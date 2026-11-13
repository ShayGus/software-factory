# Personal Software Factory — extending FirstMate

**Updated:** 9 November 2026 · **Status:** implementation design, not an installed system.  
**Supporting material:** the original short recommendation is not included in this distribution.
**Source of truth:** this Markdown. HTML and the development-task export are generated from it. Wireframes are linked source assets, embedded into the HTML for offline viewing.  
**Supersedes:** the earlier platform-first design and 84-task implementation baseline. The broader platform survey remains background research, not an additional build specification.

## 1. Decision and scope

**Extend FirstMate with a MIFAL-inspired product-development methodology and a personal management UI. FirstMate's existing main agent remains a participant in conversation, design, planning, delegation and review.** The core addition is an explicit path from product understanding to design, an ordered plan, detailed implementation tasks, derived worker instructions and review against the original design and plan. Shared records and integration tools make that method usable across sessions and workers. There is no assumption that FirstMate, its main process, or any of its responsibilities must be replaced.

The user's central problem is developing the correct features in a coherent way. Existing orchestration, PR handling and backlog operation broadly work; the missing method is upstream of implementation and review. The supplied retrospective provides failure cases, not a request to make PR housekeeping or metrics the main project. The user also reports that their RoboRev setup reviews worker instructions which are often wrong. This describes their setup, not a claim about every RoboRev configuration. [USR1] Implementation tests evaluate whether the additions address these failures. Compatibility inspection determines where the additions attach; it does not require the user to demonstrate that the problems are real.

Recommended defaults:

- Implement a staged development workflow, shared design/plan artifacts and a FirstMate skill/toolkit. Use the same records and operations from the existing main agent and the UI; add targeted integration changes where required.
- Keep FirstMate's existing execution mechanisms, tasks-axi backlog, worktree integration, and quality pipeline. Add links and context rather than migrating their state.
- Use TypeScript for new code by default, with runtime validation at process and file boundaries. Python is also viable; no Bash rewrite or language migration is a prerequisite.
- Prioritize the design-and-planning methodology. Evaluate free self-hosted Piyaz only as a supporting UI/context candidate before building equivalent screens. UI host selection does not supply the method; use a focused UI if integration is awkward.
- Start with one operator, one FirstMate home and one project containing one or more repositories. Team administration and permission-system development are outside this release.

### Required outcomes

| ID | Requirement | Observable outcome |
|---|---|---|
| NEED-01 | Build on the existing installation | Main-agent participation and existing execution continue through the integration |
| NEED-02 | Preserve requested features | Original requests, features, criteria, and unmapped work remain inspectable |
| NEED-03 | Establish a coherent design and detailed plan | Ground the design in existing work and original goals; produce dependency-aware, verifiable implementation slices before commissioning their implementation |
| NEED-04 | Make scope changes explicit | Current work retains its meaning; amendments and suggested enhancements have separate records |
| NEED-05 | Manage tasks and dependencies | UI and agent actions use the same task operations; blocked work names its prerequisites |
| NEED-06 | Derive faithful worker instructions | Each brief names the design, detailed-plan revision and task it implements; instruction fidelity is checked before dispatch |
| NEED-07 | Review against the intended product | Compare actual behavior with the original request, design and detailed plan; a technically clean implementation of a bad brief can still fail |
| NEED-08 | Learn without rule accumulation | Immediate corrections work now; inferred lessons are consolidated once or twice daily |
| NEED-09 | Communicate clearly in UI and chat | Show outcomes, evidence, remaining gaps and next action; questions include context and concern material product choices |
| NEED-10 | Recover without duplicate execution | Retries, restarts, late replies, and stale observations are represented honestly |
| NEED-11 | Remain understandable and open source | Required functionality runs in eligible free editions; typed modules have narrow responsibilities |
| NEED-12 | Support incremental adoption | Existing tasks can be linked without invented acceptance; the extension can be disabled without dismantling FirstMate |
| NEED-13 | Choose execution to fit the work | Tightly coupled investigation preserves continuity; independent work can still run in parallel without unnecessary review chains |
| NEED-14 | Follow work through delivery | Exact lifecycle intent is preserved; ready PRs, waiting reviews and their next action are surfaced promptly through existing supervision |

The first release includes the complete understand–design–plan–detail–instruct–implement–review cycle, editable feature/task priorities and dependencies, four focused UI views and learning consolidation. Existing operational features are integrated rather than rebuilt; metrics and PR observations support the method. A new scheduler, permanent hierarchy of managers, portfolio administration, a general workflow builder, and wholesale script translation are not release requirements.

### What the supplied retrospective changes

The retrospective is supplied evidence of the user's experience; its incident figures are not independently measured baselines. It illustrates why an explicit design, detailed plan and independent review reference are needed. Operational remedies below are supporting measures within that method. The detailed source is preserved in the bundle. [USR1]

| Reported failure | Required response in this design |
|---|---|
| Repeated unchecked counts and contradictory reports | Inspect measurement definitions and inputs; record evidence, freshness and corrections to prior claims |
| Existing designs/code overlooked; working calculations rebuilt | Inspect relevant implementation and reuse findings before commissioning changes |
| General system requirement narrowed to ERPNext example | Preserve whether a named system is an example, a required integration or the full scope |
| Rewind became a new worker; several conflicting steers | Record the requested action and target, sequence amendments, coalesce only compatible pending updates |
| Review waits and small choices inflate overhead | Choose focused/parallel execution by coupling; reuse valid reviews and resolve internal technical questions through investigation |
| Ready PR left unattended; irrelevant questions/messages | Surface ready work and next actions; reuse existing instructions and report only relevant progress |
| No regression presented as progress | Compare delivered behavior with the starting baseline and requested improvement |

## 2. Reuse recommendation and supporting evidence

FirstMate already separates original user intent from implementation instructions and warns against expanding a narrow request. Its task backend models dependencies, holds, links, and extensible metadata. Those primitives support an extension, although they do not establish faithful product interpretation. [FM1] [TA1]

MIFAL is the main methodology reference. Its documented flow preserves product thinking through a specification and dependent implementation tickets, then reviews both code standards and conformance to the originating specification. Its specification includes the user problem, solution, implementation/testing decisions and exclusions; tickets deliver verifiable slices with explicit blockers. Adapt these mechanisms to FirstMate rather than installing a second execution system. [MF2] [MF3] [MF4] [MF5]

Selectively adopt the methodology. MIFAL also contains repeated confirmations and frequent retrospective prompts; this proposal keeps detail proportionate, reuses settled designs and consolidates inferred lessons on the requested daily cadence. Do not import its whole instruction set without reconciling it with FirstMate.

| Option | Relevant existing capability | Recommendation for this installation |
|---|---|---|
| **Beads + Scotty** | Chosen task/dependency store and existing local browser page | Reuse the tasks-axi Beads backend and Scotty list/graph; verify canonical edit routing in the bounded spike below |
| **Focused custom UI** | Built directly over the toolkit and FirstMate observations | Default fallback if reuse requires extensive synchronization or incompatible workflow changes |
| **Paca** | Apache-2.0 full project application and extension surfaces | Broader alternative; additional application infrastructure needs a clear personal-use benefit [ALT2] |

