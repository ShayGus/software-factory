import { createHash } from 'node:crypto';
import type { FactoryRecord, GuidanceRevision, Observation } from './records.js';
import type { LearningIdentity } from './learning-contracts.js';
import { markdownSectionRange } from './markdown-sections.js';

export const learningDigest = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
export const learningKey = (identity: LearningIdentity) => JSON.stringify([identity.topic,
  identity.scope.kind === 'feature' ? identity.scope.featureId : null]);
export const uniqueLegacySections = <T extends { uri: string; heading: string; digest: string }>(sections: T[]): T[] =>
  sections.filter((section, index) => sections.findIndex((other) => other.uri === section.uri &&
    other.heading === section.heading && other.digest === section.digest) === index);
export function currentLearningRecords(records: FactoryRecord[]) {
  const latest = new Map<string, FactoryRecord>();
  for (const record of records) if (!latest.has(record.id) || latest.get(record.id)!.revision < record.revision) latest.set(record.id, record);
  return [...latest.values()];
}
export function activeGuidance(records: FactoryRecord[]): GuidanceRevision[] {
  const guidance = currentLearningRecords(records).filter((record): record is GuidanceRevision => record.kind === 'guidance_revision');
  const superseded = new Set(guidance.flatMap((record) => record.supersededGuidance.filter((ref) => ref.id !== record.id).map((ref) => ref.id)));
  return guidance.filter((record) => !superseded.has(record.id) && !record.unresolvedConflicts.length);
}
function legacyScopeApplies(records: FactoryRecord[], guidance: GuidanceRevision, featureId?: string) {
  // Opaque legacy URIs do not establish project-wide applicability. Require
  // resolved record scopes until the rule has explicit learning classification.
  const scopes = guidance.scope.map((source) => source.record && records.find((record) =>
    record.id === source.record!.id && record.revision === source.record!.revision && record.projectId === guidance.projectId));
  if (scopes.some((scope) => !scope || !(scope.kind === 'project' || scope.kind === 'feature_revision' || scope.kind === 'criterion' || 'feature' in scope))) return false;
  return scopes.some((scope) => scope && (scope.kind === 'project' ||
    scope.kind === 'feature_revision' && scope.id === featureId ||
    scope.kind === 'criterion' && scope.featureId === featureId ||
    'feature' in scope && scope.feature !== null && scope.feature.id === featureId));
}
export function guidanceForContext(records: FactoryRecord[], featureId?: string) {
  const applicable = activeGuidance(records).filter((record) => record.learning ?
    record.learning.scope.kind === 'project' || record.learning.scope.featureId === featureId : legacyScopeApplies(records, record, featureId));
  return applicable.filter((record) => !record.learning || record.learning.scope.kind !== 'project' || !applicable.some((other) =>
    other.learning?.scope.kind === 'feature' && other.learning.topic === record.learning!.topic && other.learning.authority === 'explicit'));
}
export function legacySectionsForGuidance(records: FactoryRecord[], guidance: GuidanceRevision) {
  return (guidance.legacyReplacements ?? []).map((replacement) => {
    const observation = records.find((record) => record.id === replacement.observation.id && record.revision === replacement.observation.revision);
    const section = observation?.kind === 'observation' && observation.legacySections?.find((section) =>
      section.uri === replacement.uri && section.heading === replacement.heading && section.digest === replacement.digest);
    if (!section) throw new Error('legacy_replacement_source_missing');
    return section;
  });
}
function follows(records: FactoryRecord[], later: GuidanceRevision, earlier: GuidanceRevision): boolean {
  const pending = [later]; const seen = new Set<string>();
  while (pending.length) {
    const current = pending.pop()!; const key = JSON.stringify([current.id, current.revision]);
    if (seen.has(key)) continue;
    seen.add(key);
    if (current.id === earlier.id && current.revision >= earlier.revision) return true;
    for (const ref of current.supersededGuidance) {
      const parent = records.find((record) => record.kind === 'guidance_revision' && record.id === ref.id && record.revision === ref.revision);
      if (parent?.kind === 'guidance_revision') pending.push(parent);
    }
  }
  return false;
}
function currentLegacySections(records: FactoryRecord[], uri: string) {
  type Section = ReturnType<typeof legacySectionsForGuidance>[number];
  const latest = new Map<string, { section: Section; guidance: GuidanceRevision }>();
  for (const guidance of records) if (guidance.kind === 'guidance_revision') for (const section of legacySectionsForGuidance(records, guidance)) {
    if (section.uri !== uri) continue;
    const heading = section.heading.trim();
    const previous = latest.get(heading);
    if (!previous || follows(records, guidance, previous.guidance)) latest.set(heading, { section, guidance });
    else if (!follows(records, previous.guidance, guidance)) {
      const order = Date.parse(guidance.updatedAt) - Date.parse(previous.guidance.updatedAt);
      if (order > 0) latest.set(heading, { section, guidance });
      else if (order === 0 && section.digest !== previous.section.digest) throw new Error(`legacy_adoption_order_ambiguous: ${uri} ${section.heading}`);
    }
  }
  return [...latest.values()];
}
function sectionRange(text: string, heading: string) {
  try { return markdownSectionRange(text, heading); } catch { return undefined; }
}
function adoptedSnapshots(records: FactoryRecord[]) {
  return uniqueLegacySections(records.flatMap((record) => record.kind === 'guidance_revision' ? legacySectionsForGuidance(records, record) : []));
}
/** Select covering adoptions before checking bytes. A superseded child cannot
 * invalidate a current parent that now owns the complete section. */
