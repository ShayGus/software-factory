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
ID and generation. An observed new generation for the recorded repository
confirms launch; an empty, stale, malformed or unknown snapshot cannot authorize
another spawn. Missing metadata for an in-flight or orphaned target, or an explicitly invalid inventory without a trustworthy target generation, also prevents launch. An existing generation before a new launch requires an explicit
operator decision/new attempt. The one-feature runbook uses this same path.

Corrections carry a unique operation ID in the exact transport payload. After an
ambiguous send, `deliver-correction` checks a fresh fleet snapshot and the recorded
task's durable `.inbox/*.msg` and `.inbox/handled/*.msg` records for that exact
payload. A matching message proves delivery, not acknowledgement or incorporation.
Acknowledgement and artifact incorporation still require their existing separate
evidence. Missing records keep the outcome unknown and never cause an automatic
resend. Lifecycle actions record the pre-action generation and endpoint liveness. Relaunch requires a new generation; interruption and cancellation recovery require a previously observed live endpoint to be freshly confirmed absent on the same generation. Crew `done` or `failed` states can describe quality jobs and never prove endpoint cessation. Cancellation uses the same observation rule before any repeated exit request; it never fabricates `done`.

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
operations. Missing, changed or unresolved artifacts keep the gate closed. If a missing file had no recorded content digest, supplying the file yields `verification_required`. Use `verify-restored-artifact --db <db> --input <verification.json>` with `projectId`, absolute `path`, the expected SHA-256 `digest`, and nonempty verification `evidence`. It checks the supplied bytes and persists their identity and evidence before reconciliation can continue. It cannot replace a known backup digest. Once artifacts
are available, `reconcile-project` reads a fresh fleet snapshot and every recorded
mapping/assignment/external-attempt ID through the backlog wrapper before lifting
the gate. No pending mutation runs during these reads. The restore CLI invokes
this observational reconciliation automatically; it never invokes a pending mutation. Once reconciliation succeeds, the temporary restore artifact gate is retired; verification remains in history and normal regenerated briefs are not compared against old backup bytes on a later re-enable. A backup of a disabled project remains disabled until an explicit re-enable. Commands return nonzero when restoration/reconciliation remains incomplete, a start is unknown, or handback reports an error.

## Disable and handback

`disable-project --db <db> --project <id> --mode pause` commits disable and retires
all unfinished operation intents atomically. Existing labelled toolkit holds
remain. Active FirstMate execution continues.

`--mode hand_back --adapter-config <tasks.json>` also removes holds only when the
reason exactly matches the mapping's toolkit ownership marker and the hold is
permanent. It removes a configured toolkit guard dependency only when the mapping's
persisted installed-dependency list proves ownership. Other holds and dependencies
remain. Outstanding product conditions are stored on the project. Errors are
reported per task; repeating handback reads before converging, so a lost unhold
result is safe. Disable never invokes worker stop or cleanup.

Disabled projects bypass the opt-in instruction hook so ordinary FirstMate
execution remains available. Restoring/reconciling projects fail closed. Re-enable
uses `reconcile-project` and always observes both FirstMate interfaces before
allowing fresh explicit operations. Retired intents remain permanently suspended;
they do not replay on re-enable. A new task intent may explicitly replace a retired
intent. For a suspended, unattempted steering or lifecycle correction, explicitly queue the existing correction ID with a new idempotency key, its current expected revision, the same payload/recipient/order and `readdress: true`. This archives the retired delivery intent and creates a replacement without changing the correction identity. Task-producing and cancellation corrections retain BUILD-08 task reconciliation and cannot use this transport replacement. An ambiguous prior send cannot be replaced: after re-enable, `deliver-correction` only observes its recorded payload/generation, with no external retry, so a confirmed prior delivery can satisfy incorporation normally. Existing product evidence and correction incorporation requirements remain.

## Compatibility and validation

The adapter follows the BUILD-01 installed-interface evidence: FirstMate
`ed1eb1d7`, tasks-axi 0.2.6 flat TOON task details and JSON mutation receipts,
`fm-fleet-snapshot.v1`, and numbered durable steering inbox files. This is an
exercised contract, not a universal compatibility claim. The tests use fake
wrappers only, including actual toolkit process termination immediately after
external success. They do not call the installed FirstMate scripts, any model,
network service, or Herdr lifecycle commands.
