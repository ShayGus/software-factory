# Beads backend contract (one-home build)

This local adapter targets **bd 1.1.0**, build `8e4e59d39f34`.
Other versions must be refused until their schema and behavior are verified.
The existing Markdown backend remains the default.

## Identity and ownership

One explicitly configured `.beads` workspace and database belong to one
FirstMate home. No discovery, title matching, cross-workspace lookup, or routing
through Beads' `--repo` is permitted. `repo` remains a task attribute.
Logical IDs remain caller-supplied slug join keys. Physical IDs are exactly
`<prefix>-<logical-id>`; the versioned metadata records the logical ID as well.
The logical ID is always the public input/output identity: an already-prefixed
logical ID is preserved literally, so `fm-example` maps to `fm-fm-example`.
Physical IDs are never accepted as aliases. This makes the mapping injective.
Rows in the configured prefix without tasks-axi metadata are native Beads tickets.
Reads hydrate their native fields without writing metadata; the first tasks-axi mutation adopts them in its transaction.
Malformed or unsupported existing tasks-axi metadata and foreign-prefix rows still fail closed.

## Persistence model

Native status maps `queued → open`, `in_flight → in_progress`, `done → closed`.
Native title and description represent title and body.
New tasks-axi rows use native type `task`; native-created rows retain their type and expose it as their initial kind.

FirstMate kind (including `captain`), repo, optional priority presence, logical
ID, typed links, dependency reasons, structured hold, original dates, stable
ordering and arbitrary task `meta` live under versioned `tasks_axi` metadata.
Other clients' metadata must survive writes. Native dependency endpoints use
physical IDs with the same direction as tasks-axi's logical edges.

Dates retain their optional legacy values; database timestamps must not become
fabricated historical dates. New dates and hold expiry use the local calendar,
matching Markdown. Holds are orthogonal to lifecycle state and never synthesize
a due date or captain answer. The existing CLI readiness derivation remains
authoritative. Holds, including encoded reasons, survive start/done/reopen.

Evidence-bearing closure must atomically preserve typed evidence and state,
or persist and verify evidence before closing with idempotent recovery. A
successful response must never describe closure whose evidence was lost.
Body replacement with `archiveBody` must retain the previous body durably.

## Concurrency and failure boundary

All writers must connect to **one externally managed Dolt SQL server**. There
is no embedded fallback and an adapter-only file lock is insufficient.
Two-client contention, transaction rollback, metadata replacement semantics,
and server-loss behavior must be proven on fresh scratch databases before
the adapter is implemented. Read/modify/write must protect against stale
external writes; server connectivity alone does not provide that guarantee.
Timeouts, schema errors and transport failures remain errors, never absence.

## Capabilities and release limits

The release covers CRUD, all three lifecycle states, dependencies and reasons,
structured holds (including atomic create-with-hold), evidence, body history,
and count-based logical archival. Archival retains addressable closed rows and
history; it never invokes native `bd prune` or native delete. Explicit removal
remains guarded against active dependents.

Public followups are unsupported and must be refused before any mutation.
`mv` refuses with an explicit one-home limitation. Render/normalization is a
Markdown-only operation. No deployment, real FirstMate database, migration,
FirstMate edits, Scotty changes, or multi-home handoff is included.

Configuration will use `backend = "beads"` and `[beads]` with an explicit
`path`, executable `binary`, `prefix`, and explicit server/database settings.
Relative paths resolve from the backlog root. A Docker transport must allowlist
exact workspaces, forward only approved environment variables, preserve stdin
and exit status, and refuse unknown paths. No shell command string is accepted
as a binary. Tests use scratch workspaces only.

## Scratch server proof (2026-11-10)

Verified bd 1.1.0 from image `local/scotty:v0.4.0-cf6dda1` (image ID
`sha256:3593e03ac0035ab7cb463e21e731e756ddfe762a800e0c58c759547cde88809d`).
The independently managed scratch server uses `dolthub/dolt:2.7.2`, digest
`sha256:1abcdd77083cc7dedce01f91d1314b48e55e5bdd512c575f086b929494c77a31`.
No ports were exposed; an explicit Unix socket connects the scratch clients.
Both workspaces were initialized with `bd init --server --external`, the same
explicit database, prefix `fm`, and the server socket. One client executes the
extracted binary locally, the other executes bd in a throwaway container.

