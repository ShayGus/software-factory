#!/usr/bin/env node
import { captureLearning, consolidateLearning, readLegacySection } from './learning.js';
import { learningContext } from './learning-context.js';
import { prepareLearningSchedule, runScheduledLearning } from './learning-schedule.js';
import { readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { captureChannelCoverage, chatHookCommand, chatHookSettings } from './capture-coverage.js';
import { captureChatPrompt } from './chat-hook.js';
import { deliverRequest } from './delivery.js';
import { prepareWorkerBrief, checkWorkerBrief } from './briefs.js';
import { captureRequest, initializeProject, mapRequest, requestCoverage, unclassifiedRequests } from './intake.js';
import { recordStage, checkPlanReadiness, planReadinessHistory, stageHistory } from './planning.js';
import { reviewProduct } from './product-review.js';
import { ProjectStore, StoreError } from './store.js';
import { manageExecutionTask, queueManagedTask, reconcileManagedTask, TaskAdapterOptionsSchema } from './tasks.js';

const help = `Software Factory request intake and staged planning
All commands print JSON; chat-hook is silent on success. No settings are installed.

  init           --db <sqlite> --input <Project JSON file>
  capture        --db <sqlite> --project <id> --client-request-id <id>
                 --channel <cli|chat|firstmate_inbox|other> --source <reference>
                 --text-file <file|-> [--captured-at <ISO timestamp>]
  map            --db <sqlite> --input <MapRequestInput JSON file>
  understand     --db <sqlite> --input <RecordStageInput JSON file>
  design         --db <sqlite> --input <RecordStageInput JSON file>
  plan           --db <sqlite> --input <RecordStageInput JSON file>
  detail         --db <sqlite> --input <RecordStageInput JSON file>
  check-plan     --db <sqlite> --input <CheckReadinessInput JSON file>
  prepare-brief  --db <sqlite> --input <PrepareWorkerBriefInput JSON file>
  check-brief    --db <sqlite> --project <id> --assignment <id>
                 --revision <integer> --brief <already scaffolded brief path>
                 --agent-config <ProjectAgentConfig JSON file>
                 [--preparation-gate <reserved brief-preparation condition ID>]
  review-product --db <sqlite> --input <ReviewProductInput JSON file>
                 --agent-config <ProjectAgentConfig JSON file>
  learning-capture --db <sqlite> --input <CaptureLearningInput JSON file>
  learning-consolidate --db <sqlite> --input <ConsolidateLearningInput JSON file>
                 --agent-config <ProjectAgentConfig JSON file>
  learning-context --db <sqlite> --project <id> [--feature <id>]
  learning-legacy --db <sqlite> --source <path or file URI> --heading <Markdown heading>
  learning-schedule --db <sqlite> --schedule <LearningSchedule JSON file>
                 --agent-config <ProjectAgentConfig JSON file>
  learning-tick  --db <sqlite> --schedule <LearningSchedule JSON file>
                 --agent-config <ProjectAgentConfig JSON file> [--now <ISO timestamp>]
  findings       --db <sqlite> --project <id> --plan <plan ID>
  stages         --db <sqlite> --project <id> --feature <feature ID>
  unclassified   --db <sqlite> --project <id>
  coverage       --db <sqlite> --project <id> --request <request ID>
  outbox         --db <sqlite> --project <id>
  queue-task     --db <sqlite> --input <MapManageExecutionTaskCommand JSON file>
  manage-task    --db <sqlite> --input <MapManageExecutionTaskCommand JSON file>
                 --adapter-config <TaskAdapterOptions JSON file>
  reconcile-task --db <sqlite> --project <id> --operation <id>
                 --adapter-config <TaskAdapterOptions JSON file>
  deliver        --db <sqlite> --project <id> --request <request ID>
                 --fm-home <absolute home> [--inbox-executable <absolute path>]
  chat-hook      --db <sqlite> --project <id> [--client-request-id <id>]
                 Reads a Claude Code UserPromptSubmit JSON event from stdin.
  hook-settings  --db <sqlite> --project <id>
  channels       --db <sqlite> --project <id> [--settings <path>]...

Mapping offsets are half-open UTF-16 positions in the original request.
See README.md for project/mapping examples, correction, and announcement recovery.
`;
const valueOption = { type: 'string' as const };
const optionsByCommand: Record<string, Record<string, { type: 'string'; multiple?: boolean }>> = {
  'learning-capture': { db: valueOption, input: valueOption },
  'learning-consolidate': { db: valueOption, input: valueOption, 'agent-config': valueOption },
  'learning-context': { db: valueOption, project: valueOption, feature: valueOption },
  'learning-legacy': { db: valueOption, source: valueOption, heading: valueOption },
  'learning-schedule': { db: valueOption, schedule: valueOption, 'agent-config': valueOption },
  'learning-tick': { db: valueOption, schedule: valueOption, 'agent-config': valueOption, now: valueOption },
  init: { db: valueOption, input: valueOption },
  capture: { db: valueOption, project: valueOption, 'client-request-id': valueOption,
    channel: valueOption, source: valueOption, 'text-file': valueOption, 'captured-at': valueOption },
  map: { db: valueOption, input: valueOption },
  understand: { db: valueOption, input: valueOption },
  design: { db: valueOption, input: valueOption },
  plan: { db: valueOption, input: valueOption },
  detail: { db: valueOption, input: valueOption },
  'check-plan': { db: valueOption, input: valueOption },
  'prepare-brief': { db: valueOption, input: valueOption },
  'check-brief': { db: valueOption, project: valueOption, assignment: valueOption, revision: valueOption, brief: valueOption, 'agent-config': valueOption, 'preparation-gate': valueOption },
  'review-product': { db: valueOption, input: valueOption, 'agent-config': valueOption },
  findings: { db: valueOption, project: valueOption, plan: valueOption },
  stages: { db: valueOption, project: valueOption, feature: valueOption },
  unclassified: { db: valueOption, project: valueOption },
  coverage: { db: valueOption, project: valueOption, request: valueOption },
  outbox: { db: valueOption, project: valueOption },
  'queue-task': { db: valueOption, input: valueOption },
  'manage-task': { db: valueOption, input: valueOption, 'adapter-config': valueOption },
  'reconcile-task': { db: valueOption, project: valueOption, operation: valueOption, 'adapter-config': valueOption },
  deliver: { db: valueOption, project: valueOption, request: valueOption,
    'fm-home': valueOption, 'inbox-executable': valueOption },
  'chat-hook': { db: valueOption, project: valueOption, 'client-request-id': valueOption },
  'hook-settings': { db: valueOption, project: valueOption },
  channels: { db: valueOption, project: valueOption, settings: { type: 'string', multiple: true } },
};
export function runCli(args: string[]): number {
  const [verb, ...rest] = args;
  if (!verb || verb === '--help' || verb === 'help') { process.stdout.write(help); return 0; }
  try {
    const options = optionsByCommand[verb];
    if (!options) throw new StoreError('validation', `unknown_command: ${verb}`);
    const { values } = parseArgs({ args: rest, options, strict: true, allowPositionals: false });
    const optional = (name: string) => typeof values[name] === 'string' ? values[name] as string : undefined;
    const required = (name: string): string => {
      const value = optional(name);
      if (!value || !value.trim()) throw new StoreError('validation', `missing_option: --${name}`);
      return value;
    };
    const jsonFile = (name: string): unknown => JSON.parse(readFileSync(required(name), 'utf8'));
    const database = resolve(required('db'));
    const output = (value: unknown) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    if (verb === 'hook-settings' || verb === 'channels') {
      const command = chatHookCommand(process.execPath, fileURLToPath(import.meta.url), database, required('project'));
      output(verb === 'hook-settings' ? chatHookSettings(command) : captureChannelCoverage(command,
        (values.settings as string[] | undefined) ?? []));
      return 0;
    }
    const store = new ProjectStore(database);
    try {
      switch (verb) {
        case 'learning-capture': output(captureLearning(store, jsonFile('input'))); break;
        case 'learning-consolidate': output(consolidateLearning(store, jsonFile('input'), jsonFile('agent-config'))); break;
        case 'learning-context': output(learningContext(store.history(required('project')), optional('feature'))); break;
        case 'learning-legacy': output(readLegacySection(required('source'), required('heading'))); break;
        case 'learning-schedule': output(prepareLearningSchedule(jsonFile('schedule'), {
          node: process.execPath, cli: fileURLToPath(import.meta.url), db: database,
          schedule: resolve(required('schedule')), agentConfig: resolve(required('agent-config')) })); break;
        case 'learning-tick': output(runScheduledLearning(store, jsonFile('schedule'), optional('now') ?? new Date().toISOString(), jsonFile('agent-config'))); break;
        case 'init': output(initializeProject(store, jsonFile('input'))); break;
        case 'capture': {
          const textFile = required('text-file');
          output(captureRequest(store, { projectId: required('project'),
            clientRequestId: required('client-request-id'), channel: required('channel'),
            source: { uri: required('source') }, originalText: readFileSync(textFile === '-' ? 0 : textFile, 'utf8'),
            attachments: [], ...(optional('captured-at') ? { capturedAt: optional('captured-at') } : {}),
          }));
          break;
        }
        case 'understand': case 'design': case 'plan': case 'detail': {
          const input = jsonFile('input');
          if (!input || typeof input !== 'object' || !('stage' in input) || !input.stage ||
            typeof input.stage !== 'object' || !('stage' in input.stage) || input.stage.stage !== verb) {
            throw new StoreError('validation', 'stage_does_not_match_command');
          }
          output(recordStage(store, input)); break;
        }
        case 'check-plan': {
          const report = checkPlanReadiness(store, jsonFile('input'));
          output(report);
          return report.readyPlan ? 0 : 1;
        }
        case 'prepare-brief': {
          const report = prepareWorkerBrief(store, jsonFile('input'));
          output(report); return report.ok ? 0 : 1;
        }
        case 'check-brief': {
          const revision = z.coerce.number().int().positive().parse(required('revision'));
          const agentConfig = optional('agent-config') ? jsonFile('agent-config') : undefined;
          const report = checkWorkerBrief(store, required('project'), { id: required('assignment'), revision }, required('brief'), agentConfig,
            undefined, optional('preparation-gate'));
          output(report); return report.ok ? 0 : 1;
        }
        case 'review-product': {
          const report = reviewProduct(store, jsonFile('input'), jsonFile('agent-config'));
          output(report); return report.review.outcome === 'passed' ? 0 : 1;
        }
        case 'findings': output(planReadinessHistory(store, required('project'), required('plan'))); break;
        case 'stages': output(stageHistory(store, required('project'), required('feature'))); break;
        case 'map': output(mapRequest(store, jsonFile('input'))); break;
        case 'unclassified': output(unclassifiedRequests(store, required('project'))); break;
        case 'coverage': output(requestCoverage(store, required('project'), required('request'))); break;
        case 'outbox': output(store.operations(required('project'))); break;
        case 'queue-task': output(queueManagedTask(store, jsonFile('input'))); break;
        case 'manage-task': {
          const result = manageExecutionTask(store, jsonFile('input'), TaskAdapterOptionsSchema.parse(jsonFile('adapter-config')));
          output(result); return result.operation.state === 'succeeded' ? 0 : 1;
        }
        case 'reconcile-task': {
          const result = reconcileManagedTask(store, required('project'), required('operation'),
            TaskAdapterOptionsSchema.parse(jsonFile('adapter-config')));
          output(result); return result.state === 'succeeded' ? 0 : 1;
        }
        case 'deliver': {
          const executable = optional('inbox-executable');
          const operation = deliverRequest(store, required('project'), required('request'), {
            fmHome: required('fm-home'), ...(executable ? { inboxExecutable: executable } : {}),
          });
          output(operation);
          return operation.state === 'succeeded' ? 0 : 1;
        }
        case 'chat-hook':
          captureChatPrompt(store, required('project'), JSON.parse(readFileSync(0, 'utf8')), optional('client-request-id'));
          break;
      }
      return 0;
    } finally { store.close(); }
  } catch (error) {
    const detail = error instanceof StoreError ? error.detail : {
      code: 'validation', message: error instanceof Error ? error.message : String(error),
      paths: error instanceof z.ZodError ? error.issues.map((issue) => issue.path.join('.')) : [], externalReferences: [],
    };
    process.stderr.write(`${JSON.stringify({ error: detail })}\n`);
    return 1;
  }
}
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = runCli(process.argv.slice(2));
}
