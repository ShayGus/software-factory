# BUILD-05: Beads + Scotty canonical-operation spike

Beads is the chosen execution task/dependency store, through the existing
FirstMate/tasks-axi Beads backend. Scotty is the existing browser page. Piyaz is
out. This companion project does not replace or migrate a FirstMate workspace.

**Provisional decision:** retain Beads and use Scotty as an enforced read-only
execution list/graph with canonical links. Build focused toolkit management
editors in BUILD-12–14 and BUILD-17. Unmodified Scotty does not route its native
forms to toolkit/FirstMate operations, so it fails section 2's full management-UI
reuse criteria. Close that native-editor reuse experiment here; do not build a
generic synchronization layer or reconsider the selected task store.

## Evidence and boundaries

The spike uses BUILD-02 `records.ts`, `rules.ts`, and `commands.ts`, BUILD-03
`ProjectStore`, and BUILD-08 `manageExecutionTask`/`reconcileManagedTask` and
`firstmate.ts`. `src/ui-spike.ts` is a bounded JSON API stub, not a new store or
production HTTP service. Toolkit mutations reuse existing command envelopes,
schema validation, history, expected revisions, idempotency and transactions.
Task mutations take this path:

```text
UiSpikeApi /canonical
  -> manageExecutionTask -> existing durable intent/reconciliation
  -> scratch tasks wrapper -> tasks-axi main CLI and BeadsStore
  -> configured bd transport -> dedicated scratch Dolt server
Scotty -> read-only bd wrapper -> same server database (no task synchronizer)
```

The opt-in integration test compiles the **read-only tasks-axi repository's main**, recording its
commit in the scratch `source.json`; they do not modify or build in that
repository. Only already-installed runtime dependencies are reused. The global
tasks-axi install at inspection lacked the Beads backend and is not used for task
operations. There is no package download or model call.

Inspected local sources:

- `/home/shayg/fm-homes/linux-mate/data/sf-beads-adapter-scope/report.md`,
  especially sections 4 and 7: bd 1.1.0 command mapping and embedded contention.
- `/home/shayg/fm-homes/linux-mate/projects/tasks-axi` main,
  `src/backends/beads.ts`, `beads-transport.ts`, `beads-sql.ts` and
  `docs/beads-backend.md`: pinned bd build `8e4e59d39f34`, Dolt 2.7.2,
  server-only transport, transactional metadata/history and native-field readback.
- `/home/shayg/.local/share/scotty/source` (installed v0.4.0,
  `cf6dda198db15a77399d1d9e77292618a7d08fa1`): `lib/bd.ts`, `schema.ts`,
  `config.ts`, `api-client.ts`, API routes and `Dockerfile`; installation notes
  identify image `local/scotty:v0.4.0-cf6dda1`.

These are source/installation inspections, not reads of existing Beads data.
Neither existing workspace nor the running Scotty container was accessed.

## One canonical source per displayed field

This table covers the managed execution rows. Product records are distinct
toolkit records; the same label in a task panel does not transfer their ownership.
**No native Scotty mutation is allowed for managed rows in this spike.** Both
the published HTTP guard and the fixed `bd` read wrapper enforce that rule;
`SCOTTY_READ_ONLY=1` alone does not, since an editing cookie overrides it.

| Scotty field | One canonical owner | Representation and edit route |
|---|---|---|
| Title | FirstMate/tasks-axi task | Native Beads title is the backend representation. Open `map_manage_execution_task`, action `update`, `update.title`; read back through tasks-axi. It is not the feature outcome. |
| Status | FirstMate/tasks-axi lifecycle | Read native open/in_progress/closed as queued/in_flight/done. Open FirstMate's lifecycle operation for start/done/reopen; never translate drag/drop to `bd update/close`. Pause/resume/cancel intent uses BUILD-08 and its holds; this is not a new native lifecycle state. |
| Priority | FirstMate/tasks-axi task | Open BUILD-08 `set_priority` (0–4); observe tasks-axi's confirmed state. Feature priority has a separate toolkit owner and revision. |
| Dependencies | FirstMate/tasks-axi operational edges | Open BUILD-08 `edit_dependencies`, using logical task IDs. Toolkit design/plan prerequisite meaning stays in toolkit records. Native graph shows only the execution edges; metadata holds/readiness may add blocking reasons. |
| Notes | Toolkit observation record for product/feature notes | Open `capture_consolidate_learning` with `action: capture`. Native Beads notes/comments are not another product-notes editor: leave them read only, with canonical observation links in the task description. The backend's internal provenance is not an editable product note. |
| Description | FirstMate/tasks-axi task body | Open BUILD-08 `update.body` for execution instructions and canonical links. Feature meaning, original wording, criteria and decisions appear only as read-only links, never as editable descriptions of their own. |
| Labels | FirstMate/tasks-axi task classification (`kind`/`repo` metadata) | Read only. This backend has no arbitrary-label operation. Do not let Scotty labels become a second classification truth. `update.kind/repo` changes the owner's classification; it does not promise native-label synchronization. |
| Defer | FirstMate/tasks-axi operational hold | Open BUILD-08 pause/resume for an indefinite toolkit pause. Dated/other operational holds open the existing FirstMate hold operation. Native Scotty deferred status is refused: `bd defer/undefer` cannot preserve all base-state, hold, reason, kind and date semantics. Feature deferral is a toolkit disposition/decision, never this native task status. |

