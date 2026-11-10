# Software Factory contracts and persistence — BUILD-03

This TypeScript package defines the records and operation boundaries for the
FirstMate product-development workflow in [the design](Software_Factory_Design.md).
It preserves request, feature, design, detailed-plan, assignment and review identities
through one complete feature workflow. BUILD-03 adds local SQLite persistence.
It does not run FirstMate or implement a reconciler, scheduler, CLI, HTTP, UI,
tasks-axi changes or Beads.

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

`RecordSchema` is the discriminated union, and `RecordsSchema` parses arrays.
Record references are `{ id, revision }`; artifact identities are
`{ uri, revision? , digest? }`, with at least a revision or digest required.
URI fields accept repository paths and other reachable references, not just HTTP
URLs. Artifact revisions and FirstMate IDs are opaque strings; toolkit record
revisions are integers. A record revision is never a FirstMate run ID.

`CriterionSchema` defaults `requirement` to `required`. A detailed task can instead
name an explicit `maintenanceObjective` without inventing a product criterion.
Legacy mappings may have null feature/task references and empty criteria. Managed
mappings require references. Unclassified requests remain representable.

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
  ready plan, a source-compared design and an active feature.
- A review claiming `outcome: passed`, and `validateReviewForCompletion`, require
  current passing evidence for every active required criterion, passed source,
  instruction and plan comparisons, no unresolved product questions, and evidence
  of the requested improvement. A green technical-review link alone is insufficient.

**Semantic limit:** these validators do not understand natural-language scope.
`ComparisonSchema` records the separate reviewer/source-comparison action with its
sources, findings, reviewer session and time. A passing comparison cannot hide
unresolved findings, and original request references are required. An omitted
requirement that has never been identified in criteria still requires comparison
with the original text. BUILD-07 and BUILD-10 must produce these findings; a schema
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

The database has append-only record history and durable command receipts. All sixteen
BUILD-02 record kinds, including operation revisions, use `RecordSchema`; there are no
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
No separate semantic-revision counter or implicit evidence promotion is introduced.
Current references remain exact; old results and reviews remain historical until
explicitly linked into a current review through a current assignment/result. A transition
to `complete` therefore needs a passing review naming that new feature revision in
the same transaction (or already present), as BUILD-02 requires. Automated invalidation
and adoption of unaffected evidence remain later workflow policy.

- Which project license should accompany publication? The input repository supplied
  no license; this package does not select one on the operator's behalf.

Durable history, transactions, idempotency and pending-operation storage are implemented.
Operation execution/reconciliation, source comparison, assignment generation and live
product review are later builds. No live FirstMate integration or full product milestone is
claimed by these contract fixtures.
