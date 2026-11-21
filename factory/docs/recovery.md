# Recovery and incremental adoption (BUILD-15)

Software Factory remains a parallel, opt-in extension. It uses the existing
project store, operation receipts, task mappings and correction records. It does
not migrate a FirstMate workspace or install hooks, change settings, select
workers, or schedule work.

## Unknown outcomes

`reconcile-task` reads the original task ID through the configured
`fm-tasks-axi.sh show <id> --full` wrapper before every attempt. Only its explicit
`NOT_FOUND` response proves absence. Task creation preserves the mapping marker;
a colliding ID is rejected. A timeout or malformed output is unknown.

`start-worker` accepts a WorkerStartInput JSON object (`projectId`,
`idempotencyKey`, `assignment`, `repository`, `executable`, `args`, `hookRegistry`) and a runtime
adapter (`fmHome`, optional `snapshotExecutable`, `timeoutMs`,
`maxObservationAgeMs`). The default snapshot executable is
`<fmHome>/bin/fm-fleet-snapshot.sh`. Its intent and in-flight marker are saved
before spawn. Every fresh launch requires the configured native hook and runs the same worker-start checker against the prepared brief, dispatch context and independent instruction check. The native hook still checks FirstMate’s final launch candidate and overlays. Missing hook configuration or a rejected check prevents launch. Repeating the same input after a crash observes the original task
ID and generation, even if a correction has advanced the assignment revision. Hook settings and the project registry are checked again after instruction judgment before a fresh launch. An observed new generation for the recorded repository
confirms launch; an empty, stale, malformed or unknown snapshot cannot authorize
another spawn. Missing metadata for an in-flight or orphaned target prevents launch.
An invalid inventory without a trustworthy target generation also prevents launch, except when the target is explicitly queued and the only inventory gaps are identified in-flight records for other tasks.
An existing generation before a new launch requires an explicit
operator decision/new attempt. The one-feature runbook uses this same path.

If the start check refused and the operation recorded no external attempt, correct the brief through `prepare-brief`.
For a changed FirstMate scaffold, generate it in a scratch data directory and pass its absolute path as `scaffoldPath` in the saved prepare input.
Keep the original assignment, attempt, plan, task, return location and native brief path.
Set `expectedRevision` to the current assignment revision and use a new preparation idempotency key.
After successful preparation, repeat `run-feature.mjs start` with its original run configuration and task ID, or replay the original `start-worker` input.
The existing start operation checks the new revision, records that exact revision if dispatch begins, and keeps the original start receipt.

Corrections carry a unique operation ID in the exact transport payload. After an
ambiguous send, `deliver-correction` checks a fresh fleet snapshot and the recorded
task's durable `.inbox/*.msg` and `.inbox/handled/*.msg` records for that exact
payload. A matching message proves delivery, not acknowledgement or incorporation.
Acknowledgement and artifact incorporation still require their existing separate
evidence. Missing records keep the outcome unknown and never cause an automatic
resend. Runtime inventory completeness checks apply to launch and lifecycle
operations. An orphaned or missing worker metadata entry does not invalidate an
exact durable inbox record for the captured steering recipient.

Lifecycle actions record the pre-action generation. FirstMate's endpoint record
separates terminal presence (`exists`) from agent liveness (`agent_alive`: `alive`,
`dead`, `unknown`, `not_checked`). A preserved terminal can contain a dead agent;
an absent terminal with an unknown liveness classification is not proof of stop.
The installed fleet snapshot checks agent liveness only for local secondmates;
other workers can legitimately report `not_checked`, which remains unknown.

Interrupt keeps the agent running. Its own `fm-control` receipt must name the
recorded task and contain an adapter cancellation acknowledgement
(`interrupt-delivered ... verified=agent-alive|endpoint cancel=confirmed`). A
receipt remains useful even on nonzero process exit. A delivered key with
`cancel=unconfirmed`, endpoint changes, or crew/busy state alone cannot confirm an
interrupt. When a response is lost and no such acknowledgement is available,
recovery stays unknown and never sends another interrupt.

Cancellation recovery instead requires a fresh `agent_alive: dead` observation
on the recorded generation after the exit attempt; endpoint disappearance is
unnecessary because FirstMate exit preserves the terminal. Relaunch requires a
new generation. Crew `done` or `failed` can describe quality jobs and never prove
agent stop. None of these observations fabricates native task completion.

