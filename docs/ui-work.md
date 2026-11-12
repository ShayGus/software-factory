# BUILD-13: work and dependency views

The existing BUILD-12 local server now serves these routes, using the same
`ToolkitApi`, request handler, browser client and canonical editors:

| Route | Purpose |
| --- | --- |
| `/projects/:project/work` | Execution list, blocking reasons, unknowns and ready work |
| `/projects/:project/dependencies` | Prerequisites, product requirements and consumers with task actions |
| `/projects/:project/work/:mapping` | Focused task with feature revision, detailed-plan-task, assignment and original-request links |

Global navigation includes Work and Dependencies. Scotty remains a plain,
read-only navigation link. Beads through FirstMate/tasks-axi remains the task
store. This companion project does not copy or replace a FirstMate workspace.

## Exact actions and context

Every task form uses `buildEditCommand` to produce the existing
`map_manage_execution_task` envelope, with the mapping's expected revision,
an idempotency key and a required reason. The existing dispatcher applies
BUILD-08 `manageExecutionTask`. Priority uses `set_priority`; replacing explicit
prerequisite IDs uses `edit_dependencies` (including add and remove); an
indefinite toolkit hold uses `pause` and its release uses `resume`; cancellation
uses `cancel`. Product prerequisites remain governed by the plan. Another
owner's holds are preserved, including dated holds. This screen does not invent
a dated-hold command that BUILD-08 does not support.

Cancelled mappings retain their cancellation reason and require explicit
replanning for further changes. Pending, unknown and failed external operations
withhold further edits until inspection/reconciliation, except a definitive
rejection before mutation. Lost HTTP responses retain the exact operation for
retry in the open page. Conflicts and other forms' drafts keep BUILD-12's
existing preservation behavior.

Task rows show canonical readiness reasons, dependency states, holds, unresolved
correction deliveries/incorporation, product readiness and review waits as text.
The dependency view includes product prerequisites and unmapped/unknown producers;
a missing observation never establishes a fulfilled prerequisite. A returned
worker is labeled `returned`; feature completeness still comes exclusively from
BUILD-12's current product-review validation. Neither reading a snapshot nor
cancelling or returning a worker changes the feature.

## Observational boundary

`UiOptions.readSnapshot` is an optional, read-only provider of a validated
`WorkSnapshotSchema` projection. It must read already available structured
observations, not invoke FirstMate. At implementation time BUILD-15's
`src/runtime.ts` was not on main. This interface is deliberately a **toolkit
projection**, not an invented wire contract for `fm-fleet-snapshot.sh --json`.
A runtime adapter can provide it once that structured read model is available.
No terminal scraping, polling command, scheduling, mutation, model call or
second persistence store is introduced here.

The projection preserves `observedAt`, `provenance` and `omissions`, plus task
IDs, observed worker state, execution/waiting milliseconds, review-wait text and
ready PR/branch observations (`reference`, `readySince`, `nextAction`). Each
unobserved task field is explicitly null. An empty ready array means no ready
item was reported for that supplied task; null means Unknown. Duplicate task
observations remain ambiguous. Malformed, unavailable or future-dated snapshots
remain Unknown. Missing tasks and an empty observation list do not imply an
empty fleet. Ready observations without a canonical mapping still appear with
Unknown task context.

Execution task state and priority retain the independent, validated BUILD-08
observation and timestamp; requested priority never substitutes for an
observation. Runtime timing values are displayed only when observed, including
an explicitly observed zero. Missing values show Unknown. Ready items show age
since ready, the original timestamp, next action and snapshot freshness; missing
or future ready timestamps show Unknown age. Ready PR URLs are plain links and
are not queried. Branch identities are readable text.

`staleAfterMs` configures freshness, default 60 seconds. `npm run ui` accepts
`SF_UI_STALE_AFTER_MS` as a positive millisecond value. Snapshot age uses its
capture time, not the HTTP read time. The browser relabels that timestamp stale
without fetching or overwriting drafts. Reload re-reads the provider and local
records; reads never retry mutations.

The fixture launcher additionally loads `fixtures/ui-work-snapshot.json`.
It labels all data synthetic, sets the sample snapshot time to launch time and
its ready branch to thirty minutes earlier. It does not run FirstMate or claim
a live fleet observation. Real provider integration and reconnect reconciliation
remain with BUILD-15; durable browser recovery remains outside this change.

## Validation boundary

`test/ui.test.ts` extracts the rendered forms and submits their envelopes through
the actual HTTP handler and isolated fake task wrapper. All work, dependency and
focused task actions exercise canonical receipts, replay, stale revisions,
add/remove prerequisites, pause/resume, cancellation and unknown-outcome locks.
Fixtures check readiness, correction/review waits, missing observations, ready
age/action, snapshot provenance/omissions/staleness and returned workers without
feature completion. `test/ui-client.test.ts` runs the compiled browser client with
an in-memory DOM surface and clock to check the configured freshness threshold.
Tests open no listener, browser or network and make no real FirstMate call.

Browser end-to-end and visual inspection remain deferred to the requested later
integration run. Review by a separate agent remains the supervisor's handoff;
this implementation does not claim its own independent product review.
