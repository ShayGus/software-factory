#!/usr/bin/env node
// Input formatting only: no agent, backlog, lifecycle or canonical-store write.
// Usage: node materialize-run.mjs SETTINGS SELECTION EXACT_REQUEST
import { execFileSync } from 'node:child_process';
import { isUtf8 } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const [settingsPath, selectionPath, requestPath] = process.argv.slice(2);
if (process.argv.length !== 5 || ![settingsPath, selectionPath, requestPath].every(isAbsolute)) {
  throw new Error('usage: materialize-run.mjs /absolute/settings.json /absolute/selection.json /absolute/exact-request.txt');
}
const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
const selection = JSON.parse(readFileSync(selectionPath, 'utf8'));
for (const key of ['factoryRoot', 'home', 'fork', 'agentTemplate', 'hookRegistry']) {
  if (!isAbsolute(settings[key] ?? '')) throw new Error(`absolute setting required: ${key}`);
}
const { FeatureRunConfigSchema, ProjectStore, digestText, nativeStepProfile, stepAgentCommand } = await import(pathToFileURL(join(settings.factoryRoot, 'dist/src/index.js')).href);
const home = realpathSync(settings.home);
const repository = realpathSync(selection.repository);
const projectId = selection.projectName;
if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(projectId)) throw new Error('projectName must be a safe registered project name');
// FirstMate interprets its existing Markdown registry; preserve its selected
// entry as evidence rather than introducing a second registry/parser here.
const registryPath = join(home, 'data/projects.md');
const registry = readFileSync(registryPath, 'utf8');
if (!selection.registration?.trim() || !registry.includes(selection.registration) ||
    !selection.registration.includes(projectId)) throw new Error('selected registration must be an exact excerpt of home/data/projects.md');
const defaultProject = join(home, 'projects', projectId);
if (!selection.registration.includes(repository) && !(existsSync(defaultProject) && realpathSync(defaultProject) === repository)) {
  throw new Error('repository must match the selected registration or home/projects/<registered-name>');
}
if (execFileSync('git', ['-C', repository, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim() !== repository) {
  throw new Error('repository must be the registered Git root');
}
const database = join(home, 'data/software-factory/projects', projectId, 'project.sqlite');
const now = new Date().toISOString();
let project;
if (existsSync(database)) {
  const store = new ProjectStore(database, { readOnly: true });
  try { project = store.get(projectId, projectId, 1); } finally { store.close(); }
  if (project?.kind !== 'project') throw new Error('existing database has no initialized project');
  if (realpathSync(project.firstMateHomeRef) !== home || !project.repositories.some((repo) => repo.uri === repository)) {
    throw new Error('existing project does not match selected home/repository');
  }
} else {
  project = { ...selection.project, kind: 'project', id: projectId, projectId, schemaVersion: 1, revision: 1,
    createdAt: now, updatedAt: now, repositories: [{ uri: repository }], designRefs: [], firstMateHomeRef: home };
}
const runId = `sf-${randomUUID()}`;
const directory = join(home, 'data/software-factory/runs', runId);
const agentConfig = join(home, 'data/software-factory/projects', projectId, 'agents.json');
const agents = existsSync(agentConfig) ? JSON.parse(readFileSync(agentConfig, 'utf8')) :
  { ...JSON.parse(readFileSync(settings.agentTemplate, 'utf8')), projectId };
for (const step of ['understand', 'design', 'plan', 'detail', 'plan_check', 'instruction_check', 'product_review']) {
  stepAgentCommand(agents, projectId, step);
}
nativeStepProfile(agents, projectId, 'build');
const files = selection.sources.map(({ path, reason }) => {
  if (!isAbsolute(path) || !reason?.trim()) throw new Error('each source needs an absolute path and selection reason');
  const canonical = realpathSync(path);
  const local = relative(repository, canonical);
  if (local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local)) throw new Error('source must remain inside the registered repository');
  execFileSync('git', ['-C', repository, 'ls-files', '--error-unmatch', '--', local], { stdio: 'pipe' });
  const bytes = readFileSync(canonical);
  if (!isUtf8(bytes) || bytes.includes(0)) throw new Error('source snapshots must be UTF-8 text');
  const text = bytes.toString('utf8');
  return { source: { uri: canonical }, originalPath: path, reason, digest: digestText(text), text };
});
if (files.reduce((total, file) => total + file.text.length, 0) > 1_000_000) throw new Error('select a smaller planning snapshot (maximum 1000000 characters)');
if (!files.length) throw new Error('select repository source snapshots before planning');
const baseline = execFileSync('git', ['-C', repository, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const exactRequest = readFileSync(requestPath, 'utf8');
const capturedRequestPath = join(directory, 'request.txt');
const sourceFiles = files.map((file, index) => ({ source: file.source, path: join(directory, 'sources', `${index}.txt`) }));
const config = FeatureRunConfigSchema.parse({ version: 1, project, database, runDirectory: directory,
  agentConfig, hookRegistry: settings.hookRegistry, requestFile: capturedRequestPath, clientRequestId: runId,
  taskId: runId, repository, requestChannel: 'chat', sourceFiles,
  firstMate: { home, dataDirectory: join(home, 'data'), mode: selection.mode ?? settings.mode, yolo: settings.yolo,
    ...Object.fromEntries(['brief', 'spawn', 'inbox', 'tasks'].map((name) => [`${name}Executable`, join(settings.fork, 'bin', `fm-${name === 'tasks' ? 'tasks-axi' : name}.sh`)])),
    snapshotExecutable: join(settings.fork, 'bin/fm-fleet-snapshot.sh'),
    ...(settings.guardTaskId ? { guardTaskId: settings.guardTaskId } : {}) },
  baselineEvidence: [{ artifact: { uri: `git:${repository}`, revision: baseline },
    description: selection.baselineDescription, observedAt: now }] });
mkdirSync(join(directory, 'sources'), { recursive: true });
mkdirSync(join(home, 'data/software-factory/projects', projectId), { recursive: true });
const save = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
if (!existsSync(agentConfig)) save(agentConfig, agents);
writeFileSync(capturedRequestPath, exactRequest, { flag: 'wx' });
files.forEach((file, index) => writeFileSync(sourceFiles[index].path, file.text, { flag: 'wx' }));
save(join(directory, 'source-choice.json'), { registryPath, registration: selection.registration, repository,
  baseline, files: files.map(({ text, ...file }) => file) });
save(join(directory, 'run.json'), config);
process.stdout.write(JSON.stringify({ configPath: join(directory, 'run.json'), database, projectId, runDirectory: directory }) + '\n');