Adapters explicitly name their home and executable paths. `FM_*` and
`TASKS_AXI_*` addressing overrides are stripped. Fleet observations retain all
additive fields, including omissions and provenance. `generated`, `fm_home`,
backlog presence, task identity uniqueness and per-task freshness are validated.
Freshness defaults to 30 seconds and is configurable for runtime reads. Unknown
state remains unknown.

## Existing work

`legacy-import --db <db> --project <id> --adapter-config <runtime.json>` projects
existing backlog task IDs as legacy mappings. Repeated import does not duplicate
mappings. The result contains `mappings` and `omissions`: legitimate unstructured backlog rows (`structured: false`, `id: null`) remain disclosed omissions and never become task mappings. These mappings carry an explicit `importedExecution.verification = unverified`,
including tasks FirstMate says are done. Use the existing `queue-task` or
`manage-task` mapping command to progressively link a task to a feature and plan.
Linking retains the historical unverified marker. Import/linking never creates
assignments, criterion results or product reviews. Normal checks are still needed
for product verification.

## Backup and restore

`backup --db <db> --project <id> [--artifact-base <absolute-source-base>]` prints a self-contained JSON export: full store
history and receipts, plus referenced local files with original absolute paths,
SHA-256 digests and base64 bytes. Referenced repository directories are listed as excluded directories; the backup does not copy workspaces. Missing files and bytes which disagree with a
recorded artifact digest are reported by path. The store snapshot is checked
again after artifact collection; concurrent store changes require another export.
This uses a transactional logical export, not a copy of an open SQLite file. Relative local references resolve against the supplied base, which is recorded in the backup and restored project. Without a recorded base they are disclosed as unresolved references and keep restore gated. Future output destinations such as `returnLocation` are not retained-artifact obligations; only separate recorded artifact references require those files.

`restore --db <empty-db> --input <backup.json> --artifact-root <absolute-root>
--adapter-config <tasks-and-snapshot.json>` restores the closed store and files.
Original absolute artifact paths must be under the explicitly supplied root.
This supports a replacement machine with the same path layout; it does not rewrite
immutable historical references. Existing changed files are reported and not
overwritten. Parent symlinks cannot redirect writes outside the root. The JSON
store digest and each file's content digest are checked before import. A missing
manifest entry is invalid, rather than silently dropping an artifact.

The restore gate is imported in the same database transaction as the history and
receipts. Thus even a crash during file restoration cannot expose pending
operations. Repeating restore with the identical backup resumes file restoration against its matching gated import; it neither reimports history nor overwrites changed files. Missing, changed or unresolved artifacts keep the gate closed. If a missing file had no recorded content digest, supplying the file yields `verification_required`. Use `verify-restored-artifact --db <db> --input <verification.json>` with `projectId`, absolute `path`, the expected SHA-256 `digest`, and nonempty verification `evidence`. It checks the supplied bytes and persists their identity and evidence before reconciliation can continue. It cannot replace an authoritative whole-file digest. If a section-only backup captured damaged section bytes, repair the sections and use this verification command to establish the repaired file identity. Once artifacts
are available, `reconcile-project` reads a fresh fleet snapshot and every recorded
mapping/assignment/external-attempt ID through the backlog wrapper before lifting
the gate. No pending mutation runs during these reads. The restore CLI invokes
this observational reconciliation automatically; it never invokes a pending mutation. Once reconciliation succeeds, the temporary restore artifact gate is retired; verification remains in history and normal regenerated briefs are not compared against old backup bytes on a later re-enable. A backup of an interrupted restore preserves its saved enablement destination. A backup of a disabled project remains disabled until an explicit re-enable. Commands return nonzero when restoration/reconciliation remains incomplete, a start is unknown, or handback reports an error.

### Resolving an imported relative reference

If restore reports `unresolved_reference`, supply and verify that source, then run
`resolve-restored-reference --db <restored-db> --input <resolution.json>` for each
reported reference. The input contains the exact `projectId` and `reference`, an
absolute source `base`, the expected SHA-256 `digest` for a file, and nonempty verification
`evidence` (artifact identity, description and observation time). For example:

```json
{
  "projectId": "project-1",
  "reference": "evidence/spec.txt",
  "base": "/project/source",
  "digest": "sha256:<64 hex digits>",
  "evidence": [{
    "artifact": {"uri": "/project/source/evidence/spec.txt", "digest": "sha256:<64 hex digits>"},
    "description": "Recovered bytes checked against the retained source revision",
    "observedAt": "2026-11-12T13:00:00Z"
  }]
}
```

