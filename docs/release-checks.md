# BUILD-16 release checks

These checks exercise section 10 of `Software_Factory_Design.md`, including the retrospective's example-to-scope narrowing, lost corrections, unsupported rewind, unverified counts, duplicated execution, overlooked reuse, unattended delivery, and baseline-only progress. They validate this companion project; they do not replace or migrate the operator's FirstMate workspace.

Twenty named scenarios run with `npm test`. All twenty pass through the shared
production contracts and adapters; no expected-failure subtests remain. Fixture-backed
adapter checks do not establish compatibility with an installed live FirstMate home.

The immutable original text for every case is in [release-checks.json](../fixtures/release-checks.json). Semantic cases send that text, the design, plan, task and actual candidate/delivery through the existing agent runner with local fake agents. Their canned verdicts are fixture data, not language evaluation or model calls. Assertions check persisted review findings, readiness, refusal, and completion against those source requirements, including an export request omitted from **every** derived criterion. This proves the factory's handling of a source-based assessment; it does not establish the judgment quality of a real model.

| Check | Result | Observed outcome / concrete remaining defect |
|---|---|---|
| CHECK-01 | Pass | An original request with an additional export behavior reaches the independent plan checker. A failed source comparison is saved in `plan-check-agent.json`; no ready plan, task or worker is commissioned. The instruction gate also refuses the omitted source behavior. |
| CHECK-02 | Pass | An adjacent dashboard stays a proposed decision, outside the feature; source-based instruction judgment refuses its inclusion. |
| CHECK-03 | Pass | A narrow ERPNext wording correction remains in assignment context; the judge refuses unrelated system replacement and dashboard work. |
| CHECK-04 | Pass | A source-based product review records the export omission even though every rewritten criterion is reported accomplished. Completion remains refused. |
| CHECK-05 | Pass | Worker acceptance claims and an exact-commit technical pass cannot override missing second-system behavior. The failed product finding persists and the feature stays incomplete. |
| CHECK-06 | Pass | An amendment reaches the same attempt through the correction adapter, revises its context, requires replanning and invalidates stale completion evidence. Delivery never invents acknowledgement or incorporation. |
| CHECK-07 | Pass | A native `done` producer without its required artifact keeps its consumer held. The canonical operation records the exact missing output and dependency reason; native hold text remains the ownership marker. |
| CHECK-08 | Pass | The adapter process is killed after external task creation. Reopening and reconciling discovers the stable native ID; there is exactly one `add`. |
| CHECK-09 | Pass | The runtime adapter imports a stale fleet observation with an unstructured backlog omission. The default Work read model and HTTP response project that saved observation without injected `readSnapshot`: the exact omitted text, stale capture time, unknown worker/timing fields and incomplete feature remain visible. |
| CHECK-10 | Pass | A local correction updates feature and assignment immediately and blocks old fidelity. Conflicting inferred retry lessons remain explicit conflicts after a separate fake consolidation process; no generalized rule is activated. |
| CHECK-11 | Pass | BUILD-14 Decisions is now on main. HTTP and agent task-priority mutations share canonical task/mapping records with stable replay and unchanged original source. An answer built through the existing UI command builder and posted through real HTTP resolves the canonical decision; agent replay is byte-stable, and a new identical-context question reuses that exact recorded answer with revision provenance. The refreshed Decisions view shows the settled result; no native task calls occur for decision edits. |
| CHECK-12 | Pass | Handback leaves existing execution available, releases toolkit-owned holds, records the missing-evidence condition and retires pending side effects. Re-enabling observes both native task and fleet interfaces without replay; restored missing attachments keep the reconciliation gate closed. |
| CHECK-13 | Pass | Planning records the working connection interface, the absent feature and the bounded change; the brief retains that reuse finding and only one design exists. Source-based checking refuses an unjustified parallel connection implementation. |
| CHECK-14 | Pass | A checked production count is rejected when evidence lacks a method/input attestation or names a different method, fixture, revision, population, definition, unit or filters. Matching structured evidence is accepted; the unsupported original can remain reported without a guessed replacement number. These are evidence-consistency checks, not execution of the count or semantic certification of the report. |
| CHECK-15 | Pass | A technical pass with baseline-only code produces a persisted “Baseline preserved; no requested behavior improves” finding, no improvement evidence and refused completion. |
| CHECK-16 | Pass | Focused and parallel plans each retain their own strategy, reason and full selected context through readiness and brief preparation. Selection is per plan, with no global execution-mode switch. |
| CHECK-17 | Pass | The correction retains the original rewind request and exact existing assignment. The real adapter reports unsupported rewind explicitly; no control call, replacement assignment or worker is created. |
| CHECK-18 | Pass | The production runtime adapter imports installed-shape ready work alongside growing review/new-work queues. Default Work and HTTP show the observed PR, two-minute ready age, review wait, incomplete feature and next action using existing task/assignment delivery instructions. Reads leave settled request/plan records unchanged. Re-importing updates readiness even when no new task mappings are created. No caller-authored snapshot conversion is used. |
| CHECK-19 | Pass | A correct ready plan plus narrowed operative instructions is refused by the agent instruction gate. The shared real worker-start hook also vetoes the narrowed launch overlay before the fake worker starts. |
| CHECK-20 | Pass | A legacy bad brief can receive a perfectly faithful implementation and green technical review, yet the independent product reviewer records original-plan narrowing and leaves the feature incomplete. |

