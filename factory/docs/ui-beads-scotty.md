# Beads and Scotty integration

Scotty is the installed ticket editor and dependency graph for the factory's execution backlog.
It creates tickets, edits title, description, status and priority, changes assignment, parent and dependencies, and adds comments directly in Beads.
FirstMate/tasks-axi and the factory agent read the same external Dolt database; there is no synchronizer or duplicate task store.
[Setup and update](../../ARCHITECTURE.md#setup-update-and-acceptance) own installation and acceptance.

## Ownership

Execution-ticket fields live in Beads.
The [tasks-axi adapter contract](../../tools/tasks-axi/docs/beads-backend.md) owns native-row hydration, logical and physical IDs, status projection, first-write metadata adoption, preservation and concurrency.
Scotty's person defaults to Shay, with an explicitly chosen person and existing settings retained across rebuilds.
Assigned-to-me uses that person; Needs You displays actionable tickets carrying Beads' `human` label.

Original requests, feature meaning, criteria, decisions, observations and evidence remain revisioned toolkit product records.
Their focused factory editors remain available.
Editing a ticket description or adding a Beads comment does not revise a linked product record.
`POST /scotty-edit` in the toolkit refuses edits to product-record projections; it is not involved in native Scotty ticket writes.

## Service boundary

`factory/scripts/scotty-service.mjs` owns the installed fixed-project HTTP guard, request forwarding, bd bridge and person configuration.
The guard accepts native ticket routes, viewer preference, ordering and person settings for the factory project.
It validates the addressed local or configured tailnet origin before forwarding request bodies and cookies to Next's private loopback listener.
It does not expose project discovery, filesystem browsing, self-update, model assistance, publishing or attachment routes.
The bd bridge fixes the external workspace, socket and database and disables embedded fallback.
The home mount stays read-only; only Scotty's configuration directory is writable for its settings and ordering.

The old BUILD-05 scratch scenario (`ui-spike-demo.mjs` and `scotty-spike-reader.mjs`) is separate from the installed factory service.
Its deliberately restricted fixture is not used by setup or update.

## Verification entry points

`factory/test/scotty-service.test.ts` exercises ticket routes, request-body and cookie forwarding, local/tailnet origin checks, pinned database addressing and repeatable person migration.
`factory/scripts/folder-services.mjs` accepts real services by creating a ticket through Scotty, reading it through tasks-axi, editing through both clients and checking retained assignment, comments and dependencies.
Setup and update run that acceptance at each configured origin.
`tools/tasks-axi/test/backends/beads.integration.test.ts` covers native-ticket hydration and adoption on the pinned real Beads/Dolt pair, including native holds and metadata preservation.
Private task evidence records browser and running-installation update proof.