OpenProject is not the default for this use case. Multica is excluded from the eligible recommendation because its license adds use restrictions beyond the open-source license on which it is based. Free internal use alone does not satisfy the user's open-source requirement. [ALT3] Model and infrastructure charges remain separate from software licensing.

### Beads + Scotty integration check

Beads is the chosen task and dependency store; Scotty is its existing local browser page. Piyaz is out. This check resolves how the chosen tools expose toolkit records and canonical operations, not another tool selection. Execution tasks use the existing FirstMate/tasks-axi operations with the Beads backend. Scotty supplies presentation, not a competing planning or execution workflow; model-assisted actions remain disabled in the spike.

Use one feature, two execution tasks, one dependency, a correction, and a result. The early spike may use a stub canonical API to test layout and mutation routing; that produces a provisional choice. Final adoption requires real adapter round trips during UI integration. Beads + Scotty must show original intent, remaining criteria, execution links, blockers, and decisions as canonical links or read-only text. Map every exposed MVP edit: features/criteria, task state, priority, dependencies, decisions and notes. Each must call its canonical operation or open the focused editor; no native editor may silently update only a projected copy.

**Adopt it only if** the integration avoids duplicate manual bookkeeping, does not require replacing FirstMate lifecycle logic, and has a manageable extension surface for these mutations. A read-only demonstration alone does not satisfy the management-UI requirement. If adoption requires broad mutation interception, generic bidirectional backlog synchronization or substantial remodelling of Scotty, choose the focused custom UI. This check is a bounded engineering decision, not a new broad market survey.

Reuse the existing tasks-axi Beads backend, not a second task synchronizer. Native Scotty edits must be read back by the canonical owner or refused/routed to a toolkit operation. Scotty read-only mode is a browser preference, so the spike must also enforce its mutation boundary. Independent clients must use the backend's supported server configuration; Scotty's per-process embedded queue is not a cross-client lock. The field/mutation mapping and actual round trips remain the integration checks.

## 3. Architecture and data ownership

The proposed toolkit is a local package exposing a CLI and a small HTTP API over the same application functions. FirstMate uses it through a skill and adapter; the browser uses the API. A reviewer can be the existing main agent or a temporary review session started through existing mechanisms. A new permanent manager is not required.

| Module | Responsibility | Integration boundary |
|---|---|---|
| Project records | Requests, goals, feature revisions, criteria, decisions, observations and evidence metadata | Transactional store; versioned export |
| Development methodology | Produce/reuse design, ordered plan and detailed tasks; check instruction fidelity and plan conformance | Existing main agent and appropriate workers/harnesses; structured artifacts |
| FirstMate adapter | Existing task operations, brief preparation, steering, observations and result mapping | Supported CLI surfaces; small integration edits where necessary |
| Learning workflow | Consolidate observations into scoped, versioned guidance | Existing memory workflow plus a scheduled invocation |
| UI adapter | Feature/work views and mutations | Reused host if it passes the adoption check; otherwise React |

**Local baseline:** one TypeScript service, SQLite for project records and pending operations, and files for source attachments and generated briefs. This is a proposal for the companion toolkit, not a new database requirement imposed on FirstMate. Piyaz would additionally use its documented application/PostgreSQL deployment. [PY1] Its extra footprint is part of the reuse decision.

### One canonical source per field

| Information | Canonical source | Other representations |
|---|---|---|
| Original request, feature meaning, design/plan revisions, criteria and product decisions | Toolkit project records and referenced canonical design artifacts | Rendered Markdown and UI projections |
| Execution task state, operational holds, worker identity and lifecycle | FirstMate/tasks-axi | Toolkit observations and UI projections |
| Worker output and technical QA result | Referenced artifact at a recorded revision | Toolkit evidence metadata and criterion findings |
| Active generalized guidance | Versioned toolkit guidance record | Generated guidance consumed by the existing memory/context workflow |

Piyaz, if selected, consumes projections for this baseline. Its UI mutations must call the appropriate canonical operation or open a focused editor that does. A projected field must not silently become a second independently editable truth. Implementing that routing is part of the adoption check, not a capability assumed to exist.

Use an explicit mapping from toolkit IDs to host and FirstMate IDs. Do not match records by title. Historical FirstMate work can be shown as legacy/unmapped while it is linked progressively. Do not reset its state or infer that a finished task proves a feature was delivered.

## 4. Minimum data model and state semantics

These are logical records: the product brief, design and plan may initially be sections of one feature document, with linked task records. They do not require a separate service or document system per stage. All records have a stable ID, project ID, schema version, timestamps, and an integer revision where mutable. Original source content is preserved; corrections are additional records rather than destructive edits to history.

| Record | Required content |
|---|---|
| **Project** | Goal, intended user, current priorities, exclusions, domain vocabulary, repository/design references, FirstMate home reference, local timezone |
| **Request** | Exact original text, source/channel reference, capture time, client request ID, attachments, interpretation/disposition links |
| **Feature revision** | Stable feature ID, outcome, source request IDs, criteria, exclusions, priority, decisions, revision and change reason |
| **Criterion** | Stable ID, expected behavior, verification method, required/optional designation and source references |
| **Design revision** | Source/feature revisions, product behavior and examples, relevant technical design, reused components, interfaces/data flow, decisions, alternatives, testing approach, exclusions and unresolved questions |
| **Implementation plan revision** | Design revision, delivery sequence, focused/parallel strategy, integration approach, dependencies, priorities and readiness findings |
| **Detailed plan task** | Plan/task IDs, expected behavior, criteria/design references, implementation boundaries, reuse targets, inputs/outputs, blockers, verification cases and return requirements |
| **Task mapping** | FirstMate task ID, feature/criterion IDs, relevant task dependencies, mapping revision and legacy status |
| **Assignment** | Assignment/attempt IDs, feature/design/plan revisions, detailed-plan task ID, FirstMate task ID, source references, selected context, criterion IDs, prerequisite artifacts and return location |
| **Criterion result** | Assignment ID, criterion ID, passed/failed/untested/blocked, artifact identity, verification evidence and limitations |
| **Product review** | Original source, design/plan and feature revisions, reviewed artifact identities, instruction-fidelity and plan-conformance findings, baseline/improvement evidence, unresolved questions, outcome, reviewer/session reference and time |
| **Measurement/report claim** | Claim, definition/unit, population and filters, input/artifact revisions, computation or run reference, numerator/denominator where applicable, observation time, checked/reported/contradicted/unknown state and prior-claim correction link |
| **Decision/change** | Question or proposed change, affected records, rationale, disposition and original instruction when applicable |
| **Observation** | Local correction or finding, affected scope, evidence, proposed generalization and consolidation state |
| **Guidance revision** | Scope, current text, supporting observations, superseded guidance IDs, applicability and unresolved conflicts |
| **Operation** | Idempotency key, command, payload digest, pending/succeeded/failed/unknown state, external references and reconciliation record |