Other Scotty surfaces (assignee, native type, native acceptance criteria/design,
comments, close reason/dates, creator, attachments, archive/delete, human/gate
answers, AI refinement, publishing and app settings) are read only or unavailable
through the scratch guard. Worker identity and lifecycle belong to FirstMate;
evidence/close facts come from its operations. Native acceptance/design fields
are not editable copies of the toolkit's criteria/design. The guard disables
model, self-update, project-registration, filesystem and publishing endpoints,
including their GET variants; it cannot touch another registered project.

| Toolkit field | Canonical owner | Scotty representation and mutation route |
|---|---|---|
| Exact original request | Immutable toolkit Request | Link to revisioned record; refuse editing. Capture a new request/correction instead. |
| Feature outcome, priority, disposition | Toolkit FeatureRevision | Link/read-only text; focused feature editor sends revision-checked toolkit operation, linked decision and reason. |
| Criteria and verification | Toolkit Criterion + FeatureRevision refs | Link/read-only text; stub edits both in one transaction with a decision. Existing scope-change rules refuse unselected removal/demotion/deferral of required criteria. |
| Product decisions | Toolkit DecisionChange | Link; `record_decision_suggestion`. No editable Beads copy. |
| Corrections and product notes | Toolkit Observation | Link; capture observation, preserving original correction text and its separate delivery facts. The spike reuses synthetic correction evidence, not a real delivery claim. |
| Results and product completeness | Toolkit criterion results/review, referencing immutable artifacts | Link; native Done never proves product completion. The fixture has common-interface result evidence, with second-system verification still outstanding. |

## Exposed MVP edits and demonstrated stub round trips

`UiSpikeApi.handle(method, path, body)` is the stub canonical API. Its live-demo
host binds only loopback. `GET /canonical` describes available operations;
`POST /canonical` accepts the existing `CommandEnvelopeSchema`.
`GET /projects/:project/records/:id[?revision=N]` returns a read-only canonical
record. `POST /scotty-edit` refuses a projected edit with HTTP 409,
`canonical_operation_required`, owner, route and expected revision. It never
writes a projected copy. A normal editor must submit the canonical command
explicitly; the stub does not infer a product decision from a cell edit.

| Edit | Stub route and demonstrated readback | Actual integration gate |
|---|---|---|
| Features/criteria | `record_decision_suggestion` + typed `intakeRecords`; feature and criterion revision 2, selected reason, revision 1 and original request retained | BUILD-12/17 replace this contract stub with the feature editor, validate scope changes and refresh current coverage/readiness |
| Task state | BUILD-08 `pause` then `resume`; actual tasks-axi Beads backend writes/removes the hold and reads it back from fake bd; native base state remains queued | BUILD-13/17 confirm real FirstMate lifecycle operations and evidence-bearing completion; do not add start/done to this stub |
| Priority | BUILD-08 `set_priority` to 0, read back through the actual backend; replay is a no-op | BUILD-13/17 real adapter readback/conflict handling |
| Dependencies | BUILD-08 removes then restores consumer → prerequisite; fake bd ends with one physical blocks edge and tasks-axi reports the consumer blocked | BUILD-13/17 real graph, edge direction, cycles, holds and concurrent conflicts |
| Decisions | `record_decision_suggestion`, proposed → selected revision; canonical GET returns it | BUILD-14/17 focused decision editor and real scope impact |
| Notes | `capture_consolidate_learning`, action capture, creates `spike-note`; canonical GET returns it | BUILD-14/17 notes/correction editor and real delivery facts |

The example has one feature, two execution tasks (`pilot-build`, `pilot-verify`),
one final dependency, a preserved correction (`observation-1`) and a synthetic
result (`result-general`). The existing workflow fixture is reused and extended
with one detailed task. Scotty receives only the two execution rows, created by
BUILD-08; each task body links to the original request, feature, criteria,
decision, correction and result. There is no independently editable feature row
in Beads. The second-system criterion still needs current evidence; the fixture
does not claim a complete feature or an independent review of this change.