Both clients created independent rows and read each other's writes. Concurrent
compare-and-set writes from a shared baseline produced one winner. Overlapping
transactions (one-second delay before commit) produced one success and one
rolled-back conflict. A procedure that changed a row then deliberately inserted
into a nonexistent table rolled back its row change. A paused server caused the
bounded client to time out (exit 124), with no success output or embedded fallback.
Raw captures are task evidence: `two-client-proof.json`, `contention-proof.json`,
and `outage-proof.json` in the build task's external evidence directory.

Important pinned-version findings:

- Native `create --deps blocks:<missing>` exits successfully and leaves an open
  issue after warning that the dependency failed. It cannot provide atomic create.
- `--set-metadata key=<json>` stores that JSON as a string, rather than an object.
- Naive `bd sql 'BEGIN; ...; COMMIT'` can retain earlier writes on an intermediate
  failure. It must never be used as an atomic mutation primitive.
- A single `CALL` to a stored procedure with `START TRANSACTION`, an explicit
  exception handler that runs `ROLLBACK`, and final `COMMIT` passed failure and
  overlapping-client probes. Dolt procedure parameters must be copied to
  session variables before reference from `UPDATE` expressions in this setup.

The adapter therefore needs a versioned server-side transaction routine, invoked
through the configured bd executable. It must compare the prior row snapshot,
write the complete lifecycle/evidence/hold/dependency change, and retain history
within that transaction. It must reject both nonzero transport exit and JSON
error envelopes. This is a pinned SQL-schema integration behind the Store seam;
it is not safe to substitute a sequence of native CLI writes.

## Configuration and executable wrapper

No workspace is initialized by tasks-axi. Provision an empty dedicated server
database/workspace separately after deployment approval. Each writer must use
that same server; the adapter forcibly disables bd auto-start. Server mode and
endpoint/database must match the existing workspace's `metadata.json` exactly.
Both the pinned bd build and Dolt 2.7.2 server version are checked before use.
Use a database-scoped SQL account and appropriate socket/network permissions.
The adapter installs its versioned tables and routine on first mutation; it
requires table/routine creation rights.
The native-ticket integration uses `tasks_axi_apply_v2`, leaving an installed v1 routine intact.
An existing v2 routine with different source is refused.
Schema upgrades require deliberate provisioning and tests.

Example configuration (illustrative paths only):

```toml
backend = "beads"
[beads]
path = "scratch/backlog/.beads"
binary = "./scripts/beads-docker-exec.mjs"
prefix = "fm"
database = "firstmate_scratch"
server_socket = "scratch/sql/server.sock"
server_user = "root"
timeout_ms = 15000
done_keep = 10
```

Alternatively set both `server_host` and integer `server_port`, omitting
`server_socket`. Host/container reachability must be configured by the operator;
loopback does not cross container namespaces. Paths and executable paths resolve
against the invoking backlog root. Backend selection retains flag, environment,
project, user, default precedence. `[beads]` keys merge project over user keys.
`--file` and `TASKS_AXI_FILE` are Markdown-only and refused for Beads.

`binary` is one executable path/name, never a shell command. The shipped wrapper
reads an operator-owned JSON allowlist from `TASKS_AXI_BEADS_DOCKER_ALLOWLIST`:

```json
[
  {
    "path": "/absolute/scratch/backlog/.beads",
    "containerPath": "/absolute/scratch/backlog/.beads",
    "container": "approved-scratch-client",
    "user": "1000",
    "socket": "/absolute/scratch/sql/server.sock",
    "containerSocket": "/absolute/scratch/sql/server.sock"
  }
]
```