Requested criteria default to required. Removing, demoting to optional or deferring one is a scope change tied to an explicit user instruction or a recorded selected change. An agent's proposed simplification remains proposed until selected. A task may serve several criteria, and a feature may require several tasks. A technical maintenance task can link to an explicit maintenance objective; do not invent a user-facing feature solely to satisfy the schema.

**Feature state:** requested → planned → in progress → in review → complete. Deferred and cancelled are explicit dispositions with reasons. Suggested enhancements are separate records until selected. Reopening follows new evidence or changed requirements. Track the method stage separately: understanding, design, planning, ready for implementation, implementation and product review. Both are independent of FirstMate's queued/in-flight/done execution states.

**Completion rule:** every required criterion has current supporting evidence, relevant product review findings are resolved, and the review compared the delivered behavior with the original request. The evidence must name the relevant artifact revision. Changed criteria or code invalidate only affected results; unaffected evidence can be retained with a recorded justification. Missing or untested behavior keeps the feature incomplete.

For objective criteria, completion can be recorded automatically after successful checks and source comparison. Subjective behavior, material ambiguity or unresolved evidence requires a visible decision. The design does not require a new manual approval on every task.

A checklist and schema cannot establish that the natural-language request was interpreted completely. The source comparison is therefore a separate workflow action, and uncertain findings remain visible rather than being converted into certainty by a status transition.

## 5. Workflow additions within FirstMate

### 5.1 Capture requests before interpretation

UI intake writes the request and a pending FirstMate-delivery operation in one transaction. The delivery adapter uses the existing inbox's idempotent request-ID path and stores the returned reference. A saved request with failed announcement is retried through the documented recovery path, not captured again. Inbox handling is a transport fact, not proof of implementation. [FM2]

Existing chat intake needs an explicit integration point that captures original text: a supported harness event, an inbox wrapper, or a verified conversation-entry hook. A skill that asks the agent to remember capture is useful but cannot establish complete capture. If automatic capture is unavailable, expose that coverage limitation and provide a convenient capture action; do not advertise every conversational request as automatically preserved.

Map request content to features and criteria, or an explicit disposition such as clarification, deferral, duplication or non-work conversation. Preserve unclassified requests visibly. Compare the resulting feature list with the source to detect omissions and invented work. Structural mapping finds unlinked items; semantic review checks whether the mapping means what the user asked.

### 5.2 Run the product-development method

The stages below are the central capability to implement. FirstMate can perform them itself or use appropriate existing design/research workers. A new permanent product-manager agent is not required. Retain continuity through design and planning; hand over to implementation only with a sufficient detailed plan. This adopts MIFAL's specification, dependency and review ideas within the current execution environment. [MF2] [MF3] [MF4] [MF5]

| Stage | Artifact and content | Ready to proceed when |
|---|---|---|
| **Understand** | Original request, product goal, intended user behavior, terminology, priorities, examples, exclusions and current system/design findings | The desired outcome and existing work are understood; material unknowns are explicit |
| **Design** | Product flows/behavior and relevant technical design: reuse, boundaries, interfaces, data flow, failure behavior, alternatives and chosen decisions | The design covers the request; consequential choices are resolved or isolated from unaffected work |
| **Plan** | Ordered delivery slices, real dependencies, priorities, integration strategy and focused/parallel work choice | The slices collectively deliver the design without unrelated additions |
| **Detail** | Per-task behavior, relevant design decisions, implementation boundaries, required inputs/outputs, reuse targets, acceptance cases and verification method | A worker can implement without inventing missing product decisions |
| **Instruct** | Assignment derived from a detailed task, with exact design/plan references and the original intent | Instruction-fidelity check finds no omitted or altered requirement for that task |
| **Implement** | Code/artifacts and structured returns linked to the task and plan revision | The task's behavior is demonstrated; deviations and uncertainties are reported |
| **Review** | Product conformance findings against original request, design and detailed plan, alongside existing technical-review results | Required behavior is demonstrated; gaps and incorrect assumptions remain visible |

**Research existing work first.** Inspect relevant design, code, terminology and behavior. Record a short reuse finding in the design: what already works, the actual gap and the proposed change. An existing suitable design can satisfy the design stage; an existing detailed plan can be reused after checking it against the current request and code. Do not rewrite settled work merely to create a new document.

**Keep product and implementation choices distinguishable.** Preserve whether ERPNext or another named system is an example, a required integration or the full scope. Resolve internal technical questions through investigation. Ask the user only about consequential product choices that remain unresolved, with context and a recommendation. An explicit user design/decision remains the basis; routine technical choices proceed within it.

**Make the detailed plan actionable.** Each task identifies the behavior it contributes, the design decisions it must preserve, dependencies and expected artifacts, what will be reused, verification cases and what the worker must return. Prefer independently verifiable slices. Include cross-task integration and final feature verification; a set of individually completed tasks is not by itself a complete product plan. Current code paths may be evidence pointers, not inflexible instructions to preserve a file layout forever. [MF3] [MF4]

**Check the plan before commissioning implementation.** Compare it with the design and original request for dropped behavior, altered generality, invented scope, missing integration and unresolved product decisions. Record a ready plan revision once material gaps are resolved. Research/prototyping tasks can resolve design uncertainty before that point. The first implementation of a slice requires a sufficient plan for that slice; this is not a document freeze or a request for repeated human approval.

**Scale the method to the change.** A small bug can have a compact design note and short plan; a complex catalog/read subsystem warrants deeper design and continuity. Use focused execution for tightly coupled work and parallel workers for independent slices. Reuse valid earlier reasoning and review; do not add a review hierarchy for each task. The first release tests both a general cross-system feature and a narrow correction.

**Replan explicitly.** A material discovery updates the affected design/plan revision, records its rationale and regenerates impacted instructions. Routine implementation refinements remain within the plan. Scope changes remain distinguishable from technical adjustments. Explicit user corrections apply to the relevant artifacts immediately, and unaffected work continues.

### 5.3 Prepare worker context without changing the original ask

Keep `fm-brief.sh` as the lifecycle scaffold. Generate the task-specific content from the detailed plan, attaching the design/plan revisions, goal, relevant decisions, criterion IDs, exclusions, dependency outputs and original source. Put structured coverage in a sidecar or referenced specification section. FirstMate may add execution detail, but changing product meaning requires the plan-amendment path.

**Preserve Captain's intent faithfully.** FirstMate explicitly warns against turning it into an expanded coverage list. The original ask belongs there; the toolkit's interpretations and criteria remain distinguishable. Preserve FirstMate's generated delivery-mode and worktree instructions. [FM1] [FM3]

