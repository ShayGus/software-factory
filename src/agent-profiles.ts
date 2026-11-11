import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { IdSchema, TextSchema } from './primitives.js';

export const WorkflowAgentStepSchema = z.enum(['understand', 'design', 'plan', 'detail', 'instruction_check', 'product_review']);
export type WorkflowAgentStep = z.infer<typeof WorkflowAgentStepSchema>;
// The profile object is FirstMate's crew-dispatch profile subshape. Provider is
// its account/quota family, not a new API endpoint or a provider SDK selection.
export const WorkflowAgentProfileSchema = z.strictObject({
  harness: TextSchema, provider: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/u).optional(),
  model: TextSchema.optional(), effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']).optional(),
});
const executablePath = TextSchema.refine(isAbsolute, 'Agent executable must be absolute');
export const ProjectAgentConfigSchema = z.strictObject({
  schemaVersion: z.literal(1), projectId: IdSchema,
  steps: z.record(WorkflowAgentStepSchema, WorkflowAgentProfileSchema),
  executables: z.strictObject({ codex: executablePath.optional(), claude: executablePath.optional() }),
  timeoutMs: z.number().int().positive().max(600_000).default(120_000),
  cwd: TextSchema.refine(isAbsolute, 'Agent cwd must be absolute').optional(),
});
export type WorkflowAgentProfile = z.infer<typeof WorkflowAgentProfileSchema>;
export type ProjectAgentConfig = z.input<typeof ProjectAgentConfigSchema>;

export function resolveStepAgentProfile(input: unknown, projectId: string, step: WorkflowAgentStep) {
  if (!input) throw new Error(`agent_profile_not_configured: ${step}`);
  const config = ProjectAgentConfigSchema.parse(input);
  if (config.projectId !== projectId) throw new Error('agent_profile_project_mismatch');
  return { config, profile: config.steps[WorkflowAgentStepSchema.parse(step)] };
}

/** Review steps execute an agent. Each call starts a fresh
 * one-shot session; neither adapter can resume or reuse the worker/main session.
 * Effort values follow the inspected FirstMate adapter's native mappings. */
export function stepAgentCommand(input: unknown, projectId: string, step: 'instruction_check' | 'product_review') {
  const { config, profile } = resolveStepAgentProfile(input, projectId, step);
  const { harness, model, effort, provider } = profile;
  if (harness !== 'codex' && harness !== 'claude') throw new Error(`unsupported_${step}_harness: ${harness}`);
  if (provider && provider !== harness) throw new Error(`unsupported_${step}_provider: ${provider} for ${harness}`);
  if (effort && (effort === 'ultra' || (harness === 'codex' && effort === 'max' && model !== 'gpt-5.6-luna'))) {
    throw new Error(`unsupported_${step}_effort: ${effort} for ${harness}/${model ?? 'default'}`);
  }
  const executable = config.executables[harness];
  if (!executable) throw new Error(`agent_executable_not_configured: ${harness}`);
  const args = harness === 'codex' ? ['exec', '--sandbox', 'read-only', '--ephemeral', '--ignore-user-config', '--color', 'never',
    '--skip-git-repo-check', '--output-schema', fileURLToPath(new URL(`../../fixtures/${step === 'instruction_check' ? 'instruction-judge' : 'product-review'}.schema.json`, import.meta.url)),
    ...(model ? ['--model', model] : []), ...(effort ? ['-c', `model_reasoning_effort="${effort}"`] : []), '-'] :
    ['--print', '--safe-mode', '--strict-mcp-config', '--output-format', 'text', '--tools', '', '--disable-slash-commands', '--no-session-persistence',
      ...(model ? ['--model', model] : []), ...(effort ? ['--effort', effort] : [])];
  return { executable, args, timeoutMs: config.timeoutMs, ...(config.cwd ? { cwd: config.cwd } : {}), profile };
}

export function instructionAgentCommand(input: unknown, projectId: string) {
  return stepAgentCommand(input, projectId, 'instruction_check');
}
