import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProjectAgentConfig, InstructionJudgeVerdict } from '../src/index.js';
const fixture = new URL('../../fixtures/fake-instruction-judge.mjs', import.meta.url);
const root = mkdtempSync(join(tmpdir(), 'sf-fake-agent-'));
process.on('exit', () => rmSync(root, { recursive: true, force: true }));
const profile = { harness: 'codex', provider: 'codex', model: 'gpt-6.1-sol', effort: 'high' as const };
export const fakeJudge: ProjectAgentConfig = { schemaVersion: 1, projectId: 'project-1',
  steps: { understand: profile, design: profile, plan: profile, detail: profile, instruction_check: profile, product_review: profile },
  executables: { codex: fixture.pathname, claude: fixture.pathname },
};
export function fakeJudgeOptions(options: { result?: string; case?: string; record?: string; exit?: string; sleep?: string; rewrite?: string }): ProjectAgentConfig {
  const executable = join(root, `${randomUUID()}.mjs`);
  writeFileSync(executable, `#!/usr/bin/env node\nprocess.env.SF_FAKE_JUDGE_OPTIONS=${JSON.stringify(JSON.stringify(options))};\nawait import(${JSON.stringify(fixture.href)});\n`, { mode: 0o755 });
  return { ...structuredClone(fakeJudge), executables: { codex: executable, claude: executable } };
}
export const fakeVerdict = (verdict: InstructionJudgeVerdict): ProjectAgentConfig => fakeJudgeOptions({ result: JSON.stringify(verdict) });
