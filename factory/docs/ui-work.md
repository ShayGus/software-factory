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
Undelivered operational corrections (including resume and status) stay visible
with their operation state and recipient/delivery observations even though they
require no incorporation. Delivered operational corrections need no fabricated
incorporation step. Native observed blocked-by edges augment prerequisites and
consumers for display, with their ownership, capture time and freshness retained;
they are not copied into the editable toolkit dependency list.
The dependency view includes product prerequisites and unmapped/unknown producers;
a missing observation never establishes a fulfilled prerequisite. A returned
worker is labeled `returned`; feature completeness still comes exclusively from
BUILD-12's current product-review validation. Neither reading a snapshot nor
cancelling or returning a worker changes the feature.

Readiness and selected-stage continuity share dispatch's scope-compatibility and
checked-design-reuse rules. Priority and workflow-state revisions retain eligible
plans and mappings while their exact historical feature references stay linked.
Product-scope changes still require checked planning. Standalone maintenance
shows its explicit objective, exact task/design/plan references and original
requests resolved through those records and matching assignments. Its absent
feature is intentional; genuinely unlinked legacy work remains Unknown.

## Observational boundary

The default Work view reads the latest snapshot-bearing integration observation
in the project's revision history, saved by `importLegacyTasks` or `reconcileProject`.
Recovery artifact/reference observations do not hide that fleet evidence or
change its capture timestamp. It validates that snapshot
with the existing runtime adapter's `FleetSnapshotSchema` and projects it through
`WorkSnapshotSchema`. HTTP and `scripts/ui.mjs` use this same path. Re-importing
refreshes the observation even when every task already has a canonical mapping.

The projection retains the fleet's generated timestamp, source home/provenance,
unstructured backlog omissions and incomplete-inventory reason. A stale or unknown
crew observation remains unknown, with its timestamp/freshness disclosed as an
omission. An installed `done` state with a “ready for review” detail supplies
readiness only when the current `run-step` detail attributes a PR URL to that run.
A crew-state-only URL remains usable when metadata has none. Different run and
metadata URLs produce an explicit PR identity conflict and withhold readiness;
a metadata URL alone leaves current PR identity unknown.

Readiness time requires evidence of the event that made that PR ready. The installed
`paths.status_log.last_event` is historical wake data, which may precede readiness
or describe unrelated later work; it does not establish that transition. This
projection therefore leaves `readySince` null and shows Unknown age, preserving
the separately observed snapshot capture time. A structured provider may supply
an explicitly established readiness timestamp through `WorkSnapshotSchema`.
The next action points to review using
existing task/assignment delivery instructions, which remain unchanged. Runtime
execution and waiting intervals are unknown because this wire format does not
provide them. A PR URL alone does not establish readiness.

`UiOptions.readSnapshot` remains an optional read-only override for existing
structured providers and tests. It must read already available observations,
not invoke FirstMate. Invalid overrides are visibly unknown rather than falling
back to older evidence. Fixtures stay in tests.
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
on the summary and every ready-work card without fetching or overwriting drafts.
Reload re-reads the provider and local
records; reads never retry mutations.

The launcher requires an existing `SF_UI_DB` absolute SQLite path and
`SF_UI_PROJECT` ID. It never creates demo tasks, imports synthetic records, or
rebases observation times to launch time. Task edits optionally use
`SF_UI_ADAPTER_CONFIG`; page reads use persisted observations only.

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
