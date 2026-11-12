# BUILD-16 release checks

These checks exercise section 10 of `Software_Factory_Design.md`, including the retrospective's example-to-scope narrowing, lost corrections, unsupported rewind, unverified counts, duplicated execution, overlooked reuse, unattended delivery, and baseline-only progress. They validate this companion project; they do not replace or migrate the operator's FirstMate workspace.

Twenty named scenarios run with `npm test`. Seventeen pass completely; three retain concrete unresolved defects. The three defects are executable `todo` subtests, each named by its CHECK ID. Assertions for the available behavior run outside those subtests, so an unrelated failure cannot be hidden by an expected failure. A green test process does **not** mean these three release requirements are delivered.

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
| CHECK-09 | Pass | BUILD-13 Work is now on main. Production adapter parsing/import retains the unstructured fleet omission; the existing WorkSnapshot fixture and read model show stale observations, unknown worker/timing fields and the exact omitted-work message. The HTTP Work view stays visibly incomplete. |
| CHECK-10 | Pass | A local correction updates feature and assignment immediately and blocks old fidelity. Conflicting inferred retry lessons remain explicit conflicts after a separate fake consolidation process; no generalized rule is activated. |
| CHECK-11 | **Unresolved** | HTTP and agent priority mutations update the same task/mapping; replay is stable without another native write, and the overview reads the agent change. **BUILD-14 Decisions view remains absent:** `GET /projects/project-1/decisions` returns 404. Missing route: [src/ui-spike.ts:50](../src/ui-spike.ts#L50), fallback [line 99](../src/ui-spike.ts#L99). Exact case: [operations.test.ts](../test/release-checks/operations.test.ts), `CHECK-11 unresolved — Decisions view`. |
| CHECK-12 | Pass | Handback leaves existing execution available, releases toolkit-owned holds, records the missing-evidence condition and retires pending side effects. Re-enabling observes both native task and fleet interfaces without replay; restored missing attachments keep the reconciliation gate closed. |
| CHECK-13 | Pass | Planning records the working connection interface, the absent feature and the bounded change; the brief retains that reuse finding and only one design exists. Source-based checking refuses an unjustified parallel connection implementation. |
| CHECK-14 | **Unresolved** | A claim for 99 production systems is accepted as `checked` with evidence explicitly from an unrelated demo fixture. No replacement number is guessed. The checked-claim refinement only requires nonempty evidence: [src/records.ts:234](../src/records.ts#L234); graph validation only checks correction links: [src/rules.ts:630](../src/rules.ts#L630). Exact assertion: [operations.test.ts](../test/release-checks/operations.test.ts), `CHECK-14 unresolved — checked count with mismatched inputs`. The reporting method/input validation required by this case is missing. |
| CHECK-15 | Pass | A technical pass with baseline-only code produces a persisted “Baseline preserved; no requested behavior improves” finding, no improvement evidence and refused completion. |
| CHECK-16 | Pass | Focused and parallel plans each retain their own strategy, reason and full selected context through readiness and brief preparation. Selection is per plan, with no global execution-mode switch. |
| CHECK-17 | Pass | The correction retains the original rewind request and exact existing assignment. The real adapter reports unsupported rewind explicitly; no control call, replacement assignment or worker is created. |
| CHECK-18 | **Unresolved** | BUILD-13 renders a supplied toolkit WorkSnapshot correctly: the observed PR reference, two-minute age, next action, review wait and incomplete feature appear in the read model and HTTP view without changing settled intent. **Installed fleet evidence is not connected to that view:** after the real runtime adapter parses and imports the installed-shape ready observation, the default Work view still says ready-work observations are unavailable. `workView` only reads caller-supplied `options.readSnapshot` at [src/ui-work.ts:45](../src/ui-work.ts#L45); project-record observations are not a fallback. The bundled UI supplies synthetic fixture data at [scripts/ui.mjs:45](../scripts/ui.mjs#L45). Exact case: [lifecycle.test.ts](../test/release-checks/lifecycle.test.ts), `CHECK-18 unresolved — installed fleet evidence is not projected into Work`. No test-only conversion is presented as a shipped adapter. |
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

It prepares a Node 22 image with tasks-axi 0.2.6, then runs CHECK-06, 08, 12, 17 and 18 against the **installed FirstMate scripts**, using a fresh container-local FirstMate home and inert fake `codex` command in a disposable tmux session. Only the installed `bin/` directory and this source checkout are mounted read-only; task proof output is the sole writable host mount. No existing FirstMate home, credentials, endpoints, Docker socket, Beads state or Scotty is mounted. The test container has no network. Image preparation needs package/registry access; no model resolver or provider command is called. Each case records pass or an unresolved error in `real-firstmate-results.json`; unresolved cases produce exit 1. In particular, CHECK-18 should remain unresolved until installed runtime evidence is connected to the Work projection.

Only Bash and embedded JavaScript syntax were checked. **The Docker script was not executed**, so real-script compatibility and its container setup remain unverified. This is deliberately separate from the fixture-backed results above.

## Validation

Rebased onto local main `281f793` after BUILD-13 landed. `npm run typecheck` passed. Full `npm test` exited 0 with **628 tests: 624 passed, 1 existing opt-in integration skip, 3 expected failures, 0 unexpected failures**. The release checks comprise 20 parent scenarios and 3 expected-failure subtests; 17 scenarios pass completely. The latest full proof is `npm-test-rebased.log` under the task data directory.

Run `npm test` for the complete suite, or `npm run build && node --test dist/test/release-checks/*.test.js` for these scenarios alone. `npm run typecheck` verifies the shared fixture extraction and all new TypeScript. Proof logs are retained outside the worktree under `/home/shayg/fm-homes/linux-mate/data/sf-build-16/`.