An instruction-fidelity check compares the assignment with its detailed task, design and original request before managed implementation dispatch. It detects narrowed generality, omitted behavior and invented scope even when the brief is well formed. An assignment records exactly which context and revision the worker received. If a source is too large, supply a faithful task-specific extract plus a reachable original reference; record any truncation. Validate required context before managed dispatch. Ordinary pre-existing tasks remain supported while adoption is incremental.

### 5.4 Manage tasks and dependencies through existing operations

Use `fm-tasks-axi.sh` and the relevant FirstMate lifecycle wrappers. Store the mapping before exposing a new managed task as ready. Confirm installed commands and output shapes rather than inventing universal JSON support. The inspected tasks-axi interface does provide structured mutation results. [TA2]

Feature relationships and execution dependencies differ in granularity. Resolve feature prerequisites to the specific task or artifact needed. Record why the dependency exists and whether the consumer needs an available artifact or a verified criterion. Do not block every dependent on unrelated feature criteria or a universal human review.

Where product readiness adds a condition beyond ordinary task completion, represent it through an existing hold until that condition is met. The adapter must demonstrate that the task cannot become runnable between creation and application of the hold; use a supported atomic path or a small tested integration change. FirstMate remains the execution scheduler.

Changing priority, pausing, resuming, cancelling and editing dependencies in the UI call these same operations. A drag into a visual column is translated into a valid operation, not a direct edit of operational files. Dependency cycles are refused; missing prerequisite IDs remain unresolved. The inspected tasks-axi model has no native cancelled state. Represent cancellation as a toolkit disposition, a hold for queued work, and the applicable existing lifecycle action for active work. Do not mark a cancelled prerequisite done merely to clear the board; its dependents remain unresolved until the plan changes explicitly. [TA1]

### 5.5 Deliver and track corrections

Classify the requested action and target: clarification, amended scope, rewind, resume, cancellation, new work or status. Preserve this meaning when selecting an existing operation. A rewind must use a supported recovery action or expose the missing capability; launching another worker is not an equivalent substitute. Capture corrections against the affected request/feature, increment the applicable revision and identify active assignments. Use the existing durable steering path to deliver it. Track recorded, delivered, acknowledged and incorporated as distinct facts. Acknowledgement alone cannot establish that a correction was implemented. [FM4]

Sequence steering per assignment. Coalesce compatible, not-yet-delivered amendments; preserve their original sources and explicitly mark superseded instructions. Do not delay an urgent stop or lose a distinct user correction to reduce message count. A small clarification can be attached to the active attempt. A changed outcome requires an amended assignment and an impact check on dependencies and completed evidence. If the intended recipient or current state is unknown, show the unresolved delivery instead of assuming success. A late return from an old revision remains historical and does not close new criteria.

### 5.6 Review against the design and plan

Workers provide a structured return per assigned criterion and link their technical evidence. Import existing reports as evidence when possible; do not require the quality pipeline to be rewritten. Results contain accomplished behavior, failures or uncertainty, relevant artifact revisions, and separately listed suggestions.

The worker brief is not the sole definition of correctness. The review input contains the original request, product/design revision, detailed-plan revision and task, acceptance cases, actual delivered revision, worker return and existing technical-review results. FirstMate or a suitable temporary reviewer checks that the plan and intended behavior were implemented. MIFAL similarly distinguishes standards review from specification conformance. [MF5]

Keep RoboRev and the existing quality pipeline. Inspect the actual installed review integration before claiming it can consume extra context automatically. If it accepts design/plan references, provide them; otherwise run one bounded product-conformance pass through the existing harness. Do not duplicate the same code-quality checks.

The decisive case is a design requiring a general solution, a worker brief incorrectly narrowed to ERPNext, and code that perfectly follows that brief. Instruction checking should catch the problem before dispatch; product review must still reject the missing general behavior if it reaches review. Also compare the plan with the original request, so a mistake already present in the plan cannot validate itself.

MIFAL's named-claim pattern helps structure this return. The review must also consult original source text, because a requirement omitted from the claim list would otherwise remain invisible. [MF1]

Task teardown and a green test suite can coexist with an incomplete feature. Show both states and distinguish preserved baseline behavior from newly demonstrated improvement. Regression success cannot substitute for evidence that the requested goal moved.

Verification and reporting support this product review. Check measurement definitions, inputs and artifact revisions before marking numerical claims verified; worker prose alone is a reported claim. New or changed definitions need a small known-case check. An unknown optional measurement changes report wording, not implementation eligibility. Correct unsupported previous claims explicitly.

Use the existing technical-review and delivery mechanisms. Surface ready PRs and genuine review/input waits in the UI, following already-settled delivery instructions. These are supporting integrations, not a PR-system rebuild. Default communication remains achieved behavior, evidence, remaining gap and next action; questions concern unresolved product choices rather than internal mechanics.

## 6. Learning without continuous rule writing

The requested cadence applies to inferred general rules. It does not postpone current corrections, explicit standing instructions, operational capture, or compaction-time continuity.

| Input | Immediate behavior | Consolidation behavior |
|---|---|---|
| Correction to this feature | Update its record and active assignment | Consider a broader lesson only if supported |
| Explicit standing instruction from the user | Apply it in the stated scope now | Merge duplicates and record supersession |
| Worker discovers a possible general lesson | Store an observation with evidence and scope | Evaluate applicability and contradictions |
| Temporary incident or environment fact | Preserve operational context where needed | Expire, relocate or archive when obsolete |

Run consolidation once or twice daily in the configured timezone using one existing scheduling mechanism. Record the last successful window and coalesce missed runs into one catch-up. Do not create a separate always-running learning agent.

The pass groups related observations, checks active guidance, distinguishes task-specific exceptions from general patterns, and produces one of: update existing guidance, supersede it, add narrowly scoped guidance, retain an unresolved conflict, or conclude no general rule is warranted. Each change links to its evidence. An explicit feature instruction overrides an incompatible project default for that feature; ambiguity is surfaced rather than resolved by silently adding another rule.

FirstMate already has extensive `stow` capture and consolidation behavior. Integrate observation routing and promotion into that workflow; preserve operational capture at reset/compaction. Existing operational memory remains in place. Consolidation reads relevant legacy guidance and adopts identified entries or sections, recording their source and replacement. Update those sections without overwriting whole memory files, and stop injecting superseded text so the adopted rule has one active version. [FM6]

Normal inferred-guidance writes use the consolidation operation. Existing direct promotion paths in the correction/memory workflow must be adapted accordingly; adding an unused observation inbox would not fix rule accumulation. Review a generated diff and verify that superseded text stops appearing in newly assembled context.

## 7. UI scope and wireframes

The UI is for one person managing software outcomes. The screens below are proposed workflow illustrations, not screenshots or claims about Scotty. All sample values are illustrative. Each record links back to original requests, related work and evidence. Loading, stale, unknown and incomplete states use text labels, not color alone.

### Overview and features

Show requested features separately from suggestions, current design/planning stage, demonstrated behavior, remaining criteria, work and decisions needing input. Expose manual feature/task priority and dependency changes. Creation, priority changes, deferral and feature edits use toolkit operations. The overview answers what was requested, what remains, and what needs attention.

