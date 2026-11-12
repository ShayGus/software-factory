# BUILD-12: local overview and feature editors

This is the focused toolkit UI selected by BUILD-05. Beads remains the execution
store, through FirstMate/tasks-axi; Scotty remains a read-only execution list and
graph. This companion project's local fixture UI neither copies nor replaces an
existing FirstMate workspace. No FirstMate, tasks-axi, Beads or Scotty data changes
are made by the shipped fixture launcher.

## Start and configuration

`npm run ui` builds TypeScript and runs `scripts/ui.mjs`. It binds exclusively to
`127.0.0.1`, defaults to port 3185, and accepts `SF_UI_PORT` (1–65535). A port in use
fails without stopping another service. `SF_SCOTTY_URL` may name a loopback HTTP
origin for a plain navigation link. Nothing in the UI invokes Scotty operations.

Every launch imports `fixtures/ui-overview.json` into a new temporary SQLite
store and uses the same isolated subprocess task fixture as the adapter tests.
The browser and its task edits exercise real canonical functions and receipts;
the transport and evidence are synthetic. The common task is done while the
second-system behavior remains unverified. Ctrl-C closes the listener and deletes
that session's scratch directory. Restarting creates a fresh fixture session.
There is no data-directory migration, external command configuration, listener
startup, model call or real project access hidden in tests.

## Application and HTTP boundaries

`applyCommand` is shared by CLI `apply-command` and `ToolkitApi` (extended in the
original `src/ui-spike.ts`). `UiSpikeApi` remains an export alias for the existing
BUILD-05 tests and optional scratch demo. `scripts/ui-spike-http.mjs` re-exports
the single TypeScript request handler; it contains no independent stub server.

| Route | Purpose |
| --- | --- |
| `GET /` | Feature overview and focused feature/task editors |
| `GET /projects/:project/features/:feature` | Feature detail, original request, revisions, plan tasks, briefs, criteria/evidence and corrections |
| `GET /projects/:project/overview` | Read model, records and freshness metadata as JSON |
| `GET /projects/:project/inspect/:id?revision=N` | Readable record, revision history and related links |
| `GET /projects/:project/records/:id?revision=N` | Existing read-only canonical record JSON |
| `GET /canonical` | Command contract and field ownership |
| `POST /canonical` | Existing revision-checked command envelope |
| `POST /scotty-edit` | Refuses projected edits with owner and canonical operation link |
| `GET /assets/ui.css`, `ui-client.js`, `ui-edit.js` | Fixed local assets; no arbitrary file serving |

The HTTP adapter rejects foreign origins, cross-site requests and unexpected Host
headers, limits bodies to 1 MiB, decodes UTF-8 after collecting all byte chunks,
and returns structured JSON errors. CSP restricts scripts, styles and connections
to the same origin. Source text and serialized editor context are HTML-escaped;
non-HTTP artifact identifiers are text rather than executable links. All pages
and API responses disable caching. There is no login or remote-hosting mode.

## Edit routes

| Editor | Canonical operation |
| --- | --- |
| Feature outcome, priority, deferral/resumption | `record_decision_suggestion`, selected linked decision and new FeatureRevision |
| Criterion behavior/verification | Same decision operation, Criterion revision and updated feature references; original requests retained |
| Product design | `design_plan_feature` combined artifact operation |
| Delivery strategy/integration/final verification | Same design/plan operation |
| Detailed-plan task behavior, boundaries, inputs, outputs, cases and return requirements | Same design/plan operation |
| Execution-task priority | BUILD-08 `manageExecutionTask`, action `set_priority` (0–4) |
| Execution-task dependencies | BUILD-08 `edit_dependencies`, logical task IDs |
| Execution-task deferral/resumption | BUILD-08 `pause` / `resume`; dated holds stay with FirstMate |

The combined design/plan envelope already existed in BUILD-02. Its application
entry point now validates and commits design, plan and their task revisions in a
single store transaction. The editor includes expected revisions for the feature
and each artifact, updates the internal revision references, clears readiness and
marks source comparisons untested. Changed criterion references are reconciled
across task criteria, slices and criterion dependencies. Priority-only feature
decisions are linked through affectedRecords without changing product-scope
decisions, preserving otherwise valid dispatch. Existing staged `recordStage` and
`checkPlanReadiness` operations remain available through the same dispatcher and
the original CLI. Applicable stage and reuse records select the displayed artifacts, including an
older selected design or plan with newer drafts. Readiness-check revisions remain
linked to the selected detail stage. Newer drafts are labeled unselected; editing
a selected older revision allocates a new revision after the current head,
retaining every intervening draft. Assignments keep their exact historical links.
An edit never claims a product review or silently upgrades worker instructions.

All mutations carry expected revision and idempotency key. Product command
replays use the canonical store receipt. Task response replays reconstruct the
first mapping/operation response from the immutable BUILD-08 intent and outcome
receipts, including after another task edit. Unknown responses remain unknown on
replay; they do not silently retry external mutations. Explicit reconciliation
continues to use BUILD-08's existing operation. There is no second response store.

## Read semantics and interaction states

Feature completeness requires an existing passing product review accepted by
`validateReviewForCompletion` and matching the displayed design/plan. A done or
returned execution task alone never establishes it. Criterion results are shown
separately as reviewed behavior, reported evidence awaiting review, missing
untested evidence, or stale/non-passing history. Review findings or conformance
outcomes establish accomplished criteria independently of aggregate feature
completion, so an incomplete review can still demonstrate one behavior.
Original request coverage reuses
BUILD-04 and preserves `semanticReview: not_performed` rather than claiming a
semantic check was executed by rendering the page. Unclassified requests and
unmapped ranges appear on the overview even without any linked feature.

Task state/priority comes from the validated task observation recorded by
BUILD-08; requested priority is never substituted for a missing observation.
Observations retain timestamps and show Unknown when absent, Unknown
outcome when ambiguous, and Stale after the configurable read-model threshold
(default 60 seconds). The page also labels itself stale after a minute. Reads
never poll FirstMate, schedule a worker or mutate records.

Each form tracks its own dirty state, input version and unresolved command.
Every form shows Loading while saving, preserves entered values on structured
validation/conflict, and offers reload/compare on stale revision. A lost response
keeps the exact pending command in the open page for Retry same operation. A
successful save reloads only when no other draft, newer input or unresolved
command remains; the leave-page guard covers pending commands as well as drafts. A
recorded unknown/failed task outcome links to its operation and locks further
edits pending inspection/reconciliation. Unsaved changes trigger the browser's
leave-page prompt. Closing that page after a lost response requires inspection of
canonical records before new intent; durable browser-side recovery is BUILD-15.

## Verification and remaining integration

The server-rendered HTML checks extract the same editor contexts used by the
browser and send their command envelopes through the actual HTTP handler using
in-memory byte streams. No test opens a listener, browser or real network.
The tests inspect original-request wording, an unverified second-system behavior,
revision-specific brief → task → plan links, correction attempts, explicit state
labels, artifact history, conflict and replay behavior, local assets, origin
checks, escaping and CLI/HTTP parity. Existing BUILD-05 adapter tests still run.

Per the task boundary, the local start command and optional Docker/Beads demo are
prepared but not launched. Browser end-to-end testing, real project integration
and review by a separate agent remain later gates. Work/dependency screens,
decision/learning editors, model/profile configuration and recovery are outside
BUILD-12. Existing per-step agent configuration remains owned by BUILD-06/10/11;
this UI runs no agent and invents no substitute review policy.
