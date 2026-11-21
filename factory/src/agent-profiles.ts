import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { IdSchema, ProjectRuleFilesSchema, TextSchema } from './primitives.js';

export const WorkflowAgentStepSchema = z.enum(['understand', 'design', 'plan', 'detail', 'plan_check', 'instruction_check', 'build', 'product_review', 'learning_consolidation']);
export type WorkflowAgentStep = z.infer<typeof WorkflowAgentStepSchema>;
export type ExecutedAgentStep = Exclude<WorkflowAgentStep, 'build'>;
export const planningAuthorSteps = ['understand', 'design', 'plan', 'detail'] as const;
// The profile object is FirstMate's crew-dispatch profile subshape. Provider is
// its account/quota family, not a new API endpoint or a provider SDK selection.
export const WorkflowAgentProfileSchema = z.strictObject({
  harness: TextSchema, provider: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/u).optional(),
  model: TextSchema.optional(), effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']).optional(),
});
const executablePath = TextSchema.refine(isAbsolute, 'Agent executable must be absolute');
export const ProjectAgentConfigSchema = z.strictObject({
  schemaVersion: z.literal(1), projectId: IdSchema,
  ruleFiles: ProjectRuleFilesSchema.optional(),
  steps: z.strictObject({
    understand: WorkflowAgentProfileSchema, design: WorkflowAgentProfileSchema,
    plan: WorkflowAgentProfileSchema, detail: WorkflowAgentProfileSchema,
    instruction_check: WorkflowAgentProfileSchema, product_review: WorkflowAgentProfileSchema,
    learning_consolidation: WorkflowAgentProfileSchema,
    plan_check: WorkflowAgentProfileSchema.optional(), build: WorkflowAgentProfileSchema.optional(),
  }),
  executables: z.strictObject({ codex: executablePath.optional(), claude: executablePath.optional() }),
  timeoutMs: z.number().int().positive().max(600_000).default(120_000),
  cwd: TextSchema.refine(isAbsolute, 'Agent cwd must be absolute').optional(),
});
export type WorkflowAgentProfile = z.infer<typeof WorkflowAgentProfileSchema>;
export type ProjectAgentConfig = z.input<typeof ProjectAgentConfigSchema>;

export function resolveStepAgentProfile(input: unknown, projectId: string, step: ExecutedAgentStep | 'build') {
  if (!input) throw new Error(`agent_profile_not_configured: ${step}`);
  const config = ProjectAgentConfigSchema.parse(input);
  if (config.projectId !== projectId) throw new Error('agent_profile_project_mismatch');
  const profile = config.steps[step];
  if (!profile) throw new Error(`agent_profile_not_configured: ${step}`);
  return { config, profile };
}

export function nativeStepProfile(input: unknown, projectId: string, step: WorkflowAgentStep) {
  const resolved = resolveStepAgentProfile(input, projectId, step);
  const { harness, provider, model, effort } = resolved.profile;
  if (harness !== 'codex' && harness !== 'claude') throw new Error(`unsupported_${step}_harness: ${harness}`);
  if (provider && provider !== harness) throw new Error(`unsupported_${step}_provider: ${provider} for ${harness}`);
  if (effort && (effort === 'ultra' || (harness === 'codex' && effort === 'max' && model !== 'gpt-5.6-luna'))) {
    throw new Error(`unsupported_${step}_effort: ${effort} for ${harness}/${model ?? 'default'}`);
  }
  return resolved;
}

/** Authoring may use a dedicated planning session. Other calls are one-shot. */
export function stepAgentCommand(input: unknown, projectId: string, step: ExecutedAgentStep,
  session?: { id?: string; outputPath: string }) {
  const { config, profile } = nativeStepProfile(input, projectId, step);
  const { harness, model, effort } = profile;
  // nativeStepProfile limits these harnesses before executable lookup.
  if (harness !== 'codex' && harness !== 'claude') throw new Error(`unsupported_${step}_harness: ${harness}`);
  const executable = config.executables[harness];
  if (!executable) throw new Error(`agent_executable_not_configured: ${harness}`);
  const sessionId = session?.id ?? (session && harness === 'claude' ? randomUUID() : undefined);
  const args = harness === 'codex' ? ['exec', '--sandbox', 'read-only', '--color', 'never',
    ...(session?.id ? ['resume'] : []), '--ignore-user-config', ...(!session ? ['--ephemeral'] : []),
    '--skip-git-repo-check',
    ...(['instruction_check', 'product_review', 'plan_check', 'learning_consolidation'].includes(step) ? ['--output-schema',
      fileURLToPath(new URL(`../../fixtures/${step === 'learning_consolidation' ? 'learning-consolidation' : step === 'product_review' ? 'product-review' : step === 'plan_check' ? 'plan-review' : 'instruction-judge'}.schema.json`, import.meta.url))] : []),
    ...(model ? ['--model', model] : []), ...(effort ? ['-c', `model_reasoning_effort="${effort}"`] : []),
    ...(session ? ['--json', '--output-last-message', session.outputPath] : []),
    ...(session?.id ? ['-c', 'sandbox_mode="read-only"', session.id] : []), '-'] :
    ['--print', '--safe-mode', '--strict-mcp-config', '--output-format', 'text', '--tools', 'Read,Glob,Grep',
      '--permission-mode', 'dontAsk', '--allowedTools', 'Read,Glob,Grep', '--disable-slash-commands',
      ...(session ? [session.id ? '--resume' : '--session-id', sessionId!] : ['--no-session-persistence']),
      ...(model ? ['--model', model] : []), ...(effort ? ['--effort', effort] : [])];
  return { executable, args, timeoutMs: config.timeoutMs,
    ...(config.cwd ? { cwd: config.cwd } : {}), ruleFiles: config.ruleFiles, profile, sessionId };
}

export function projectRuleDirections(ruleFiles?: string[]): string {
  if (!ruleFiles?.length) return '';
  const paths = ruleFiles.map((path) => `- ${JSON.stringify(path)}`).join('\n');
  return `Before doing any task work, open and read each project rule file at these absolute paths.\n${paths}\n\n`;
}

export function instructionAgentCommand(input: unknown, projectId: string) {
  return stepAgentCommand(input, projectId, 'instruction_check');
}
