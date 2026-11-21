// Shared full-feature fixture: all agents are local canned processes, never providers.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { z } from 'zod';
import { RecordsSchema, ref, recordSource, runFeature, stableId, FeatureRunConfigSchema } from '../src/index.js';
import { fakeRuntime } from './runtime-helper.js';
import { fakeTaskWrapper } from './task-wrapper-helper.js';
const at = '2026-11-11T18:00:00Z';
const defaultOriginal = 'Build feature X for every connected system, ERPNext is only an example.';
const goodCode = 'export function feature(system) { return system.featureX(); }\n';
export const unrequestedOption = 'export const providerTimeout = 180_000;';
export const unrequestedTest = 'export const futureTimeoutTest = () => providerTimeout > 0;';
export const unchangedReviewLine = 'export const unchangedProof = true;';
const badCode = 'export function feature(system) { if (system.name !== "ERPNext") throw Error("unsupported"); return system.featureX(); }\n';
const baseline = RecordsSchema.parse(JSON.parse(readFileSync(new URL('../../fixtures/workflow.json', import.meta.url), 'utf8')));
const script = fileURLToPath(new URL('../../scripts/worker-start-before.mjs', import.meta.url));

export function scenario(options: { bootstrap: boolean; originalRequest?: string; twoTasks?: boolean; factoryLayout?: boolean; independentBranch?: boolean; existingCode?: boolean } = { bootstrap: true }) {
  const original = options.originalRequest ?? defaultOriginal;
  const root = mkdtempSync(join(tmpdir(), 'sf-milestone-'));
  const save = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value, null, 2));
  const executable = (name: string, body: string) => {
    const path = join(root, name); writeFileSync(path, `#!${process.execPath}\n${body}`, { mode: 0o755 }); return path;
  };
  const home = join(root, 'home'); const data = join(home, 'data'); const repository = join(root, 'sample');
  mkdirSync(join(home, 'config'), { recursive: true }); mkdirSync(data); mkdirSync(repository);
  const git = (...args: string[]) => execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Test');
  writeFileSync(join(repository, 'baseline.txt'), 'Feature X absent.');
  if (options.existingCode) writeFileSync(join(repository, 'connection.mjs'), 'export function connect(system) { return system.connection; }\n');
  git('add', '.'); git('-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'Baseline');
  const before = git('rev-parse', 'HEAD');
  const database = options.factoryLayout ? join(data, 'software-factory/projects/project-1/project.sqlite') : join(root, 'project.sqlite'); const runDirectory = join(root, 'run');
  const requestFile = join(root, 'request.txt'); writeFileSync(requestFile, original);
  const request = { id: stableId('request', 'project-1', 'milestone'), revision: 1 };
  const feature = { id: 'feature-1', revision: 1 };
  const criteria = [{ id: 'criterion-general', revision: 1 }, { id: 'criterion-second-system', revision: 1 },
    ...(options.independentBranch ? [{ id: 'criterion-independent', revision: 1 }] : [])];
  const base = { schemaVersion: 1, projectId: 'project-1', revision: 1, createdAt: at, updatedAt: at };
  const comparison = (refs: { id: string; revision: number }[]) => ({ result: 'passed', sourceRefs: refs.map(recordSource),
    findings: [], reviewerSession: 'fake-source-analyst', comparedAt: at });
  const scope = [{ request, term: 'ERPNext', coverage: 'general' }];
  const understanding = { ...base, kind: 'understanding_revision', id: 'understanding', feature, sourceRequests: [request], criteria,
    goal: original, userBehavior: 'Use feature X with every system', terms: {}, priorities: [], examples: ['ERPNext'], exclusions: [],
    existingWork: [{ source: { uri: requestFile }, finding: 'Common interface exists' }], openUnknowns: [],
    scope: [{ request, term: 'ERPNext', role: 'example' }], changeReason: 'Research supplied sources' };
  const design = { ...baseline.find((record) => record.kind === 'design_revision')!, sourceRefs: [recordSource(request)],
    sourceComparison: comparison([request]), workflow: { understanding: ref(understanding),
      reuse: { alreadyWorks: 'Connection interface', gap: 'Feature X absent', change: 'Extend common interface' }, scope, changeReason: 'Design feature' } };
  const draft = { ...base, kind: 'detailed_plan_task', id: 'task-1', feature, design: ref(design),
    plan: { id: 'plan-1', revision: 1 }, criteria, draft: true };
  const plan = { ...baseline.find((record) => record.kind === 'implementation_plan_revision')!, readiness: { ready: false, comparison: comparison([request, design]) },
    workflow: { slices: [{ id: 'slice-1', behavior: original, criteria, tasks: [ref(draft)] }], scope,
      integrationSteps: ['Connect common interface'], finalVerification: ['Exercise ERPNext and another system'], retainedTasks: [], changeReason: 'Plan delivery' } };
  const task = { ...baseline.find((record) => record.kind === 'detailed_plan_task')!, ...base, revision: 2, draft: false,
    plan: { id: plan.id, revision: 2 }, designRefs: [recordSource(design)], reuseTargets: [{ uri: requestFile }],
    verificationMethod: 'Exercise both systems', decisionsToKeep: [] };
  const detailed = { ...plan, revision: 2, deliverySequence: [ref(task)], workflow: { ...plan.workflow,
    slices: [{ ...plan.workflow.slices[0]!, tasks: [ref(task)] }] } };
  const stage = (name: string, artifact: { id: string; revision: number }, previous?: string) => ({ ...base, kind: 'stage_revision',
    id: `stage-${name}`, stage: name, feature, sourceRequests: [request], criteria, artifact: ref(artifact),
    changeReason: name, ...(previous ? { previousStage: { id: `stage-${previous}`, revision: 1 } } : {}) });
  const input = (stage: unknown, records: unknown[]) => ({ idempotencyKey: `stage-${(stage as { stage: string }).stage}`,
    expectedRevision: 0, issuedAt: at, stage, records });
  const outputs = {
    understand: { mapping: { projectId: 'project-1', requestId: request.id, expectedRevision: 1, idempotencyKey: 'map-feature', issuedAt: at,
      start: 0, end: original.length, rationale: 'Preserve general feature', target: { kind: 'new_feature', feature: {
        id: feature.id, outcome: original, criteria: criteria.map((criterion) => ({ id: criterion.id,
          expectedBehavior: 'Feature X through the common interface', verificationMethod: 'Exercise connected-system fixtures' })) } } },
    input: input(stage('understand', understanding), [understanding]) },
    design: input(stage('design', design, 'understand'), [design]),
    plan: input(stage('plan', plan, 'design'), [plan, draft]),
    detail: input(stage('detail', detailed, 'plan'), [detailed, task]),
  };
  if (options.twoTasks || options.independentBranch) {
    // Split criteria between producer and consumer while preserving full feature scope.
    const draft2 = { ...draft, id: 'task-2', criteria: [criteria[1]!] };
    draft.criteria = [criteria[0]!];
    const task2 = { ...task, id: 'task-2', criteria: [criteria[1]!] };
    task.criteria = [criteria[0]!];
    const edge = { prerequisiteTaskId: task.id, consumerTaskId: task2.id,
      reason: 'The second system uses the shared interface', needs: { kind: 'criterion' as const, criterion: criteria[0]! } };
    for (const [stagePlan, first, second] of [[plan, draft, draft2], [detailed, task, task2]] as const) {
      stagePlan.deliverySequence = [ref(first), ref(second)];
      stagePlan.dependencies = [edge];
      stagePlan.workflow.slices[0]!.tasks = [ref(first), ref(second)];
    }
    outputs.plan.records.push(draft2); outputs.detail.records.push(task2);
    if (options.independentBranch) {
      const draft3 = { ...draft, id: 'task-3', criteria: [criteria[2]!] };
      const task3 = { ...task, id: 'task-3', criteria: [criteria[2]!] };
      plan.deliverySequence.push(ref(draft3)); detailed.deliverySequence.push(ref(task3));
      plan.workflow.slices[0]!.tasks.push(ref(draft3)); detailed.workflow.slices[0]!.tasks.push(ref(task3));
      outputs.plan.records.push(draft3); outputs.detail.records.push(task3);
    }
  }
  save(join(root, 'outputs.json'), outputs); save(join(root, 'mode.json'), { narrow: false, badDelivery: false, planFailure: false });
  const agent = executable('agent.mjs', `import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync,appendFileSync,copyFileSync,writeFileSync} from 'node:fs';
const root=${JSON.stringify(root)};
const args=process.argv.slice(2); const step=args[args.indexOf('--model')+1];
const prompt=readFileSync(0,'utf8'); const files=JSON.parse(prompt.trimEnd().split('\\n').at(-1));
const snapshot=JSON.parse(readFileSync(files.evidence,'utf8'));
const mode=JSON.parse(readFileSync(root+'/mode.json','utf8'));
assert.equal(args.includes('--resume'),false);
assert.equal(Object.keys(process.env).some(k=>k.startsWith('FM_')||k==='CODEX_THREAD_ID'),false);
const sessionId = !args.includes('--json') ? undefined : args.includes('resume') ? args.at(-2) : randomUUID();
appendFileSync(root+'/agents.jsonl',JSON.stringify({step,pid:process.pid,args,prompt,sessionId,cwd:process.cwd()})+'\\n');
if(step===mode.failStep) {
 process.stderr.write('Agent diagnostic before exit.\\n');
 process.exit(17);
}
let out=JSON.parse(readFileSync(root+'/outputs.json','utf8'))[step];
// This scenario authors records after capture; other tests' fixed fixtures stay unchanged.
if(out && snapshot.request) out=JSON.parse(JSON.stringify(out).replaceAll(${JSON.stringify(at)},new Date(Date.parse(snapshot.request.capturedAt)+1).toISOString()).replaceAll(${JSON.stringify(request.id)},snapshot.request.id).replaceAll(${JSON.stringify(requestFile)},snapshot.request.source.uri));
if(step==='detail' && snapshot.findings) out=snapshot.instructionText ? mode.specEdits ?? [] :
 {plan:{},tasks:[{id:snapshot.tasks[0].id,changes:{expectedBehavior:'Correct scope for all connected systems, revision '+snapshot.plan.revision}}]};
if(step==='detail' && mode.reviseTitles && snapshot.findings && !snapshot.instructionText) {
 assert.deepEqual(JSON.parse(readFileSync(root+'/fake-state.json','utf8')).calls,[]);
 assert.deepEqual(snapshot.findings.map(finding=>finding.title),['Project Leap','Phase 1']);
 out={plan:{ticketTitle:'Export invoices from all connected systems'},
  tasks:[{id:snapshot.tasks[0].id,changes:{expectedBehavior:'Export invoice records using the shared report'}}]};
}
if(step==='detail' && mode.ticketAtPlanReview && !snapshot.findings) {
 const path=root+'/fake-state.json';
 const native=JSON.parse(readFileSync(path,'utf8'));
 native.tasks[mode.ticketAtPlanReview.id].body=mode.ticketAtPlanReview.text;
 writeFileSync(path,JSON.stringify(native));
}
if(step==='plan_check') out=mode.planFailure || (mode.reviseOnce && snapshot.plan.revision===2) ?
 {verdict:'fail',findings:[{type:'narrowing',message:'ERPNext example became the full scope',quotes:[{source:'original_request',text:${JSON.stringify(original)}}]}]} :
 {verdict:'pass',findings:[]};
if(step==='plan_check') out.titleFindings=mode.reviseTitles ? snapshot.ticketTitles
 .filter(ticket=>['Project Leap','Phase 1'].includes(ticket.title))
 .map(ticket=>({id:ticket.id,reason:'The title omits invoice export'})) : [];
if(step==='plan_check' && mode.ticketAtPlanReview) {
 assert.deepEqual(snapshot.currentTicket,mode.ticketAtPlanReview);
 assert.deepEqual(snapshot.authority,[mode.confirmedDone]);
}
if(step==='plan_check' && mode.reviseOnce && snapshot.plan.revision===2) out.findings.push({
 type:'omission',message:'A reviewer suggested extra cleanup',quotes:[{source:'design',text:'Extra cleanup'}]
});
if(step==='instruction_check') {
 assert.ok(snapshot.originalRequests[0].text===${JSON.stringify(original)});
 if(mode.requirePreparationHold) {
   const native=JSON.parse(readFileSync(root+'/fake-state.json','utf8'));
   assert.equal(native.tasks['milestone-worker'].held,true,'task became runnable before instruction check');
 }
 if(mode.removeHookDuringCheck) { const fs=await import('node:fs'); fs.rmSync(${JSON.stringify(join(home, 'config', 'hooks.json'))}); }
 out={verdict:'pass',findings:[]};
 if(mode.instructionOmission && !snapshot.candidateInstructions.includes(mode.instructionOmission)) out={verdict:'fail',findings:[
   {type:'omission',message:'Connected systems verification is missing',quotes:[{source:'original_request',text:snapshot.originalRequests[0].text}]}
 ]};
 if(mode.narrow && snapshot.candidateInstructions.includes('Implement feature X for ERPNext only.')) { out={verdict:'fail',findings:[{type:'narrowing',message:'ERPNext example became the full scope',quotes:[{source:'instructions',text:'Implement feature X for ERPNext only.'}]}]}; }
}

if(step==='product_review') {
 if(mode.publishReturnDuringReview) copyFileSync(mode.publishReturnDuringReview.source,mode.publishReturnDuringReview.path);
 assert.equal(snapshot.originalRequests[0].text,${JSON.stringify(original)});
 const code=mode.badDelivery?${JSON.stringify(badCode)}:${JSON.stringify(goodCode)};
 const extra=mode.extraScope?${JSON.stringify([unrequestedOption, unrequestedTest])}:[];
 const productCommit=snapshot.deliveries[0].deliveredArtifact.revision;
 if(mode.verifyReviewRound) {
  const events=readFileSync(root+'/review-events.jsonl','utf8').trimEnd().split('\\n').map(JSON.parse);
  const inputs=events.filter(entry=>entry.phase==='launch'&&entry.commit===productCommit);
  assert.deepEqual(inputs.map(entry=>entry.reviewer).sort(),['code','scope']);
  assert.ok(!events.some(entry=>entry.phase==='collect'&&entry.commit===productCommit),'product must start before either quality result is collected');
  const diff=readFileSync(snapshot.deliveries[0].diffPath,'utf8');
  for(const input of inputs) assert.equal(input.patch,diff);
  if(mode.returnRevision===2) {
   assert.match(diff,/^\\+export function feature/m);
   assert.ok(!diff.includes(${JSON.stringify(unchangedReviewLine)}));
   assert.equal(snapshot.previousProductReview.commits[0],mode.previousCommit);
   assert.ok(snapshot.previousProductReview.findings.some(entry=>entry.message==='ERPNext only violates original generality'));
   assert.ok(snapshot.deliveredFiles.every(file=>!file.snapshotPath));
  } else {
   assert.ok(diff.includes(${JSON.stringify(unchangedReviewLine)}));
   assert.equal(snapshot.previousProductReview,undefined);
  }
  appendFileSync(root+'/review-events.jsonl',JSON.stringify({phase:'product',commit:productCommit})+'\\n');
 }
 if(!snapshot.previousProductReview) {
  assert.equal(readFileSync(snapshot.deliveredFiles.find(f=>f.path==='feature.mjs').snapshotPath,'utf8'),code+extra.map(x=>x+'\\n').join('')+
   (mode.verifyReviewRound?${JSON.stringify(unchangedReviewLine + '\n')}:''));
 }
 out={sourceComparison:'passed',instructionFidelity:mode.badDelivery?'failed':'passed',planConformance:mode.badDelivery?'failed':'passed',
 criteria:snapshot.assignedCriteria.map((criterion,i)=>({criterion,state:mode.badDelivery&&i===1?'failed':'accomplished',behavior:'Common interface behavior',quotes:[{source:'delivery',text:code.trim()}],limitations:[]})),
 findings:mode.badDelivery?['instructionFidelity','planConformance'].map(check=>({check,type:'narrowed_generality',message:'ERPNext only violates original generality',quotes:[{source:'original_request',text:${JSON.stringify(original)}},{source:'delivery',text:code.trim()}]})):[],suggestions:[],unresolvedQuestions:[]};
 if(mode.verifyReviewRound) {
  if(mode.returnRevision===2) out.criteria.shift();
  else out.criteria[0].quotes=[{source:'delivery',text:${JSON.stringify(unchangedReviewLine)}}];
 }
 if(mode.ticketAtProductReview) {
  assert.deepEqual(snapshot.currentTicket,mode.ticketAtProductReview);
  assert.deepEqual(snapshot.deliveries[0].confirmedDefinitionOfDone,[mode.confirmedDone]);
  const criterion=out.criteria.find(entry=>entry.criterion?.id==='criterion-second-system');
  assert.ok(criterion);
  criterion.quotes=[{source:'original_request',text:mode.reviewQuote}];
  if(mode.withdrawnProof) {
   criterion.state='out_of_scope';
   criterion.behavior='The current ticket withdrew the additional browser proof';
  } else {
   criterion.state='failed';
   out.planConformance='failed';
   out.findings=[{check:'planConformance',type:'missing_behavior',message:'The current ticket requires additional browser proof',quotes:criterion.quotes}];
  }
 }
 if(mode.productNote) out.findings.push({check:'planConformance',type:'unrequested_addition',disposition:'note',message:'Product observation',quotes:[{source:'delivery',text:code.trim()}]});
 if(mode.extraScope) {
  assert.deepEqual(snapshot.deliveries[0].confirmedDefinitionOfDone,[mode.confirmedDone]);
  const diff=readFileSync(snapshot.deliveries[0].diffPath,'utf8');
  for(const addition of extra) assert.ok(diff.includes('+'+addition));
  if(!mode.productAcceptsExtra) {
   if(mode.extrasBreakDone) out.planConformance='failed';
   out.findings=extra.map(addition=>({check:'planConformance',type:'unrequested_addition',disposition:mode.extrasBreakDone?'blocking':'note',message:addition,
     quotes:[{source:'delivery',text:addition}]}));
  }
 }
 out.findings=out.findings.map(finding=>({disposition:'blocking',...finding}));
}
if (sessionId) {
 writeFileSync(args[args.indexOf('--output-last-message')+1],JSON.stringify(out));
 process.stdout.write(JSON.stringify({type:'thread.started',thread_id:sessionId})+'\\n');
} else process.stdout.write(JSON.stringify(out));`);
  const profiles = Object.fromEntries(['understand', 'design', 'plan', 'detail', 'plan_check', 'instruction_check', 'product_review', 'build', 'learning_consolidation']
    .map((step) => [step, { harness: 'codex', provider: 'codex', model: step, effort: step.includes('check') || step === 'product_review' ? 'high' : 'medium' }]));
  const agentConfig = join(root, 'agents.json'); save(agentConfig, { schemaVersion: 1, projectId: 'project-1', steps: profiles, executables: { codex: agent } });
  const wrapper = fakeTaskWrapper(root, true, database);
  const brief = executable('brief.mjs', `import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import assert from 'node:assert/strict'; assert.equal(process.env.FM_HOME,${JSON.stringify(home)});
const path=(process.env.FM_DATA_OVERRIDE??${JSON.stringify(data)})+'/'+process.argv[2]; mkdirSync(path,{recursive:true});
writeFileSync(path+'/brief.md',readFileSync(${JSON.stringify(fileURLToPath(new URL('../../fixtures/firstmate-brief.md', import.meta.url)))},'utf8')+'\\nShip branch: fm/'+process.argv[2]+'\\n');`);
  const inbox = executable('inbox.mjs', `import {readFileSync} from 'node:fs'; import assert from 'node:assert/strict';
assert.equal(readFileSync(0,'utf8'),${JSON.stringify(original)});
process.stdout.write(JSON.stringify({schema:'fm-inbox-note.v1',outcome:'created',id:'note-1',request_id:process.argv[4],saved:true,announced:true,acknowledged:false,path:${JSON.stringify(join(data, 'note.md'))}}));`);
  const returnWorker = executable('return-worker.mjs', `import {readFileSync,writeFileSync} from 'node:fs'; import {execFileSync} from 'node:child_process'; import {dirname} from 'node:path';
const root=${JSON.stringify(root)}, repository=${JSON.stringify(repository)};
const taskId=process.argv[2]||'milestone-worker';
const {ProjectStore}=await import(${JSON.stringify(new URL('../src/index.js', import.meta.url).href)});
const store=new ProjectStore(${JSON.stringify(database)});
const assignment=store.records('project-1').find(r=>r.kind==='assignment'&&r.firstMateTaskId===taskId);store.close();
const run=dirname(assignment.returnLocation);
const mode=JSON.parse(readFileSync(root+'/mode.json','utf8')); const prepared={assignment:{id:assignment.id,revision:assignment.revision}};
const code=mode.badDelivery?${JSON.stringify(badCode)}:${JSON.stringify(goodCode)};
writeFileSync(repository+'/feature.mjs',code+(mode.verifyReviewRound?${JSON.stringify(unchangedReviewLine + '\n') }:'')+(mode.extraScope?${JSON.stringify(`${unrequestedOption}\n${unrequestedTest}\n`)}:''));
const git=(...a)=>execFileSync('git',['-C',repository,...a],{encoding:'utf8'}).trim();git('add','feature.mjs');git('-c','core.hooksPath=/dev/null','commit','--allow-empty','-qm','Fake worker delivery '+taskId);
if(mode.extraScope) git('-c','core.hooksPath=/dev/null','commit','--allow-empty','-qm','Finalize multi-commit delivery');
const artifact={uri:'git:'+repository,revision:git('rev-parse','HEAD')};
git('update-ref','refs/heads/fm/'+taskId,artifact.revision);
writeFileSync(run+'/worker-return.json',JSON.stringify({repository,deliveredArtifact:artifact,paths:['feature.mjs'],results:assignment.criteria.map((criterion,i)=>({
kind:'criterion_result',id:taskId+'-result-'+i,projectId:'project-1',schemaVersion:1,revision:mode.returnRevision??1,createdAt:${JSON.stringify(at)},updatedAt:${JSON.stringify(at)},
assignment:prepared.assignment,criterion,result:'passed',accomplishedBehavior:'Synthetic worker claims both systems work',artifact,
evidence:[{artifact,description:'Synthetic acceptance evidence',observedAt:${JSON.stringify(at)}}],limitations:[],suggestions:[]}))}));`);
  const hookRegistry = join(root, 'hook-projects.json');
  save(hookRegistry, { version: 1, projects: [{ home, projectId: 'project-1', database, agentConfig }] });
  const hookSettings = { version: 1, hooks: [{ id: 'software-factory', event: 'worker.start.before', argv: [script, hookRegistry], timeout_seconds: 300 }] };
  const spawn = executable('spawn.mjs', `import {readFileSync,writeFileSync} from 'node:fs';import {spawnSync} from 'node:child_process';import {createHash} from 'node:crypto';
const source=${JSON.stringify(data)}+'/'+process.argv[2]+'/brief.md';
const candidate=${JSON.stringify(data)}+'/'+process.argv[2]+'/launch-brief.md';
const mode=JSON.parse(readFileSync(${JSON.stringify(join(root, 'mode.json'))},'utf8'));
const text='# Current worker role contract\\nYou are a crewmate.\\n\\n'+readFileSync(source,'utf8')+(mode.narrow?'\\nImplement feature X for ERPNext only.\\n':'');writeFileSync(candidate,text);
writeFileSync(${JSON.stringify(join(root, 'spawn-args.json'))},JSON.stringify(process.argv.slice(2)));
const event={version:1,event:'worker.start.before',operation:'spawn',home:process.env.FM_HOME,project:process.argv[3],kind:'ship',task_id:process.argv[2],source_brief_path:source,brief_path:candidate,brief_sha256:createHash('sha256').update(text).digest('hex')};
const checked=spawnSync(${JSON.stringify(script)},[${JSON.stringify(hookRegistry)}],{input:JSON.stringify(event),encoding:'utf8'});
writeFileSync(${JSON.stringify(join(root, 'hook-result.json'))},checked.stdout||checked.stderr);
if(checked.status!==0) process.exit(1);
writeFileSync(${JSON.stringify(join(root, 'worker-started'))},'started');
if(mode.exposeWorkerGeneration) writeFileSync(${JSON.stringify(join(home, 'runtime.json'))},JSON.stringify([{
 id:process.argv[2],spawn_gen:'generation-1',project:process.argv[3],
 endpoint:{exists:true,agent_alive:'alive',freshness:'fresh',observed_at:''},
 current_state:{state:'active',freshness:'fresh',observed_at:''}
}]));
const worker=spawnSync(${JSON.stringify(returnWorker)},[process.argv[2]],{encoding:'utf8'});process.stderr.write(worker.stderr);process.exit(worker.status??1);`);
  executable('roborev', `import {appendFileSync,readdirSync,readFileSync,writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const root=${JSON.stringify(root)};
const mode=JSON.parse(readFileSync(root+'/mode.json','utf8'));
const [command,...args]=process.argv.slice(2);
const uuid='937a87c5-a027-4797-9d74-04d1538cb46c';
if(command==='run') {
 assert.deepEqual(args.slice(0,3),['--json','--no-context','--label']);
 const prompt=readFileSync(0,'utf8');
 const input=JSON.parse(prompt.split('\\n').at(-1));
 assert.match(input.commit,/^[a-f0-9]{40}$/);
 assert.ok(input.definitionOfDone.length);
 if(mode.extraScope) assert.deepEqual(input.definitionOfDone,[mode.confirmedDone]);
 if(mode.ticketAtProductReview) {
  assert.deepEqual(input.currentTicket,mode.ticketAtProductReview);
  assert.deepEqual(input.definitionOfDone,[mode.confirmedDone]);
 }
 const findings=[];
 if(input.reviewer==='scope'&&!mode.technicalAcceptsExtra) {
  const additions=${JSON.stringify([unrequestedOption, unrequestedTest])}.filter(addition=>input.patch.includes('+'+addition));
  for(const message of additions) findings.push({disposition:mode.extrasBreakDone?'blocking':'note',message});
 }
 if(input.reviewer==='code'&&mode.technicalFailureCommits?.includes(input.commit)) {
  findings.push({disposition:'blocking',message:'Code defect on this commit'});
 }
 if(mode.verifyReviewRound && mode.returnRevision===2) {
  assert.deepEqual(input.previous,{commit:mode.previousCommit,findings:[
   {disposition:'blocking',message:input.reviewer+' blocker'},
   ...(input.reviewer==='code'?[{disposition:'note',message:'Code observation'}]:[])]});
  assert.ok(!input.patch.includes(${JSON.stringify(unchangedReviewLine)}));
 } else if (mode.verifyReviewRound) {
  findings.push({disposition:'blocking',message:input.reviewer+' blocker'});
  if(input.reviewer==='code') findings.push({disposition:'note',message:'Code observation'});
 }
 if(mode.codeNote && input.reviewer==='code') findings.push({disposition:'note',message:'Code observation'});
 if(mode.scopeNote && input.reviewer==='scope') findings.push({disposition:'note',message:'Scope observation'});
 const output=JSON.stringify({verdict:findings.some(finding=>finding.disposition==='blocking')?'fail':'pass',findings});
 const id=43+readdirSync(root).filter(name=>/^review-job-\\d+\\.json$/.test(name)).length;
 const job={id,uuid,git_ref:args[3],status:'done',job_type:'task'};
 writeFileSync(root+'/review-job-'+id+'.json',JSON.stringify({job_id:id,job,prompt,output,commit:input.commit}));
 if(mode.verifyReviewRound) appendFileSync(root+'/review-events.jsonl',JSON.stringify({phase:'launch',...input})+'\\n');
 process.stdout.write(JSON.stringify({job_id:id,job_uuid:uuid,git_ref:args[3],status:'queued'}));
} else {
 assert.equal(args[0],'--job');
 const raw=readFileSync(root+'/review-job-'+args[2]+'.json','utf8');
 if (command==='wait') {
  assert.equal(args[1],'--quiet');
  if(mode.verifyReviewRound) {
   const {commit}=JSON.parse(raw);
   const events=readFileSync(root+'/review-events.jsonl','utf8').trimEnd().split('\\n').map(JSON.parse);
   assert.ok(events.some(entry=>entry.phase==='product'&&entry.commit===commit),'quality must stay in flight until product starts');
   appendFileSync(root+'/review-events.jsonl',JSON.stringify({phase:'collect',commit})+'\\n');
  }
 } else {
  assert.equal(command,'show');
  assert.equal(args[1],'--json');
  process.stdout.write(raw);
 }
}`);
  const project = { ...baseline.find((record) => record.kind === 'project')!, repositories: [{ uri: repository }], firstMateHomeRef: home };
  const runtime = fakeRuntime(home);
  mkdirSync(join(home, 'bin'));
  writeFileSync(join(home, 'bin/fm-fleet-snapshot.sh'), `#!${process.execPath}
const {execFileSync}=require('node:child_process');const fs=require('node:fs');
const snapshot=JSON.parse(execFileSync(${JSON.stringify(runtime.executable)},[],{encoding:'utf8'}));
const native=JSON.parse(fs.readFileSync(${JSON.stringify(wrapper.statePath)},'utf8'));
snapshot.backlog.records=Object.values(native.tasks).map((task,i)=>({id:task.id,order:i+1,state:task.state,kind:task.kind,repo:task.repo,hold_reason:task.hold?.reason??null,blocked_by_ids:task.deps.filter(d=>d.type==='blocked-by').map(d=>d.id)}));
process.stdout.write(JSON.stringify(snapshot));
`, {mode:0o755});
  const config: z.input<typeof FeatureRunConfigSchema> = { version: 1, project, database, runDirectory, agentConfig,
    hookRegistry, requestFile, clientRequestId: 'milestone', taskId: 'milestone-worker', repository,
    firstMate: { home, snapshotExecutable: runtime.executable, dataDirectory: data, briefExecutable: brief, spawnExecutable: spawn, inboxExecutable: inbox,
      tasksExecutable: wrapper.executable, mode: 'local-only', yolo: 'off' }, sourceFiles: [],
    baselineEvidence: [{ artifact: { uri: `git:${repository}`, revision: before }, description: 'Feature X absent at baseline', observedAt: at }] };
  if (options.bootstrap) runFeature(config, 'bootstrap');
  save(join(home, 'config', 'hooks.json'), hookSettings);
  const oldPath = process.env.PATH; process.env.PATH = `${root}:${oldPath}`;
  return { root, home, data, database, config, wrapper, returnWorker, save, outputs,
    mode: (value: unknown) => save(join(root, 'mode.json'), value),
    close: () => { if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath; rmSync(root, { recursive: true, force: true }); } };
}
