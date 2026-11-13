# BUILD-12: local overview and feature editors

This is the focused toolkit UI selected by BUILD-05. Beads remains the execution
store, through FirstMate/tasks-axi; Scotty remains a read-only execution list and
graph. The folder service edits canonical project records through the same application functions as the CLI.
Execution-task edits go through the installed FirstMate/tasks-axi wrapper.

## Start and configuration

Factory-folder setup owns the persistent screens and prints their addresses; see [Run it from FirstMate](../README.md#run-it-from-firstmate).
The index at `/` lists initialized factory projects from `config/software-factory.projects.json`, or explains how to make the first request when it is empty.
New registry entries appear on the next request without a server restart.
`/projects/:project` opens that project's feature overview; every project route and canonical edit resolves to its registered database.
Unavailable project records remain visible with an error instead of disappearing from the index.

For standalone development, `npm run ui` builds TypeScript and runs `scripts/ui.mjs`.
Set `SF_UI_DB` to an existing absolute SQLite path and `SF_UI_PROJECT` to its project ID, with optional `SF_UI_ADAPTER_CONFIG` for task operations.
Folder mode instead uses `SF_UI_REGISTRY` and `SF_UI_HOME`.
The host listener binds to `127.0.0.1`, defaults to port 3185 and accepts `SF_UI_PORT` (1–65535).
The setup-owned container sets `SF_UI_HOST=0.0.0.0` internally and publishes only on host loopback.
A port in use fails without stopping another service.
`SF_SCOTTY_URL` may name a loopback HTTP origin for a plain navigation link; nothing in the UI invokes Scotty operations.
The standalone fixture demo remains `scripts/ui-spike-demo.mjs`; it is separate from the installed folder service.

## Application and HTTP boundaries

`applyCommand` is shared by CLI `apply-command` and `ToolkitApi` (extended in the
original `src/ui-spike.ts`). `UiSpikeApi` remains an export alias for the existing
BUILD-05 tests and optional scratch demo. `scripts/ui-spike-http.mjs` re-exports
the single TypeScript request handler; it contains no independent stub server.

| Route | Purpose |
| --- | --- |
| `GET /` | Factory project index in folder mode; feature overview in standalone project mode |
| `GET /projects/:project` | Feature overview and focused feature/task editors |
| `GET /projects/:project/features/:feature[?bundle=encoded-ref-JSON]` | Selected or explicitly named bundle, original request, revisions, plan tasks, briefs, criteria/evidence and corrections |
| `GET /projects/:project/decisions` | Contextual product questions, answer editors and existing answers |
| `GET /projects/:project/learning` | Observation inbox, scoped guidance/history, conflicts, last consolidation diff and next window |
| `GET /projects/:project/overview` | Read model, records and freshness metadata as JSON |
| `GET /projects/:project/work`, `/dependencies`, `/work/:mapping` | BUILD-13 [work, dependency and focused task views](ui-work.md) |
| `GET /projects/:project/inspect/:id?revision=N` | Readable record, revision history and related links |
| `GET /projects/:project/records/:id?revision=N` | Existing read-only canonical record JSON |
| `GET /canonical` | Command contract and field ownership |
| `POST /canonical` | Existing revision-checked command envelope, including model-free learning capture |
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
| Execution-task cancellation | BUILD-08 `cancel`; product completeness remains independent |

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
linked to the selected detail stage. A Detail selection applies only when it
refines the current Plan-stage revision; earlier detailed plans remain linked
as historical context. Newer drafts are labeled unselected. Every artifact editor
uses one explicitly chosen edit bundle. Without a `bundle` query parameter,
editors use the selected design, selected logical plan and its task revisions.
Legacy records use an unambiguous existing assignment plan reference when no
stage selection exists; absent or ambiguous references stay Unknown rather than
selecting a newer draft.
After a save, the response includes `bundle` with exact design/plan/task refs and
`resumeUrl`; the browser navigates to that URL when no other edits need protection.
If other drafts remain, the save offers the same explicit Inspect/Resume link.

Every saved plan revision has an Inspect/Resume link naming its complete artifact
bundle. This includes older-format drafts with no base metadata. A named URL
loads exactly those immutable revisions as the primary readable design and plan,
as well as the editors, even when newer drafts or stage selections exist. Selected
stage revisions appear separately as labeled context. Readiness and evidence name
the design/plan revisions they describe; completeness and current-evidence checks
use the displayed bundle, retaining older evidence with its historical revision links. No automatic resumption, compatibility inference or receipt-based edit-base
detection runs. Only a missing or incomplete named bundle shows Conflict and
withholds artifact saves. Current revision heads still guard each new write;
resuming an old bundle creates a new revision rather than overwriting history.

All task editors come directly from the chosen bundle, including added or
replaced IDs. Selected historical tasks and assignment links are read-only
context. Successful sequential design, plan and task saves retain earlier edits
by following their returned URLs. Assignments keep their exact historical links.
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
model/profile configuration and recovery are outside BUILD-12/14.
[BUILD-13](ui-work.md) provides the work/dependency screens on this same server.
Existing per-step agent configuration remains owned by BUILD-06/10/11;
this UI runs no agent and invents no substitute review policy.


## BUILD-14 decisions and learning

BUILD-14 adds the needs-input and learning routes to this same server and client.
Only open product questions have answer controls. Each question retains affected
record revisions, original request text, related features, criteria and work.
Question context resolves the exact affected feature and criterion revisions;
a newer feature head appears separately as current context. A criterion-only
reference does not establish a feature revision when its owner is ambiguous.
Technical questions remain readable work context and have no approval control.
An answer creates a new revision of the existing decision through
`recordDecisionSuggestion`, preserving the question, sources and affected refs.
The answer text is separate from its rationale. Expected revision and idempotency
key use the same store receipts as the other editors.

Existing selected, resolved product decisions with explicit answer text are
offered for reuse only when question wording and the complete set of affected
revisions match exactly.
Reuse records `answer.reusedFrom`; the canonical operation validates the current
source revision and matching context. Conflicting matching answers are labeled
and withheld from reuse controls. Reading a page never resolves a question or
runs work. This makes no semantic claim about differently worded questions or
changed product scope.
Legacy decisions without explicit answers remain readable context, with their
instruction and rationale labeled separately; neither is substituted for an answer.

The learning view shows pending observations with evidence and scope, current
guidance and all retained revisions, superseded text with replacement links,
and unresolved observation/guidance conflicts. The view labels the worker
contexts in which guidance applies, using the canonical
`guidanceForContext` selector. Unclassifiable legacy guidance remains in history
as inactive/unknown. The same canonical selector resolves legacy project/feature
scope and explicit feature overrides; the UI defines no separate scope rules.
Rule inspection also labels supersession and links to the replacement. Explicit standing instructions use
BUILD-11 `captureLearning`, including its exact supersession checks; inferred
rules are never promoted by this UI. The instruction editor captures evidence,
scope and topic and uses the guidance revisions visible when the form loaded.
A concurrent change to that topic produces a conflict. It creates canonical
observations and guidance, without writing or reading external memory files.

The last consolidation view shows the saved verdict, before guidance and exact
written revisions from the mutation receipt, plus recorded legacy section diffs.
An imported run without a receipt shows its saved verdict and labels its written
revision list Unknown. No displayed diff applies itself to a file. The optional
`UiOptions.learningSchedule` supplies a read-only next-window preview using the
existing schedule schema and timezone rules. Missing/mismatched schedules stay
Unknown; displaying configured windows does not claim a scheduler is installed.
The fixture launcher supplies `fixtures/learning-schedule.json` for illustration.
The view offers no consolidation trigger or schedule installation.

The fixture includes a pending lesson, a conflict, superseded/current guidance
and an illustrative saved run. HTTP stream tests extract the actual rendered
forms and exercise decision answers/reuse and standing instructions, checking
immutable history, replay, stale revisions, scope validation and absence of
execution mutations. A fake agent performs consolidation in a temporary store
to verify the last-run diff comes from canonical receipts. No test starts a real
model, browser, listener or network connection. The existing responsive layout
stacks forms at 760px; navigation keeps feature review and needs-input accessible
before execution graph links. Browser visual verification and independent-agent
review remain integration gates for firstmate, consistent with the worker brief.
