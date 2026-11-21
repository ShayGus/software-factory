# One feature through FirstMate

For normal chat-driven use, install the [FirstMate skill](../README.md#run-it-from-firstmate).
This operator runbook also connects the existing commands for one captured request, one feature,
and one independent implementation task. Software Factory is a parallel project
and uses **the FirstMate home given in the settings**, with the FirstMate fork's
code and a Beads backlog selected from that home's configuration. No workspace,
backlog, settings or existing tasks are copied or migrated from another home.

Bootstrap and validate the project database first, while its hook is disabled.
Only then install the sample hook and matching project registry in the configured
home. Preparation verifies them before creating a native task or releasing its hold.

Build this package with `npm ci` and `npm run build`. Keep the checkout available
at a stable absolute path: both entry scripts load its compiled modules. The
operator configures the chosen home, registers its target project and selects
its runtime before a live run; an existing home can be used. This repository neither
creates nor configures homes.

## Run configuration

Use `FeatureRunConfigSchema` in `src/feature-run.ts`. All paths below are operator
configuration, with no machine-specific defaults. A minimal `run.json` is:

```json
{
  "version": 1,
  "project": {
    "kind": "project", "id": "pilot", "projectId": "pilot",
    "schemaVersion": 1, "revision": 1,
    "createdAt": "2026-11-12T00:00:00Z", "updatedAt": "2026-11-12T00:00:00Z",
    "goal": "Deliver a connection label through the product workflow",
    "intendedUser": "One operator", "priorities": [], "exclusions": [],
    "vocabulary": {}, "repositories": [{ "uri": "/absolute/firstmate-home/projects/pilot" }],
    "designRefs": [], "firstMateHomeRef": "/absolute/firstmate-home", "timezone": "Asia/Jerusalem"
  },
  "database": "/absolute/pilot-proof/project.sqlite",
  "runDirectory": "/absolute/pilot-proof/run",
  "agentConfig": "/absolute/pilot-proof/agents.json",
  "hookRegistry": "/absolute/pilot-proof/hook-projects.json",
  "requestFile": "/absolute/pilot-proof/request.txt",
  "clientRequestId": "connection-label-1",
  "taskId": "connection-label-1",
  "repository": "/absolute/firstmate-home/projects/pilot",
  "firstMate": {
    "home": "/absolute/firstmate-home",
    "dataDirectory": "/absolute/firstmate-home/data",
    "briefExecutable": "/absolute/firstmate-fork/bin/fm-brief.sh",
    "spawnExecutable": "/absolute/firstmate-fork/bin/fm-spawn.sh",
    "inboxExecutable": "/absolute/firstmate-fork/bin/fm-inbox.sh",
    "tasksExecutable": "/absolute/firstmate-fork/bin/fm-tasks-axi.sh",
    "mode": "local-only", "yolo": "off", "timeoutMs": 1080000, "launchTimeoutMs": 120000
  },
  "sourceFiles": [{
    "source": { "uri": "/absolute/pilot-proof/research.txt" },
    "path": "/absolute/pilot-proof/research.txt"
  }],
  "baselineEvidence": [{
    "artifact": { "uri": "git:/absolute/firstmate-home/projects/pilot", "revision": "FULL_BASELINE_COMMIT_SHA" },
    "description": "At this commit the requested connection-label behavior was absent",
    "observedAt": "2026-11-12T00:00:00Z"
  }]
}
```

The home owns its `.tasks.toml` Beads selection and graph configuration from the
start. `fm-tasks-axi.sh` already delegates to that adapter; Software Factory continues
to use this wrapper, not native Beads calls. If atomic `add --hold-reason` is
unavailable, configure `firstMate.guardTaskId` to an existing permanently held,
unfinished guard, following BUILD-08's existing protocol. Do not set up a second
backlog or use a symlink to another home's backlog.
The scripted run requires the standard `home/data` layout so scaffold, task-wrapper
and launch paths agree; individual adapters retain their existing configuration APIs.

Supply original, readable research/code snapshots in `sourceFiles`.
Every `sourceFiles[].path` must be absolute; relative snapshot paths are
rejected before capture so planning and brief preparation read the same file.
Planning agents receive paths to the captured request, selected snapshots, repository and records for the current attempt.
They read these inputs and can inspect additional repository files read-only.
External references in generated designs and tasks must resolve through the operator-provided mappings or the captured request.
Unlisted paths and file URIs are refused before brief preparation.

Set `agentConfig` using `fixtures/workflow-agents.json`, with the matching project
ID and absolute installed harness executables. `understand`, `design`, `plan`,
`detail`, `plan_check`, `instruction_check`, `build` and `product_review` each select
their own harness, provider, model and effort. The run path requires all eight.
The shared configuration also requires BUILD-11's `learning_consolidation` profile;
this feature run does not execute it. Individual commands retain the seven base
profile entries, with `plan_check` and `build` added for the connected run path.
Supported native harnesses are Codex and Claude, with the existing effort/provider validation.
The four authoring profiles must use the same harness so understand, design, plan and detail can share a read-only session.
Each turn returns a separate output for validation and storage before the next turn.
Continuations receive the current stored records and carry forward the planner's earlier reading of the request and repository.
Build flags go to real `fm-spawn.sh`.
The independent plan check and other reviews use fresh sessions, separate from planning and the build worker.
There are no agent calls for mechanical capture, mapping, rendering or transport.
The installed setting `maxRevisionRounds` is captured in each run and defaults to three corrective rounds per gate.
Set it to zero to stop after the first failure.
An agent turn that errors or emits invalid output receives the diagnostic in its next turn, using its original session when available.
If the retries are exhausted, the error points to the saved `agent.stderr` beside the turn's input and stdout.

## Execute the path

Run these commands only when a live run has been authorized:

```sh
/absolute/software-factory/scripts/run-feature.mjs bootstrap /absolute/pilot-proof/run.json
# After bootstrap succeeds, create the matching registry and enable the sample hook.
/absolute/software-factory/scripts/run-feature.mjs prepare /absolute/pilot-proof/run.json
/absolute/software-factory/scripts/run-feature.mjs start   /absolute/pilot-proof/run.json
# FirstMate supervises its worker through the normal return/delivery workflow.
# After worker-return.json and the existing exact-commit technical result exist:
/absolute/software-factory/scripts/run-feature.mjs review  /absolute/pilot-proof/run.json
```

The phases call the existing CLI and FirstMate commands in this order:

| Phase | Commands and evidence |
| --- | --- |
| Bootstrap, before enabling hook | Existing local `init` creates the project database and record; a read-only open validates the existing schema and configured project identity. No agent, hook or FirstMate command is needed. Enable the hook only after this succeeds for every project in its registry. |
| Prepare | Validate the bootstrapped database; verify hook/registry and time budgets; `capture`; `understand` agent generates a full-request `map` and the `understand` input; `design`; `plan`; `detail`; independent `plan_check` agent; `check-plan`; verify hook/registry again; `queue-task` with a pending preparation condition; `reconcile-task` creates a held native task through real `fm-tasks-axi.sh`; real `fm-brief.sh`; `prepare-brief`; independent preparation `check-brief`; verify hook/registry again; `manage-task` records the passing evidence and releases the hold |
| Start | Verify the operator-installed hook and project registry; `deliver` through real `fm-inbox.sh` to announce the captured request; real `fm-spawn.sh` with the `build` profile; FirstMate invokes a fresh `worker.start.before` instruction check before starting its worker |
| Worker return | Worker commits code, verifies acceptance and writes `worker-return.json` at the assignment's return location, preserving the scaffold's delivery contract; FirstMate owns worker supervision, task state and delivery |
| Review | `review-product` imports worker results, reads the actual committed code and exact-commit technical evidence, then calls a separate `product_review` agent with the current scope |

Stage agents return the existing `RecordStageInputSchema`.
Understand also returns `MapRequestInputSchema`.
Each stage opens the schemas and record context from its evidence file.
The `prepare` convenience phase rejects multiple features, multiple tasks and plan dependencies.
The skill uses `plan` followed by task-specific phases for larger plans.
Independent plan review checks every line of the confirmed definition of done and each recorded owner answer.
For legacy requests without a separately confirmed definition of done, the captured request supplies the requirements.
Rare corner cases and observations outside those requirements are advisory.
Blocking findings go back to the same planner session to revise the affected detail, followed by an independent review of that revision.
The native task stays held until brief preparation, instruction checking and hook/registry verification succeed.
`check-brief --preparation-gate factory:brief-preparation/<task-id>` is a read-only preparation
check: it defers only that reserved condition and reports `dispatchReady: false`.
All other readiness rules still apply. This option is never used by the start hook.
After success, `manage-task` records the check evidence and reconciles the release;
a failed check or unavailable hook leaves the native task held.
An instruction failure goes back to the planner for a targeted edit to the brief prose while the request, scaffold and assignment metadata stay fixed.
A start precheck refusal can reprepare the brief and retry the same start operation before any launch is attempted.
An ambiguous launch still requires runtime reconciliation.
A failed product review with attributable findings sends them to the original worker through its verified FirstMate inbox.
Review reports `awaiting_worker_revision` while it waits for a new commit or revised criterion evidence, then checks the new delivery on the next return wake.

Bootstrap does not read agent settings or require hook installation. It retains
`bootstrap-project-input.json`, `bootstrap.stdout` and `bootstrap.stderr` under
`runDirectory`, and reuses `init`'s idempotent receipt on repeat. If it fails, leave
the hook disabled and repair that local context before enabling it. Preparation,
start and review validate the existing database without initializing a missing one.
The configured project must match the stored initialization payload, including
goal and exclusions. A mismatch is rejected read-only before capture or agent
calls; restore the initialized configuration rather than silently changing the
project through `run.json`.
A preparation preflight failure therefore leaves the valid database available for
the hook to classify unmanaged tasks. Do not register an unavailable database with
an enabled home-wide hook: fail-closed lookup would refuse every task start there.

The worker return matches `FeatureWorkerReturnSchema`:

```json
{
  "repository": "/absolute/worker-worktree",
  "deliveredArtifact": { "uri": "git:/absolute/worker-worktree", "revision": "FULL_DELIVERED_COMMIT_SHA" },
  "results": [
    {
      "kind": "criterion_result", "id": "result-1", "projectId": "pilot",
      "schemaVersion": 1, "revision": 1,
      "createdAt": "2026-11-12T00:10:00Z", "updatedAt": "2026-11-12T00:10:00Z",
      "assignment": { "id": "connection-label-1-assignment", "revision": 1 },
      "criterion": { "id": "ACTUAL_CRITERION_ID_FROM_ASSIGNMENT", "revision": 1 },
      "result": "passed", "accomplishedBehavior": "State the demonstrated behavior",
      "artifact": { "uri": "git:/absolute/worker-worktree", "revision": "FULL_DELIVERED_COMMIT_SHA" },
      "evidence": [{
        "artifact": { "uri": "git:/absolute/worker-worktree", "revision": "FULL_DELIVERED_COMMIT_SHA" },
        "description": "Acceptance verification and its result", "observedAt": "2026-11-12T00:10:00Z"
      }],
      "limitations": [], "suggestions": []
    }
  ],
  "paths": []
}
```

Return one result for every assigned criterion, with actual assignment/criterion
identities and matching artifact provenance. Supply relevant unchanged dependencies
in `paths`. The run path adds its own review identity and preserved baseline evidence.
A green technical review or a worker's passing claims cannot replace product
conformance. `review-product` exits nonzero for failed or incomplete outcomes and
keeps their records. It does not itself change FirstMate task state or feature state.

Prepare and review have exclusive `.started` markers. Start uses a durable operation in the canonical store and the shared instruction/dispatch checker with a verified native hook and is safe to repeat with the same configuration: it observes FirstMate before resolving an ambiguous launch and never blindly spawns another worker. Inputs, profile selections, agent outputs,
CLI stdout/stderr and `prepared.json` remain under `runDirectory`; the manifest binds
later phases to the same parsed run configuration. There is no automatic retry after
an ambiguous FirstMate effect. Inspect the saved output and use the existing
`outbox`/`reconcile-task` for backlog changes, or repeat start for a worker-start operation.
For a start check refusal, the [recovery runbook](recovery.md#unknown-outcomes) explains how to re-prepare the existing assignment and repeat start.
After incomplete product review, inspect its saved input and receipt,
then use `review-product` with a new review key and the saved `task-adapter.json` as `--adapter-config` to read the fresh ticket.

## Plans with several tasks

The existing runner also exposes task-specific phases so FirstMate can use the individual commands without combining task dispatch with supervision:

```sh
/absolute/software-factory/scripts/run-feature.mjs plan /absolute/run.json
# For each eligible taskId returned in planned.json:
/absolute/software-factory/scripts/run-feature.mjs prepare-task /absolute/run.json TASK_ID
/absolute/software-factory/scripts/run-feature.mjs start /absolute/run.json TASK_ID
# Normal FirstMate supervision, delivery and exact-commit technical evidence:
/absolute/software-factory/scripts/run-feature.mjs review /absolute/run.json TASK_ID
# After every task returns, check the whole request and integration together:
/absolute/software-factory/scripts/run-feature.mjs review-all /absolute/run.json
```

`plan` performs capture, understand, design, plan, detail, independent plan review and `check-plan`, then queues every task and reconciles each native task through the existing adapter.
Projects with existing code do not need earlier factory designs or plans.
Planning can record inspected code reuse while authoring current-feature artifacts; selection of an older factory artifact still requires its recorded revision and a current-request comparison.
The [stage schema](../src/records.ts) defines these separate reuse variants.
The optional run configuration `featureTaskId` selects an existing native feature ticket; otherwise the adapter creates a held feature ticket.
Each planned task is created with a native parent relation to that ticket, separately from its blocking prerequisites.
All tasks remain held for brief preparation.
The existing task mappings derive product requirements and native dependency edges from the checked plan.
`planned.json` binds the request, checked plan, detailed tasks and operation IDs to the unchanged run configuration; it is not a scheduler or a second source of task state.
After partial task reconciliation, use its operation IDs with `outbox`/`reconcile-task` rather than repeating planning.
`requestChannel` selects capture provenance and defaults to `cli`; the chat skill sets `chat`.

FirstMate selects the next eligible task through its normal supervision.
`prepare-task` scaffolds and checks its brief, then reconciles its preparation-hold release through `manage-task`.
Prerequisites must have the existing current producer criterion/artifact evidence; a native done flag alone is insufficient.
Producer return artifacts are materialized from their exact Git commits with the existing delivery snapshot reader and included as handover context.
Task inputs, checks, worker return and phase outputs live under `runDirectory/tasks/<taskId>`.
The build instructions receive the exact assignment identity and return location from the prepared brief.
The brief points to its verified coverage sidecar and source snapshots for exact context without embedding source extracts.
The start hook checks every launch candidate, just as for the single-task convenience phase.
A failed preparation or start check leaves work undispatched.
For publishing runs, each sub-task receives a native local-only brief and starts from the shared local `fm/ticket/<native-ticket-id>` branch.
FirstMate initializes that branch on the first start.
After the sub-task passes review, the guarded local landing fast-forwards the ticket branch to its reviewed commit.
Preparation and reviews are single-use; recover failures using saved inputs and existing individual commands with deliberate new keys, rather than deleting markers and blindly replaying effects.

Review each producer before completing its normal FirstMate delivery and releasing consumers.
A slice review returns `taskOutcome: passed` only when that task's own assigned criteria, worker results and exact-commit technical evidence pass the shared task-delivery rules.
The canonical review may remain feature-incomplete.
Sibling returns do not enter task review inputs or eligibility; a sibling's failed review or concurrent return cannot block unrelated work.
Failed or uncertain task judgments stop that task's delivery and its dependents, while unrelated eligible branches can proceed.
The final aggregate review must pass before the feature is reported complete.
`review-all` captures the available return bytes once at its start and saves `review-all-snapshot.json` with exact deliveries and `pendingTasks`.
When any task is pending, it returns `state: awaiting_worker_returns` without an agent call or a single-use review marker, so a later aggregate attempt can include later arrivals.
For publishing runs, it reports `state: awaiting_ticket_branch` until the branch contains every exact returned commit and its tip is one of those commits.
With all returns present, it calls the existing `review-product` operation with that snapshot, exact assignment and commit identities, and the current review scope.
After a passing aggregate review, it saves and returns `ticketDelivery` with the ticket ID, branch, reviewed head, and configured FirstMate delivery posture.
The [factory skill](../skills/software-factory/SKILL.md) owns publishing the ticket from this handoff.
Whole-feature completeness is separate from any single task's delivery eligibility.
A per-task pass does not replace this final integration review.
No phase polls workers, changes native completion state, installs hooks or adds a scheduling service.
Review phases run the [Factory scope review](../README.md#plan-based-product-review---build-10) alongside the existing technical review evidence.
Each plan, code and product scope review reads the current Beads ticket body when it contains owner scope.
The next delivery review uses changes to that body even when the plan, commit and worker return are unchanged.
For a chat-originated ticket that still has only its Factory marker, the captured request supplies the scope.

## Publishing a reviewed ticket

For no-mistakes delivery, `ticket-delivery.json` identifies a private `intentFile` containing the full reviewed ticket text and any additional recorded owner answers, and records its digest.
The handoff uses the same backlog ticket body as the passing review.
From the isolated checkout at the reviewed ticket head, use `node /absolute/software-factory/factory/scripts/ticket-validation.mjs start /absolute/ticket-delivery.json` for a new run.
The helper passes the complete captured ticket to no-mistakes through `--intent-file`, and the pipeline owns opening the PR.
Reattach to an active run through the ordinary driver and keep its original intent.
Read the full body of the pipeline-opened PR from the forge and pipe the raw Markdown into `node /absolute/software-factory/factory/scripts/ticket-validation.mjs check-pr /absolute/ticket-delivery.json`.
Delivery needs the full Intent section, so an omitted, shortened or otherwise incomplete ticket leaves the verification incomplete under the repository's existing publication settings.

## Worker-start hook

The executable `scripts/worker-start-before.mjs` accepts the absolute path of an
operator-controlled project registry as its only argument and reads FirstMate's
version 1 event JSON from stdin. After successful database bootstrap, create the
registry outside the repository:

```json
{
  "version": 1,
  "projects": [{
    "home": "/absolute/firstmate-home",
    "projectId": "pilot",
    "database": "/absolute/pilot-proof/project.sqlite",
    "agentConfig": "/absolute/pilot-proof/agents.json"
  }]
}
```

After every listed database has been bootstrapped and validated, the operator can
add this entry to **the configured home's** `config/hooks.json`:

```json
{
  "version": 1,
  "hooks": [{
    "id": "software-factory-instruction-check",
    "event": "worker.start.before",
    "argv": [
      "/absolute/software-factory/scripts/worker-start-before.mjs",
      "/absolute/pilot-proof/hook-projects.json"
    ],
    "timeout_seconds": 300
  }]
}
```

This is a sample only; no installation is performed. Use FirstMate's hook config
ownership/permission rules. Choose a hook timeout longer than `agents.timeoutMs`
plus at least five seconds for local checks, within FirstMate's 900-second before-hook limit.
`firstMate.timeoutMs` is the outer spawn deadline (default 1,080,000 ms, maximum
3,600,000 ms). It must exceed the sum of every configured `worker.start.before`
hook budget (120 seconds when omitted, plus one second termination grace each),
plus `firstMate.launchTimeoutMs` (default 120,000 ms, maximum 600,000 ms).
The instruction hook itself must have more than `agents.timeoutMs + 5000` ms.
Preparation and start both validate these budgets; a short deadline fails before
a task is created or released. Non-spawn FirstMate calls use `launchTimeoutMs`.
Agent-backed CLI commands have an outer deadline of at least 600,000 ms or the
configured agent timeout plus 30,000 ms, whichever is larger, to allow startup
and validation outside the agent budget.
Each dispatching home needs its own entry. For the scripted start, the entry must use these exact
two absolute argv paths; the full hook runner still validates the configuration.

Lookup canonicalizes home paths (including symlink aliases) and uses the event's
`home` and `task_id` against canonical task mappings and
assignments in configured project databases. Databases are opened read-only without creation
or initialization; schema version, strict table columns and configured project
identity must be available before any task can be classified as unmanaged. An
empty, truncated, incompatible or wrong-project database causes a nonzero refusal.
The brief cannot label itself unmanaged.
A task with no matching managed records passes without calling an agent. A managed
task uses `currentAssignmentAttempts` to collapse revisions within each assignment
ID and select the latest task attempt by update time. Historical IDs do not make
a unique current attempt ambiguous; genuinely tied attempts remain blocked. The
selected current attempt must pass the existing managed-mapping and brief checks;
a historical matching brief cannot substitute for conflicting current context. A managed
task with missing/ambiguous assignment, unavailable database, stale context, altered
sidecar/source, invalid event or unavailable reviewer fails closed. Registry entries
must remain available while their managed tasks can launch or relaunch.

The hook reads `source_brief_path` and the **actual** `brief_path` candidate and
verifies its `brief_sha256`. It requires exactly one preserved source brief and
checks its saved scaffold, assignment metadata, sidecar and source revisions.
The whole launch candidate must contain exactly one canonical assignment block;
additional or conflicting blocks fail before the judge is called. It
then semantically judges the entire candidate, including FirstMate's prepended role
and appended delivery overlays. A narrowed overlay cannot inherit a pass from the
source brief. Candidate, source and authoritative context are checked again after
the agent call. No pass is cached, and the hook makes no mutating FirstMate call.
Any nonzero exit vetoes the start in FirstMate before allocation/worker launch.

## Verification and live proof

`test/milestone.test.ts` exercises the path using fake agents, a fake task wrapper,
fake brief/inbox/spawn commands and a fake existing technical-review result. The
fake spawn calls this actual hook executable before its worker-start marker. It
proves one passing feature; an ERPNext-only overlay blocked before worker start;
and a legacy bad assignment whose perfectly matching code fails product review
despite passing technical evidence. It also checks separate reviewer processes,
step profiles, plan rejection, unmanaged tasks, corrupt digests and missing context.
It uses temporary git repositories and makes no live model or FirstMate call.

A separate live script and needs list are prepared under the task's external proof
directory, `sf-milestone-1/`. They take the FirstMate home, fork, project,
profiles and delivery settings from configuration. The live script is deliberately
not run as part of this milestone; it creates no home, enables no hook and migrates
no existing workspace. A successful fake test is not evidence of a live model or
Beads integration run.