The operation verifies the file at `base/reference`, records that base and the
verified file identity, and removes only the resolved reference from the restore
gate. A whole-file digest retained in history or an original command receipt must
match the supplied whole-file hash; operator evidence cannot replace it with a new
hash. Markdown section obligations use the same current covering adoption as
context assembly. The current adoption's heading range and section hash must
match; a covering parent replaces obligations for its former child sections.
Re-adoption can update a section without making superseded snapshots live restore
requirements. Pending, unadopted observation sections remain validation obligations until adoption retires them. Those snapshots remain unchanged in history. Distinct current
sections can have different hashes without constraining surrounding content to
either section's hash; a missing or changed current covering section is rejected.
A new whole-file identity can be recorded only when no whole-file digest was retained. The recorded base must remain consistent across resolutions; a wrong digest
cannot release the gate. Historical source URIs remain intact. After every
reported reference is resolved, use `reconcile-project` with the existing task and
snapshot adapter to inspect live FirstMate state and lift the gate. This procedure
works on the already imported database and does not require deleting or replacing
its history.

For a repository directory, omit `digest` and provide evidence identifying the
existing directory (for example an artifact URI with a stable revision). When no
retained content digest is required, resolution applies the same excluded-directory
rule as backup: it verifies directory presence, records the exclusion and source
base, and adds no file-hash obligation. A directory cannot discharge a reference
that requires retained file bytes or a known digest. Workspace contents are not
copied.

## Disable and handback

`disable-project --db <db> --project <id> --mode pause` commits disable and retires
all unfinished operation intents atomically. Existing labelled toolkit holds
remain. Active FirstMate execution continues.

`--mode hand_back --adapter-config <tasks.json>` also removes holds only when the
reason exactly matches the mapping's toolkit ownership marker and the hold is
permanent. It removes a configured toolkit guard dependency only when the mapping's
persisted dependency ownership intent proves ownership. That intent is saved before guard installation, including guards protecting cancellation consumers. Other holds and dependencies
remain. Outstanding product conditions are stored on the project. Errors are
reported per task; repeating handback reads before converging, so a lost unhold
result is safe. Disable never invokes worker stop or cleanup.

Disabled projects bypass the opt-in instruction hook so ordinary FirstMate
execution remains available. Restoring/reconciling projects fail closed. Re-enable
uses `reconcile-project` and always observes both FirstMate interfaces before
allowing fresh explicit operations. Retired intents remain permanently suspended;
they do not replay on re-enable. A new task intent may explicitly replace a retired
intent. For a suspended, unattempted steering or lifecycle correction, explicitly queue the existing correction ID with a new idempotency key, its current expected revision, the same payload/recipient/order and `readdress: true`. This archives the retired delivery intent and creates a replacement without changing the correction identity. Task-producing and cancellation corrections cannot use this generic transport
replacement. After re-enable, explicitly run `recover-task-correction --db <db>
--input <recovery.json> --adapter-config <correction-adapter.json>`. The input is
`{"projectId":"...","correctionId":"...","idempotencyKey":"new-explicit-recovery-key"}`;
the adapter supplies the existing BUILD-08 `taskAdapter` and, for cancellation,
the exact fresh recipient binding. This records explicit recovery permission,
retains the original correction ID, task ID and payload, and reconciles through
BUILD-08 before any retry. An interrupted retired child operation receives a
fresh durable intent for the same native task; an already confirmed result is
reused. Repeat the recovery key to resume safely after another lost result.
Disable retires that recovery permission too, and it is checked inside the child
task lock so re-enable cannot replay it late. After a second disable, use a fresh recovery key to reconcile the suspended child for the same source intent. Recovery remains bound to the captured source operation and task digest, and carries forward a recorded cancellation exit attempt so a lost response cannot trigger another exit. An ambiguous prior send cannot be replaced: after re-enable, `deliver-correction` only observes its recorded payload/generation, with no external retry, so a confirmed prior delivery can satisfy incorporation normally. Existing product evidence and correction incorporation requirements remain.

## Compatibility and validation

The adapter follows the BUILD-01 installed-interface evidence: FirstMate
`ed1eb1d7`, tasks-axi 0.2.6 flat TOON task details and JSON mutation receipts,
`fm-fleet-snapshot.v1`, and numbered durable steering inbox files. This is an
exercised contract, not a universal compatibility claim. The tests use fake
wrappers only, including actual toolkit process termination immediately after
external success. They do not call the installed FirstMate scripts, any model,
network service, or Herdr lifecycle commands.
