import type { Ref } from './primitives.js';
import type { FactoryRecord, DetailedPlanTask } from './records.js';
import type { EditContext } from './ui-edit.js';
import { relatedRefs, sameRef, type FeatureView, type ProjectView } from './ui-state.js';

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
    <body><a class="skip" href="#main">Skip to content</a><header><a class="brand" href="/">Software Factory</a><nav aria-label="Main"><a href="/">Features</a>
    ${view.options.scottyUrl && /^https?:\/\//u.test(view.options.scottyUrl) ? `<a href="${h(view.options.scottyUrl)}" rel="noreferrer">Scotty execution list</a>` : '<span>Scotty link not configured</span>'}</nav></header>
    <main id="main"><div class="notice">${view.options.fixture ? 'Fixture mode — all requests, task observations and evidence are synthetic.' : 'Local project records'}
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
function taskRows(feature: FeatureView) {
  return feature.tasks.map((item) => {
    const mapping = item.mapping;
    const context = { kind: 'task' as const, mapping };
    const operation = item.operation?.kind === 'operation' ? item.operation : undefined;
    return `<article class="task-row"><h3>${h(item.task?.title ?? mapping.firstMateTaskId)}</h3><p>${h(item.label)}${item.observedAt ? ` · ${h(item.observedAt)}` : ''}</p>
      <p>Task progress: ${h(item.task?.state ?? 'Unknown')}. Feature completeness: ${h(feature.completeness)}.</p>
      <p>Priority: ${h(item.priority ?? 'Unknown')} · Dependencies: ${h(mapping.dependencies.join(', ') || 'None recorded')} · ${mapping.management?.paused ? 'Deferred — toolkit pause' : 'No toolkit pause recorded'}</p>
      ${mapping.disposition.state !== 'active' ? text(`${mapping.disposition.state}: ${mapping.disposition.reason}`) : ''}
      ${item.task?.hold ? text(`Held: ${item.task.hold.reason}`) : ''}${item.task?.blocked_by.length ? text(`Blocked by: ${item.task.blocked_by.join(', ')}`) : ''}
      <p>${recordLink(mapping.projectId, mapping)} · Plan task: ${mapping.detailedPlanTask ? recordLink(mapping.projectId, mapping.detailedPlanTask) : 'Unknown — legacy mapping'}
      ${operation ? ` · ${recordLink(mapping.projectId, operation, 'Operation and observation evidence')}` : ''}</p>
      <p>Original requests: ${links(mapping.projectId, feature.feature.sourceRequests)} · Related briefs: ${links(mapping.projectId, feature.assignments.filter((assignment) => assignment.firstMateTaskId === mapping.firstMateTaskId))}</p>
      ${operation && operation.state !== 'succeeded' && !operation.taskRejection?.beforeMutation ? empty('Edits unavailable — inspect and reconcile the saved operation first.') : edit({ ...context, action: 'set_priority' }, 'Edit task priority', field('priority', 'Task priority (0–4)', item.priority ?? '', 'number'))}
      ${operation && operation.state !== 'succeeded' && !operation.taskRejection?.beforeMutation ? '' : edit({ ...context, action: 'edit_dependencies' }, 'Edit task dependencies', field('dependencies', 'Prerequisite logical task IDs (comma separated)', mapping.dependencies.join(', '), 'text'))}
      ${operation && operation.state !== 'succeeded' && !operation.taskRejection?.beforeMutation ? '' : edit({ ...context, action: mapping.management?.paused ? 'resume' : 'pause' }, mapping.management?.paused ? 'Resume task' : 'Defer task (indefinite pause)', empty('Dated holds use the existing FirstMate hold operation.'))}
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
    <section><h2>Decisions needing input</h2>${view.input.map((decision) => `<p>${recordLink(view.options.projectId, decision, decision.questionOrChange)} — Open ${h(decision.choice?.kind)} question. ${h(decision.rationale)}</p>`).join('') || empty('No open decisions recorded.')}</section>
    <section><h2>Work and input needed</h2>${view.features.map((feature) => `<h3><a href="${featureUrl(view.options.projectId, feature.feature.id)}">${h(feature.feature.outcome)}</a></h3>${taskRows(feature)}`).join('')}</section>`);
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
  const base = feature.editBundle;
  const context = base && design ? { feature: feature.feature, ...base,
    expectedRevisions: [feature.feature, base.design, base.plan, ...base.tasks].map((record) => {
      const head = view.records.find((candidate) => candidate.id === record.id) ?? record;
      return { id: head.id, revision: head.revision };
    }),
    criterionMap: feature.stages.filter((stage) => sameRef(stage.feature, feature.feature)).flatMap((stage) => stage.reuse?.criterionMap ?? []),
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
    <section><h2>Stage progress</h2><p>Recorded feature stage: ${h(item.feature.methodStage)}</p>${named ? empty('Named bundle inspection does not change stage selections.') : item.stages.map((stage) => `<p>${recordLink(projectId, stage, stage.stage)} → ${recordLink(projectId, stage.artifact)} · ${sameRef(stage.feature, item.feature) ? 'Current feature revision' : 'Stale — earlier feature revision'} · ${h(stage.changeReason)}</p>`).join('') || empty('Unknown — stage history not recorded.')}</section>
    ${artifacts(view, item)}<section id="criteria"><h2>Criteria & evidence</h2><p>Evidence for displayed bundle: ${scope}.</p>${item.criteria.map((criterion) => `<article class="criterion"><h3>${recordLink(projectId, criterion.target, criterion.criterion?.kind === 'criterion' ? criterion.criterion.expectedBehavior : criterion.target.id)}</h3>
      <p class="state">${h(criterion.label)}</p>${criterion.criterion?.kind === 'criterion' ? `<p>${h(criterion.criterion.requirement)} · ${h(criterion.criterion.disposition.state)} · Verify: ${h(criterion.criterion.verificationMethod)}</p>
      ${edit({ kind: 'criterion', feature: item.feature, criterion: criterion.criterion }, 'Edit criterion', field('expectedBehavior', 'Expected behavior', criterion.criterion.expectedBehavior) + field('verificationMethod', 'Verification method', criterion.criterion.verificationMethod))}` : empty('Unknown — criterion record unavailable.')}
      <ul>${evidence(view, criterion)}</ul></article>`).join('')}</section>
    <section id="briefs"><h2>Worker briefs → plan tasks</h2>${item.assignments.map((assignment) => `<article><h3>${recordLink(projectId, assignment, `Assignment ${assignment.id}`)}</h3>
      <p>Attempt: ${h(assignment.attemptId)} · Execution task: ${h(assignment.firstMateTaskId)}</p><p>Derived from ${recordLink(projectId, assignment.detailedPlanTask, 'Detailed plan task')} in ${recordLink(projectId, assignment.plan, 'Plan')} and ${recordLink(projectId, assignment.design, 'Design')}.</p>
      <p>${sameRef(assignment.plan, item.plan) && sameRef(assignment.design, item.design) && sameRef(assignment.feature, item.feature) ? 'Current referenced revisions' : 'Stale — assignment references earlier product revisions'}. Fidelity: ${h(assignment.instructionFidelity.result)}</p>
      <details><summary>Read worker instructions</summary><pre>${h(assignment.instructionText)}</pre></details><p>Original requests: ${links(projectId, item.feature.sourceRequests)}</p></article>`).join('') || empty('Unknown — no assignments recorded.')}</section>
    <section><h2>Task progress</h2>${taskRows(item)}</section><section id="changes"><h2>Decisions & changes</h2>
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
  const contexts = view.features.filter((item) => {
    const records = [item.feature, ...item.designs, ...item.plans, ...item.assignments, ...item.decisions, ...item.corrections,
      ...item.tasks.map((task) => task.mapping), ...item.tasks.flatMap((task) => task.operation ? [task.operation] : []),
      ...item.criteria.flatMap((criterion) => [criterion.target, ...criterion.results]), ...item.feature.sourceRequests];
    return record.kind === 'project' || records.some((entry) => entry.id === record.id || related.some((target) => target.id === entry.id));
  });
  return shell(view, record.id, `<a href="/">All features</a><h1>${h(record.id)} <span class="revision">r${record.revision}</span></h1>
    <p>${h(record.kind)} · Recorded ${h(record.updatedAt)}</p><h2>Original requests & related features</h2>
    ${contexts.map((item) => `<p><a href="${featureUrl(view.options.projectId, item.feature.id)}">${h(item.feature.outcome)}</a> · ${links(view.options.projectId, item.feature.sourceRequests)}</p>`).join('') || empty('Unknown — no related feature has been linked.')}
    <h2>Related work, sources & evidence records</h2><p>${links(view.options.projectId, relatedRefs(record))}</p><h2>Revision history</h2>
    <p>${links(view.options.projectId, view.history.filter((entry) => entry.id === record.id))}</p><h2>Canonical record</h2><p><a href="${recordUrl(view.options.projectId, record, false)}">Read JSON</a></p><pre>${h(JSON.stringify(record, null, 2))}</pre>`);
}