Proposed overview and feature coverage.
The original wireframe source (`personal_wireframes/overview.svg`) is not included in this distribution.

### Feature detail

Make the original request, product design, detailed plan and their revisions directly accessible. Show which plan task produced each worker assignment. Keep criteria, decisions and changes alongside those references. Show task progress separately from feature completeness. Corrections name the active revision and affected attempts; evidence can be inspected per criterion.

Proposed feature detail with original request and incomplete criteria.
The original wireframe source (`personal_wireframes/feature.svg`) is not included in this distribution.

### Work and dependencies

Provide a task list or board and a dependency view. Cards show feature links and blocking reasons. Task actions go through FirstMate. Include ready-since/review age and next action for PRs, plus execution versus waiting time where observed. A returned worker appears as returned even if the associated product behavior is incomplete. Use the chosen Beads + Scotty list/graph where useful; focused toolkit editors handle product meaning and canonical mutations that Scotty cannot route. The board is a proposed presentation option.

Proposed task board and dependency view.
The original wireframe source (`personal_wireframes/work.svg`) is not included in this distribution.

### Learning and decisions

Show observations, current guidance, scope, supersession and the next consolidation window. A compact needs-input view groups real product questions; it is not an approval queue for routine implementation. On narrow screens, preserve feature review and decision handling before complex graph editing.

Proposed observations and learning consolidation.
The original wireframe source (`personal_wireframes/learning.svg`) is not included in this distribution.

## 8. Interfaces, recovery and adoption

### Proposed application operations

These are new toolkit operations, not claims that FirstMate already exposes matching commands. CLI and HTTP wrappers call the same functions. An MCP wrapper may be added if the existing harness benefits; it is not required for the first integration.

| Operation family | Input | Result |
|---|---|---|
| Capture request | Client request ID, exact text, source, project | Request ID and delivery state |
| Design/plan feature | Source and existing-design references, expected revisions, behavior, decisions and detailed tasks | Design/plan revisions, traceability and readiness findings |
| Record decision/suggestion | Affected records, rationale, disposition | Linked decision and impact summary |
| Map/manage execution task | Feature/criterion IDs, existing or new task, requested operation | Mapping plus confirmed FirstMate state or unknown outcome |
| Prepare assignment | Detailed-plan task ID, feature/design/plan revisions, selected context | Existing scaffold, derived instructions, fidelity findings and assignment ID |
| Deliver correction | Revision, affected assignment, original correction | Delivery record and pending incorporation state |
| Record/review result | Original request, design/plan revisions, assignment, results and delivered artifact identity | Product conformance findings, technical-review links and completeness |
| Capture/consolidate learning | Observation or scheduled-window ID | Guidance diff, conflicts and supersession |
| Read project state/export | Project ID, cursor or revision | Features, work, decisions, learning and freshness |

Mutations carry an idempotency key and expected revision. Reusing a key with a different payload is an error. Return structured validation, conflict, not-found, external-failure or unknown-outcome information. Parse subprocess responses as untrusted external data and pass arguments without shell interpolation.

### Persistence and reconciliation

Write project mutations and intended external operations transactionally. A small reconciler performs pending operations and records observed outcomes; it does not select or schedule workers. After an ambiguous dispatch result, inspect FirstMate using recorded IDs before retrying. Never equate an HTTP/process timeout with proof that nothing happened.

Use `fm-fleet-snapshot.sh --json` for the available observational read model. Preserve timestamps, provenance, omissions and unknown state instead of scraping terminal text or showing absent data as an empty fleet. [FM5] Keep polling and freshness thresholds configurable. Reconnect should reconcile snapshots before replaying mutations.

Persist evidence references plus a digest or stable revision for locally retained artifacts. Keep source requests and product changes recoverable through history and a consistent backup/export. Restore the store and referenced local artifacts together, then reconcile live FirstMate state. Report missing artifacts explicitly.

### Incremental rollout

Inspect installed versions, local overrides, intake paths and command contracts to implement the adapter. Begin with one project and opt-in managed features. Existing tasks appear as legacy until linked; running workers continue normally. Do not retroactively mark old results verified.

Disabling project integration suspends pending toolkit operations and prevents delayed replay; active FirstMate work remains available. The action explicitly chooses pause or hand back to ordinary FirstMate management. Pause retains labelled toolkit readiness holds; handback disposes of only toolkit-created holds and records outstanding product conditions. Existing unrelated holds remain intact. Re-enabling reconciles live state before resuming operations. Removing a UI projection must not cancel its underlying task. Keep a concise compatibility record for the exercised version; do not claim universal compatibility across all FirstMate releases.

Use the user's existing agent harness through FirstMate where possible. The extension does not require selecting a new model provider or buying an additional orchestration service. Deployment instructions must list the free editions and actual dependencies used.

## 9. Development packages and tasks

The tasks below are the current build baseline. They replace the prior 84-task backlog. They are proposed work, not tickets created in a tracker and not evidence that software was implemented.

| Package | Tasks | Parallel development boundary |
|---|---|---|
| Foundation | BUILD-01–03 | Interface inspection and schema work can start independently |
| Product workflow | BUILD-04, 06–07 | Use the agreed schemas and recorded fixtures |
| Existing-runtime integration | BUILD-08–10 | Separate task, correction and result adapters with shared IDs |
| UI reuse and views | BUILD-05, 12–14 | Start with mocks; choose reuse before building duplicate screens |
| Learning | BUILD-11 | Use observation/guidance contracts; independent of UI choice |
| Delivery | BUILD-15–18 | Recovery, regression validation, integration and packaging |

### BUILD-01 — Map the installed interfaces

**Package:** Foundation  
**Depends on:** none  
**Covers:** NEED-01, NEED-10, NEED-12  
**Deliverable:** Record installed versions, overrides, intake, task, brief, steering, result and snapshot contracts. Capture representative output fixtures and identify minimal integration edits.  
**Acceptance:** Each required operation has a supported call or a precisely scoped patch; uncertain results and input-capture limits are documented. FirstMate's main agent and existing lifecycle remain in the proposed path.

### BUILD-02 — Define records and operation contracts

**Package:** Foundation  
**Depends on:** none  
**Covers:** NEED-02, NEED-04, NEED-06, NEED-07, NEED-08, NEED-11  
**Deliverable:** Runtime-validated schemas for section 4, command envelopes, enums, revision rules and fixtures.  
**Acceptance:** Invalid results, unknown criterion IDs and mismatched revisions are detected; fixtures include changed scope, omitted criteria and ambiguous execution outcomes.

### BUILD-03 — Implement project persistence

**Package:** Foundation  
**Depends on:** BUILD-02  
**Covers:** NEED-02, NEED-04, NEED-10, NEED-11  
**Deliverable:** SQLite records, history, idempotent mutations, pending-operation storage and portable export.  
**Acceptance:** Restart preserves requests and revisions; stale writes conflict; repeated commands do not duplicate records; different payloads cannot reuse an operation key.

