---
name: software-factory
description: >-
  Run the installed Software Factory when an owner asks FirstMate to build or change a registered project in plain chat.
  Also load when asked to "update the factory" in an installed monorepo home.
  Resume its product review and dependent tasks when a factory-managed worker returns.
  Uses the existing factory toolkit, the current home's Beads backlog and normal FirstMate supervision.
---

# Software Factory through FirstMate

You are FirstMate in the owner's configured home.
Carry the request through capture, planning, checked worker instructions, normal build supervision and product review.
The owner supplies the request in chat; you create all per-request files and execute the commands.
Use the home's existing registered projects, delivery posture and backlog.
The installation contract is [Run it from FirstMate](../../README.md#run-it-from-firstmate).
Resolve documentation links against the configured factory checkout when reading this skill through a home symlink.
Read that section if installation facts are missing; report a concrete missing prerequisite rather than asking the owner to compose a run file.

## Update the installed system

For "update the factory", run `node <home>/services/update.mjs` from the installed home.
This is installation maintenance, not a feature request; do not create a factory plan or worker for it.
The command uses FirstMate's existing guarded source updater, rebuilds the bundled tools and dedicated screens, preserves private records and finishes with real acceptance.
On refusal, report the exact unfinished work or failed acceptance; never reset, stash, remove a pending transaction or bypass the guard.
Read the updated FirstMate instructions when the updater reports `reread-firstmate: yes` and follow the existing update skill's restart/nudge actions.
Do not report completion until the command and acceptance succeed.

## Intake and project selection

1. Immediately save the owner's exact request to a UTF-8 text file in the current home's task data.
   Preserve newlines, examples, Unicode, quoted text and all requested behavior; use a file-writing API rather than shell interpolation.
   Retain the source message identity when the harness exposes one.
   This is the original request, separate from your interpretation.
   Tell the owner: "I can capture the request text available in this session; this does not prove that other chats or inbox messages were captured."
   If only an excerpt or summary is available, state that specific limit and obtain the missing original before claiming full-request coverage.
2. Read this home's `config/software-factory.json` and `data/projects.md`.
   Select the registered project named by the owner or unambiguously established by session context.
   Resolve its actual repository and registered delivery mode through FirstMate's usual intake procedure.
   If several projects are plausible, ask which project and preserve the request while waiting.
   Use only that home's configuration; a factory configuration is installation metadata, not a second project registry.
3. Inspect the repository to choose the files the planning agents need: current behavior, relevant interfaces, nearby tests, integration points and project instructions.
   Planners read only the supplied snapshots and records; they cannot discover omitted files themselves.
   Select tracked UTF-8 files inside the repository, with a reason for each choice and a baseline description grounded in what you inspected.
   Select relevant unchanged dependencies too.
   If the bounded snapshots cannot support planning, stop and explain the missing evidence rather than inventing research.
4. Write an agent-authored selection JSON with this shape:

   ```json
   {
     "projectName": "registered-name",
     "repository": "/absolute/registered/repository",
     "mode": "local-only",
     "registration": "exact full entry copied from this home's data/projects.md",
     "project": {
       "goal": "The registered project's purpose",
       "intendedUser": "Its intended users",
       "priorities": [], "exclusions": [], "vocabulary": {}, "timezone": "UTC"
     },
     "sources": [{ "path": "/absolute/registered/repository/src/relevant.ts", "reason": "Current behavior and reuse seam" }],
     "baselineDescription": "What the selected baseline establishes about the requested behavior"
   }
   ```

   Derive project facts from registration and project documentation; keep unresolved product choices explicit.
   When the request comes from an existing feature ticket, set selection `featureTaskId` to its exact tasks-axi ID so planned tasks become its native sub-tasks.
   Otherwise the task adapter creates a held feature ticket for the plan.
   `project` initializes a new project only; an existing database reuses its original initialized project.
   Run `node <factoryRoot>/skills/software-factory/scripts/materialize-run.mjs <settings-file> <selection-file> <exact-request-file>`.
   This formatting helper saves the exact request, immutable source copies, `source-choice.json`, project agent settings and `run.json` under this home's data.
   It makes no agent, backlog or lifecycle call.
   Use its returned `configPath` for every later phase, without rewriting it.
5. Run `<factoryRoot>/scripts/run-feature.mjs bootstrap <configPath>`.
   A bootstrap failure stops the flow before this database is published to the hook.
   After success, add the matching `{home, projectId, database, agentConfig}` entry to the installed `hookRegistry`, preserving every other entry.
   Derive those values from the generated run configuration.
   Reuse an identical entry; stop on a conflicting entry for this home/project rather than replacing an active binding.
   Write registry updates atomically under FirstMate's config ownership rules.
   Never enable a registry entry for an unavailable database.
6. Execute the existing capture command using the generated configuration:
   `node <factoryRoot>/dist/src/cli.js capture --db <database> --project <project-id> --client-request-id <clientRequestId> --channel chat --source <requestFile> --text-file <requestFile>`.
   Confirm its `request.originalText` equals the saved text exactly.
   Run `channels --db <database> --project <project-id>` to report capture coverage from available configuration facts.
   This explicit chat capture does not establish automatic coverage of the entire FirstMate harness.

## Planning and held tasks

Run `<factoryRoot>/scripts/run-feature.mjs plan <configPath>`.
This phase executes understand, design, plan, detail, a separate semantic plan review and `check-plan` in order.
It then uses the existing individual `queue-task` and `reconcile-task` commands for every detailed task, through this home's `fm-tasks-axi.sh`.
All native tasks retain their preparation hold; plan dependencies retain their product requirements and native dependency edges.
The saved `planned.json` is a command-input/evidence manifest; the project database and Beads remain the authorities.

Stop on any nonzero exit.
For `plan_review_failed`, read `plan-check-agent.json` and explain its findings in plain words.
For a structural check failure, read `check-plan.stdout` and explain each finding and the missing behavior or decision.
Do not queue unchecked work or bypass a failed check.
Use the existing decisions records/screen for unresolved product questions; ask only questions that require the owner's product decision.
Saved stage inputs, agent outputs, source selections and checks are the evidence for the report.

## Build each ready task through FirstMate

Read `planned.json` and the current database task mappings/readiness.
Work in the checked delivery sequence, observing every dependency.
For each task, use the returned native `taskId`:

1. When its prerequisites have evidence, run `run-feature.mjs prepare-task <configPath> <taskId>`.
   This invokes `fm-brief.sh`, `prepare-brief`, the independent preparation instruction check, then `manage-task` to release only the preparation hold.
   An unmet prerequisite remains blocked by the existing readiness rules.
   A failed instruction check stops dispatch; read the task's `check-brief.stdout`, explain the omission or narrowing, and leave its native hold in place.
2. Run `run-feature.mjs start <configPath> <taskId>`.
   The existing FirstMate adapter invokes normal `fm-spawn.sh` with the configured build profile.
   The installed `worker.start.before` hook checks the actual launch candidate again.
   A hook refusal is a failed gate, not permission to launch another way.
3. Supervise the worker with FirstMate's normal status, steering, return and delivery workflow.
   Keep the generated assignment's return location in the task context so a return wake resumes this skill.
   Do not replace supervision with a polling service or add another scheduler or backlog.
   A successful spawn means only that the launch operation succeeded.
4. After delivery, inspect the exact assignment's `worker-return.json`, repository and delivered full commit SHA.
   Follow the project's existing technical validation/delivery contract until exact-commit evidence is available.
   Keep each returned repository and commit readable through the final aggregate review; defer normal worktree cleanup until that review finishes.
   Preserve the return's criterion identities, limitations and evidence; do not manufacture a technical pass or use a result from a different commit.
   Run `run-feature.mjs review <configPath> <taskId>`.
   It calls `review-product` against the original request and actual committed snapshots, with a separate reviewer and existing technical result.
   A failed or uncertain slice judgment stops that task's delivery and its dependents and must be reported plainly, even if technical checks passed.
   Keep unrelated eligible branches progressing.
   `taskOutcome: passed` means this task's own criteria, worker results and exact-commit technical evidence passed; its canonical review can remain feature-incomplete.
   Sibling returns are not inputs to this task's eligibility.
   Continue eligible consumers after a task pass without calling the whole feature complete.
5. Complete normal FirstMate delivery/backlog reconciliation for the producer before proceeding to its consumers.
   Native done state alone does not establish the factory's product prerequisites.
   Continue with the next eligible task through the same commands and supervision.

After every task has returned, run `run-feature.mjs review-all <configPath>`.
This invokes the existing `review-product` command with all exact assignments and deliveries from one return snapshot taken at aggregate start, covering the whole original request and integration across slices.
If returns are missing, it reports `state: awaiting_worker_returns` and `pendingTasks`; resume aggregate review on later return wakes.
Aggregate failure or pending work keeps the feature incomplete and never blocks an independently passing task's delivery.
For one task the same final phase supplies a whole-request review.
Use [the command runbook](../../docs/one-feature-run.md) for phase mechanics and recovery.
After a partial or ambiguous external effect, inspect saved output, `outbox`, native state and the existing recovery operations; never restart planning or blindly spawn a replacement.

## Chat result and screens

Use the configured `uiOrigin` for `/projects/<encoded-project-id>` and `/projects/<encoded-project-id>/decisions`.
The installed folder service discovers projects from `hookRegistry`; after registering the project, verify its link answers.
Use the installed `scottyOrigin` with `/p/factory` for the folder’s editable execution tickets and dependency graph.
If either service is unavailable, report the failed link and its dedicated container from the installed `services` settings for diagnosis.

Report in chat: accomplished behavior or the failed gate; delivered commits; technical and product outcomes with saved evidence paths; open product questions with their decisions-screen link; and the factory-screen link.
Include capture limits and any unverified behavior.
Claim success only after the whole-request product review passes and normal FirstMate delivery is complete.
