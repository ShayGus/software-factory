import { createHash } from 'node:crypto';
import type { FactoryRecord, GuidanceRevision, Observation } from './records.js';
import type { LearningIdentity } from './learning-contracts.js';

export const learningDigest = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
export const learningKey = (identity: LearningIdentity) => JSON.stringify([identity.topic,
  identity.scope.kind === 'feature' ? identity.scope.featureId : null]);
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
export function guidanceForContext(records: FactoryRecord[], featureId?: string) {
  const applicable = activeGuidance(records).filter((record) => !record.learning || record.learning.scope.kind === 'project' || record.learning.scope.featureId === featureId);
  return applicable.filter((record) => !record.learning || record.learning.scope.kind !== 'project' || !applicable.some((other) =>
    other.learning?.scope.kind === 'feature' && other.learning.topic === record.learning!.topic && other.learning.authority === 'explicit'));
}
/** Projection only: legacy files are never written. An adopted section has one
 * authority thereafter; a changed legacy source fails closed for reconciliation. */
export function legacySectionsForGuidance(records: FactoryRecord[], guidance: GuidanceRevision) {
  return (guidance.legacyReplacements ?? []).map((replacement) => {
    const observation = records.find((record) => record.id === replacement.observation.id && record.revision === replacement.observation.revision);
    const section = observation?.kind === 'observation' && observation.legacySections?.find((section) =>
      section.uri === replacement.uri && section.heading === replacement.heading && section.digest === replacement.digest);
    if (!section) throw new Error('legacy_replacement_source_missing');
    return section;
  });
}
export function projectLegacyContext(records: FactoryRecord[], uri: string, text: string): string {
  const seen = new Set<string>();
  for (const guidance of records) if (guidance.kind === 'guidance_revision') for (const section of legacySectionsForGuidance(records, guidance)) {
    const key = JSON.stringify([section.uri, section.heading, section.digest]);
    if (section.uri !== uri || seen.has(key)) continue;
    seen.add(key);
    if (!text.includes(section.before)) throw new Error(`legacy_section_changed: ${uri} ${section.heading}`);
    text = text.replace(section.before, `${section.heading}\n[Adopted guidance is supplied separately in the current scoped guidance.]\n`);
  }
  return text;
}
export function learningContext(records: FactoryRecord[], featureId?: string) {
  const latest = currentLearningRecords(records);
  return {
    guidance: guidanceForContext(records, featureId),
    corrections: latest.filter((record): record is Observation => record.kind === 'observation' &&
      (record.learning?.inputKind === 'local_correction' || record.learning?.inputKind === 'operational' && record.consolidationState !== 'no_general_rule') &&
      (record.learning.scope.kind === 'project' || record.learning.scope.featureId === featureId)),
    conflicts: latest.filter((record): record is Observation => record.kind === 'observation' && record.consolidationState === 'conflict' &&
      (!record.learning || record.learning.scope.kind === 'project' || record.learning.scope.featureId === featureId)),
  };
}