### BUILD-04 — Capture requests and show coverage

**Package:** Product workflow  
**Depends on:** BUILD-01, BUILD-03  
**Covers:** NEED-02, NEED-03, NEED-04  
**Deliverable:** UI/CLI intake, supported conversational capture or an explicit capture-action fallback, source-to-feature mapping and unclassified-request view.  
**Acceptance:** Original wording survives decomposition and correction; an omitted feature remains visible; capture coverage is accurately reported for each entry channel.

### BUILD-05 — Resolve the UI reuse decision

**Package:** UI  
**Depends on:** BUILD-01, BUILD-02  
**Covers:** NEED-01, NEED-05, NEED-09, NEED-11  
**Deliverable:** One-feature Beads + Scotty spike using the existing tasks-axi Beads task operations, a stub canonical API and a provisional reuse/focused-editor decision covering field ownership, workflow guidance, dependencies and every exposed mutation. Beads and Scotty are already chosen; Piyaz is out.

**Acceptance:** Identify a viable route for every exposed MVP edit and demonstrate stub round trips. Confirm actual canonical mutations in BUILD-12–14 and BUILD-17 before final adoption. If the section 2 criteria fail, choose the focused UI and close the spike; do not build a generic synchronization platform.

### BUILD-06 — Implement the staged design and planning method

**Package:** Product workflow  
**Depends on:** BUILD-02, BUILD-04  
**Covers:** NEED-02, NEED-03, NEED-04, NEED-07, NEED-09, NEED-13  
**Deliverable:** Understand/design/plan/detail workflow with existing-design reuse, explicit product and technical decisions, verifiable slices, integration steps, dependencies and plan-readiness findings.  
**Acceptance:** A general cross-system feature and a narrow correction produce proportionate designs and actionable detailed plans. Existing designs are reused; missing behavior, example-driven narrowing and missing integration are caught before implementation. No repeated approval is added for settled decisions.

### BUILD-07 — Derive and validate worker instructions

**Package:** Product workflow  
**Depends on:** BUILD-01, BUILD-03, BUILD-06  
**Covers:** NEED-03, NEED-04, NEED-06, NEED-13  
**Deliverable:** Detailed-plan-to-brief generator, design/source context selector, instruction-fidelity check and sidecar integrated after FirstMate scaffolding.  
**Acceptance:** Original intent and lifecycle scaffold remain intact. Every brief traces to design/plan/task revisions; a general design narrowed to one example is detected before implementation dispatch; missing context is explicit.

### BUILD-08 — Connect task and dependency management

**Package:** Runtime integration  
**Depends on:** BUILD-01, BUILD-03, BUILD-07  
**Covers:** NEED-01, NEED-05, NEED-10  
**Deliverable:** Mapping, create/update/priority/hold/cancel/dependency operations and product-readiness translation through existing wrappers.  
**Acceptance:** A managed task cannot dispatch before its mapped prerequisite/hold clears; dependency cycles fail; FirstMate remains execution owner; ambiguous mutations reconcile by stable ID.

### BUILD-09 — Carry corrections to active work

**Package:** Runtime integration  
**Depends on:** BUILD-01, BUILD-03, BUILD-07  
**Covers:** NEED-04, NEED-06, NEED-10, NEED-14  
**Deliverable:** Exact lifecycle-intent mapping, revision impact, ordered/coalesced steering and distinct acknowledgement/incorporation tracking.  
**Acceptance:** The correct attempt receives ordered corrections; compatible pending updates consolidate without losing sources; rewind does not silently launch new work; delivery failures and stale returns cannot claim current completion.

### BUILD-10 — Integrate plan-based product review

**Package:** Runtime integration  
**Depends on:** BUILD-01, BUILD-03, BUILD-06, BUILD-07  
**Covers:** NEED-02, NEED-06, NEED-07, NEED-09, NEED-13, NEED-14  
**Deliverable:** Review package containing original intent, design, detailed plan and delivered revision; RoboRev/quality-result integration; bounded product-conformance review and outcome evidence.  
**Acceptance:** Code that follows a bad brief but violates the design fails product review even when technical review passes. Missing plan behavior and wrong implementations are identified; original-request omissions are checked; unchanged quality checks are reused.

### BUILD-11 — Integrate learning consolidation

**Package:** Learning  
**Depends on:** BUILD-01, BUILD-03  
**Covers:** NEED-04, NEED-08  
**Deliverable:** Observation capture, scoped guidance revisions, configured daily/twice-daily invocation, and adapted correction/stow write paths.  
**Acceptance:** Local corrections apply immediately; inferred lessons wait for consolidation; duplicate/conflicting observations do not produce contradictory active guidance; explicit standing instructions remain immediate; compaction capture still works.

### BUILD-12 — Build overview and feature views

**Package:** UI  
**Depends on:** BUILD-03, BUILD-04, BUILD-05  
**Covers:** NEED-02, NEED-04, NEED-07, NEED-09  
**Deliverable:** Reused or custom feature overview, readable/editable design and detailed-plan views, stage progress, source, criteria, changes and evidence; initial integration uses fixtures.  
**Acceptance:** The user can inspect/change feature priorities, open its design and detailed plan, trace a task brief to that plan and identify missing behavior without chat history; all edits use canonical operations.

### BUILD-13 — Build work and dependency views

**Package:** UI  
**Depends on:** BUILD-05, BUILD-08  
**Covers:** NEED-05, NEED-09, NEED-10, NEED-13, NEED-14  
**Deliverable:** Work/dependency views, exact task actions, execution/wait observations, ready PRs with age/next action and snapshot freshness.  
**Acceptance:** UI edits use canonical operations; blockers, unknowns and review waits remain visible; ready PRs are surfaced; focused work retains its context; returning a worker does not complete its feature.

### BUILD-14 — Build decisions and learning views

**Package:** UI  
**Depends on:** BUILD-05, BUILD-11  
**Covers:** NEED-04, NEED-08, NEED-09, NEED-14  
**Deliverable:** Contextualized product questions, existing-answer reuse, observation inbox, guidance scope/history and consolidation diff.  
**Acceptance:** Real UI mutations update canonical decisions/guidance. The user can answer a material question, inspect a superseded rule and see unresolved conflicts without approving ordinary implementation.

### BUILD-15 — Reconcile, import and restore

**Package:** Delivery  
**Depends on:** BUILD-03, BUILD-08, BUILD-09, BUILD-10  
**Covers:** NEED-01, NEED-10, NEED-12  
**Deliverable:** Unknown-outcome reconciliation, progressive legacy linking, backup/restore and project disable behavior.  
**Acceptance:** Crash after external success produces no duplicate worker on restart; old work stays unverified until checked; restore reports missing artifacts; disabling the extension preserves existing execution.

### BUILD-16 — Validate the reported failure patterns

