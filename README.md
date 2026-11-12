# Software Factory product workflow

This TypeScript package defines the records and operation boundaries for the
FirstMate product-development workflow in [the design](Software_Factory_Design.md).
It preserves request, feature, design, detailed-plan, assignment and review identities
through one complete feature workflow. BUILD-03 adds local SQLite persistence.
BUILD-04 adds CLI intake, source mapping, a standalone Claude Code chat hook,
configuration-based capture coverage and an explicit FirstMate inbox delivery adapter.
BUILD-06 adds staged understanding, design, planning, detail, reuse and readiness checks.
BUILD-08 connects managed tasks and product prerequisites to FirstMate's existing task wrappers.
The [one-feature run path](docs/one-feature-run.md) connects these commands to real
FirstMate brief/start wrappers and its worker-start hook. It does not implement a
scheduler, production UI/HTTP service, tasks-axi changes or a Beads adapter; the
FirstMate home given in the settings selects Beads through FirstMate's existing task wrapper.
Bootstrap the project database before enabling the sample hook; the runbook then
verifies the hook before creating or releasing managed native work.

Node.js 22.13.0 or later is required. Install and verify with:

```sh
npm ci
npm test
npm run typecheck
```

`npm run build` emits JavaScript and TypeScript declarations under `dist/`.
The package entry point is `dist/src/index.js`. The only runtime dependency is
[Zod](https://zod.dev/basics), pinned in the lockfile. Zod provides runtime parsing,
path-specific errors and inferred TypeScript types from the same schema, avoiding
separate interface and validator definitions. It is MIT licensed and runs locally.
No network, paid service or database server is required at runtime or for tests.

The BUILD-05 canonical-routing tests are self-contained. The additional local
backend check is opt-in: `npm run test:beads-spike` uses a fake bd process with
the existing tasks-axi main source at
`/home/shayg/fm-homes/linux-mate/projects/tasks-axi` and the runtime dependencies
from a `tasks-axi` install on `PATH`. Those are optional prerequisites, not
requirements for `npm ci`, `npm test`, or type checking. This check never opens
a real Beads database or starts Docker. See [the UI spike report](docs/ui-beads-scotty.md).

## Record contracts

Every schema is exported, along with its inferred TypeScript type. Every record has
`kind`, opaque stable `id`, `projectId`, `schemaVersion: 1`, positive integer
`revision`, `createdAt` and `updatedAt`. Timestamps are ISO 8601 with a UTC offset;
updates cannot precede creation. A project names itself as its `projectId`.
All objects reject unknown keys. Schemas do not trim, rewrite or coerce source text.

| Design section 4 record | Export |
| --- | --- |
| Project | `ProjectSchema` |
| Request | `RequestSchema` |
| Feature revision | `FeatureRevisionSchema` |
| Criterion | `CriterionSchema` |
| Design revision | `DesignRevisionSchema` |
| Implementation plan revision | `ImplementationPlanRevisionSchema` |
| Detailed plan task | `DetailedPlanTaskSchema` |
| Task mapping | `TaskMappingSchema` |
| Assignment | `AssignmentSchema` |
| Criterion result | `CriterionResultSchema` |
| Product review | `ProductReviewSchema` |
| Measurement/report claim | `MeasurementClaimSchema` |
| Decision/change | `DecisionChangeSchema` |
| Observation | `ObservationSchema` |
| Guidance revision | `GuidanceRevisionSchema` |
| Operation | `OperationSchema` |
| Understanding revision (BUILD-06) | `UnderstandingRevisionSchema` |
| Method stage selection (BUILD-06) | `StageRevisionSchema` |
| Deterministic readiness result (BUILD-06) | `PlanReadinessRevisionSchema` |

`RecordSchema` is the discriminated union, and `RecordsSchema` parses arrays.
Record references are `{ id, revision }`; artifact identities are
`{ uri, revision? , digest? }`, with at least a revision or digest required.
URI fields accept repository paths and other reachable references, not just HTTP
URLs. Artifact revisions and FirstMate IDs are opaque strings; toolkit record
revisions are integers. A record revision is never a FirstMate run ID.

`CriterionSchema` defaults `requirement` to `required`. A standalone maintenance
task has `feature: null`, empty `criteria` and an explicit `maintenanceObjective`.
Its design, plan, managed mapping and assignment also use `feature: null` and link
the exact applicable revisions. Legacy mappings can also omit the detailed task
reference. Unclassified requests remain representable.

A standalone maintenance design links its original request revisions through
`sourceRefs[].record`. Its source comparison, the plan comparison and assignment
instruction comparison must cite those requests. A maintenance result uses
`criterion: null` and links its objective through the assignment's exact detailed
task revision. Its product review and `record_review_result` command use
`feature: null`. Passing maintenance reviews require passing results for every
reviewed assignment, reviewed artifact identities, source comparisons and
baseline/improvement evidence.

The named state enums are exported from `src/primitives.ts`. Wire values use
underscores for spaces. Feature progress (`requested` through `complete`) and method
stage (`understanding` through `product_review`) are separate from observed execution.
`deferred` and `cancelled` are dispositions requiring a reason and selected decision.
They are never fabricated tasks-axi states. A correction records its action,
assignment, affected revision, sequence, supersession and independently evidenced
`recorded`, `delivered`, `acknowledged`, `incorporated` facts; acknowledgement does
not add incorporation.

## Validation and revision rules

```ts
import {
  validateRecords, validateAssignmentForDispatch, validateReviewForCompletion,
} from '@software-factory/contracts';

const checked = validateRecords(untrustedRecords);
if (!checked.ok) {
  console.error(checked.issues); // code, recordId, path, message
} else {
  const dispatch = validateAssignmentForDispatch(checked.data, {
    id: 'assignment-1', revision: 1,
  });
  const completion = validateReviewForCompletion(checked.data, {
    id: 'review-1', revision: 1,
  });
}
```

Supply a **closed reference context**: the project and all referenced records,
including historical revisions. This is validation input, not a persistence design.
Record-local `Schema.parse` checks structure; `validateRecords` also checks links:

- Unknown criterion IDs, missing references, wrong record kinds, cross-project links
  and duplicate ID/revision pairs fail.
- Assignments name the exact feature/design/plan/task revisions. Those references
  must agree with the linked records, even when both conflicting revisions exist.
  Assigned criteria must match the detailed task; ready plans collectively cover
  active required criteria. Plan dependencies must name tasks in delivery order.
- Reviews use the original request references, matching design/plan/task/assignment
  revisions, assigned result revisions and the actual reviewed artifact identities.
  Results cannot claim an unassigned criterion or silently close a later revision.
- Feature revisions after revision 1 name their immediate predecessor. Removing,
  demoting or deferring an active required criterion needs a linked **selected**
  decision with the criterion ID, feature ID, old/new revisions and change action.
  A proposal or a decision for a different transition does not authorize the change.
- Source capture fields remain immutable across request revisions. Corrections are
  additional records. Stable record identity and creation time remain intact.

`assertExpectedRevision(expected, actual)` checks optimistic revision expectations;
`0` means creation and `actual: null` means absent. `assertRevisionTransition(before,
after)` requires the same identity, one revision increment, ordered timestamps and
preserved original request capture. `ProjectStore` performs these checks atomically
with writes and retains history; the standalone functions do not supply storage atomicity.

Failed comparisons and failed/incomplete reviews are valid historical records.
Storing them must not accidentally mean dispatch or completion is permitted:

- `validateAssignmentForDispatch` also requires passing instruction fidelity, a
  ready plan, a source-compared design, a matching active current task mapping,
  required request/design/plan/task context, the current assignment revision,
  and an active current feature with unchanged scope for feature assignments.
  Generated assignments also require their full selected context. `check-brief`
  additionally checks actual files and obtains a fresh agent judgment for a start.
- A review claiming `outcome: passed`, and `validateReviewForCompletion`, require
  current passing evidence for every active required criterion, passed source,
  instruction and plan comparisons, no unresolved product questions, and evidence
  of the requested improvement. Each passing comparison cites the exact design,
  plan and detailed task revisions named by the review.

**Semantic limit:** these validators do not understand natural-language scope.
`ComparisonSchema` records the separate reviewer/source-comparison action with its
sources, findings, reviewer session and time. A passing comparison cannot hide
unresolved findings, and original request references are required. An omitted
requirement that has never been identified in criteria still requires comparison
with the original text. BUILD-07 uses an agent to judge instruction meaning, with
mechanical checks kept separate; BUILD-10 owns product review. A schema
cannot certify that a reviewer told the truth.

The ERPNext fixtures deliberately keep both criterion IDs in the narrowed assignment.
The source-comparison finding rejects dispatch. A separate completion fixture retains
passing technical QA but rejects the missing general behavior. This does not pretend
that a string match on “ERPNext” proves semantic fidelity.

## Operation envelopes

`CommandEnvelopeSchema` is a strict discriminated union for every operation family
in section 8. Each family has its own typed payload:

| Section 8 operation | `command` |
| --- | --- |
| Capture request | `capture_request` |
| Design/plan feature | `design_plan_feature` |
| Record decision/suggestion | `record_decision_suggestion` |
| Map/manage execution task | `map_manage_execution_task` |
| Prepare assignment | `prepare_assignment` |
| Deliver correction | `deliver_correction` |
| Record/review result | `record_review_result` |
| Capture/consolidate learning | `capture_consolidate_learning` |
| Read project state/export | `read_project_state_export` |

All envelopes carry `schemaVersion`, transport `id`, `projectId`, `issuedAt` and
`idempotencyKey`. Mutations also carry the canonical `targetId` and `expectedRevision`
of that target; creation uses revision zero. Multi-record design/plan input carries
additional `expectedRevisions`. Read/export has no mutation revision requirement.
Payloads are operation inputs, not invented shell commands or FirstMate API outputs.
Parsing does not execute the requested action or validate it against a store.
Application handlers must validate the assembled record context and check all expected
revisions before committing changes.

`commandDigest` hashes canonical command meaning using SHA-256, including project,
command, target, expected revision and payload. Object key order, transport ID,
issuance time and idempotency key do not affect the digest; source text and array
order do. `assertIdempotencyReuse` rejects a different project/key/command/digest.
`ProjectStore` owns the durable project/key uniqueness check and replay result.
An ambiguous external operation must not be retried merely because a subprocess timed out.

Operations preserve `pending`, `succeeded`, `failed` or `unknown` plus external
references and optional evidenced reconciliation. `BoundaryErrorSchema` defines
structured `validation`, `conflict`, `not_found`, `external_failure` and
`unknown_outcome` information. This package does not invent successful outcomes.

## FirstMate evidence and fixtures

BUILD-01's installed interface map and source samples were read from:

- `/home/shayg/fm-homes/linux-mate/data/sf-build-01/report.md`
- `/home/shayg/fm-homes/linux-mate/data/build-01-fixtures/`

`fixtures/firstmate/` includes exact JSON payloads extracted from the captured
`fm-inbox-note.v1` created/replay responses and tasks-axi add/dependency/hold/start/done
responses. The filename in each wrapper names its source sample. These deliberately
limited boundary schemas claim only the exercised shapes, not universal FirstMate
compatibility. The negative cancelled-state fixture mutates an actual task sample.

The ambiguous observation preserves this exact captured line:

```text
state: unknown · source: run-step · selected run code identity unverified; run ids: 01M6VG9461W93JFHANWM4248QJ, 01M6SEHBPQB2DDZNW858EN701T, 01M6S5DASCMXR2ZDTFYTYB3SJ9
```

`ExecutionObservationSchema` is a labelled toolkit wrapper around that text with a
task ID, provenance and observation time. It is not represented as a FirstMate JSON
result. `executionStateToken` preserves its token, including `unknown`; it provides
no success or product-completion inference. Other adapter output shapes should be
added only after inspecting real samples in their integration build.

`fixtures/workflow.json` is a complete **synthetic** product workflow, not evidence
of a live implementation. `fixtures/scenarios/*.json` are readable deltas over it:
record/revision selector, field path, replacement value, additional records and an
expected validation gate/error. The tests expand every delta, run schemas and graph
rules, then the requested dispatch/completion gate. The suite covers all sixteen
record types and all nine operation families, changed scope, omitted criteria,
invalid results, ambiguous execution, revision conflicts, the ERPNext case and legacy
unmapped work. Tests also verify metadata, exact source preservation, default required
criteria, revision increments and idempotency replay/conflicts. Fixtures run entirely
offline; no FirstMate commands are executed.

## SQLite persistence

`ProjectStore` uses Node's built-in [`node:sqlite` `DatabaseSync`](https://nodejs.org/download/release/v22.14.0/docs/api/sqlite.html).
It adds no package dependency or native-addon installation and fits the single local
TypeScript service baseline. Node 22.13.0 is the minimum because that version removed
the SQLite flag requirement; Node 22 still labels this API experimental. Transactions
and prepared statements use the common Node 22 API surface. Zod remains the only
runtime package dependency. Operations are synchronous; handlers must stay short.

The database has append-only record history and durable command receipts. The sixteen
BUILD-02 record kinds and three BUILD-06 method records use `RecordSchema`; there are no
parallel persistence record shapes. SQLite `user_version` identifies storage format 1;
unknown versions are rejected. This build does not supply database migrations.

```ts
import { ProjectStore, pendingOperation } from '@software-factory/contracts';

const store = new ProjectStore('/path/to/project.sqlite');
try {
  const result = store.mutate(captureCommand, (history) => {
    // A trusted application handler derives BUILD-02 records from the command.
    // Include the Project record here too if this is the project's first write.
    const requestRecord = deriveRequestRecord(captureCommand, history);
    return [requestRecord, pendingOperation(captureCommand, 'delivery-operation-id')];
  });
  // result.records contains exact { id, revision } references to the first writes.
  const backup = store.exportProject(captureCommand.projectId);
  // JSON.stringify(backup) is portable; import it with emptyStore.importProject(...).
} finally {
  store.close();
}
```

`mutate(envelope, prepare)` is a persistence primitive, not an implementation of the
nine application command handlers. `prepare` is trusted application code: derive its
records from the validated command meaning, and perform no external effects or nested
store mutations. The callback must return an array synchronously. All records must
belong to the command project. Include the intended pending operation in that same
array; it and the mutation and receipt commit together. Purely local changes need no
external operation. `pendingOperation(command, id)` creates a BUILD-02 operation with
the command digest/key and state `pending`; it does not execute anything. A new
operation must match the envelope and have no claimed external outcome.

A `BEGIN IMMEDIATE` transaction takes the write lock before checking revisions or
replay. The envelope's `targetId`/`expectedRevision` and design command's additional
`expectedRevisions` are checked against current records. The target can be an unchanged
aggregate whose revision guards writes to related records. Every proposed record also
compares `revision - 1` against its current revision (zero for creation). There is one
write per stable ID per mutation. New histories start at revision 1; updates increment
by one and retain identity, creation time, ordered timestamps and original request
capture. The complete project history plus proposed writes passes `validateRecords`
before storage. A failed validation, stale comparison, callback or database write
leaves no records, operation or receipt behind. IDs are globally stable; client request
IDs and operation keys are unique within each project.

A receipt is unique by project/idempotency key. Replays compare the BUILD-02
`commandDigest` and return the **first** result without running `prepare`, even when
the target or operation has since advanced. Transport ID/time and object key order
can change; different command meaning fails with `idempotency_conflict`. Record
references in the result resolve to the original immutable revisions, not latest state.
`StoreError.detail` follows `BoundaryErrorSchema`: stale writes use `conflict`,
schema/rule errors and key misuse use `validation`, missing exports use `not_found`.
SQLite filesystem/locking errors and application callback errors propagate unchanged.
The busy timeout is five seconds; callers can retry contention with the same command.

`history(projectId)` returns every revision, `records(projectId)` returns latest
revisions, and `get(projectId, id, revision?)` selects a current or historical record.
`operations(projectId)` returns latest operation records, including `pending`,
`succeeded`, `failed` and `unknown`. Record observed outcomes by another idempotent
`mutate` call, targeting the operation's expected revision and returning its next
BUILD-02 operation revision. Preserve its original command, key and digest; attach
external references and evidenced reconciliation as appropriate. This only records
an observation. There is no executor, retry loop, reconciler or automatic state change.

`exportProject(projectId)` takes a consistent read snapshot and returns versioned
JSON containing all record history (including operations) and command receipts with
their original envelopes/results. `ProjectExportSchema` validates the transport
container while reusing BUILD-02 schemas. `importProject(export)` accepts only a
completely empty store, checks closed references and contiguous revision history,
then imports everything in one transaction. Restore preserves pending/unknown states
and replay results without executing operations. Historical operations imported without
a receipt still reserve their keys and cannot be replayed as new work. Export contains
artifact/attachment references and their identities, not file bytes; move referenced
files separately. Missing-file reporting and live reconciliation belong to BUILD-15.

The store currently validates and reads project histories in memory. This keeps the
foundation small for the local baseline; large-project indexing/streaming is later work.
Tests use real temporary SQLite databases: close/reopen, two-connection stale writes,
repeat/conflicting keys, an injected database failure proving rollback of records plus
pending operation plus receipt, all sixteen record kinds, operation outcome history,
and JSON round trips that retain replay behavior. BUILD-02 fixtures still run unchanged.

## Feature revision decision and remaining questions

A state-only feature update **creates a new feature revision**, using the same
increment, `previousRevision`, and `changeReason` rules as any other feature update.
A transition to `complete` can use a passing review of that exact revision or
cite an earlier passing review through `completionEvidence: { review, reason }`.
Carry-forward requires unchanged feature content and disposition across the
intervening revisions. The cited review still names the original assignment,
results and delivered artifacts. The reason records why that evidence still applies.

- Which project license should accompany publication? The input repository supplied
  no license; this package does not select one on the operator's behalf.

Durable history, transactions, idempotency and pending-operation storage are implemented.
Request delivery, staged planning, assignment preparation and product review are implemented below.
General operation execution/reconciliation remains a later build.
No live FirstMate integration or full product milestone is claimed by these contract fixtures.

## Request capture CLI — BUILD-04

Build with `npm run build`, then run `node /absolute/software-factory/dist/src/cli.js
--help`. The package also exposes the `software-factory` bin entry point. All
commands return JSON, with structured errors on stderr and a nonzero exit status.
The `chat-hook` command stays silent on success so captured text is not injected
back into the conversation as hook output.

The CLI uses the same `ProjectStore`, record schemas and command contracts exported
by this package. There is no second store. Initialize a project from a canonical
`Project` JSON record (replace the home reference with the intended FirstMate home):

```json
{
  "kind": "project", "id": "pilot", "projectId": "pilot", "schemaVersion": 1,
  "revision": 1, "createdAt": "2026-11-10T11:00:00Z", "updatedAt": "2026-11-10T11:00:00Z",
  "goal": "Preserve requests through product review", "intendedUser": "Product owner",
  "priorities": [], "exclusions": [], "vocabulary": {},
  "repositories": [], "designRefs": [],
  "firstMateHomeRef": "/absolute/firstmate-home", "timezone": "Asia/Jerusalem"
}
```

Save that as `/tmp/project.json`. For the following examples, set `factory_cli` to
the built CLI's absolute path. Put the exact request in `/tmp/request.txt`; file
input and stdin preserve spaces, line endings and trailing newlines.

```sh
factory_cli=/absolute/software-factory/dist/src/cli.js
node "$factory_cli" init --db /tmp/pilot.sqlite --input /tmp/project.json
node "$factory_cli" capture --db /tmp/pilot.sqlite --project pilot \
  --client-request-id owner-message-001 --channel cli --source file:/tmp/request.txt \
  --captured-at 2026-11-10T12:00:00Z --text-file /tmp/request.txt
```

Use `--text-file -` to read stdin. `--captured-at` is optional and defaults to the
capture time. Capture commits the immutable `Request`, a pending `capture_request`
`Operation`, and the idempotency receipt in one SQLite transaction. Request IDs are
deterministic and project-scoped. The same client request ID and payload replay;
changed text, channel, source, attachments or an explicitly changed capture time
conflict. A correction is additional source/decision content, never an edit to
`originalText`. A new user message gets a new client request ID.

### Map content and inspect omissions

For an exact request `Export every system.\nKeep history.\n`, this mapping creates
an initial feature and criterion for the first line only. Save it to
`/tmp/mapping.json`, replacing `requestId` with the ID returned by capture:

```json
{
  "projectId": "pilot", "requestId": "<returned request ID>",
  "expectedRevision": 1, "idempotencyKey": "classify-export-001",
  "issuedAt": "2026-11-10T12:01:00Z", "start": 0, "end": 21,
  "rationale": "Separate export from the history requirement",
  "target": {
    "kind": "new_feature",
    "feature": {
      "id": "export-all-systems", "outcome": "Export every connected system",
      "criteria": [{
        "id": "export-each-system", "expectedBehavior": "Export every connected system",
        "verificationMethod": "Exercise two different connected systems"
      }]
    }
  }
}
```

```sh
node "$factory_cli" map --db /tmp/pilot.sqlite --input /tmp/mapping.json
node "$factory_cli" coverage --db /tmp/pilot.sqlite --project pilot --request '<returned request ID>'
node "$factory_cli" unclassified --db /tmp/pilot.sqlite --project pilot
```

Offsets are zero-based, half-open UTF-16 indices, as in JavaScript `text.slice(start,
end)`. Every original character counts, including whitespace. A range containing
only whitespace can be classified independently. The coverage output
contains exact mapped excerpts, feature/criterion revision references and exact
unmapped ranges. In this example, `Keep history.\n` remains visible in both coverage
and the unclassified view. Overlapping mappings may associate one passage with
several features; coverage counts their union. A completely mapped request leaves
the unclassified view. This reports structural links; `semanticReview:
"not_performed"` explicitly leaves interpretation quality for source comparison.

Use `target: { "kind": "feature", "feature": { "id": "...", "revision": 1 },
"criteria": [{ "id": "...", "revision": 1 }] }` to link an existing feature and
its criteria. They must belong to the same project and feature revision, and the
feature must name this source request. Use `target: { "kind": "disposition",
"disposition": "clarification" }` for a passage that is not feature work. Other
values are `deferral`, `duplication`, and `non_work_conversation`. These classify
source content; changing a feature's scope or lifecycle is a separate operation.

To correct a mapping, submit a new mapping with a new `idempotencyKey`, the current
request's `expectedRevision`, a nondecreasing `issuedAt`, an `originalInstruction`
containing the correction verbatim, and `replaces: [{ "id": "<old mapping decision
ID>", "revision": 1 }]`. Replaced decisions remain in history, while only the new
links contribute to current coverage. Replacing a large range with a smaller one
exposes the remainder as unmapped. Do not overwrite the original request with the
correction. Capture a new correction message separately if it also needs inbox
delivery; assignment steering belongs to BUILD-09.

Mappings extend the existing `DecisionChange` record with optional
`requestMapping` metadata (source request revision, range, disposition, feature,
criteria and replaced decisions). They use `record_decision_suggestion` commands;
optional canonical `intakeRecords` in that command contain an initial feature and
criteria so all content participates in its payload digest and atomic write. The
request's disposition links select the current mapping decisions. Its aggregate
disposition is `unclassified` while any text is unmapped, `work` for fully mapped
content containing work, or the sole non-work disposition. Fully mapped content
with several non-work dispositions retains the aggregate `unclassified` token;
the per-range report and unclassified view use actual range coverage.

Initialization compares the complete canonical project record when checking a
replay. Capture and mapping replays return the revisions written by the original
mutation. Use `coverage` or `outbox` to read current coverage or delivery state.

### Deliver through the FirstMate inbox

Capture queues delivery; it does not contact FirstMate. Inspect and deliver it
explicitly:

```sh
node "$factory_cli" outbox --db /tmp/pilot.sqlite --project pilot
node "$factory_cli" deliver --db /tmp/pilot.sqlite --project pilot \
  --request '<returned request ID>' --fm-home /absolute/firstmate-home
```

`--fm-home` must be explicit and absolute. The adapter executes
`<fmHome>/bin/fm-inbox.sh note --request-id <toolkit-request-id> --json -`
with the exact text on stdin and that `FM_HOME`, using a literal argument array
without a shell. Stdin also preserves flag-like text and large prompts. Inherited
`FM_*` variables are removed before setting the explicit `FM_HOME`, preventing
ambient state, root or wake-queue overrides from redirecting delivery. To use scripts
from a separate installation with a scratch home, pass an absolute
`--inbox-executable /absolute/installation/bin/fm-inbox.sh`. The project-scoped
toolkit request ID prevents client-ID collisions between projects in the same
FirstMate inbox.

The adapter validates the returned `fm-inbox-note.v1` JSON, matching request ID,
and `saved: true`. It records the note ID, path and full receipt in a new operation
revision. `outcome: "replay"` is success and refers to the existing note. Repeated
delivery of a succeeded operation performs no new subprocess call. A nonzero exit without a valid saved receipt, a timeout, malformed response or
wrong request ID remains an explicit `unknown` outcome; an executable that cannot start is `failed`. Retrying `deliver` uses the
same request ID, so a save followed by a failed process or local commit reconciles
through FirstMate's replay path. Keep using the same home when retrying.

`saved: true, announced: false` means the note exists but its alert needs recovery.
The saved receipt is recorded as success even when FirstMate exits 3 for that
announcement failure.
Use the existing FirstMate command `FM_HOME=/absolute/firstmate-home
/absolute/installation/bin/fm-inbox.sh announce <returned-note-id>` to repeat the
alert. Do not capture another request. The persisted receipt retains the original
announcement observation; this toolkit does not infer later alert acknowledgement
or product completion. Delivery is transport, not implementation evidence.

Adapter compatibility is based on BUILD-01 samples `01a`/`01b`/`01c` from FirstMate
commit `ed1eb1d7`. Tests use a contract double inside a temporary FirstMate home,
including save-then-fail/replay recovery; they never execute against the real
FirstMate home. No FirstMate files, supervisor settings, task lifecycle or Beads
records are modified by this package.

### Standalone Claude Code chat capture

`chat-hook` reads a Claude Code `UserPromptSubmit` JSON event from stdin. It stores
the `prompt` verbatim with channel `chat`, and uses `session_id` and
`transcript_path` as provenance without reading the transcript. When present,
`prompt_id` supplies a stable per-turn client ID; the same prompt in a later turn
is a distinct request. Older events without `prompt_id` receive a fresh ID per
invocation. For a controlled retry of such an event, supply the same explicit
`--client-request-id` each time. Text alone is never a deduplication key.

The event fields and command-hook layout follow the official
[Claude Code hooks reference](https://code.claude.com/docs/en/hooks#userpromptsubmit).
Generate the exact settings snippet for this project/database:

```sh
node "$factory_cli" hook-settings --db /tmp/pilot.sqlite --project pilot
```

The output has this shape, with absolute paths filled in:

```json
{
  "hooks": {
    "UserPromptSubmit": [{
      "hooks": [{
        "type": "command",
        "command": "'/usr/bin/node' '/absolute/software-factory/dist/src/cli.js' 'chat-hook' '--db' '/tmp/pilot.sqlite' '--project' 'pilot'",
        "timeout": 10
      }]
    }]
  }
}
```

This command only prints JSON. Installation is an explicit configuration action
outside this task; no settings file is edited. The hook captures locally and
queues delivery, so inbox availability does not delay the prompt. Use `outbox`
and `deliver` for the pending notes. Errors return nonzero and are written to
stderr; an event that fails capture is not preserved. The hook neither enables
nor depends on FirstMate's background supervisor or existing host-mirror hook.

### Report entry-channel coverage from configuration facts

```sh
node "$factory_cli" channels --db /tmp/pilot.sqlite --project pilot
node "$factory_cli" channels --db /tmp/pilot.sqlite --project pilot \
  --settings /absolute/project/.claude/settings.json
```

| Entry channel | Reported capture | Configuration fact |
| --- | --- | --- |
| CLI | Manual | A user or integration must invoke `capture`. |
| Chat without supplied enabled hook evidence | Manual fallback | `capture --channel chat` is available; automatic chat capture is not verified. |
| Chat with the generated unconditional command | Automatic in inspected configuration | An exact command match names this CLI, database and project, with no async/conditional execution or hook disabling. |
| FirstMate inbox | Manual fallback | No inbound importer is implemented; explicitly capture a note's exact text and source with `--channel firstmate_inbox`. Sending an outbox note does not capture other inbox entries. |

`--settings` is read-only and repeatable. The report lists each inspected path,
parse/read errors, matching hook configuration and disabling facts. Any inspected
`disableAllHooks: true` or unreadable/invalid settings prevents an automatic claim.
It recognizes the generated command exactly; arbitrary shell wrappers and
conditional hooks remain unverified. No supplied settings means no installed-hook
evidence. Other scopes, policy, runtime hook acceptance and successful execution
are not verified, and the report says so. This configuration report does not claim
that every historical conversational request was captured.

BUILD-04 verification covers immutable original text across mapping/correction,
visible omitted ranges, all dispositions, stale-write rejection, atomic capture,
CLI round trips, hook idempotence and channel coverage with no hook installed.

## Staged design and planning — BUILD-06

The local CLI and exported application functions now record Understand, Design, Plan,
Detail and deterministic readiness checks in the BUILD-03 store. They use the existing
`design_plan_feature` operation family and its idempotency/CAS rules. These commands
make no model, network, FirstMate, worker-dispatch or task-manager calls.

```sh
software-factory understand --db /absolute/path/project.sqlite --input /absolute/path/understand.json
software-factory design     --db /absolute/path/project.sqlite --input /absolute/path/design.json
software-factory plan       --db /absolute/path/project.sqlite --input /absolute/path/plan.json
software-factory detail     --db /absolute/path/project.sqlite --input /absolute/path/detail.json
software-factory check-plan --db /absolute/path/project.sqlite --input /absolute/path/check.json
software-factory findings  --db /absolute/path/project.sqlite --project project-1 --plan plan-new
software-factory stages    --db /absolute/path/project.sqlite --project project-1 --feature feature-1
```

Every stage input follows `RecordStageInputSchema` (`recordStage(store, input)`):

```json
{
  "idempotencyKey": "understand-feature-1",
  "expectedRevision": 0,
  "issuedAt": "2026-11-10T10:36:43Z",
  "stage": {
    "kind": "stage_revision", "id": "stage-understand", "projectId": "project-1",
    "schemaVersion": 1, "revision": 1,
    "createdAt": "2026-11-10T10:36:43Z", "updatedAt": "2026-11-10T10:36:43Z",
    "stage": "understand", "feature": { "id": "feature-1", "revision": 1 },
    "sourceRequests": [{ "id": "request-1", "revision": 1 }],
    "criteria": [{ "id": "criterion-general", "revision": 1 }],
    "artifact": { "id": "understand-1", "revision": 1 },
    "changeReason": "Research the existing message flow"
  },
  "records": [{
    "kind": "understanding_revision", "id": "understand-1", "projectId": "project-1",
    "schemaVersion": 1, "revision": 1,
    "createdAt": "2026-11-10T10:36:43Z", "updatedAt": "2026-11-10T10:36:43Z",
    "feature": { "id": "feature-1", "revision": 1 },
    "sourceRequests": [{ "id": "request-1", "revision": 1 }],
    "criteria": [{ "id": "criterion-general", "revision": 1 }],
    "goal": "Correct the ERPNext error message",
    "userBehavior": "Read the correct message after the existing error",
    "terms": { "error": "The existing connection failure" },
    "priorities": [], "examples": [], "exclusions": ["No changes to connection behavior"],
    "existingWork": [{ "source": { "uri": "repo://connection-errors" }, "finding": "The error flow already works" }],
    "openUnknowns": [],
    "scope": [{ "request": { "id": "request-1", "revision": 1 }, "term": "ERPNext", "role": "entire_scope" }],
    "changeReason": "Initial investigation"
  }]
}
```

This example assumes intake has already created the named feature, criterion and
request with ERPNext in its original text. Each subsequent stage names its predecessor
through `previousStage: {id, revision}`. `expectedRevision` applies to the stage ID;
each supplied artifact also undergoes the store's revision checks. Use revision 1
and expected revision 0 for a new stage, then increment both appropriately. Reusing
a key with a changed payload fails, and a replay returns the original receipt.

| Stage | Selected artifact | Content added to the existing contracts |
| --- | --- | --- |
| `understand` | `UnderstandingRevisionSchema` | Goal, user behavior, vocabulary, priorities, examples, exclusions, researched existing work, explicit unknowns, request scope roles |
| `design` | `DesignRevisionSchema` | `workflow.understanding`; `workflow.reuse` with `alreadyWorks`, `gap`, `change`; `workflow.scope`; `workflow.changeReason`. Existing behavior, technical design, source comparison and decision references remain canonical. |
| `plan` | `ImplementationPlanRevisionSchema` | `workflow.slices` (ordered IDs, behavior, criteria and task refs), `scope`, `integrationSteps`, `finalVerification`, `retainedTasks`, `changeReason`. Existing execution strategy, ordered tasks, real dependencies and priorities remain canonical. |
| `detail` | The selected plan or a later revision of it | Detailed task revisions containing behavior, design references, `decisionsToKeep`, boundaries, reuse targets, inputs, outputs, blockers, acceptance cases, `verificationMethod` and return requirements |

At Plan, include linked draft tasks in `records` alongside the plan, using
`draft: true` and their feature/design/plan/criterion references. At Detail, supply
completed task revisions and a plan revision whose delivery sequence and slices name
them. All linked records are stored atomically, so circular task/plan links require
no partial writes. An omitted detail field can remain absent in a draft and is
reported by readiness. A non-draft task retains BUILD-02's required detail. Empty
input, reuse-target or decision lists explicitly mean none; acceptance cases,
outputs and boundaries, when supplied, must be nonempty.

Decisions extend `DecisionChangeSchema` with
`choice: {kind: "product" | "technical", state: "resolved" | "open"}`. Resolved means
`selected` or `rejected`; open decisions cannot use those dispositions. Only open
product decisions produce approval-related readiness findings. Settled decisions
are reused without an approval mutation, including when an old question list still
contains the exact answered question. Each task lists the relevant design decisions
it must preserve; it need not repeat decisions unrelated to that task. A checked
reuse also recognizes legacy `selected`/`rejected` decisions without `choice`
metadata as settled. A question matched to a classified technical decision is not
reported as a product approval.

A stage can select an existing design or plan without writing it again: supply
`records: []` and `stage.reuse` containing a passed `check` (the existing
`ComparisonSchema`) and a `criterionMap` of `{current: Ref, existing: Ref}` entries.
The comparison must cite the current original requests and selected artifact;
every current criterion must map to a criterion of the reused artifact's feature.
This also supports rechecking existing artifacts for a newer feature revision.
The passed current-request comparison can bind historical scope pointers to an
additional request; directly applicable scope entries still have to agree with
that request. Reuse translates prerequisite criteria through the recorded map in
the generated ready plan. A prerequisite must supply every criterion a dependency
translates to. Repeated reuse composes the prior checked plan's mappings for
retained tasks and slices. Tasks authored against the current feature keep their
explicit criteria.
When Detail revises a reused ready plan, verified task retention links preserve
the selected plan's earlier criterion mappings across that refinement.
Earlier designs with prose reuse findings can be selected through this check;
plans need structured slices and feature-verification steps to pass readiness.

Readiness input follows `CheckReadinessInputSchema` (`checkPlanReadiness`):

```json
{
  "projectId": "project-1",
  "detailStage": { "id": "stage-detail", "revision": 1 },
  "expectedPlanRevision": 2,
  "idempotencyKey": "check-plan-new-2",
  "issuedAt": "2026-11-10T10:36:43Z"
}
```

The check persists a `PlanReadinessRevisionSchema` with exact feature, plan and
Detail-stage references. Findings name the affected revision and field. A finding
withholds a ready plan, and `check-plan` returns exit status 1 with the findings in
stdout. With no findings, the same transaction creates the next plan revision with
`readiness.ready: true`, a passed comparison, and `workflow.readinessCheck`. Task
revisions are retained. Existing assignment and review validation accepts those
verified retention links while checking feature, design and criterion compatibility.
Ready plans also reject draft/incomplete task detail when the plan predates BUILD-06.
`findings` and `planReadinessHistory` read the persisted
checks without rerunning or changing them. `stages` and `stageHistory` show the
method history separately from the source feature revision and execution state.

The check requires delivery coverage for active required criteria and for optional
criteria that the plan elects to implement. Tasks/slices without a current criterion
need an explicit maintenance objective on every maintenance task in that slice.
It catches unlinked scope, example-only scope, expansion beyond an entire-scope
request, failure to preserve required integrations, absent integration across multiple slices, absent
final feature verification, open product decisions, unresolved source findings,
missing actionable detail, and inconsistent stage/dependency ordering. Scope roles
come from recorded source analysis: for example, the BUILD-02 request says ERPNext
is an example, so Understand records `role: "example"` and Design/Plan must record
`coverage: "general"` for that request and term. An ERPNext-only scope is recorded as
`coverage: "example_only"` and blocks readiness even when all criterion IDs survive.
This deterministic check does not infer arbitrary natural-language intent or prove
the completeness of the source analysis. The original text and the recorded source
comparisons remain available for that review; no model call is hidden in readiness.

For a material discovery, write a new affected design/plan revision with its reason
and update the corresponding stage revision. An unchanged task can remain at its
exact previous revision when the new plan lists
`workflow.retainedTasks: [{task: {id, revision}, reason: "..."}]`. Changed tasks get
new revisions. Correct findings through these revisions and run a new readiness
check with a new key. Earlier checks remain history. A ready revision cannot change
the delivery content that its linked readiness record checked.

`test/planning.test.ts` exercises a general cross-system feature and a compact
single-message correction through the same CLI/application path, plus current-request
reuse, dropped behavior, the BUILD-02 ERPNext narrowing scenario, integration gaps,
detail gaps, settled decisions, correction/recheck, revision-preserving replanning,
transaction conflicts and export/restore. Assignment generation and instruction fidelity
are implemented below; execution management remains a later build.

## Derived worker instructions — BUILD-07

`prepareWorkerBrief` (`prepare-brief`) takes a ready detailed task, the ready plan
revision that retains it, an existing managed task mapping, and a brief file already
scaffolded by FirstMate. It fills only `## Captain's intent` and
`## Firstmate spec`. Every byte outside those two section bodies is retained,
including role, worktree, safety and delivery instructions. Tests use
`fixtures/firstmate-brief.md`; preparing a brief does not run FirstMate scripts.

Captain's intent contains the exact captured original request text. When a feature
has several source requests, their original texts appear in recorded order,
separated by two newlines. Criteria, design interpretations and task instructions
appear in Firstmate spec. That section contains behavior, preserved design and
decisions, exclusions, boundaries, inputs/outputs, reuse targets, acceptance and
verification cases, integration, dependencies, and the worker's return requirements.

After FirstMate has created the scaffold, prepare it through the application API
or CLI:

```sh
software-factory prepare-brief --db /absolute/project.sqlite --input prepare.json
software-factory check-brief --db /absolute/project.sqlite --project project-1 \
  --assignment assignment-build-1 --revision 1 --brief /absolute/data/build-1/brief.md \
  --agent-config /absolute/software-factory.agents.json
```

`prepare.json` follows `PrepareWorkerBriefInputSchema`:

```json
{
  "projectId": "project-1",
  "assignmentId": "assignment-build-1",
  "attemptId": "attempt-build-1",
  "expectedRevision": 0,
  "idempotencyKey": "prepare-build-1",
  "issuedAt": "2026-11-11T12:00:00Z",
  "detailedPlanTask": { "id": "task-1", "revision": 2 },
  "plan": { "id": "plan-1", "revision": 3 },
  "firstMateTaskId": "build-1",
  "returnLocation": "data/build-1/report.md",
  "briefPath": "/absolute/data/build-1/brief.md",
  "maxSourceChars": 16000,
  "sourceFiles": [
    {
      "source": { "uri": "https://example.org/original-design" },
      "path": "/absolute/sources/original-design.txt",
      "start": 100,
      "end": 900
    }
  ]
}
```

Use actual stored IDs and revisions and list each original source/reuse target
that needs a local snapshot. A source with an absolute local path or `file:` URI
is read directly. Other external references require a `sourceFiles` entry matching
the complete `SourceRef` (URI, optional record and excerpt); no network retrieval
occurs. Snapshots must be readable UTF-8 text. Unsupported/binary or unavailable
sources are explicit missing context. Record references resolve at their exact
revision from the project store and are included in the sidecar, including records
selected only through design, reuse or source references.

When several prerequisite versions share a URI, supply one snapshot per complete
artifact identity. Add `artifact: {uri, revision?, digest?}` to each `sourceFiles`
entry, matching that prerequisite's exact declared fields. A lone unversioned
snapshot cannot establish which version it represents. Each version is selected
and checked separately; missing-context findings include its revision/digest.
The supplied snapshot retains the declared revision and a verified content digest.
An excerpted source is checked separately against its selected snapshot; it does
not require that quote to appear in every artifact version sharing the URI.
Provide its snapshot under the complete source reference, including `excerpt`,
alongside the separate versioned artifact snapshots.

`selectAssignmentContext` selects the feature, design, plan, detailed task,
original requests and sources, assigned criteria, decisions, exclusions, dependency
outputs, and checked planning/reuse provenance. Checked criterion translations
from BUILD-06 are reused. Explicit artifact dependencies retain their artifact
identities. A criterion dependency selects its passed result and output artifact
for the prerequisite's exact task revision when available. Without a recorded
result, a `factory:criterion-output/<task>/<criterion>@<revision>` source names the
missing handover; an explicit local output snapshot can supply that context.
This records received context; execution dependency/hold management uses [managed execution tasks](#managed-execution-tasks---build-08).

Each supplied source has an original reference and a full-text SHA-256 identity.
Extracts are verbatim unless [learning projection](#legacy-sections) removes adopted legacy evidence; projected views retain a separate content identity.
Optional `start`/`end` are half-open UTF-16 offsets in the original snapshot selecting the task-relevant range.
`maxSourceChars` caps each extract; `truncated: true` records any omitted prefix or suffix.
Without a range, the source beginning is selected.
The full original stays reachable through its local snapshot, store history, or the original record bundled in the sidecar.
Truncation never rewrites Captain's intent.

Coverage is written beside the brief as `brief.sf.json` by default; `sidecarPath`
can override it. The sidecar names the assignment revision, every selected record
revision, record snapshots (with learning evidence projected for workers), source references and digests, extracts,
truncation, criterion IDs, prerequisite artifacts and missing context. The
assignment stores the same selection, exact source-derived instruction text,
fidelity comparison, original scaffold, output paths and sidecar digest.
Use distinct output paths for distinct assignments. An unrelated existing sidecar
or another assignment's output paths are refused.

Preparation is offline: `prepare-brief` returns 0 when mechanical preparation
succeeds, with `instructionFidelity: "untested"` and `dispatchReady: false`. It does
not approve implementation. Missing context still produces a failed comparison
and nonzero preparation result. The historical assignment stores its generated
instructions and context; a semantic pass is never invented by the generator.

`checkWorkerBrief` (`check-brief`) is the read-only worker-start gate. It preserves
deterministic checks for exact Captain's intent, lifecycle scaffold bytes, required
context, sidecar/source integrity, revisions, plan readiness and task mapping.
All toolkit-written machine fields are in exactly one JSON block delimited by
`<!-- software-factory-assignment:v1:begin -->` and
`<!-- software-factory-assignment:v1:end -->`. It contains the return destination,
assignment/design/plan/task identities, criterion and decision references, source
and reuse pointers, dependency outputs, selected extracts, and coverage references.
The sidecar carries the same fields plus complete original records. The checker
requires one complete block, decodes strict JSON, rejects duplicate keys, and
compares every field with the canonical assignment and received sidecar. Missing,
duplicated, malformed or edited data fails before any judge call.

The toolkit does not repeat authoritative fields in prose sections or infer them
from headings, code fences or labels such as `Traceability` and `Return location:`.
Those words elsewhere are ordinary text for the semantic judge; examples and
quoted designs can use them freely. Reserved marker examples in source prose are
escaped on rendering, while original source data is retained in the JSON/sidecar.
Only the marked block is machine authority. Behavior prose can be paraphrased.
The canonical assignment values are also supplied in the judge snapshot.
Older briefs without a marked block must be regenerated with a new preparation
revision/key; they are not accepted as an unmarked fallback.

If those checks pass, it makes **one agent call** with a frozen snapshot containing
the exact original request, design, plan, detailed task, criteria/decisions and
actual candidate instructions. The agent judges narrowing, omission and invented
scope by meaning. There are no narrowing word patterns or literal-prose equality
rules. A faithful paraphrase can pass; a well-formed generated task can still fail.
The prompt distinguishes adapter details and planned slices from restricting the
whole requested feature, and treats quoted source instructions as untrusted data.

Configure agents once per project in `software-factory.agents.json`; start with
`fixtures/workflow-agents.json`. `ProjectAgentConfigSchema` maps each step directly
to a FirstMate crew-dispatch profile object with the same field names and values:
`harness`, `provider`, `model`, `effort`. Harness is required; the other fields are
optional as in FirstMate. The seven base step entries, including
`learning_consolidation`, remain required; the connected run path also requires
`plan_check` and `build`. Understand, Design, Plan and Detail execute agents in that
run path. Missing entries and cross-project
configuration are refused rather than inherited from another step or session.

```json
{
  "schemaVersion": 1,
  "projectId": "project-1",
  "steps": {
    "understand": { "harness": "codex", "provider": "codex", "model": "gpt-6.1-sol", "effort": "medium" },
    "design": { "harness": "codex", "provider": "codex", "model": "gpt-6.1-sol", "effort": "high" },
    "plan": { "harness": "codex", "provider": "codex", "model": "gpt-6.1-sol", "effort": "high" },
    "detail": { "harness": "codex", "provider": "codex", "model": "gpt-6.1-sol", "effort": "medium" },
    "instruction_check": { "harness": "codex", "provider": "codex", "model": "gpt-6.1-sol", "effort": "high" },
    "product_review": { "harness": "claude", "provider": "claude", "model": "claude-opus-5-5", "effort": "high" },
    "learning_consolidation": { "harness": "codex", "provider": "codex", "model": "gpt-6.1-sol", "effort": "high" }
  },
  "executables": { "codex": "/absolute/path/to/codex", "claude": "/absolute/path/to/claude" },
  "cwd": "/absolute/review-directory",
  "timeoutMs": 120000
}
```

`resolveStepAgentProfile` is the shared resolver for understand/design/plan/detail,
independent `plan_check`, `instruction_check`, `build`, `product_review` and
`learning_consolidation` profiles.
Each review step selects its own profile, never the worker's or the main session's.
The executable map names installed harness binaries, not arbitrary command argv.
The adapter constructs the command itself:

- Codex: fresh `exec --ephemeral --ignore-user-config` with a read-only sandbox, the selected `--model`,
  and `-c model_reasoning_effort=...`. Native JSON-schema output uses the bundled
  judge schema. No resume/continue/session reuse is supported.
- Claude: fresh `--print --no-session-persistence --safe-mode --strict-mcp-config` with tools disabled, the selected
  `--model` and `--effort`, and text stdout carrying the structured JSON verdict.

The native effort mapping matches the inspected FirstMate adapter: Codex supports
`low|medium|high|xhigh`, with `max` limited to `gpt-5.6-luna`; Claude supports
`low|medium|high|xhigh|max`. Unsupported efforts are refused, not dropped. A native
profile's optional provider must be `codex` or `claude` respectively; this is the
existing account/quota family, not a new API provider. Other harnesses/providers
are not executed by this judge and produce a clear error with no fallback.
Raw `executable`/`args` judge configurations are no longer accepted.

Worker/main session markers and FirstMate lifecycle/inbox environment variables
are removed before launch; native authentication is preserved. Customizations are
disabled for these review calls, rather than attaching to a running agent.
Every check launches a separate one-shot process with a complete prompt on stdin
and the default two-minute timeout. The CLI must return only its final JSON verdict
on stdout; progress belongs on stderr. There are no retries, provider SDKs or
RoboRev subprocesses in instruction checking.
Product review uses the same isolated agent runner and reads existing RoboRev evidence as described below.

The result follows `fixtures/instruction-judge.schema.json`:

```json
{
  "verdict": "fail",
  "findings": [{
    "type": "narrowing",
    "message": "The candidate restricts the general feature to the example.",
    "quotes": [
      { "source": "original_request", "text": "every connected system" },
      { "source": "instructions", "text": "ERPNext only" }
    ]
  }]
}
```

Each finding has type `narrowing`, `omission` or `invented_scope`, a concrete
message and at least one verbatim quote. Quote sources are `original_request`,
`assignment`, `design`, `plan`, `task` and `instructions`; an omission quotes the authoritative
requirement absent from the candidate. Quotes must occur in the submitted evidence.
Pass requires an empty findings array; fail requires findings. Unknown fields,
duplicate JSON keys, extra prose, fabricated quotes, malformed output, a missing
command, timeout or nonzero exit all fail closed. There is no cached-pass fallback.

The CLI returns 0 only when mechanical checks and the fresh semantic verdict pass.
Its JSON contains `judgment.verdict`, the grounded findings, a comparison using the
existing assignment contract and an input digest identifying the reviewed snapshot.
`judgment.ok` describes a valid agent response, while top-level `ok` is start
eligibility. A failure verdict has top-level `ok: false`. The read-only gate returns
the fresh comparison rather than overwriting assignment history. It rechecks files
and current dispatch references after the call so a changed candidate, context or
assignment cannot inherit the earlier snapshot's pass. `validateAssignmentForDispatch`
remains the pure contract validator for a supplied comparison; use `check-brief`
for the fresh worker-start decision. Pre-existing unmanaged tasks remain supported.

The judge is an assessment, not proof that arbitrary prose was understood correctly.
Original source artifacts and quotes remain inspectable for product review.
Build tests use `fixtures/fake-instruction-judge.mjs` only. The owner examples are
fixed input/verdict fixtures: `fixtures/instruction-judge/narrowed-task.json` must
fail, while `fixtures/instruction-judge/adapter-boundary.json` must pass with
preserved every-system behavior. The fake checks its captured inputs and emits a
canned verdict; it does not implement another word matcher. A real model proof is
separate and requires the owner's authorization before running the ready command.

Preparation commits its assignment and idempotency receipt before atomically
materializing each file. Retrying the same key repairs interrupted file writes;
a changed payload cannot reuse the key. An old assignment revision cannot dispatch
or overwrite newer prepared files. Missing source context produces an inspectable
brief and failed comparison; supply it through a new assignment revision and key.
The [worker-start hook adapter](docs/one-feature-run.md#worker-start-hook) invokes
the same instruction check for FirstMate's evaluated launch candidate. Installing
the sample hook entry remains an explicit operator action in the FirstMate home given in the settings.

`test/agent-profiles.test.ts`, `test/instruction-judge.test.ts`, `test/briefs.test.ts` and the BUILD-07 integration cases in `test/planning.test.ts`
cover preserved intent/scaffold bytes (LF and CRLF), exact revision coverage,
context truncation, dependency outputs, explicit missing sources, altered content,
agent verdict handling, sidecar/source damage, persistent replay,
stale assignment rejection, CLI exit codes, and preparation from both general and
narrow BUILD-06 ready plans.

### Judge adaptation sources

The prompt and parser are implemented inside this package. These are the exact
read-only sources studied and adapted; their surrounding review orchestration,
interviews, extra approval loops and multi-agent workflows were not imported.

| Source | Adapted part |
| --- | --- |
| RoboRev [internal/goalreview/prompt.go](https://github.com/kenn-io/roborev/blob/626dea478c5d5ab5c1d25845ce1474120f9c0f7b/internal/goalreview/prompt.go) and [internal/goalreview/result.go](https://github.com/kenn-io/roborev/blob/626dea478c5d5ab5c1d25845ce1474120f9c0f7b/internal/goalreview/result.go), commit `626dea478c5d5ab5c1d25845ce1474120f9c0f7b` | Frozen authoritative evidence, untrusted embedded instructions, separate mechanical findings, and strict grounded JSON results including duplicate-key rejection. |
| RoboRev [internal/prompt/custom_review.go](https://github.com/kenn-io/roborev/blob/626dea478c5d5ab5c1d25845ce1474120f9c0f7b/internal/prompt/custom_review.go), same commit | One explicit structured output contract, independent of agent-native schema support. |
| Installed local `/home/shayg/fm-homes/linux-mate/projects/software-factory/.roborev/task-fit.tmpl`, SHA-256 `a73d54fd32d3e907181d2fb35c825cdb26f3b66e0525685868979b8e667bde2c` | Task fit against originating design/intent, concrete missing/extra behavior, and refusing to infer the request from the candidate alone. This template is untracked, so it has no source commit to cite. |
| Matt Pocock [write-a-prd/SKILL.md](https://github.com/mattpocock/skills/blob/ab45d5e6e1733b7ae27a0795f2a86418c2d451a0/write-a-prd/SKILL.md), [prd-to-plan/SKILL.md](https://github.com/mattpocock/skills/blob/ab45d5e6e1733b7ae27a0795f2a86418c2d451a0/prd-to-plan/SKILL.md), [prd-to-issues/SKILL.md](https://github.com/mattpocock/skills/blob/ab45d5e6e1733b7ae27a0795f2a86418c2d451a0/prd-to-issues/SKILL.md), commit `ab45d5e6e1733b7ae27a0795f2a86418c2d451a0` | Carry user behavior, implementation/testing decisions and exclusions into source-linked verifiable slices; judge the assigned contribution with its dependencies rather than requiring every task to build the whole feature. |

## Managed execution tasks - BUILD-08

`queueManagedTask(store, command)` commits a `task_mapping`, selected intent decision and pending `operation` in one transaction.
It accepts the existing `map_manage_execution_task` command envelope, whose `targetId` is the stable mapping ID and whose `expectedRevision` is that mapping's current revision, or zero for a new mapping.
The command's `task.firstMateTaskId` is supplied by the caller before creation and remains immutable.
New tasks require ready detailed plans and preserve their selected feature and criteria.
`manageExecutionTask(store, command, adapter)` queues that same intent and calls `reconcileManagedTask(store, projectId, operationId, adapter)`.
Task intents and reconciliation are serialized across processes using a SQLite coordination file beside the canonical project database.
The lock covers external mutations through outcome persistence and spans the project so cancellation can protect dependent mappings without conflicting lock orders.
Record transactions remain separate and short; lock contention returns a conflict if acquisition exceeds five seconds.
The CLI exposes the same functions as `queue-task`, `manage-task` and `reconcile-task`; see `software-factory --help` for arguments.

Configure the adapter explicitly, using absolute paths for the home and wrapper executables:

```json
{
  "fmHome": "/absolute/firstmate-home",
  "tasksExecutable": "/absolute/firstmate-installation/bin/fm-tasks-axi.sh",
  "guardTaskId": "factory-permanent-guard",
  "controlExecutable": "/absolute/firstmate-installation/bin/fm-control.sh",
  "timeoutMs": 10000
}
```

Inherited `FM_*` and `TASKS_AXI_*` addressing overrides are removed before invoking the wrapper with the configured `FM_HOME`.
No wrapper path or home is inferred from this machine.
The adapter checks the configured wrapper's `add --help` for `--hold-reason`.
With that flag, creation includes an initial hold in the same call.
Otherwise `guardTaskId` must name an existing, permanently held, unfinished task reserved for the adapter; FirstMate must retain it without completing or removing it.
Creation first blocks on that guard, then installs the toolkit hold, then removes the guard dependency.
The mapping and intended operation have already committed before either creation path runs.
An unrelated hold is preserved; an independent guard dependency protects toolkit conditions while that hold remains, including when it expires.
This also requires a configured permanent guard even on an installation supporting atomic creation.
Use the same adapter configuration when recovering an interrupted operation.

The supported intent actions map to existing operations:

| Intent action | Existing wrapper operation |
| --- | --- |
| `map` | Observe the stable task and refresh its desired dependencies and product hold |
| `create` | `add` in Queued state, initially held or guarded |
| `update` | `update`, with `payload.update` fields `title`, `body`, `repo`, `kind` |
| `set_priority` | `update --priority`, with an integer from 0 through 4 |
| `pause` / `resume` | Retain / release the toolkit hold, subject to other prerequisites |
| `edit_dependencies` | `block` new prerequisites before `unblock` of removed toolkit-owned edges |
| `cancel` | Selected cancelled disposition and a retained hold; active work additionally uses the configured `fm-control.sh <id> exit` |

The adapter never starts, spawns, dispatches or marks work done.
FirstMate owns execution and subsequent lifecycle cleanup, including preservation of unlanded work.
Cancellation does not fabricate tasks-axi's nonexistent cancelled state or complete a cancelled prerequisite.
Dependents of cancelled prerequisites remain unresolved until explicitly replanned.
Cancellation installs protective holds or guard dependencies on existing managed consumers before confirming synchronization, including consumers of already-completed prerequisites and downstream work reached through completed tasks.
These protections survive FirstMate completing or removing the prerequisite during normal cleanup.

`payload.dependencies` contains the desired ordinary FirstMate task IDs; retain those IDs when issuing another action.
The current detailed plan's dependencies are also retained as typed product requirements on the mapping.
Additional `payload.requirements` use the existing `DependencySchema`: a particular `prerequisiteTaskId` and `consumerTaskId` from detailed planning, a `reason`, and either an artifact identity or a criterion revision in `needs`.
Explicit additional requirements are stored separately in `management.explicitRequirements`; omitting the field in a later command retains only those explicit extras alongside freshly generated current-plan requirements.
Successful synchronization persists the exact installed toolkit-owned dependency IDs in `management.managedDependencies`, so obsolete edges can be removed even if producer resolution later changes or becomes ambiguous.
This observation advances the mapping revision; use the mapping returned by `manageExecutionTask`, or reread the current mapping after standalone reconciliation, for the next expected revision.
Feature prerequisites must be resolved to that specific producer before they can clear a hold.
Missing or ambiguous producer mappings and missing native task IDs remain unresolved, even though tasks-axi treats dangling native edges as resolved.
Both the managed graph and the observed native prerequisite graph reject cycles.

An artifact requirement needs evidence of that exact artifact identity from a current result belonging to the mapped producer's current assignment.
An artifact may be available even when its associated criterion failed.
A criterion requirement additionally needs a passing result for the current criterion revision.
The latest record revision is selected independently within each assignment ID; attempt chronology then uses those revisions' update times.
Distinct assignment IDs tied for the latest time remain unresolved because their local revision numbers do not establish a task-wide attempt order.
Evidence must name that exact current assignment revision.
Ordinary native task completion alone never supplies either product fact.
Additional readiness conditions use `payload.readiness: [{id, reason, evidence: []}]`; an empty evidence list means unresolved, and supplied versioned evidence records the observation that clears the condition.
Omitting `readiness` retains existing conditions; an explicit array replaces them.
After new evidence or mappings arrive, issue a new `map` command with a new idempotency key and current expected revision to refresh the hold.
`operation.state: succeeded` confirms the requested backlog synchronization, and may still report unresolved readiness reasons and a held task in its reconciliation observation.

Mutation JSON is parsed against the installed tasks-axi 0.2.6 `add`, `update`, `hold`, `unhold`, `block` and `unblock` result contracts.
Its `show --full` command is a separate flat TOON read contract, parsed strictly without claiming JSON read support.
Timeouts, lost output, partial responses and mismatched task identities leave an unknown operation with retained evidence.
Reconciliation reads the backlog by the original stable ID before retrying, recognizes an already-created task by its persisted mapping marker, and refuses an unrelated ID collision.
Repeated successful keys replay their original receipt; a different payload cannot reuse that key, and another mutation cannot overtake an unconfirmed intent on the same mapping.
Definitive rejections before any external mutation, such as a native dependency cycle, are recorded as failed with `taskRejection.beforeMutation` and may be replaced by a corrected command with a fresh key.
An ambiguous or partially applied operation still requires reconciliation before another intent can replace it.

`test/tasks.test.ts` uses a fake wrapper and scratch SQLite databases exclusively.
It checks runnable state after each mutation in both creation paths, missing prerequisites, typed artifact/criterion readiness, cycles, cancellation, foreign holds, CLI integration, and recovery after lost mutation output or a timeout.
Run `npm test` for these checks and the existing planning, assignment, intake and storage regressions.
| Matt Pocock [skills/engineering/code-review/SKILL.md](https://github.com/mattpocock/skills/blob/4ae2317ddb22b046e26455e4f9c9b3aaaf62212d/skills/engineering/code-review/SKILL.md), commit `4ae2317ddb22b046e26455e4f9c9b3aaaf62212d` | The spec-review axis: identify missing/partial, unrequested and incorrectly interpreted behavior, with quotations from the authority. |

The inspected installed RoboRev was `0.74.0-fmpatch.1`; its build metadata names
base commit `626dea478c5d5ab5c1d25845ce1474120f9c0f7b` and marks local modifications.
The pinned public files therefore describe that base, not an assertion that the
local patch is identical. Read-only inspection of `~/.roborev/config.toml` found
the existing Codex agent default and goal-review configuration. Its settings,
daemon, private review history and hooks are not dependencies of this judge.

Profile compatibility was inspected read-only in FirstMate at commit
`ed1eb1d74079f42702ab706096079616bd214a3f`: `docs/configuration.md` (Crew dispatch
profiles), `bin/fm-dispatch-resolve.sh` (`effort_ok`) and `bin/fm-spawn.sh`
(`effort_flag_for_harness`). The local `config/crew-dispatch.json` demonstrated the
same four profile fields; this package neither modifies it nor imports its role
rules, quota selection or account management. The copied native field/effort
mapping is implemented in `src/agent-profiles.ts`.


## Plan-based product review - BUILD-10

`reviewProduct(store, input, agentConfig)` implements the canonical `record_review_result` operation for one delivered assignment or an aggregate of assignments for the same feature, design and plan revisions.
The CLI is `software-factory review-product --db <sqlite> --input <ReviewProductInput JSON file> --agent-config <ProjectAgentConfig JSON file>`.
It prints the persisted review and returns zero only for a passing product review.
It does not change feature state or FirstMate task state.

The input names `projectId`, `reviewId`, `expectedRevision`, `idempotencyKey`, `issuedAt`, the exact `assignment` reference, an absolute `repository`, `deliveredArtifact`, worker `results`, and `baselineEvidence`.
`deliveredArtifact.revision` must be a full commit SHA; each worker return uses the existing `criterion_result` contract and the same delivered artifact identity.
`additionalDeliveries` optionally supplies further `{assignment, repository, deliveredArtifact, results, paths}` entries for a feature-wide review.
Each entry retains its own task, commit, file snapshots, quality evidence and exact worker-result references; one bounded agent pass reviews the combined package.
A maintenance delivery with no criteria contributes one null-criterion outcome alongside the distinct criterion outcomes, including when the deliveries belong to a feature.
The feature-wide completion rule still requires all active required criteria, so a delivered partial slice stays incomplete until the aggregate supplies the remaining evidence.
`paths` optionally adds unchanged dependency files to the review snapshot; every path changed by the commit is included automatically.
`maxSourceChars` bounds the delivered snapshot, defaulting to 256,000 characters and limited to 1,000,000.
The snapshot accepts at most 1,000 text files and the complete package is limited to 1,500,000 characters.
Binary files, unreadable commits, missing requested paths and exceeded limits return explicit errors rather than silently truncating evidence.
Files come from the pinned commit, including first-parent merge changes, regardless of local worktree edits.
Supply relevant unchanged dependencies in `paths`; the reviewer must report uncertainty when the supplied evidence cannot establish behavior.

The package includes exact original request text, the design and plan revisions, detailed task and acceptance cases, canonical assignment metadata, actual delivered code, per-criterion worker returns, selected decisions, baseline evidence and existing technical-review results.
The reviewer checks the plan independently against the original request and reports original-request omissions even when no listed criterion mentions them.
A brief that incorrectly narrows a general design to ERPNext cannot redefine correctness.
Suggestions remain separate from required findings and criterion outcomes.

`product_review` selects its own harness, provider, model, effort and executable through the shared profile mechanism above.
Each new operation starts one fresh, read-only, one-shot agent process with the frozen package on stdin, without worker session identity or lifecycle environment.
`fixtures/product-review.schema.json` describes its strict JSON output; runtime validation also rejects duplicate keys, ungrounded quotations and missing or duplicate criterion outcomes.
An accomplished outcome requires committed-code evidence from a delivery assigned to that criterion.
Every assigned criterion, including optional criteria, must have a worker return before the review can pass.
Unavailable agents, timeouts, malformed output, uncertain behavior, missing worker evidence, missing baseline evidence or unavailable quality results leave the review incomplete.
A failed product comparison or technical verdict records a failed review.
A passing review requires passing original-source, instruction-fidelity and plan-conformance comparisons, accomplished assigned behavior, and the existing completion rules for required criteria, baseline and improvement evidence.

`readRoborevResult` invokes only `roborev show --json <full-commit-SHA>` in the supplied repository.
The adapter follows the inspected `roborev v0.74.0-fmpatch.1` response: review `job_id`, raw output and `structured_output`, plus nested `job.id`, `job.git_ref`, `job.status` and `job.job_type`.
Only completed review jobs for that exact commit are accepted.
The structured technical verdict is retained; a missing verdict is uncertain, and a closed review does not imply a pass.
No review, tests, analysis or quality checks are enqueued.
A definitive exact-commit quality result already retained by an earlier product review is reused, including when that product review failed.
An uncertain cached quality result is refreshed on a new review operation, preserving the original uncertain review and receipt replay.
A changed delivered commit reads its own quality result.

The product review persists its input digest, unique reviewer session, selected profile, committed file snapshots, raw technical evidence and per-criterion accomplished/failed/uncertain verdicts in the existing review record.
Original source, design, plan, task and worker returns remain available through their exact historical references.
The command receipt makes an identical completed operation replay return the saved review without another agent or quality read; changed input under the same key is a conflict.
Assignment currency and worker-return content are checked again inside the mutation transaction after the reviewer finishes.
A superseded assignment retains an incomplete historical assessment; a concurrently inserted conflicting return or a newer return revision produces a conflict without saving a passing review.
There is no automatic retry of an unavailable reviewer.
These records remain evidence of the supplied snapshot and reviewer judgment, not a claim that code execution was observed by the reviewer.

`test/product-review.test.ts` exercises the decisive ERPNext-only case with passing technical checks, missing behavior, wrong implementation, an original-request omission, bounded immutable delivery snapshots, quality-result reuse, per-step isolated profiles, strict output rejection, persistence, replay and CLI status.
Tests use fake agent executables and fake quality results and make no real model calls.

## Learning capture and consolidation

`captureLearning` and `captureStowObservation` write to the existing project store.
An observation retains evidence, a topic, project or feature scope, its original finding, and its capture reason.
The stow adapter always captures an inferred observation; pass `compaction: true` for reset-time capture.
It commits synchronously and needs neither an agent nor a scheduled pass to preserve continuity.
The CLI equivalent is `learning-capture --db <sqlite> --input <CaptureLearningInput JSON file>`.
The existing FirstMate stow skill remains an external caller; this project does not modify its skill, memory, settings, or hooks.

A capture input has this form:

```json
{
  "projectId": "project-1",
  "id": "observation-example",
  "idempotencyKey": "stow-example",
  "issuedAt": "2026-11-12T08:30:00.000Z",
  "identity": { "scope": { "kind": "project" }, "topic": "instruction-scope" },
  "finding": "The task treated an example as the full requirement.",
  "proposedGeneralization": "Preserve examples as examples.",
  "inputKind": "inferred",
  "captureReason": "compaction",
  "evidence": [{
    "artifact": { "uri": "file:///project/transcript.txt", "digest": "sha256:<actual digest>" },
    "description": "The original request and the narrowed task instructions",
    "observedAt": "2026-11-12T08:30:00.000Z"
  }]
}
```

Use `inputKind: "local_correction"`, `captureReason: "correction"`, feature scope (`{ "kind": "feature", "featureId": "..." }`), and the next complete `feature` revision to correct a feature immediately.
Its `changeReason` must preserve the correction text exactly.
The feature revision and corrections to the current attempt per task commit atomically; retired attempts retain their timestamps and revisions.
Assignments retain their frozen design/plan/feature references, receive the correction in their instructions and selected context, and require a fresh fidelity check before dispatch.
Delivery to an already running FirstMate worker remains the correction-delivery operation's responsibility.
Only the possible broader lesson waits for consolidation.

Use `inputKind: "standing_instruction"` for an explicit instruction that applies immediately in its stated scope.
When replacing existing guidance in that scope/topic, include every current guidance reference in `supersedes`; an omitted or stale reference refuses the mutation.
A broader project instruction can also supersede overlapping inferred feature guidance while preserving explicit feature overrides.
An explicit feature instruction overrides the project default for that topic in that feature's context.
Operational observations are immediately available as continuity context; a consolidation result of `no_rule` retires that operational context.

`consolidateLearning` runs one fresh bounded agent process using the required `learning_consolidation` step in the shared project agent config.
All seven step profiles are required; update existing configs from `fixtures/workflow-agents.json`.
The pass receives pending/conflicting observations grouped by topic and scope, their evidence, and active guidance across the project.
It records update, supersede, add, unresolved conflict, or no-rule decisions, with exact observation and replaced-guidance links.
Updates retain the guidance ID and advance its revision; supersession creates a replacement with links to retired guidance.
An inference cannot replace an explicit instruction.
Overlapping guidance for a topic cannot both remain active, except for the explicit feature override selected by context assembly.
Natural-language relatedness and contradictions across topic labels are judgments for the consolidation agent, whose prompt requires comparison with all active guidance.
Ambiguity remains visible as conflicting observations, without promoting competing rules.
Malformed output, incomplete coverage, or a changed observation/guidance snapshot aborts the entire pass and leaves the window unsuccessful.

`learning-consolidate --db <sqlite> --input <ConsolidateLearningInput JSON file> --agent-config <file>` invokes a pass directly.
Its input includes project/idempotency IDs, issue time, scheduled-window ID/time, schedule digest, and project timezone.
`learning-context --db <sqlite> --project <id> [--feature <id>]` shows applicable guidance, immediate corrections/operational context, and open conflicts.
New worker briefs and sidecars use the same scoped guidance selection.
Guidance without learning metadata must have resolvable scope record references; unclassified legacy guidance stays in history until its scope is classified.
Historical records remain available through the normal store history/export APIs.

### Legacy sections

`readLegacySection(pathOrFileUri, markdownHeading)` reads exactly one named section, including nested subsections, with its digest.
Heading-shaped lines inside backtick or tilde fences remain part of the source section.
The CLI is `learning-legacy --db <sqlite> --source <path> --heading '## Section'`.
Include the returned object in the capture's `legacySections`, with evidence identifying that source.
The consolidation agent decides whether to adopt it; explicit standing instructions can adopt their sections immediately.
Each adopted section links to its original observation, and the learning run records a section-level before/after diff.
An immediate standing-instruction adoption returns the same section diff in its capture result.
Duplicate sections produce one diff.
No operation writes or overwrites a legacy memory file.
Context assembly resolves the current covering adoption before validating section bytes.
An adopted whole section is omitted and replaced with one marker line naming its adopted guidance.
Observation context retains complete section snapshots that have not been adopted and omits only snapshots retired by adoption.
This structured selection is shared by observation extracts, sidecar records, fidelity checks, and the learning-context API.
Original artifact identities are verified before projection and retained as `selectedContext[].artifact`; changed views have a separate `projectedArtifact` identity.
Snapshot ranges keep their original UTF-16 offsets.
Selected external ranges are retained as `selectedContext[].originalRange` and in context-pointer metadata so fidelity checks validate the selected occurrence, including repeated excerpts.
An excerpt or explicit range overlapping an adopted section is refused with `retired_section_excerpt` until its reference is reconciled.
Record excerpts select their unchanged text directly from the worker record; serialized JSON and character offsets are not rewritten.
The replacement record carries source pointers rather than the superseded text; full source text and diffs stay in observation/run history.
A changed adopted section fails context assembly until its source is reconciled.

### Prepared schedule

`fixtures/learning-schedule.json` is an example twice-daily schedule in the project's configured timezone.
Set `hours` to one or two distinct local hours and `startsAt` to the earliest eligible instant.
Use the existing Cronie cron mechanism:

```sh
node dist/src/cli.js learning-schedule --db /absolute/project.sqlite --schedule /absolute/learning-schedule.json --agent-config /absolute/software-factory.agents.json
```

The command prints the argument array and disabled cron entry, including `CRON_TZ`; it never installs or enables it.
The prepared command calls `learning-tick` with those same paths.
`runScheduledLearning`/`learning-tick` chooses only the most recent due local window and coalesces every missed window into that one catch-up.
Successful learning runs persist the last good window with schedule/config/snapshot identity in the normal project store and survive export/restore.
Failures leave the window eligible for a later invocation.
Repeated DST hours share one local window ID; skipped hours catch up at the next configured slot.
There is no resident learning agent or additional scheduling service.

## Corrections to active work (BUILD-09)

`queueCorrection(store, DeliverCorrectionCommand)` commits an immutable original
correction, its sources and impact summary, and an external-operation intent in
one transaction. `deliverCorrection(store, projectId, correctionId, options)`
performs the recorded operation. The corresponding CLI commands are
`queue-correction --input command.json` and
`deliver-correction --project ID --correction ID --adapter-config adapter.json`,
with `--db project.sqlite` on both. No model or network call is involved.

The command targets an exact current assignment reference and a linked current
request or feature reference. Its sequence must be the next positive integer for
that assignment ID, across amended assignment revisions. Replaying an idempotency
key returns its original intent; changing its payload conflicts. Source text is
preserved verbatim. Classification is an explicit caller decision; the runtime
does not guess lifecycle intent from prose.

| Intent | Existing operation |
| --- | --- |
| Clarification or amended scope | Configured `fm-send.sh TASK_ID MESSAGE` durable steering |
| Urgent stop (`urgentStop: true`) | Configured `fm-control.sh TASK_ID interrupt`, bypassing earlier pending steering |
| Rewind | Failed operation with the installed recovery-capability gap; no worker launch |
| Resume | Configured `fm-control.sh TASK_ID relaunch`, requiring an observed stopped attempt |
| Cancellation | Matching BUILD-08 cancel command, including its active-work `exit` and protective dependency holds |
| New work | Matching BUILD-08 create command and its existing plan/readiness gates |
| Status | Configured `fm-crew-state.sh TASK_ID` observational read; never steering or worker launch |

Status rejects `urgentStop`; it always maps to an observational read.
Cancellation remains cancellation when urgent. Neither rewind nor new work is
translated to relaunch. New work creates a managed task without dispatching it.
Cancellation and new work require a `taskCommand` using the existing
`MapManageExecutionTaskCommand` contract and a configured BUILD-08 `taskAdapter`.

The adapter configuration supplies absolute `fmHome`, `sendExecutable` and
`controlExecutable` paths, plus `stateExecutable` for status. No installation path
is hard-coded. Child processes use argument arrays and an explicit `FM_HOME`;
inherited `FM_*` overrides are removed. `recipients` contains fresh observations
from the integrating runtime read model, each with `assignment`, `attemptId`,
`firstMateTaskId`, `state` (`active`, `stopped` or `unknown`) and `observedAt`.
`maxObservationAgeMs` defaults to 30 seconds; `timeoutMs` defaults to 10 seconds.
A task ID alone does not establish which attempt currently owns its inbox. Missing,
ambiguous, stale or mismatched bindings leave delivery pending with an unresolved
reason. A replacement attempt cannot receive steering intended for its predecessor.
The adapter consumer is responsible for supplying truthful current observations.

An `amended_scope` command requires `changedOutcome` on its affected feature.
It advances the feature revision, reopens completed work, amends the identified
assignments while retaining their checked design/plan baseline, and records
`correctionContext.requiresReplan`. Its impact lists assignments, dependent task
mappings and completed result/review evidence. Old evidence remains inspectable;
current completion and product-prerequisite readiness cannot consume it. The
planning and brief workflow must produce checked replacements before dispatch or
completion. A targeted correction delivers to its named assignment; the impact
list exposes the other affected assignments for explicit targeted steering.

Pending scope amendments can consolidate only when they share an explicit
`compatibilityKey` and no intervening distinct instruction forms an ordering
barrier. Consolidation recursively sends every original correction and source in
sequence, marks superseded instructions, and leaves their delivery facts untouched.
Delivered messages and urgent stops never consolidate. A failed or unknown earlier
correction blocks later ordinary steering. Urgent cancellation and interruption
bypass that queue. Durable steering can be delivered to a freshly observed stopped
attempt. Drain earlier messages in sequence while it is stopped, then deliver the
explicit resume; relaunch continues to wait until those deliveries are confirmed.

`recordCorrectionFact` (CLI `correction-fact --input fact.json --db project.sqlite`)
records acknowledgement and incorporation separately. Its input names
`projectId`, exact `correction` and `assignment` references, `fact`, `at`,
`idempotencyKey`, and nonempty artifact `evidence`. The integrating observer records
acknowledgement after the durable inbox message moves to `handled/`. Incorporation
requires separate implementation/verification evidence for the current assignment.
`deliveryRecipient` preserves the exact assignment revision, attempt and runtime
task captured before the wrapper call. Acknowledgement names that historical
recipient. Incorporation may name a checked successor revision of the same attempt
that explicitly retains the correction; `incorporationAssignment` records that
successor without rewriting the delivery recipient. Brief regeneration carries
corrections into required context and clears `requiresReplan` only for the checked
amended scope. Generated briefs keep their semantic judgment in external check
evidence, so the observer must supply that verification with the incorporation
artifact evidence. Missing correction context, unchecked replanning, and replacement
attempts cannot establish incorporation.

Acknowledgement never creates incorporation. The BUILD-10 completion gate checks
pending corrections, assignment currency, product scope and replanning state.
State-only feature revisions can use evidence for the unchanged active scope;
actual scope changes, inactive dispositions and changed-and-reverted scope still
require current evidence. Existing explicit retention rules continue to govern
recording feature completion. Historical returns and reviews remain stored.

External delivery and its recipient are marked unconfirmed durably before invoking
a wrapper. The outcome transaction rechecks the attempt; a concurrent replacement
leaves the original recipient unresolved and cannot inherit a delivered fact. A
nonzero exit or timeout can follow a saved message, so it remains `unknown` and is
never blindly retried; missing or non-executable wrappers report `failed`. Unknown
status output also remains unresolved. An exit-zero steering/lifecycle receipt
records only `delivered`. Reconciliation of ambiguous delivery after a crash is
reserved for BUILD-15.