`test/ui-spike.test.ts` runs the canonical-routing scenario through BUILD-08 with
the repository's self-contained fake task wrapper. It checks all twelve projection
routes, historical GET, stale revisions, idempotency conflicts and unknown-outcome
reconciliation after a lost committed response. `test/spike-portability.test.ts`
also runs it with only Node on PATH, so it cannot use git or a global tasks-axi.
The default suite requires only this checkout and `npm ci` dependencies.

`npm run test:beads-spike` explicitly enables `test/ui-spike.integration.test.ts`.
This additional test needs the inspected tasks-axi source and an installed
tasks-axi's runtime dependencies; it runs the same scenario against the real
main CLI/BeadsStore with a fake bd SQL/version process. It exercises real command
validation, ID mapping and metadata decoding and records the source commit.
It is skipped by default and never uses a real Beads database.

`test/ui-spike-http.test.ts` drives the actual demo HTTP handler with in-memory
byte chunks, verifies a split multibyte canonical note is persisted intact, and
checks the byte limit. No listener or network request is needed.
`test/scotty-reader.test.ts` checks native mutations,
workspace overrides, cookie-resistant HTTP policy and model/update route refusal
without starting Docker or making network requests. This proves stub routing,
not Dolt transactions, actual bd behavior, browser rendering or live mutation
correctness.

## Prepared scratch demonstration — intentionally not run

The launcher is `/home/shayg/fm-homes/linux-mate/data/sf-build-05/run-demo.sh`.
It runs the checked-in `scripts/ui-spike-demo.mjs` via `sg docker -c ...`.
It requires the built toolkit, the existing tasks-axi source/runtime dependencies,
and **already present** Scotty and pinned Dolt images. `--pull never` prevents a
download; no image build, package install or model/network service call is used.

Each invocation allocates a new `live-*` scratch directory and uniquely named
containers. A dedicated Dolt 2.7.2 container owns the new database via a Unix
socket; both bd clients use it, with no SQL port publication or embedded
fallback. A temporary container from the existing Scotty image supplies its
pinned bd binary for scratch initialization. The Scotty container uses that
same existing image, mounting **only the new scratch directory**. No FirstMate
home, existing Beads directory, Scotty config or production container is mounted,
queried, changed or restarted. Only created container names are removed on exit;
proof, toolkit export and scratch database files remain under this task's data
directory. No production migration or lifecycle dispatch is performed.

When firstmate elects to run it later:

1. Build this branch, then invoke the external launcher with this checkout path
   (or the merged checkout path). The script seeds canonical records and tasks
   through the path above and saves `round-trips.json`, `toolkit-export.json`,
   `source.json` and `proof.json` in its fresh scratch directory.
2. Open `http://127.0.0.1:3186/p/sf-build05` with chrome-devtools-axi. Check the two
   task rows, priority 0, consumer's blocker, and graph edge. Follow task-body
   links to `http://127.0.0.1:3185` and inspect preserved request, feature/criteria,
   correction, decision and result. Canonical links return JSON in this spike;
   focused screens are later work.
3. Attempt a native title/status/priority/dependency/notes edit, including after
   trying to toggle viewer mode. The HTTP guard refuses writes before Scotty;
   the bd reader independently refuses native mutations. Canonical changes
   require a typed POST to the stub API; re-read the canonical owner and refresh
   Scotty. GET `/canonical` describes supported operation contracts.
4. Record browser proof separately. Ctrl-C cleans up only the script's named
   scratch containers. No test or validation command automatically launches this
   demo. Ports 3185/3186 must be free; a conflict is a failure, never a reason to
   stop another service.

## What remains unproven

Local validation commands are `npm run typecheck`, `npm test`, and the optional
`npm run test:beads-spike`. The live runner and external shell launcher are
syntax-checked without execution.
After the review fixes, type checking passed, the default suite reported 335
passes and one opt-in skip, and the separate fake-bd integration test passed.
Validation logs are under `/home/shayg/fm-homes/linux-mate/data/sf-build-05/`.

Scotty supplies the useful task list/graph, but no verified extension hook routes
all native mutations to canonical operations. Its read-only preference and
embedded serialization are insufficient alone. The guarded scratch deployment
is deliberately limited to this feature and is not an installed product.
Scotty also does not interpret FirstMate's structured hold/readiness metadata:
pause can leave the native task visibly open. Read holds and product blockers
from their canonical operation/record; native board position is not dispatch
readiness. This is another requirement for the focused work view.

BUILD-12–14 and BUILD-17 must verify actual canonical mutations and browser
round trips, including FirstMate lifecycle, evidence closure, dated holds,
feature scope changes, conflict/unknown/stale UI states, and current coverage
after revisions. A separate review agent should review the committed change;
the worker performs implementation and validation only. Browser end-to-end
testing remains for the authorized later run, as requested. No generic two-way
sync or full management screens were built here.
