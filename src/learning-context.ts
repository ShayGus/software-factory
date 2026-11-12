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
  if (scopes.some((scope) => !scope || !['project', 'feature_revision', 'criterion', 'design_revision', 'detailed_plan_task', 'assignment'].includes(scope.kind))) return false;
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
    const previous = latest.get(section.heading);
    if (!previous || follows(records, guidance, previous.guidance)) latest.set(section.heading, { section, guidance });
    else if (!follows(records, previous.guidance, guidance)) {
      const order = Date.parse(guidance.updatedAt) - Date.parse(previous.guidance.updatedAt);
      if (order > 0) latest.set(section.heading, { section, guidance });
      else if (order === 0 && section.digest !== previous.section.digest) throw new Error(`legacy_adoption_order_ambiguous: ${uri} ${section.heading}`);
    }
  }
  return [...latest.values()].map(({ section }) => section);
}
type Edit = { start: number; end: number; replacement: string };
function applyProjection(original: string, edits: Edit[]) {
  let text = '', previousEnd = 0;
  for (const edit of edits) {
    text += original.slice(previousEnd, edit.start) + edit.replacement;
    previousEnd = edit.end;
  }
  text += original.slice(previousEnd);
  return { text, mapOffset(offset: number, edge: 'start' | 'end') {
    let delta = 0;
    for (const edit of edits) {
      if (offset < edit.start) break;
      if (offset <= edit.end) return edit.start + delta +
        (offset === edit.end || offset !== edit.start && edge === 'end' ? edit.replacement.length : 0);
      delta += edit.replacement.length - (edit.end - edit.start);
    }
    return offset + delta;
  } };
}
/** Validate current adoptions against the unmodified snapshot, then replace
 * disjoint ranges once. Historical section evidence remains in the store. */
function legacyProjection(records: FactoryRecord[], uri: string, original: string) {
  const ranges = currentLegacySections(records, uri).map((section) => {
    const range = markdownSectionRange(original, section.heading);
    if (range.before !== section.before || learningDigest(range.before) !== section.digest) throw new Error(`legacy_section_changed: ${uri} ${section.heading}`);
    return { start: range.start, end: range.end,
      replacement: `${section.heading}\n[Adopted guidance is supplied separately in the current scoped guidance.]\n` };
  }).sort((a, b) => a.start - b.start || b.end - a.end);
  const disjoint: Edit[] = [];
  for (const range of ranges) {
    const previous = disjoint.at(-1);
    if (previous && range.start < previous.end) previous.end = Math.max(previous.end, range.end);
    else disjoint.push(range);
  }
  return applyProjection(original, disjoint);
}
export function projectLegacyContext(records: FactoryRecord[], uri: string, text: string): string {
  return legacyProjection(records, uri, text).text;
}
/** Worker records retain exact provenance and evidence pointers, while the
 * original legacy section bodies are available only through record history. */
export function workerContextRecord(record: Observation): Observation;
export function workerContextRecord(record: FactoryRecord): FactoryRecord;
export function workerContextRecord(record: FactoryRecord): FactoryRecord {
  if (record.kind !== 'observation' || !record.legacySections?.length) return record;
  const { legacySections: _sections, ...projection } = record;
  return projection;
}
export function projectContextSource(records: FactoryRecord[], uri: string, original: string, record?: FactoryRecord) {
  if (record) {
    const projected = record.kind === 'request' ? record.originalText : JSON.stringify(workerContextRecord(record), null, 2);
    if (projected !== original) return applyProjection(original, [{ start: 0, end: original.length, replacement: projected }]);
  }
  return legacyProjection(records, uri, original);
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
      (record.learning.scope.kind === 'project' || record.learning.scope.featureId === featureId)).map((record) => workerContextRecord(record)),
    conflicts: latest.filter((record): record is Observation => record.kind === 'observation' && record.consolidationState === 'conflict' &&
      (!record.learning || record.learning.scope.kind === 'project' || record.learning.scope.featureId === featureId)).map((record) => workerContextRecord(record)),
  };
}
