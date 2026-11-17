import type { Ref } from './primitives.js';
import type { FactoryRecord, DetailedPlanTask } from './records.js';
import type { EditContext } from './ui-edit.js';
import { relatedRefs, sameRef, uiStaleAfterMs, type FeatureView, type ProjectView } from './ui-state.js';
import { durationLabel, workView, type WorkView } from './ui-work.js';
import { stageCriteria, stageDependencies, stageSliceCriteria } from './planning-checks.js';
import { StoreError } from './store.js';

export const escapeHtml = (value: unknown) => String(value ?? '').replace(/[&<>"']/gu, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
const h = escapeHtml;
const enc = encodeURIComponent;
const empty = (text: string) => `<p class="muted">${h(text)}</p>`;
const text = (value: unknown) => `<p class="prose">${h(value)}</p>`;
const items = (values: string[]) => values.length ? `<ul>${values.map((value) => `<li>${h(value)}</li>`).join('')}</ul>` : empty('None recorded.');
export const recordUrl = (projectId: string, target: Ref, inspect = true) => `/projects/${enc(projectId)}/${inspect ? 'inspect' : 'records'}/${enc(target.id)}?revision=${target.revision}`;
const recordLink = (projectId: string, target: Ref, label = target.id) => `<a href="${recordUrl(projectId, target)}">${h(label)} <span class="revision">r${target.revision}</span></a>`;
const links = (projectId: string, refs: Ref[]) => refs.map((target) => recordLink(projectId, target)).join(' · ') || 'None recorded';
const featureUrl = (projectId: string, id: string) => `/projects/${enc(projectId)}/features/${enc(id)}`;
function external(uri: string) {
  // Arbitrary source/evidence identifiers stay readable without becoming script,
  // filesystem, protocol-relative or invented remote navigation.
  return /^https?:\/\//u.test(uri) ? `<a href="${h(uri)}" rel="noreferrer">${h(uri)}</a>` : `<span class="identifier">${h(uri)}</span>`;
}
const labelName = (name: string) => name.replace(/[A-Z]/gu, (letter) => ` ${letter.toLowerCase()}`).replace(/^./u, (letter) => letter.toUpperCase());
function field(name: string, label: string, value: unknown, type: 'text' | 'number' | 'textarea' = 'textarea') {
  return `<label>${h(label)}${type === 'textarea' ? `<textarea name="${name}" rows="3">${h(value)}</textarea>` :
    `<input name="${name}" type="${type}" value="${h(value)}"${type === 'number' ? ' step="1" required' : ''}>`}</label>`;
}
function select(name: string, label: string, value: string, options: string[]) {
  return `<label>${h(label)}<select name="${name}">${options.map((option) => `<option${option === value ? ' selected' : ''}>${h(option)}</option>`).join('')}</select></label>`;
}
function edit(context: EditContext, title: string, fields: string) {
  return `<details class="editor"><summary>${h(title)}</summary><form data-editor>
    <input type="hidden" name="context" value="${h(JSON.stringify(context))}">${fields}
    ${field('reason', 'Reason for change', '', 'text')}<div class="form-actions"><button type="submit">Save change</button>
    <output aria-live="polite">Ready to edit</output></div></form></details>`;
}
function shell(view: ProjectView, title: string, body: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${h(title)} · Software Factory</title><link rel="stylesheet" href="/assets/ui.css"><script type="module" src="/assets/ui-client.js"></script></head>
    <body><a class="skip" href="#main">Skip to content</a><header><a class="brand" href="/">Software Factory</a><nav aria-label="Main"><a href="/projects/${enc(view.options.projectId)}">Features</a>
    <a href="/projects/${enc(view.options.projectId)}/decisions">Needs input (${view.questions.length})</a><a href="/projects/${enc(view.options.projectId)}/learning">Learning</a>
    <a href="/projects/${enc(view.options.projectId)}/work">Work</a><a href="/projects/${enc(view.options.projectId)}/dependencies">Dependencies</a>
    ${view.options.scottyUrl && /^https?:\/\//u.test(view.options.scottyUrl) ? `<a href="${h(view.options.scottyUrl)}" rel="noreferrer">Scotty tickets and dependencies</a>` : '<span>Scotty link not configured</span>'}</nav></header>
    <main id="main" data-stale-after-ms="${uiStaleAfterMs(view.options.staleAfterMs)}"><div class="notice">${view.options.fixture ? 'Fixture mode — all requests, task observations and evidence are synthetic.' : 'Local project records'}
    <span>Read at ${h(view.readAt)}</span></div><div id="page-state" role="status" aria-live="polite">Loaded — local records. Execution observations carry their own freshness labels.</div>
    <noscript><p>Read-only — enable JavaScript to save edits through canonical operations.</p></noscript>${body}</main>
    <footer>Original request → design → detailed plan → worker brief → evidence</footer></body></html>`;
}
function featureEditor(item: FeatureView) {
  return edit({ kind: 'feature', feature: item.feature }, `Edit feature · r${item.feature.revision}`,
    field('outcome', 'Requested outcome', item.feature.outcome) + field('priority', 'Feature priority (lower first)', item.feature.priority, 'number') +
    select('disposition', 'Feature disposition', item.feature.disposition.state, item.feature.disposition.state === 'cancelled' ? ['cancelled'] : ['active', 'deferred']));
}
function featureRow(view: ProjectView, item: FeatureView) {
  const { feature } = item;
  return `<article class="feature-row"><div><h3><a href="${featureUrl(view.options.projectId, feature.id)}">${h(feature.outcome)}</a></h3>
    <p>Priority ${feature.priority} · ${h(feature.disposition.state)} · ${recordLink(feature.projectId, feature)}</p>
    <p>Stage: ${h(feature.methodStage)} · Design ${item.design ? `r${item.design.revision}` : 'Unknown — not recorded'} · Plan ${item.plan ? `r${item.plan.revision}` : 'Unknown — not recorded'}</p>
    <p>${h(item.completeness)}</p><p>Demonstrated behavior: ${h(item.criteria.filter((criterion) => criterion.label === 'Demonstrated (reviewed)').map((criterion) => criterion.criterion?.kind === 'criterion' ? criterion.criterion.expectedBehavior : criterion.target.id).join('; ') || 'None verified in a current product review.')}</p>
    <p>Reported evidence: ${h(item.criteria.flatMap((criterion) => criterion.demonstrated.map((result) => result.accomplishedBehavior)).join('; ') || 'None current.')}</p>
    <p>Remaining criteria: ${item.remaining.length}</p><ul>${item.remaining.map((criterion) => `<li>${h(criterion.criterion?.kind === 'criterion' ? criterion.criterion.expectedBehavior : criterion.target.id)} — ${h(criterion.label)}</li>`).join('')}</ul>
    <p>Original requests: ${links(feature.projectId, feature.sourceRequests)}</p><p>Related work: ${links(feature.projectId, item.tasks.map((task) => task.mapping))}</p></div>
    <div>${featureEditor(item)}</div></article>`;
}
function taskActions(item: { mapping: FeatureView['tasks'][number]['mapping']; operation: FeatureView['tasks'][number]['operation']; priority: number | null | undefined }, canCancelTasks = true) {
  const { mapping, operation } = item;
  if (mapping.disposition.state === 'cancelled') return empty('Cancelled — further changes require explicit replanning.');
  if (operation?.kind === 'operation' && operation.state !== 'succeeded' && !operation.taskRejection?.beforeMutation) return empty('Edits unavailable — inspect and reconcile the saved operation first.');
  const context = { kind: 'task' as const, mapping };
  return edit({ ...context, action: 'set_priority' }, 'Edit task priority', field('priority', 'Task priority (0–4)', item.priority ?? '', 'number')) +
    edit({ ...context, action: 'edit_dependencies' }, 'Add or remove dependencies', field('dependencies', 'Prerequisite logical task IDs (comma separated; empty removes all explicit dependencies)', mapping.dependencies.join(', '), 'text') + empty('Product prerequisites from the plan remain governed by product readiness.')) +
    edit({ ...context, action: mapping.management?.paused ? 'resume' : 'pause' }, mapping.management?.paused ? 'Unhold task (resume toolkit pause)' : 'Hold task (indefinite toolkit pause)', empty('Uses the canonical pause/resume operation. Other owners’ holds remain visible and are preserved.')) +
    (canCancelTasks ? edit({ ...context, action: 'cancel' }, 'Cancel execution task', empty('Records cancellation through FirstMate; feature completeness still requires product review.')) : empty('Cancel execution tasks through FirstMate chat on the host.'));
}
function taskRows(feature: FeatureView, canCancelTasks = true) {
  return feature.tasks.map((item) => {
    const mapping = item.mapping;
    const operation = item.operation?.kind === 'operation' ? item.operation : undefined;
    return `<article class="task-row"><h3>${h(item.task?.title ?? mapping.firstMateTaskId)}</h3><p>${h(item.label)}${item.observedAt ? ` · ${h(item.observedAt)}` : ''}</p>
      <p>Task progress: ${h(item.task?.state ?? 'Unknown')}. Feature completeness: ${h(feature.completeness)}.</p>
      <p>Priority: ${h(item.priority ?? 'Unknown')} · Dependencies: ${h(mapping.dependencies.join(', ') || 'None recorded')} · ${mapping.management?.paused ? 'Deferred — toolkit pause' : 'No toolkit pause recorded'}</p>
      ${mapping.disposition.state !== 'active' ? text(`${mapping.disposition.state}: ${mapping.disposition.reason}`) : ''}
      ${item.task?.hold ? text(`Held: ${item.task.hold.reason}`) : ''}${item.task?.blocked_by.length ? text(`Blocked by: ${item.task.blocked_by.join(', ')}`) : ''}
      <p>${recordLink(mapping.projectId, mapping)} · Plan task: ${mapping.detailedPlanTask ? recordLink(mapping.projectId, mapping.detailedPlanTask) : 'Unknown — legacy mapping'}
      ${operation ? ` · ${recordLink(mapping.projectId, operation, 'Operation and observation evidence')}` : ''}</p>
      <p>Original requests: ${links(mapping.projectId, feature.feature.sourceRequests)} · Related briefs: ${links(mapping.projectId, feature.assignments.filter((assignment) => assignment.firstMateTaskId === mapping.firstMateTaskId))}</p>
      ${taskActions(item, canCancelTasks)}
    </article>`;
  }).join('') || empty('Unknown — no execution mappings recorded.');
}
export function renderOverview(view: ProjectView) {
  return shell(view, 'Features', `<h1>Requested outcomes</h1>${text(view.project.goal)}
    <section><h2>Unmapped requests</h2>${view.unclassified.map((request) => `<article><h3>${recordLink(view.options.projectId, request)}</h3>
      <p>Incomplete — original text still needs classification.</p><blockquote>${h(request.originalText)}</blockquote>
      <h4>Unmapped ranges</h4>${items(request.coverage.unmapped.map((range) => range.text))}</article>`).join('') || empty('No unmapped request text.')}</section>
    <section aria-labelledby="requested"><h2 id="requested">Requested features</h2>${view.features.sort((a, b) => a.feature.priority - b.feature.priority).map((item) => featureRow(view, item)).join('') || empty('No requested features recorded.')}</section>
    <section aria-labelledby="suggestions"><h2 id="suggestions">Suggestions · outside current scope</h2>${view.suggestions.map((suggestion) => `<article><h3>${recordLink(view.options.projectId, suggestion, suggestion.questionOrChange)}</h3>${text(suggestion.rationale)}<p>Proposed — not selected. Related records: ${links(view.options.projectId, suggestion.affectedRecords)}</p></article>`).join('') || empty('No suggestions recorded.')}</section>
    <section><h2>Decisions needing input</h2>${decisionRows(view)}</section>
    <section><h2>Work and input needed</h2>${view.features.map((feature) => `<h3><a href="${featureUrl(view.options.projectId, feature.feature.id)}">${h(feature.feature.outcome)}</a></h3>${taskRows(feature, view.options.canCancelTasks)}`).join('')}</section>`);
}
const workUrl = (projectId: string, id: string) => `/projects/${enc(projectId)}/work/${enc(id)}`;
function workContext(view: ProjectView, row: WorkView['rows'][number]) {
  const { mapping, feature, maintenance } = row;
  return `<p>Feature: ${feature ? `<a href="${featureUrl(mapping.projectId, feature.feature.id)}">${h(feature.feature.outcome)}</a> · ${recordLink(mapping.projectId, mapping.feature!, 'Mapped feature revision')}` : maintenance ? 'Standalone maintenance — no feature by design' : 'Unknown — feature not linked'}
    · Plan task: ${mapping.detailedPlanTask ? recordLink(mapping.projectId, mapping.detailedPlanTask) : 'Unknown'}</p>
    ${maintenance ? `<p>Maintenance objective: ${h(maintenance.objective)}</p><p>Design: ${maintenance.design?.kind === 'design_revision' ? recordLink(mapping.projectId, maintenance.design) : 'Unknown'}
      · Plan: ${maintenance.plan?.kind === 'implementation_plan_revision' ? recordLink(mapping.projectId, maintenance.plan) : 'Unknown'}</p>` : ''}
    <p>Assignments: ${row.assignments.length ? links(mapping.projectId, row.assignments) : 'Unknown — no assignment recorded'}
    · Original requests: ${feature ? links(view.options.projectId, feature.feature.sourceRequests) : row.sourceRequests.length ? links(mapping.projectId, row.sourceRequests) : 'Unknown'}</p>`;
}
function edgeOrigin(edge: WorkView['rows'][number]['dependencies'][number] | WorkView['rows'][number]['consumers'][number]['edge']) {
  return `${h(edge.source)}${edge.observedAt ? ` · ${edge.stale ? 'Stale — edge observed at' : 'Edge observed at'} ${h(edge.observedAt)}` : ''}`;
}
function snapshotFreshness(work: WorkView) {
  return `<p${work.snapshot ? ` data-snapshot-at="${h(work.snapshot.observedAt)}" data-stale-after-ms="${work.threshold}"` : ''}>${h(work.snapshotLabel)}</p>`;
}
function workRow(view: ProjectView, row: WorkView['rows'][number], dependencies: boolean) {
  const { mapping, observation } = row;
  return `<article class="task-row" id="task-${h(mapping.id)}"><h2><a href="${workUrl(mapping.projectId, mapping.id)}">${h(row.task?.title ?? mapping.firstMateTaskId)}</a></h2>
    ${workContext(view, row)}
    <p>${h(row.label)} · ${h(row.observedAt ?? 'Observed at: Unknown')} · Priority: ${h(row.priority ?? 'Unknown')}</p>
    <p>Worker: ${h(observation?.workerState ?? 'Unknown')} · Execution: ${h(durationLabel(observation?.executionMs))} · Waiting: ${h(durationLabel(observation?.waitingMs))}</p>
    <p>Feature completeness: ${h(row.feature?.completeness ?? (row.maintenance ? 'Not applicable — standalone maintenance' : 'Unknown — product review unavailable'))}</p>
    <h3>Blocking reasons and review waits</h3>${row.reasons.length ? items(row.reasons) : empty('No blocking reason recorded. Missing observations below still need inspection.')}
    ${row.corrections.length ? `<p>Correction evidence: ${links(mapping.projectId, row.corrections)}</p>` : ''}
    ${row.correctionOperations.map(({ correction, operation }) => `<p>${h(correction.correction.action)} · ${h(operation.state)} · ${recordLink(mapping.projectId, operation, 'Correction delivery operation')}</p>`).join('')}
    <h3>Unknowns</h3>${row.unknowns.length ? items(row.unknowns) : empty('No missing fields in these observations.')}
    <h3>${dependencies ? 'Dependency view — this task needs' : 'Prerequisites'}</h3>
    ${row.dependencies.length ? `<ul>${row.dependencies.map((entry) => `<li>${entry.mapping ? `<a href="${workUrl(mapping.projectId, entry.mapping.id)}">${h(entry.id)}</a>` : h(entry.id)} — ${h(entry.label)} · ${edgeOrigin(entry)}</li>`).join('')}</ul>` : empty('No execution prerequisites recorded.')}
    ${row.requirements.length ? `<ul>${row.requirements.map(({ requirement, producer }) => `<li>Product prerequisite ${h(requirement.prerequisiteTaskId)} (${h(requirement.needs.kind)}): ${h(requirement.reason)} — ${producer ? recordLink(mapping.projectId, producer) : 'Unknown — producer mapping unresolved'}</li>`).join('')}</ul>` : ''}
    ${dependencies ? `<p>Needed by: ${row.consumers.map((entry) => `<a href="${workUrl(mapping.projectId, entry.id)}">${h(entry.firstMateTaskId)}</a> (${edgeOrigin(entry.edge)})`).join(' · ') || 'No consumers recorded'}</p>` : ''}
    <p>${recordLink(mapping.projectId, mapping, 'Canonical task mapping')}${row.operation ? ` · ${recordLink(mapping.projectId, row.operation, 'Operation and observation evidence')}` : ''}</p>
    ${taskActions(row, view.options.canCancelTasks)}</article>`;
}
export function renderWork(view: ProjectView, dependencies = false, focusId?: string) {
  const work = workView(view);
  const rows = focusId ? work.rows.filter((row) => row.mapping.id === focusId) : work.rows;
  if (focusId && !rows.length) throw new StoreError('not_found', 'work_task_not_found');
  const projectId = view.options.projectId;
  return shell(view, focusId ? 'Focused work' : dependencies ? 'Dependencies' : 'Work', `<h1>${focusId ? 'Focused work' : dependencies ? 'Work dependencies' : 'Work and waiting'}</h1>
    <p><a href="/projects/${enc(projectId)}/work">All work</a> · <a href="/projects/${enc(projectId)}/dependencies">Dependency view</a></p>
    <section aria-labelledby="snapshot-heading"><h2 id="snapshot-heading">Snapshot freshness</h2>
    ${snapshotFreshness(work)}
    <p>Provenance: ${h(work.snapshot?.provenance ?? 'Unknown')} · Stale after ${h(durationLabel(work.threshold))}</p>
    <h3>Omissions</h3>${work.snapshot ? items(work.snapshot.omissions.length ? work.snapshot.omissions.map((entry) => `Unknown — omitted: ${entry}`) : ['No omissions declared by the snapshot source.']) : empty('Unknown — snapshot coverage unavailable.')}</section>
    <section aria-labelledby="ready-heading"><h2 id="ready-heading">Ready PRs and branches</h2>
    ${work.ready.length ? work.ready.map((entry) => `<article><h3>${entry.kind === 'pr' ? 'Ready PR' : 'Ready branch'} · ${external(entry.reference)}</h3>
      <p>Age since ready: ${h(entry.age)} · Ready since: ${h(entry.readySince ?? 'Unknown')} · Next action: ${h(entry.nextAction ?? 'Unknown')}</p>
      <p>${entry.row ? `<a href="${workUrl(projectId, entry.row.mapping.id)}">${h(entry.firstMateTaskId)}</a>` : `${h(entry.firstMateTaskId)} — Unknown task mapping`}</p>${entry.row ? workContext(view, entry.row) : ''}
      ${snapshotFreshness(work)}</article>`).join('') : empty(work.readyKnown ? 'No ready PR or branch reported in this snapshot. Coverage is limited to its supplied tasks.' : 'Unknown — ready-work observations unavailable.')}</section>
    <section aria-labelledby="work-heading"><h2 id="work-heading">${focusId ? 'Task context and actions' : dependencies ? 'Prerequisites and consumers' : 'Execution tasks'}</h2>
      ${rows.map((row) => workRow(view, row, dependencies)).join('') || empty('Unknown — no execution mappings recorded. This does not establish an empty FirstMate fleet.')}</section>`);
}
function evidence(view: ProjectView, item: FeatureView['criteria'][number]) {
  return item.results.map((result) => {
    const assignment = view.history.find((record) => sameRef(record, result.assignment));
    return `<li>${recordLink(view.options.projectId, result, `${result.result}: ${result.accomplishedBehavior}`)}
    — ${item.demonstrated.some((current) => sameRef(current, result)) ? 'Reported current evidence' : 'Stale or non-passing evidence; retained as history'}
    <p>Assignment: ${recordLink(view.options.projectId, result.assignment)}</p>
    <p>Evidence revisions: ${assignment?.kind === 'assignment' ? `design ${recordLink(view.options.projectId, assignment.design)} · plan ${recordLink(view.options.projectId, assignment.plan)}` : 'Unknown'}</p>
    ${result.evidence.map((entry) => `<p>${h(entry.description)} · ${h(entry.observedAt)}<br>${external(entry.artifact.uri)} @ ${h(entry.artifact.revision ?? entry.artifact.digest)}</p>`).join('')}
    ${items(result.limitations)}</li>`;
  }).join('') || '<li>Missing evidence — no result recorded for this criterion.</li>';
}
function artifacts(view: ProjectView, feature: FeatureView) {
  const design = feature.displayDesign;
  const plan = feature.displayPlan;
  const tasks = feature.plan?.deliverySequence.flatMap((target) => {
    const task = view.history.find((record) => sameRef(record, target));
    return task?.kind === 'detailed_plan_task' ? [task] : [];
  }) ?? [];
  const saved = feature.editBundle;
  const stage = feature.editStage;
  // Apply the canonical, source-aware lineage rules before sending browser-safe
  // editor context. A resumed draft already names its translated feature.
  const base = saved && stage ? { ...saved,
    tasks: saved.tasks.map((task) => ({ ...task, criteria: stageCriteria(view.history, stage, task.criteria, task.feature, [task]) })),
    plan: { ...saved.plan, dependencies: stageDependencies(view.history, stage, saved.plan.dependencies, saved.plan.feature),
      ...(saved.plan.workflow ? { workflow: { ...saved.plan.workflow, slices: saved.plan.workflow.slices.map((slice) => {
        const criteriaProvenance = stageSliceCriteria(view.history, stage, saved.plan, slice);
        return { ...slice, criteria: criteriaProvenance.criteria, criteriaProvenance };
      }) } } : {}) },
  } : saved;
  const context = base && design ? { feature: feature.feature, ...base,
    expectedRevisions: [feature.feature, base.design, base.plan, ...base.tasks].map((record) => {
      const head = view.records.find((candidate) => candidate.id === record.id) ?? record;
      return { id: head.id, revision: head.revision };
    }),
  } : undefined;
  const taskEditor = (task: DetailedPlanTask) => context ? edit({ ...context, kind: 'plan-task', taskId: task.id }, `Edit plan task ${task.id} · r${task.revision}`,
    field('expectedBehavior', 'Expected behavior', task.expectedBehavior) + field('verificationMethod', 'Verification method', task.verificationMethod ?? 'Run the listed verification cases') +
    (['boundaries', 'inputs', 'outputs', 'verificationCases', 'returnRequirements', 'blockers'] as const).map((name) => field(name, `${labelName(name)} (one per line)`, task[name]?.join('\n'))).join('')) : '';
  const taskRow = (task: DetailedPlanTask, editable: boolean) => `<li><h3>${recordLink(view.options.projectId, task, task.expectedBehavior ?? task.id)}</h3>
    <p>${task.draft ? 'Incomplete — draft task' : 'Detailed task'} · Criteria: ${links(view.options.projectId, task.criteria)}</p>
    <h4>Boundaries</h4>${items(task.boundaries ?? [])}<h4>Inputs</h4>${items(task.inputs ?? [])}<h4>Outputs</h4>${items(task.outputs ?? [])}
    <h4>Verification cases</h4>${items(task.verificationCases ?? [])}<h4>Return requirements</h4>${items(task.returnRequirements ?? [])}
    <p>Produced assignments: ${links(view.options.projectId, feature.assignments.filter((assignment) => sameRef(assignment.detailedPlanTask, task)))}</p>
    ${editable ? taskEditor(task) : ''}</li>`;
  return `${feature.missingBundle ? `<p role="status">Conflict — named bundle no longer exists or is incomplete. <a href="${featureUrl(view.options.projectId, feature.feature.id)}">Open the selected bundle</a>.</p>` : ''}<section id="design"><h2>Product design</h2><p>Revision history: ${links(view.options.projectId, feature.designs)}</p>
    ${feature.designDrafts.length ? `<p>Newer draft — not selected: ${links(view.options.projectId, feature.designDrafts)}. Stage selection stays unchanged.</p>` : ''}
    ${design ? `<p>${recordLink(view.options.projectId, design)} · ${sameRef(design.feature, feature.feature) ? 'Current feature revision' : 'Stale — design names an earlier feature revision'}</p>
      <h3>Product behavior</h3>${text(design.productBehavior)}<h3>Technical design</h3>${text(design.technicalDesign)}<h3>Data flow</h3>${text(design.dataFlow)}
      <h3>Reuse findings</h3>${items(design.reuseFindings)}<h3>Interfaces</h3>${items(design.interfaces)}<h3>Examples</h3>${items(design.examples)}
      <h3>Testing approach</h3>${text(design.testingApproach)}<h3>Alternatives</h3>${items(design.alternatives)}<h3>Exclusions</h3>${items(design.exclusions)}
      <h3>Unresolved questions</h3>${items(design.unresolvedQuestions)}<p>Source comparison for ${recordLink(view.options.projectId, design)}: ${h(design.sourceComparison.result)}</p>
      ${context ? edit({ ...context, kind: 'design' }, `Edit product design · r${context.design.revision}`,
        (['productBehavior', 'technicalDesign', 'dataFlow', 'testingApproach'] as const).map((name) => field(name, name.replace(/[A-Z]/gu, (letter) => ` ${letter.toLowerCase()}`), context.design[name])).join('') +
        (['reuseFindings', 'interfaces', 'examples', 'alternatives', 'exclusions', 'unresolvedQuestions'] as const).map((name) => field(name, `${labelName(name)} (one per line)`, context.design[name].join('\n'))).join('')) : empty('Incomplete — a coherent design, plan and task set is required before editing.')}` : empty('Unknown — product design not recorded.')}</section>
    <section id="plan"><h2>Detailed plan</h2><p>Revision history: ${links(view.options.projectId, feature.plans)}</p>
    <h3>Saved artifact bundles</h3><ul>${feature.savedBundles.map((saved) => `<li><a href="${h(saved.url)}">Inspect/Resume ${h(saved.refs.design.id)} r${saved.refs.design.revision} · ${h(saved.refs.plan.id)} r${saved.refs.plan.revision} · ${saved.refs.tasks.length} tasks</a></li>`).join('')}</ul>
    ${feature.planDrafts.length ? `<p>Newer draft — not selected: ${links(view.options.projectId, feature.planDrafts)}. Stage selection stays unchanged.</p>` : ''}
    ${feature.historicalDetails.length ? `<p>Historical detailed plans: ${links(view.options.projectId, feature.historicalDetails.map((stage) => stage.artifact))}.</p>` : ''}
    ${plan ? `<p>Readiness for ${recordLink(view.options.projectId, plan)} · design ${recordLink(view.options.projectId, plan.design)}: ${plan.readiness.ready && sameRef(plan.feature, feature.feature) && sameRef(plan.design, design) ? 'Recorded ready — see readiness evidence' : 'Incomplete or stale — readiness needs checking'}</p>
      <p>Strategy: ${h(plan.strategy)} · ${h(plan.strategyReason)}</p>${text(plan.integrationApproach)}
      <h3>Integration steps</h3>${items(plan.workflow?.integrationSteps ?? [])}<h3>Final verification</h3>${items(plan.workflow?.finalVerification ?? [])}
      <h3>Plan dependencies</h3>${items(plan.dependencies.map((edge) => `${edge.consumerTaskId} needs ${edge.prerequisiteTaskId}: ${edge.reason}`))}
      ${context ? edit({ ...context, kind: 'plan' }, `Edit delivery plan · r${context.plan.revision}`,
        select('strategy', 'Execution strategy', context.plan.strategy, ['focused', 'parallel']) + field('strategyReason', 'Strategy reason', context.plan.strategyReason) + field('integrationApproach', 'Integration approach', context.plan.integrationApproach) +
        field('integrationSteps', 'Integration steps (one per line)', context.plan.workflow?.integrationSteps.join('\n')) + field('finalVerification', 'Final verification (one per line)', context.plan.workflow?.finalVerification.join('\n'))) : ''}
      <h3>Tasks in the edit bundle</h3><ol class="plan-tasks">${context?.tasks.map((task) => taskRow(task, true)).join('') ?? ''}</ol>
      <div id="historical-plan-tasks"><h3>Selected plan tasks and assignment history · read-only</h3><ol class="plan-tasks">${tasks.map((task) => taskRow(task, false)).join('')}</ol></div>` : empty('Unknown — detailed plan not recorded.')}</section>`;
}
export function renderFeature(view: ProjectView, item: FeatureView) {
  const projectId = view.options.projectId;
  const named = view.options.bundle?.featureId === item.feature.id;
  const scope = `design ${item.displayDesign ? recordLink(projectId, item.displayDesign) : 'Unknown'} · plan ${item.displayPlan ? recordLink(projectId, item.displayPlan) : 'Unknown'}`;
  return shell(view, item.feature.outcome, `<a href="/">All features</a><h1>${h(item.feature.outcome)}</h1><p>Completeness for displayed bundle: ${scope} — ${h(item.completeness)}</p>
    ${named ? `<p id="selected-stage-context">Selected-stage context: design ${item.design ? recordLink(projectId, item.design) : 'Unknown'} · plan ${item.plan ? recordLink(projectId, item.plan) : 'Unknown'} · <a href="${featureUrl(projectId, item.feature.id)}">Open selected bundle</a></p>` : ''}
    <p>Feature stage: ${h(item.feature.methodStage)} · ${h(item.feature.disposition.state)} · Priority ${item.feature.priority} · ${recordLink(projectId, item.feature)}</p>
    <nav class="section-nav" aria-label="Feature sections"><a href="#request">Original request</a><a href="#design">Design</a><a href="#plan">Detailed plan</a><a href="#criteria">Criteria & evidence</a><a href="#briefs">Worker briefs</a><a href="#changes">Changes & corrections</a></nav>
    ${featureEditor(item)}<section id="request"><h2>Original request</h2>${item.requests.map(({ target, record, coverage }) => `<article><h3>${recordLink(projectId, target)}</h3>
      ${record?.kind === 'request' ? `<blockquote>${h(record.originalText)}</blockquote><p>Source: ${external(record.source.uri)} · ${h(record.channel)} · ${h(record.capturedAt)}</p>` : empty('Unknown — original request unavailable.')}
      <p>Request coverage: ${coverage.structuralCoverageComplete ? 'Mapped' : 'Incomplete — unmapped original text remains'}. Semantic review: ${h(coverage.semanticReview)}.</p>
      ${items(coverage.unmapped.map((range) => range.text))}</article>`).join('')}</section>
    <section><h2>Stage progress</h2><p>Recorded feature stage: ${h(item.feature.methodStage)}</p>${named ? '<p>Selected-stage history · named bundle inspection does not change stage selections.</p>' : ''}${item.stages.map((stage) => `<p>${recordLink(projectId, stage, stage.stage)} → ${recordLink(projectId, stage.artifact)} · ${sameRef(stage.feature, item.feature) ? 'Current feature revision' : 'Stale — earlier feature revision'} · ${h(stage.changeReason)}</p>`).join('') || empty('Unknown — stage history not recorded.')}</section>
    ${artifacts(view, item)}<section id="criteria"><h2>Criteria & evidence</h2><p>Evidence for displayed bundle: ${scope}.</p>${item.criteria.map((criterion) => `<article class="criterion"><h3>${recordLink(projectId, criterion.target, criterion.criterion?.kind === 'criterion' ? criterion.criterion.expectedBehavior : criterion.target.id)}</h3>
      <p class="state">${h(criterion.label)}</p>${criterion.criterion?.kind === 'criterion' ? `<p>${h(criterion.criterion.requirement)} · ${h(criterion.criterion.disposition.state)} · Verify: ${h(criterion.criterion.verificationMethod)}</p>
      ${edit({ kind: 'criterion', feature: item.feature, criterion: criterion.criterion }, 'Edit criterion', field('expectedBehavior', 'Expected behavior', criterion.criterion.expectedBehavior) + field('verificationMethod', 'Verification method', criterion.criterion.verificationMethod))}` : empty('Unknown — criterion record unavailable.')}
      <ul>${evidence(view, criterion)}</ul></article>`).join('')}</section>
    <section id="briefs"><h2>Worker briefs → plan tasks</h2>${item.assignments.map((assignment) => `<article><h3>${recordLink(projectId, assignment, `Assignment ${assignment.id}`)}</h3>
      <p>Attempt: ${h(assignment.attemptId)} · Execution task: ${h(assignment.firstMateTaskId)}</p><p>Derived from ${recordLink(projectId, assignment.detailedPlanTask, 'Detailed plan task')} in ${recordLink(projectId, assignment.plan, 'Plan')} and ${recordLink(projectId, assignment.design, 'Design')}.</p>
      <p>${sameRef(assignment.plan, item.displayPlan) && sameRef(assignment.design, item.displayDesign) && sameRef(assignment.feature, item.feature) ? 'Current referenced revisions' : 'Stale — assignment references earlier product revisions'}. Fidelity: ${h(assignment.instructionFidelity.result)}</p>
      <details><summary>Read worker instructions</summary><pre>${h(assignment.instructionText)}</pre></details><p>Original requests: ${links(projectId, item.feature.sourceRequests)}</p></article>`).join('') || empty('Unknown — no assignments recorded.')}</section>
    <section><h2>Task progress</h2>${taskRows(item, view.options.canCancelTasks)}</section><section id="changes"><h2>Decisions & changes</h2>
      ${item.decisions.map((decision) => `<article><h3>${recordLink(projectId, decision, decision.questionOrChange)}</h3><p>${h(decision.disposition)}${decision.choice ? ` · ${h(decision.choice.state)}` : ''}</p>${text(decision.rationale)}<p>Affected records: ${links(projectId, decision.affectedRecords)}</p></article>`).join('') || empty('No linked decisions recorded.')}
      <h2>Corrections</h2><p>Active feature revision: ${recordLink(projectId, item.feature)}</p>${item.corrections.map((observation) => {
        const correction = observation.correction!;
        const assignment = view.history.find((record) => sameRef(record, correction.assignment));
        return `<article><h3>${recordLink(projectId, observation)}</h3><blockquote>${h(correction.originalText)}</blockquote><p>Affected revision: ${recordLink(projectId, correction.affectedRevision)} · ${correction.supersededBy ? 'Superseded' : 'Active correction'}</p>
          <p>Affected assignment: ${recordLink(projectId, correction.assignment)} · Attempt: ${h(assignment?.kind === 'assignment' ? assignment.attemptId : 'Unknown')}</p>
          <p>Other affected attempts: ${links(projectId, correction.impact?.assignments ?? [])}</p>
          <p>Delivery facts: ${h(correction.facts.map((fact) => `${fact.fact} at ${fact.at}`).join('; '))}</p>
          <p>Earlier recipients: ${h(correction.deliveryHistory?.map((snapshot) => snapshot.recipient.attemptId).join(', ') || 'None recorded')}</p></article>`;
      }).join('') || empty('No corrections recorded.')}<h2>Feature revision history</h2><p>${links(projectId, view.history.filter((record) => record.id === item.feature.id))}</p></section>`);
}
export function renderRecord(view: ProjectView, record: FactoryRecord) {
  const related = relatedRefs(record);
  const currentDecision = record.kind === 'decision_change' ? view.records.find((entry) => entry.id === record.id) : undefined;
  const guidance = record.kind === 'guidance_revision' ? view.learning.guidance.find((item) => sameRef(item.record, record)) : undefined;
  const contexts = view.features.filter((item) => {
    const records = [item.feature, ...item.designs, ...item.plans, ...item.assignments, ...item.decisions, ...item.corrections,
      ...item.tasks.map((task) => task.mapping), ...item.tasks.flatMap((task) => task.operation ? [task.operation] : []),
      ...item.criteria.flatMap((criterion) => [criterion.target, ...criterion.results]), ...item.feature.sourceRequests];
    return record.kind === 'project' || records.some((entry) => entry.id === record.id || related.some((target) => target.id === entry.id));
  });
  return shell(view, record.id, `<a href="/">All features</a><h1>${h(record.id)} <span class="revision">r${record.revision}</span></h1>
    <p>${h(record.kind)} · Recorded ${h(record.updatedAt)}</p>
    ${guidance ? `<p class="state">${guidance.active ? 'Current guidance' : guidance.replacements.length ? 'Superseded guidance' : 'Inactive guidance'}</p>
      ${guidance.replacements.length ? `<p>Replaced by: ${links(view.options.projectId, guidance.replacements)}</p>` : ''}<p><a href="/projects/${enc(view.options.projectId)}/learning#guidance">Guidance scope and history</a></p>` : ''}
    ${record.kind === 'decision_change' && record.choice?.kind === 'product' && record.choice.state === 'open' ? currentDecision?.kind === 'decision_change' && currentDecision.choice?.state === 'resolved' ? `<p>${recordLink(view.options.projectId, currentDecision, 'Saved answer')}</p>` : `<p><a href="/projects/${enc(view.options.projectId)}/decisions#question-${enc(record.id)}">Answer in context</a></p>` : ''}
    <h2>Original requests & related features</h2>
    ${contexts.map((item) => `<p><a href="${featureUrl(view.options.projectId, item.feature.id)}">${h(item.feature.outcome)}</a> · ${links(view.options.projectId, item.feature.sourceRequests)}</p>`).join('') || empty('Unknown — no related feature has been linked.')}
    <h2>Related work, sources & evidence records</h2><p>${links(view.options.projectId, relatedRefs(record))}</p><h2>Revision history</h2>
    <p>${links(view.options.projectId, view.history.filter((entry) => entry.id === record.id))}</p><h2>Canonical record</h2><p><a href="${recordUrl(view.options.projectId, record, false)}">Read JSON</a></p><pre>${h(JSON.stringify(record, null, 2))}</pre>`);
}

function decisionRows(view: ProjectView) {
  const projectId = view.options.projectId;
  return view.questions.map(({ decision, affected, context, currentContext, requests, answers, answerConflict }) => `<article class="question" id="question-${h(decision.id)}">
    <h3>${recordLink(projectId, decision, decision.questionOrChange)}</h3><p class="state">Open product question</p>${text(decision.rationale)}
    <p>Affects: ${links(projectId, decision.affectedRecords)}</p>
    ${requests.map((request) => `<details><summary>Original request · ${h(request.id)} r${request.revision}</summary><blockquote>${h(request.originalText)}</blockquote>${recordLink(projectId, request)}</details>`).join('') || empty('Unknown — no original request link resolves.')}
    ${context.map((item) => `<p>Affected feature revision: ${recordLink(projectId, item.feature, item.feature.outcome)}</p>
      <p>Criteria: ${item.criteria.map(({ target, record }) => recordLink(projectId, target, record?.kind === 'criterion' ? record.expectedBehavior : 'Unknown criterion')).join(' · ')} · Related work: ${links(projectId, item.tasks)}</p>`).join('')}
    ${affected.map((record) => record.kind === 'criterion' ? text(record.expectedBehavior) : '').join('')}
    ${currentContext.map((item) => `<p>Current feature context (separate from this question): ${recordLink(projectId, item.feature, item.feature.outcome)} · <a href="${featureUrl(projectId, item.feature.id)}">Review current feature</a> · Related current work: ${links(projectId, item.tasks)}</p>`).join('')}
    ${answerConflict ? '<p class="state">Unresolved conflict — matching previous answers disagree. Inspect decision history before answering.</p>' : ''}
    ${answers.length ? `<p>Existing answer available for the same question and affected revisions:</p>${text(answers[0]!.answer!.text)}
      <p>Source: ${links(projectId, answers)}</p>${edit({ kind: 'answer', decision, reuse: answers[0]! }, 'Use existing answer', empty('Reuse records the source answer in this decision revision.'))}` : ''}
    ${edit({ kind: 'answer', decision }, 'Answer product question', field('answer', 'Product answer', ''))}
    </article>`).join('') || empty('No material product questions need input.');
}
export function renderDecisions(view: ProjectView) {
  const projectId = view.options.projectId;
  const resolved = view.records.filter((record): record is Extract<FactoryRecord, { kind: 'decision_change' }> => record.kind === 'decision_change' && record.choice?.kind === 'product' && record.choice.state === 'resolved');
  return shell(view, 'Needs input', `<h1>Product questions needing input</h1>
    ${text('Answer choices that affect the requested product outcome. Routine implementation continues through the existing work process.')}
    <section><h2>Open questions</h2>${decisionRows(view)}</section>
    <section><h2>Existing answers</h2>${resolved.map((decision) => `<article><h3>${recordLink(projectId, decision, decision.questionOrChange)}</h3>${decision.answer ? text(decision.answer.text) : `<p>Legacy decision — no explicit answer recorded</p>${decision.originalInstruction ? text(decision.originalInstruction) : ''}${text(`Rationale: ${decision.rationale}`)}`}
      <p>Affected revisions: ${links(projectId, decision.affectedRecords)}</p>${decision.answer?.reusedFrom ? `<p>Reused from: ${recordLink(projectId, decision.answer.reusedFrom)}</p>` : ''}</article>`).join('') || empty('No resolved product answers recorded.')}</section>
    <section><h2>Technical questions · work context</h2>${view.input.filter((decision) => decision.choice?.kind === 'technical').map((decision) => `<p>${recordLink(projectId, decision, decision.questionOrChange)} — implementation question, handled with its work.</p>`).join('') || empty('No open technical questions recorded.')}</section>`);
}
export function renderLearning(view: ProjectView) {
  const projectId = view.options.projectId;
  const learning = view.learning;
  const sources = (values: { uri: string; record?: Ref | undefined }[]) => values.map((source) => source.record ? recordLink(projectId, source.record) : external(source.uri)).join(' · ');
  const scope = (record: Extract<FactoryRecord, { kind: 'guidance_revision' | 'observation' }>) => record.learning ?
    `${record.learning.scope.kind === 'project' ? 'Project' : `Feature ${record.learning.scope.featureId}`} · topic ${record.learning.topic}` :
    record.kind === 'guidance_revision' ? view.learning.guidance.find((item) => sameRef(item.record, record))?.contexts.join(' · ') || 'Unknown legacy scope' : 'Unclassified legacy scope';
  const observation = (record: Extract<FactoryRecord, { kind: 'observation' }>) => `<article><h3>${recordLink(projectId, record, record.finding)}</h3>
    <p>${h(record.consolidationState)} · ${h(scope(record))}</p><p>Scope sources: ${sources(record.affectedScope)}</p>
    ${record.proposedGeneralization ? text(`Possible lesson: ${record.proposedGeneralization}`) : ''}
    ${record.evidence.map((entry) => `<p>Evidence: ${h(entry.description)} · ${h(entry.observedAt)} · ${external(entry.artifact.uri)} @ ${h(entry.artifact.revision ?? entry.artifact.digest)}</p>`).join('') || empty('Missing evidence — no evidence recorded.')}</article>`;
  const identities = [...new Map([{ scope: { kind: 'project' as const }, topic: 'general' },
    ...view.features.map((item) => ({ scope: { kind: 'feature' as const, featureId: item.feature.id }, topic: 'general' })),
    ...learning.identities].map((identity) => [JSON.stringify(identity), identity])).values()];
  const standing = edit({ kind: 'standing-instruction', projectId, identities, guidance: learning.active }, 'Record explicit standing instruction',
    '<p>This instruction applies immediately in the selected scope. It replaces current guidance with the same topic in that scope; project instructions also replace inferred feature rules for that topic. Explicit feature overrides remain.</p>' +
    `<label>Scope and existing topic<select name="identity">${identities.map((identity) => `<option value="${h(JSON.stringify(identity))}">${h(identity.scope.kind === 'project' ? 'Project' : `Feature ${identity.scope.featureId}`)} · ${h(identity.topic)}</option>`).join('')}</select></label>` +
    field('topic', 'New topic (optional; otherwise use selected topic)', '', 'text') + field('instruction', 'Explicit standing instruction', '') +
    field('evidenceUri', 'Evidence source', '', 'text') + field('evidenceRevision', 'Evidence revision or digest', '', 'text'));
  const run = learning.lastRun;
  return shell(view, 'Learning', `<h1>Observations and guidance</h1>
    <nav class="section-nav" aria-label="Learning sections"><a href="#inbox">Observation inbox</a><a href="#conflicts">Conflicts</a><a href="#guidance">Guidance and history</a><a href="#consolidation">Last consolidation</a></nav>
    <p>${h(learning.scheduleState)}</p><p>Next consolidation window: ${learning.nextWindow ? `${h(learning.nextWindow.scheduledFor)} · ${h(learning.nextWindow.id)}` : 'Unknown'}</p>
    <section id="inbox"><h2>Observation inbox</h2>${learning.pending.map(observation).join('') || empty('No pending observations.')}<p>Inferred lessons stay pending until consolidation evaluates their evidence and scope.</p></section>
    <section id="conflicts"><h2>Unresolved conflicts</h2>${learning.conflicts.map(observation).join('')}
    ${learning.guidanceConflicts.map((record) => `<article><h3>${recordLink(projectId, record, record.text)}</h3><p>${h(scope(record))}</p>${items(record.unresolvedConflicts)}</article>`).join('')}
    ${!learning.conflicts.length && !learning.guidanceConflicts.length ? empty('No unresolved learning conflicts recorded.') : ''}</section>
    <section id="guidance"><h2>Current guidance</h2>${learning.active.map((record) => `<article><h3>${recordLink(projectId, record, record.text)}</h3><p>Current · ${h(scope(record))} · ${h(record.learning?.authority ?? 'legacy authority')}</p>
      <p>Applies in worker context: ${h(learning.guidance.find((item) => sameRef(item.record, record))?.contexts.join(' · '))}</p>${text(record.applicability)}<p>Scope sources: ${sources(record.scope)}</p><p>Supporting observations: ${links(projectId, record.supportingObservations)}</p></article>`).join('') || empty('No active guidance recorded.')}
      ${standing}<h3>Revision and supersession history</h3>
      ${learning.guidance.map(({ record, replacements, active }) => `<article><h4>${recordLink(projectId, record, record.text)}</h4><p>${active ? 'Current' : replacements.length ? 'Superseded' : 'Inactive — scope unknown or unresolved conflict'} · ${h(scope(record))}</p>
      ${replacements.length ? `<p>Replaced by: ${links(projectId, replacements)}</p>` : ''}<p>Supersedes: ${links(projectId, record.supersededGuidance)}</p><p>Supporting observations: ${links(projectId, record.supportingObservations)}</p></article>`).join('') || empty('No guidance history recorded.')}</section>
    <section id="consolidation"><h2>Last consolidation diff</h2>${run ? `<p>${recordLink(projectId, run)} · Window ${h(run.scheduledWindowId)} · ${h(run.scheduledFor)} · ${h(run.timezone)}</p>
      ${run.verdict.decisions.map((decision) => `<article><h3>${h(decision.outcome)} · ${h(decision.groupId)}</h3>${text(decision.rationale)}<p>Observations: ${links(projectId, decision.observationRefs)}</p><p>Replaced guidance: ${links(projectId, decision.guidanceRefs)}</p>${decision.text ? text(`After: ${decision.text}`) : ''}</article>`).join('')}
      <h3>Guidance before this run</h3>${learning.before?.map((record) => `<p>Before: ${recordLink(projectId, record, record.text)}</p>`).join('') || empty('No active guidance before this run.')}
      <h3>Guidance written by this run</h3>${learning.after === undefined ? empty('Unknown — this imported run has no mutation receipt; consult the saved verdict above.') : learning.after.map((record) => `<p>After: ${recordLink(projectId, record, record.text)}</p>`).join('') || empty('No guidance changes.')}
      ${run.sectionDiffs.map((diff) => `<h3>${h(diff.source.heading)}</h3><pre>${h(diff.diff)}</pre>`).join('')}` : empty('Unknown — no successful consolidation run recorded.')}</section>`);
}