The scenarios live in [intent.test.ts](../test/release-checks/intent.test.ts), [lifecycle.test.ts](../test/release-checks/lifecycle.test.ts), and [operations.test.ts](../test/release-checks/operations.test.ts). They compose the existing task wrapper, runtime and judge fixtures. The full-feature fixture was extracted unchanged from `milestone.test.ts` into [milestone-helper.ts](../test/milestone-helper.ts), with an optional original-request override so release cases can supply their actual source text.

## Installed interface provenance

Lifecycle-sensitive CHECK-06, 08, 12, 17 and 18 invoke the production TypeScript adapters against isolated executable wrappers, never a live home. Shapes and capability limits were checked against the BUILD-01 report at `/home/shayg/fm-homes/linux-mate/data/sf-build-01/report.md` and installed scripts on 12 November 2026:

- `fm-tasks-axi.sh` delegates mutations as JSON and full reads in tasks-axi's structured text format. Installed tasks-axi is **0.2.6**. These cases use the existing helper's non-atomic add path with a permanent guard, matching BUILD-01's missing atomic create-and-hold capability.
- `fm-task-inbox-lib.sh:212` writes `schema=fm-task-inbox.v1`, `at`, optional `body-terminator=1`, `--` and the exact message body. The steering fixture uses that envelope; delivery and incorporation remain separate facts.
- `fm-fleet-snapshot.sh:14` documents `generated`, `fm_home`, backlog, task generation, endpoint and current-state fields. Its emitted `pr` object is at line 915, and status-event age belongs under `paths.status_log.last_event`. The existing runtime helper and additive ready/omission fixtures retain these shapes. `fm-crew-state.sh:1314` reports ready-for-review work as `done` with detail `checks green: PR ready for review`, not an invented `pr-ready` state.
- `fm-control.sh` supports interrupt, exit and relaunch; the toolkit's rewind refusal is exercised without executing any control command.

## Prepared real-script validation — not run

The self-contained script is `/home/shayg/fm-homes/linux-mate/data/sf-build-16/real-firstmate-checks.sh`. Run explicitly from an operator shell:

```sh
sg docker -c '/home/shayg/fm-homes/linux-mate/data/sf-build-16/real-firstmate-checks.sh /home/shayg/.treehouse/software-factory-5a36c6/3/software-factory /home/shayg/fm-homes/linux-mate/bin'
```

It prepares a Node 22 image with tasks-axi 0.2.6, then runs CHECK-06, 08, 12, 17 and 18 against the **installed FirstMate scripts**, using a fresh container-local FirstMate home and inert fake `codex` command in a disposable tmux session. Only the installed `bin/` directory and this source checkout are mounted read-only; task proof output is the sole writable host mount. No existing FirstMate home, credentials, endpoints, Docker socket, Beads state or Scotty is mounted. The test container has no network. Image preparation needs package/registry access; no model resolver or provider command is called. Each case records pass or an unresolved error in `real-firstmate-results.json`; unresolved cases produce exit 1. The prepared script has not been rerun following the production Work projection fix; its previous CHECK-18 expectation may need updating before use.

Only Bash and embedded JavaScript syntax were checked. **The Docker script was not executed**, so real-script compatibility and its container setup remain unverified. This is deliberately separate from the fixture-backed results above.

## Validation

The focused release suite passes **20 scenarios, 0 failures, 0 TODOs**.
`npm run typecheck` passes. Full `npm test` exits 0 with **638 tests: 637 passed, 1 existing
opt-in integration skip, 0 failures, 0 TODOs**. The production launcher smoke check
serves imported readiness, two-minute age, next action and the exact omission over
HTTP, then shuts down with the persisted project unchanged. After adding reopen
and no-runtime-refresh assertions, the focused lifecycle suite also passes.
Proof output for these fixes is retained outside the worktree under
`/home/shayg/fm-homes/linux-mate/data/sf-release-check-fixes/`.

Run `npm test` for the complete suite, or `npm run build && node --test dist/test/release-checks/*.test.js` for these scenarios alone. `npm run typecheck` verifies the shared fixture extraction and all new TypeScript. Earlier BUILD-16 proof remains under `/home/shayg/fm-homes/linux-mate/data/sf-build-16/`.
