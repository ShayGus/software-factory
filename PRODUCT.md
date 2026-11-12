# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

TypeScript, native HTML/CSS and a small local HTTP API over existing application
functions. No UI framework or runtime external network dependency. This scope
and stack come from Software_Factory_Design.md sections 7–8 and the BUILD-12 brief.

## Users

One person managing software outcomes, feature meaning and work needing input.

## Product Purpose

Preserve the original feature request through design, planning, worker
instructions, corrections and product review. A person can identify missing
behavior and trace a brief to its plan without relying on chat history.

## Operating Context

Software Factory is a companion project. FirstMate owns worker lifecycle;
Beads through tasks-axi owns execution tasks. Scotty is a read-only task list
and graph. Focused toolkit editors perform canonical management operations.

## Capabilities and Constraints

BUILD-12 supplies overview and feature detail using synthetic fixtures. Edits
carry expected revisions and idempotency keys. Task progress is separate from
product completeness. Unknown, stale, loading and incomplete states use text.
No listener is started by tests. Browser end-to-end testing and a separate-agent
review are later integration gates, not claims made by this implementation.

## Evidence on Hand

The repository design and BUILD-05 owner table govern the UI. The design's
wireframe images are absent. `fixtures/ui-overview.json` is synthetic evidence,
not an assertion about a delivered customer feature.
