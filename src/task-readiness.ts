import type { FactoryRecord, TaskMapping } from './records.js';

export const currentTaskMappings = (records: FactoryRecord[]) =>
  records.filter((record): record is TaskMapping => record.kind === 'task_mapping');

/** Resolve a product prerequisite to its particular producer, never the whole feature. */
export function taskPrerequisites(records: FactoryRecord[], mapping: TaskMapping) {
  const mappings = currentTaskMappings(records);
  return (mapping.management?.requirements ?? []).map((requirement) => {
    const candidates = mappings.filter((candidate) => !candidate.legacy &&
      candidate.detailedPlanTask?.id === requirement.prerequisiteTaskId);
    return { requirement, producer: candidates.length === 1 ? candidates[0] : undefined };
  });
}

export function taskDependencyIds(records: FactoryRecord[], mapping: TaskMapping): string[] {
  return [...new Set([...mapping.dependencies, ...taskPrerequisites(records, mapping)
    .flatMap(({ producer }) => producer ? [producer.firstMateTaskId] : [])])];
}

/** Call with current records. Both explicit execution edges and resolved product
 * edges participate, including edges whose producer is cancelled. */
export function assertTaskDependencyAcyclic(records: FactoryRecord[]): void {
  const graph = new Map(currentTaskMappings(records).map((mapping) =>
    [mapping.firstMateTaskId, taskDependencyIds(records, mapping)]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id)) throw new Error('task_dependency_cycle');
    if (visited.has(id)) return;
    visiting.add(id);
    for (const next of graph.get(id) ?? []) visit(next);
    visiting.delete(id); visited.add(id);
  };
  for (const id of graph.keys()) visit(id);
}

/** Product facts are independent of tasks-axi's done flag. Artifact availability
 * can be supported by a non-passing result; a criterion requires passing current
 * evidence from the specifically mapped producer's current assignment. */
export function taskReadinessReasons(records: FactoryRecord[], mapping: TaskMapping): string[] {
  const reasons: string[] = [];
  if (mapping.disposition.state !== 'active') reasons.push(mapping.disposition.reason);
  if (mapping.management?.paused) reasons.push('Task is paused');
  for (const condition of mapping.management?.readiness ?? []) {
    if (!condition.evidence.length) reasons.push(condition.reason);
  }
  for (const id of mapping.dependencies) {
    if (currentTaskMappings(records).some((candidate) => candidate.firstMateTaskId === id &&
      candidate.disposition.state === 'cancelled')) reasons.push(`Cancelled prerequisite ${id}`);
  }
  for (const { requirement, producer } of taskPrerequisites(records, mapping)) {
    const operation = producer?.management && records.find((record) => record.id === producer.management!.operationId);
    if (!producer || producer.disposition.state !== 'active' || (producer.management &&
      (operation?.kind !== 'operation' || operation.state !== 'succeeded'))) {
      reasons.push(`Unresolved prerequisite ${requirement.prerequisiteTaskId}: ${requirement.reason}`);
      continue;
    }
    const assignments = records.filter((record) => record.kind === 'assignment' &&
      record.firstMateTaskId === producer.firstMateTaskId &&
      record.detailedPlanTask.id === producer.detailedPlanTask?.id &&
      record.detailedPlanTask.revision === producer.detailedPlanTask.revision &&
      record.feature?.id === producer.feature?.id && record.feature?.revision === producer.feature?.revision &&
      record.criteria.length === producer.criteria.length && record.criteria.every((criterion) =>
        producer.criteria.some((entry) => entry.id === criterion.id && entry.revision === criterion.revision)));
    // A new attempt can invalidate old evidence without editing the old
    // assignment ID. Equal-time competing attempts have no certain current owner.
    const latestTime = Math.max(...assignments.map((assignment) => Date.parse(assignment.createdAt)));
    const latest = assignments.filter((assignment) => Date.parse(assignment.createdAt) === latestTime);
    const available = records.some((result) => result.kind === 'criterion_result' && result.artifact &&
      result.evidence.length > 0 && latest.length === 1 && latest.some((assignment) =>
        assignment.id === result.assignment.id && assignment.revision === result.assignment.revision) &&
      (requirement.needs.kind === 'artifact' ?
        result.artifact.uri === requirement.needs.artifact.uri &&
        result.artifact.revision === requirement.needs.artifact.revision &&
        result.artifact.digest === requirement.needs.artifact.digest :
        result.result === 'passed' && result.criterion?.id === requirement.needs.criterion.id &&
        result.criterion.revision === requirement.needs.criterion.revision &&
        records.some((criterion) => criterion.kind === 'criterion' && criterion.id === result.criterion?.id &&
          criterion.revision === result.criterion.revision && criterion.disposition.state === 'active')));
    if (!available) reasons.push(`Product prerequisite not met: ${requirement.reason}`);
  }
  return reasons;
}
