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
Collisions and foreign/unversioned rows fail closed rather than adopting them.

## Persistence model

Native status maps `queued → open`, `in_flight → in_progress`, `done → closed`.
Native title and description represent title and body. Native type is `task`;
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