**Package:** Delivery  
**Depends on:** BUILD-06, BUILD-08, BUILD-09, BUILD-10, BUILD-11, BUILD-15  
**Covers:** NEED-02, NEED-03, NEED-04, NEED-05, NEED-06, NEED-07, NEED-08, NEED-09, NEED-10, NEED-13, NEED-14  
**Deliverable:** Regression scenarios CHECK-01–20 below, including the supplied retrospective, using fixtures and the actual adapter for lifecycle-sensitive cases.  
**Acceptance:** Each scenario records a pass or a concrete unresolved defect. Semantic checks consult original requests; tests do not merely mirror the implementation's rewritten checklist.

### BUILD-17 — Integrate one real project

**Package:** Delivery  
**Depends on:** BUILD-10, BUILD-12, BUILD-13, BUILD-14, BUILD-16  
**Covers:** NEED-01, NEED-02, NEED-03, NEED-04, NEED-05, NEED-06, NEED-07, NEED-08, NEED-09, NEED-10, NEED-12, NEED-13, NEED-14  
**Deliverable:** One real feature through FirstMate, with researched reuse, an appropriate execution mode, a correction, a suggestion, a dependency and verified progress reporting.  
**Acceptance:** The new capability works alongside the existing main agent and automations; requested behavior and missing results remain visible in the UI; remaining limitations are recorded against requirements.

### BUILD-18 — Package the reproducible release

**Package:** Delivery  
**Depends on:** BUILD-05, BUILD-17  
**Covers:** NEED-01, NEED-09, NEED-11, NEED-12  
**Deliverable:** Free-edition installation, compatibility notes, upgrade/disable instructions, backup procedure, generated docs and task export.  
**Acceptance:** A clean local installation can run the chosen configuration and restore its sample project; Markdown reproduces HTML and task exports; no unselected UI host or paid-only dependency is required.

## 10. Release checks and rollout order

| ID | Scenario | Required result |
|---|---|---|
| CHECK-01 | Request contains several distinct behaviors | All are represented or visibly unresolved after planning |
| CHECK-02 | Planner introduces an adjacent enhancement | It remains a suggestion outside current feature scope |
| CHECK-03 | Worker receives a narrow request | Original meaning survives context preparation; unrelated expansion is detectable |
| CHECK-04 | Criterion omitted from the implementation checklist | Source-based review can flag the omission |
| CHECK-05 | Technical tests pass but behavior is absent | Feature stays incomplete and identifies the missing behavior |
| CHECK-06 | Correction arrives during execution | Current attempt and evidence reflect the revision; stale returns cannot close it |
| CHECK-07 | A dependency has not produced the required output | Managed dependent work remains blocked with a visible reason |
| CHECK-08 | Adapter crashes after an external operation succeeds | Reconciliation finds existing work and prevents duplicate execution |
| CHECK-09 | Worker/FirstMate observations are stale or incomplete | UI shows uncertainty and omissions rather than false completion |
| CHECK-10 | Local correction and conflicting general lessons arrive | Current work changes immediately; consolidation resolves or retains the conflict explicitly |
| CHECK-11 | User edits through UI and agent tools | The same canonical records and task operations are updated |
| CHECK-12 | Extension is disabled or data is restored | Existing work remains available; pending operations do not replay unexpectedly; toolkit holds and evidence gaps have explicit dispositions |
| CHECK-13 | Existing design/code already implements the proposed work | Planning identifies it and specifies the actual gap; no parallel copy is created without a concrete reason |
| CHECK-14 | A worker reports a count with an unclear definition or wrong fixture | Reporting checks the method/inputs and withholds verified status until supported; no guessed replacement number |
| CHECK-15 | All old checks pass but no requested behavior improves | Report says baseline preserved and identifies the unmet outcome |
| CHECK-16 | Work is tightly coupled and still being understood | Focused execution preserves context; independent tasks can still be parallelized without a universal mode switch |
| CHECK-17 | User requests rewind of an existing worker | Correct existing target/action is used, or unsupported capability is explicit; no silent new-worker substitute |
| CHECK-18 | A PR is ready while review/new work queues grow | Existing supervision surfaces readiness, age, next action and actual blockers; settled delivery instructions are reused |
| CHECK-19 | Correct design and plan produce a wrongly narrowed worker brief | Instruction-fidelity checking identifies the mismatch before managed implementation dispatch |
| CHECK-20 | Code perfectly follows a bad brief and passes technical review | Product review identifies violation of the original design/plan and leaves the feature incomplete |

Start BUILD-01 and BUILD-02 in parallel. After contracts are stable, run BUILD-05 while persistence and intake proceed. Product, runtime, learning and UI packages can then develop against shared fixtures. The first useful milestone is one feature taken through a coherent design, detailed plan, derived instructions and plan-based review; the release adds live UI mutations, correction handling, learning and recovery. Avoid migrating the whole backlog before that cycle works.

The planning estimate remains intentionally open until the installed interface map and UI reuse check are complete. Task boundaries and acceptance conditions are concrete; pretending to know the calendar cost of an untested integration would not improve the plan.

### Remaining decisions and evidence limits

The user requirements are settled. Implementation must resolve the exact conversational capture hook, installed command compatibility, Piyaz mutation integration, and source/artifact retention locations. These are engineering decisions within the stated scope. A proposal to change FirstMate's responsibilities or replace a subsystem is a separate design change, not an inference from this report.

Source inspection supports the existing integration primitives below. New records, workflows, adapters and wireframes are proposals. The user's private installed configuration has not been inspected, no platform was installed for this update, and the proposed end-to-end acceptance checks have not been executed. Public-source evidence does not negate the user's reported daily failures or establish a single cause for them.

## 11. Evidence sources

The supplied retrospective is direct input to the requirements, preserved in `FirstMate_User_Retrospective.md` (private source, not distributed). It is distinct from independently inspected public source. Pinned source snapshots provide reproducible references. Current Piyaz documentation was checked on 9 November 2026. Descriptions of future behavior above are design decisions, not claims of shipped functionality.

