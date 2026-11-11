# One feature through FirstMate

This milestone connects the existing commands for one captured request, one feature,
and one independent implementation task. Software Factory runs alongside the existing
workspace in its **own FirstMate operational home**, using the FirstMate fork's code
and a Beads backlog selected from that home's own configuration. No workspace,
backlog, settings or existing tasks are copied or migrated from another home.

Build this package with `npm ci` and `npm run build`. Keep the checkout available
at a stable absolute path: both entry scripts load its compiled modules. The
operator provisions the parallel home, registers its target project and selects
its runtime before a live run. This repository neither creates nor configures homes.

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
    "vocabulary": {}, "repositories": [{ "uri": "/absolute/parallel-home/projects/pilot" }],
    "designRefs": [], "firstMateHomeRef": "/absolute/parallel-home", "timezone": "Asia/Jerusalem"
  },
  "database": "/absolute/pilot-proof/project.sqlite",
  "runDirectory": "/absolute/pilot-proof/run",
  "agentConfig": "/absolute/pilot-proof/agents.json",
  "hookRegistry": "/absolute/pilot-proof/hook-projects.json",
  "requestFile": "/absolute/pilot-proof/request.txt",
  "clientRequestId": "connection-label-1",
  "taskId": "connection-label-1",
  "repository": "/absolute/parallel-home/projects/pilot",
  "firstMate": {
    "home": "/absolute/parallel-home",
    "dataDirectory": "/absolute/parallel-home/data",
    "briefExecutable": "/absolute/firstmate-fork/bin/fm-brief.sh",
    "spawnExecutable": "/absolute/firstmate-fork/bin/fm-spawn.sh",
    "inboxExecutable": "/absolute/firstmate-fork/bin/fm-inbox.sh",
    "tasksExecutable": "/absolute/firstmate-fork/bin/fm-tasks-axi.sh",
    "mode": "local-only", "yolo": "off", "timeoutMs": 120000
  },
  "sourceFiles": [{
    "source": { "uri": "/absolute/pilot-proof/research.txt" },
    "path": "/absolute/pilot-proof/research.txt"
  }],
  "baselineEvidence": [{
    "artifact": { "uri": "git:/absolute/parallel-home/projects/pilot", "revision": "FULL_BASELINE_COMMIT_SHA" },
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

Supply original, readable research/code snapshots in `sourceFiles`. Planning agents
receive their bytes, record history and the exact captured request. These agents are
read-only and do not inspect the repository themselves. The snapshots must be enough
to establish existing behavior, reuse and the actual gap. External references in
generated designs and tasks need matching local snapshots for brief preparation.

Set `agentConfig` using `fixtures/workflow-agents.json`, with the matching project
ID and absolute installed harness executables. `understand`, `design`, `plan`,
`detail`, `plan_check`, `instruction_check`, `build` and `product_review` each select
their own harness, provider, model and effort. The run path requires all eight;
older callers of the individual commands can continue using the original six.
Supported native harnesses are Codex and Claude, with the existing effort/provider
validation. Unsupported profiles fail before capture or dispatch. Build flags go to
real `fm-spawn.sh`; planning and review use fresh one-shot processes. All review
calls are separate from the build worker even when they select the same model.
There are no agent calls for mechanical capture, mapping, rendering or transport.

## Execute the path

Run these commands only when a live run has been authorized:

```sh
/absolute/software-factory/scripts/run-feature.mjs prepare /absolute/pilot-proof/run.json
/absolute/software-factory/scripts/run-feature.mjs start   /absolute/pilot-proof/run.json
# FirstMate supervises its worker through the normal return/delivery workflow.
# After worker-return.json and the existing exact-commit technical result exist:
/absolute/software-factory/scripts/run-feature.mjs review  /absolute/pilot-proof/run.json
```

The phases call the existing CLI and FirstMate commands in this order:

| Phase | Commands and evidence |
| --- | --- |
| Prepare | `init`, `capture`; `understand` agent generates a full-request `map` and the `understand` input; `design`; `plan`; `detail`; independent `plan_check` agent; `check-plan`; `queue-task`; `reconcile-task` through the configured real `fm-tasks-axi.sh`; real `fm-brief.sh`; `prepare-brief`; independent `check-brief` |
| Start | Verify the operator-installed hook and project registry; `deliver` through real `fm-inbox.sh` to announce the captured request; real `fm-spawn.sh` with the `build` profile; FirstMate invokes a fresh `worker.start.before` instruction check before starting its worker |
| Worker return | Worker commits code, verifies acceptance and writes `worker-return.json` at the assignment's return location, preserving the scaffold's delivery contract; FirstMate owns worker supervision, task state and delivery |
| Review | `review-product` imports worker results, reads the actual committed code and existing exact-commit technical evidence, then calls a separate `product_review` agent against the original request, design and detailed plan |

Stage agents return the existing `RecordStageInputSchema`; Understand also returns
`MapRequestInputSchema`. Their prompts include the runtime JSON schemas and complete
record context. The run path rejects multiple features, multiple tasks and plan
dependencies; use the existing individual commands for larger plans. A failed plan
review stops before queueing. Readiness, context and semantic checks retain their
existing failure behavior. No UI, scheduler or alternate record store is added.

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

Each phase has an exclusive `.started` marker. A second call cannot silently repeat
capture/planning or spawn another worker. Inputs, profile selections, agent outputs,
CLI stdout/stderr and `prepared.json` remain under `runDirectory`; the manifest binds
later phases to the same parsed run configuration. There is no automatic retry after
an ambiguous FirstMate effect. Inspect the saved output and use the existing
`outbox`/`reconcile-task`, idempotent command replay and FirstMate recovery commands
to reconcile the original operation. Do not delete a start marker and blindly
launch again. After incomplete product review, inspect its saved input and receipt,
then use `review-product` directly with a new review key if fresh evidence is needed.

## Worker-start hook

The executable `scripts/worker-start-before.mjs` accepts the absolute path of an
operator-controlled project registry as its only argument and reads FirstMate's
version 1 event JSON from stdin. Create the registry outside the repository:

```json
{
  "version": 1,
  "projects": [{
    "home": "/absolute/parallel-home",
    "projectId": "pilot",
    "database": "/absolute/pilot-proof/project.sqlite",
    "agentConfig": "/absolute/pilot-proof/agents.json"
  }]
}
```

The operator can add this entry to **that parallel home's** `config/hooks.json`:

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
plus local checks, within FirstMate's 900-second before-hook limit. Each dispatching
home needs its own entry. For the scripted start, the entry must use these exact
two absolute argv paths; the full hook runner still validates the configuration.

Lookup canonicalizes home paths (including symlink aliases) and uses the event's
`home` and `task_id` against canonical task mappings and
assignments in configured project databases. The brief cannot label itself unmanaged.
A task with no matching managed records passes without calling an agent. A managed
task with missing/ambiguous assignment, unavailable database, stale context, altered
sidecar/source, invalid event or unavailable reviewer fails closed. Registry entries
must remain available while their managed tasks can launch or relaunch.

The hook reads `source_brief_path` and the **actual** `brief_path` candidate and
verifies its `brief_sha256`. It requires exactly one preserved source brief and
checks its saved scaffold, assignment metadata, sidecar and source revisions. It
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
directory, `sf-milestone-1/`. They take the parallel home, FirstMate fork, project,
profiles and delivery settings from configuration. The live script is deliberately
not run as part of this milestone; it creates no home, enables no hook and migrates
no existing workspace. A successful fake test is not evidence of a live model or
Beads integration run.