export function legacyContextSections(records: FactoryRecord[], uri: string, original: string) {
  const adoptions = currentLegacySections(records, uri).map((adoption) => ({ ...adoption,
    range: sectionRange(original, adoption.section.heading) }));
  const covering = adoptions.filter((child) => !adoptions.some((parent) => {
    if (parent === child || !parent.range) return false;
    if (child.range) return parent.range.start < child.range.start && parent.range.end >= child.range.end;
    // A replacement parent may remove a former child's heading altogether.
    return records.some((record) => record.kind === 'guidance_revision' &&
      (follows(records, record, child.guidance) || Date.parse(record.updatedAt) > Date.parse(child.guidance.updatedAt)) &&
      legacySectionsForGuidance(records, record).some((section) => section.uri === uri &&
        section.heading.trim() === parent.section.heading.trim() && sectionRange(section.before, child.section.heading) !== undefined));
  }));
  const active = activeGuidance(records);
  const sections = covering.map(({ section, guidance, range }) => {
    if (!range || range.before !== section.before || learningDigest(range.before) !== section.digest) throw new Error(`legacy_section_changed: ${uri} ${section.heading}`);
    const successors = active.filter((current) => follows(records, current, guidance));
    const names = (successors.length ? successors : [guidance]).map((current) => `${current.id}@${current.revision}`).sort();
    return { start: range.start, end: range.end, marker: `[Adopted guidance: ${names.join(', ')}]\n` };
  }).sort((a, b) => a.start - b.start);
  let text = '', end = 0;
  for (const section of sections) {
    text += original.slice(end, section.start) + section.marker;
    end = section.end;
  }
  return { text: text + original.slice(end), sections };
}
export const sourceRangeIsRetired = (sections: { start: number; end: number }[], start: number, end: number) =>
  sections.some((section) => start < section.end && end > section.start);
export function projectLegacyContext(records: FactoryRecord[], uri: string, text: string): string {
  return legacyContextSections(records, uri, text).text;
}
/** Select complete snapshots, never edit their bodies or serialized JSON.
 * Pending evidence stays available until an adoption retires those bytes. */
export function workerContextRecord(records: FactoryRecord[], record: Observation): Observation;
export function workerContextRecord(records: FactoryRecord[], record: FactoryRecord): FactoryRecord;
export function workerContextRecord(records: FactoryRecord[], record: FactoryRecord): FactoryRecord {
  if (record.kind !== 'observation' || !record.legacySections?.length) return record;
  const adopted = adoptedSnapshots(records);
  const legacySections = record.legacySections.filter((snapshot) => !adopted.some((section) => section.uri === snapshot.uri &&
    sectionRange(section.before, snapshot.heading)?.before === snapshot.before));
  return legacySections.length === record.legacySections.length ? record : { ...record, legacySections };
}
export function workerContextText(records: FactoryRecord[], record: FactoryRecord) {
  return record.kind === 'request' ? record.originalText : JSON.stringify(workerContextRecord(records, record), null, 2);
}
export const projectedContextArtifact = (uri: string, text: string) => ({
  uri: `factory:projected-context/${encodeURIComponent(uri)}`, digest: learningDigest(text),
});
export function learningContext(records: FactoryRecord[], featureId?: string) {
  const latest = currentLearningRecords(records);
  return {
    guidance: guidanceForContext(records, featureId),
    corrections: latest.filter((record): record is Observation => record.kind === 'observation' &&
      (record.learning?.inputKind === 'local_correction' || record.learning?.inputKind === 'operational' && record.consolidationState !== 'no_general_rule') &&
      (record.learning.scope.kind === 'project' || record.learning.scope.featureId === featureId)).map((record) => workerContextRecord(records, record)),
    conflicts: latest.filter((record): record is Observation => record.kind === 'observation' && record.consolidationState === 'conflict' &&
      (!record.learning || record.learning.scope.kind === 'project' || record.learning.scope.featureId === featureId)).map((record) => workerContextRecord(records, record)),
  };
}