- **[FM1] FirstMate intent, task and brief contract:** [AGENTS.md, pinned bc9370e](https://github.com/kunchenguid/firstmate/blob/bc9370e8868421ce6791d33455301b4287a4cef3/AGENTS.md#L169-L224), including [backlog and brief sections](https://github.com/kunchenguid/firstmate/blob/bc9370e8868421ce6791d33455301b4287a4cef3/AGENTS.md#L367-L394).
- **[FM2] Idempotent inbox capture and receipt semantics:** [fm-inbox.sh](https://github.com/kunchenguid/firstmate/blob/bc9370e8868421ce6791d33455301b4287a4cef3/bin/fm-inbox.sh#L21-L92).
- **[FM3] Existing brief scaffold:** [fm-brief.sh](https://github.com/kunchenguid/firstmate/blob/bc9370e8868421ce6791d33455301b4287a4cef3/bin/fm-brief.sh#L1-L66).
- **[FM4] Durable steering:** [fm-send.sh](https://github.com/kunchenguid/firstmate/blob/bc9370e8868421ce6791d33455301b4287a4cef3/bin/fm-send.sh#L20-L81).
- **[FM5] Structured observations and freshness:** [fm-fleet-snapshot.sh](https://github.com/kunchenguid/firstmate/blob/bc9370e8868421ce6791d33455301b4287a4cef3/bin/fm-fleet-snapshot.sh#L1-L95).
- **[FM6] Capture, compaction and memory consolidation:** [stow skill](https://github.com/kunchenguid/firstmate/blob/bc9370e8868421ce6791d33455301b4287a4cef3/.agents/skills/stow/SKILL.md).
- **[TA1] Existing execution task model:** [tasks-axi model, pinned 9401ff8](https://github.com/kunchenguid/tasks-axi/blob/9401ff899c0d1d8ae6b4fd8727b9025abda2032c/src/model.ts#L36-L89).
- **[TA2] Task mutation and JSON interfaces:** [tasks-axi README](https://github.com/kunchenguid/tasks-axi/blob/9401ff899c0d1d8ae6b4fd8727b9025abda2032c/README.md).
- **[MF1] Purpose, named claims and structured returns:** [MIFAL brief contract, pinned fbf1eb1](https://github.com/romiluz13/mifal/blob/fbf1eb1197dd4e5cea502a9ddadf2ca92df6d90f/skills/team-lead/references/contracts/brief.md#L34-L81).
- **[MF2] MIFAL design-to-delivery flow and reasoning continuity:** [workflow router](https://github.com/romiluz13/mifal/blob/fbf1eb1197dd4e5cea502a9ddadf2ca92df6d90f/skills/ask-matt/SKILL.md#L14-L40).
- **[MF3] Product/implementation/testing specification:** [to-spec](https://github.com/romiluz13/mifal/blob/fbf1eb1197dd4e5cea502a9ddadf2ca92df6d90f/skills/to-spec/SKILL.md#L10-L74).
- **[MF4] Verifiable implementation slices and dependencies:** [to-tickets](https://github.com/romiluz13/mifal/blob/fbf1eb1197dd4e5cea502a9ddadf2ca92df6d90f/skills/to-tickets/SKILL.md#L14-L64).
- **[MF5] Review against the originating specification:** [code-review](https://github.com/romiluz13/mifal/blob/fbf1eb1197dd4e5cea502a9ddadf2ca92df6d90f/skills/code-review/SKILL.md#L25-L89).
- **[PY1] Piyaz free self-hosting and dependencies:** [run locally](https://docs.piyaz.ai/docs/self-hosting/run-locally/) and [AGPL license](https://github.com/FrkAk/piyaz/blob/main/LICENSE).
- **[PY2] Actual task, detail and graph surfaces:** [Tasks UI](https://docs.piyaz.ai/docs/dashboard/tasks/).
- **[PY3] MCP operations and injected workflow guidance:** [MCP overview](https://docs.piyaz.ai/docs/reference/mcp-overview/).
- **[PY4] Graph semantics and scoped notes:** [task graph](https://docs.piyaz.ai/docs/how-it-works/task-graph/) and [notes](https://docs.piyaz.ai/docs/dashboard/notes/).
- **[PY5] Optional execution pipeline:** [Composer](https://docs.piyaz.ai/docs/using-piyaz/composer/).
- **[ALT1] Smaller task/UI alternative:** [Beads license](https://github.com/gastownhall/beads/blob/main/LICENSE), [Scotty repository and license](https://github.com/brendan-appstart/bead-me-up-scotty).
- **[ALT2] Larger project application:** [Paca architecture](https://github.com/Paca-AI/paca/blob/2e93cee2c87174e6a8ed02dc08afceb0c6faaba9/docs/architecture/overview.md) and [license](https://github.com/Paca-AI/paca/blob/master/LICENSE).
- **[ALT3] Multica eligibility:** [published licensing terms](https://multica.ai/licensing).

[FM1]: https://github.com/kunchenguid/firstmate/blob/bc9370e8868421ce6791d33455301b4287a4cef3/AGENTS.md#L367-L394
[FM2]: https://github.com/kunchenguid/firstmate/blob/bc9370e8868421ce6791d33455301b4287a4cef3/bin/fm-inbox.sh#L21-L92
[FM3]: https://github.com/kunchenguid/firstmate/blob/bc9370e8868421ce6791d33455301b4287a4cef3/bin/fm-brief.sh#L1-L66
[FM4]: https://github.com/kunchenguid/firstmate/blob/bc9370e8868421ce6791d33455301b4287a4cef3/bin/fm-send.sh#L20-L81
[FM5]: https://github.com/kunchenguid/firstmate/blob/bc9370e8868421ce6791d33455301b4287a4cef3/bin/fm-fleet-snapshot.sh#L1-L95
[FM6]: https://github.com/kunchenguid/firstmate/blob/bc9370e8868421ce6791d33455301b4287a4cef3/.agents/skills/stow/SKILL.md
[TA1]: https://github.com/kunchenguid/tasks-axi/blob/9401ff899c0d1d8ae6b4fd8727b9025abda2032c/src/model.ts
[TA2]: https://github.com/kunchenguid/tasks-axi/blob/9401ff899c0d1d8ae6b4fd8727b9025abda2032c/README.md
[MF1]: https://github.com/romiluz13/mifal/blob/fbf1eb1197dd4e5cea502a9ddadf2ca92df6d90f/skills/team-lead/references/contracts/brief.md
[PY1]: https://docs.piyaz.ai/docs/self-hosting/run-locally/
[PY2]: https://docs.piyaz.ai/docs/dashboard/tasks/
[PY3]: https://docs.piyaz.ai/docs/reference/mcp-overview/
[PY4]: https://docs.piyaz.ai/docs/how-it-works/task-graph/
[PY5]: https://docs.piyaz.ai/docs/using-piyaz/composer/
[ALT1]: https://github.com/brendan-appstart/bead-me-up-scotty
[ALT2]: https://github.com/Paca-AI/paca/blob/2e93cee2c87174e6a8ed02dc08afceb0c6faaba9/docs/architecture/overview.md
[ALT3]: https://multica.ai/licensing

[USR1]: #supporting-private-source

[MF2]: https://github.com/romiluz13/mifal/blob/fbf1eb1197dd4e5cea502a9ddadf2ca92df6d90f/skills/ask-matt/SKILL.md

[MF3]: https://github.com/romiluz13/mifal/blob/fbf1eb1197dd4e5cea502a9ddadf2ca92df6d90f/skills/to-spec/SKILL.md

[MF4]: https://github.com/romiluz13/mifal/blob/fbf1eb1197dd4e5cea502a9ddadf2ca92df6d90f/skills/to-tickets/SKILL.md

[MF5]: https://github.com/romiluz13/mifal/blob/fbf1eb1197dd4e5cea502a9ddadf2ca92df6d90f/skills/code-review/SKILL.md

## Supporting private source

USR1 identifies the owner-supplied retrospective used during design.
That private source is not part of this public distribution; references describe the supplied evidence rather than an included document.
