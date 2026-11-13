---
name: Software Factory local UI
description: Inspect original intent, revision history and missing product evidence.
colors:
  paper: "#f6f5f0"
  ink: "#202e2c"
  muted: "#53635f"
  line: "#bdc8c1"
  accent: "#155b49"
  surface: "#ffffff"
typography:
  body:
    fontFamily: "system-ui, sans-serif"
    fontSize: "16px"
    lineHeight: 1.55
  heading:
    fontSize: "clamp(1.8rem, 3vw, 2.6rem)"
    lineHeight: 1.15
    letterSpacing: "-0.025em"
  section:
    fontSize: "1.5rem"
    lineHeight: 1.25
rounded:
  control: "4px"
spacing:
  section: "3rem"
  field: "1rem"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.surface}"
    rounded: "{rounded.control}"
    padding: "0.6rem 1rem"
    height: "44px"
---

# Design System: Software Factory

## Overview

The shipped screen is an operating surface for reading requests and inspecting
product evidence. Full-width sections and explicit revision links put the source
and remaining behavior in the reading path. Native expandable editors keep
routine inspection compact while preserving context during an edit.

This documents the implementation in `src/ui-style.ts` and `src/ui-pages.ts`.
Its visual choices are implementation decisions inferred from the BUILD-12 scope,
not a user-approved brand direction. Browser visual inspection is deferred by
the worker brief; server-rendered HTML and command behavior are checked locally.

## Colors

Paper is the page background; white distinguishes editor fields and navigation.
Ink and muted text carry hierarchy. Accent green denotes links and primary
buttons. States always name their meaning in text.

## Typography

Native system text supports dense local operating tasks. Headings scale from
1.8rem to 2.6rem, section headings use 1.5rem, and body text uses 16px at 1.55 line
height. Prose is capped at 75ch. Monospace is reserved for canonical JSON and
worker instructions. Revision numbers sit next to their linked record names.

## Layout

The main content is at most 1280px wide with responsive 1–4rem side padding.
Feature rows use a two-to-one reading/editing split and become a single column
at 760px. Major sections have 3rem top separation and a 1px divider. The narrow
layout preserves feature navigation and editors; no graph is introduced here.

## Elevation & Depth

Surfaces are flat. Dividers separate records, and tonal background distinguishes
source quotations and canonical excerpts. No shadows are used.

## Shapes

Controls have 4px corners. Sections and record rows have no card shell. Textareas
resize vertically, and all long identifiers can wrap.

## Components

Native details/summary groups reveal editors. Each form includes a change reason,
a save button, and a live text result. Conflict keeps entered values visible;
unknown outcomes link to their operation. Focus uses a 3px blue outline with a
3px offset. Buttons are at least 44px high. Reduced-motion settings suppress the
brief editor-opening reveal. The first link provides a keyboard skip target.

## Do's and Don'ts

- Do keep original request wording and version links directly accessible.
- Do distinguish reported evidence from current reviewed behavior.
- Do label freshness, missing evidence and unknown outcomes in text.
- Don't equate a returned or done task with product completeness.
- Don't add an editable execution projection in Scotty.