Allowlist workspace paths must be canonical and exact. The wrapper rejects
unknown workspaces, lifecycle commands and CLI workspace/path overrides. Body
files use `--body-file -` with stdin. It forwards only the approved connection
variables, actor, password and caller-supplied `BD_DUE_REQUIRED`; it always sets
`BEADS_DOLT_AUTO_START=0`. It preserves streams and exit status, with a 60-second
wrapper deadline plus the adapter's configurable deadline. It does not add a
mount, expose a port or change an existing container. SQL privileges must limit
the account to this database; the wrapper is a routing boundary, not a SQL
authorization sandbox.

## Lifecycle, history and recovery

`add --hold-reason "decision pending" --hold-kind captain` creates its hold in
the same transaction as the task and initial dependencies. `--hold-until`
accepts the existing local-date gate. Holds remain metadata and do not change
native base state or invent due dates. Explicit due-required environment policy
is refused because this release has no due-date input. Start refuses active
holds/blockers both before the mutation and inside the server transaction.

Each mutation checks a snapshot of native fields, all metadata and native
dependencies. Stale snapshots and competing writes produce a structured error.
The routine atomically writes native fields, versioned metadata, edges, native
audit events, before/after snapshots in `tasks_axi_history_v1`, and a Dolt commit.
It preserves foreign metadata and unrelated relation types. Beads permits only
one relation per target pair, so conflicting edge types are refused. Cycles
retain Markdown's semantics: every active member remains blocked.

The native statuses `open`, `in_progress` and `closed` map to the three task states.
Native `blocked`, `deferred`, `pinned` and `hooked` project as queued work with a live external hold; a nonclosed `human`-labelled ticket projects a person-decision hold.
These native holds prevent dispatch and are recomputed on read rather than copied into tasks-axi metadata.
Clear the native status or human flag in Scotty before unholding through tasks-axi.
Unrelated edits preserve native statuses, labels, assignment, comments and type.
Unknown statuses and malformed existing tasks-axi metadata fail closed.
Native edits to title,
description, priority, status and supported dependencies are reflected on read.
Managed hold/evidence/date fields remain in the versioned namespace. Native
priority 2 retains the distinction between an absent priority and explicit 2.
Beads limits titles to 500 characters. JSON metadata must be serializable.

Large transaction payloads are staged in bounded chunks in the ignored
`tasks_axi_payload_v1` table. The final CALL reads those chunks, changes tasks
atomically, and clears the request. Provisional chunks are never backlog rows.
An outage can leave orphan staging data; an operator may remove request IDs
after confirming that no corresponding operation is in flight. The transport
caps captured output at 32 MiB and reports an error when exceeded.

Prune marks surplus Done rows `tasks_axi.archived=true` by count in one
transaction. Active lists omit them; `show`/`get` and native `bd history` still
work, with body snapshots and evidence retained. It never invokes `bd prune` or
delete. `--no-archive` cannot turn this into deletion. Reopen/start clear the
archive marker; a native reopening is also visible in active lists. Explicit
`rm` is distinct, protects active dependents, and retains the adapter's history
snapshots even though native issue deletion removes current-row audit events.

After a timeout or lost response, inspect the task and retry the original
idempotent command. An operation may have committed before its response was
lost. Do not treat connectivity, lock, schema or JSON errors as a missing task.
Replaying Done adds evidence/nonduplicate notes without replacing the closed
date. There is no embedded fallback, background daemon or cross-home transfer.

## Reproducible scratch acceptance

Install project dependencies and run the normal build/test/lint/skill checks.
The opt-in integration runner requires Docker, git, and these existing images:
`local/scotty:v0.4.0-cf6dda1` and the pinned Dolt digest above. It extracts bd to
a temporary folder, initializes two fresh scratch workspaces, starts only its
own no-network/no-published-port SQL/client containers, and cleans them up.
It never opens an existing backlog or changes the Scotty service.

```sh
pnpm build
pnpm test:beads
# A focused fixture run:
pnpm test:beads -- -t 'archives by count'
```

The ordinary suite skips the real-Beads tests unless the scratch runner supplies
its marked temporary configuration. Coverage includes two clients, stale writes,
post-insert rollback, 61+ rows, metadata/relation preservation, full/large bodies,
stdin, lifecycle/hold expiry and replay, typed evidence, retained native history,
automatic pruning, unsupported operations, path refusal and server outage.
