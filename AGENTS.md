# AGENTS.md

## Project

Synthesis Tray is a desktop Obsidian plugin for composing OpenAI synthesis requests from user-selected authored material and a local conversation.

It is not an autonomous retrieval system. The plugin does not decide which vault material is relevant or send it merely because it was found, mentioned, or linked.

Primary project relation:

`explicit user selection → captured source snapshots → next-request tray → user-initiated Send → immutable turn evidence`

## Project Authority

This repository contains **project-specific specification and authority only**. Workflow, orchestration, role permissions, escalation mechanics, and general engineering operating instructions belong to Symphony, not this harness.

Authoritative project documents:

* `harness/project-spec/project-spec.md` — product purpose, current baseline, invariants, architecture boundaries, scope, and acceptance evidence.
* `harness/project-spec/authority.md` — product decision ownership, authority hierarchy, provenance rules, evidence standards, and conditions requiring a maintainer decision.

These documents have distinct scopes. `authority.md` governs how product decisions are authorized; `project-spec.md` governs the accepted product contract. The applicable issue defines its bounded task without silently amending either document.

A contradiction between the specification and authority model is a harness defect. Surface it rather than resolving it through implementation, tests, convenience, or model inference.

Existing implementation is evidence of current behavior, not higher product authority. Follow the decision hierarchy in `harness/project-spec/authority.md`.

## Core Authority Split

* The **user's explicit selection** authorizes which material enters the tray; discovery and wikilinks alone do not.
* **Authored vault content** supplies the material captured by the selected operation; the plugin does not modify authored notes.
* **Captured snapshots** preserve what was selected; completed-turn snapshots, not later vault contents, govern historical citations and inspection.
* **Linked-note content** requires separate user authorization; link metadata alone establishes no evidence about a destination's contents.
* **Send** is a distinct user action authorizing transmission to OpenAI; capture, preview, and recall do not send.
* **The maintainer** decides changes to product meaning or protected boundaries. Unsupported assumptions must remain explicit.

## Hard Boundary

Do not turn a convenience feature into autonomous context selection, silent expansion, truncation, substitution, or transmission.

The project succeeds by giving the user efficient, explicit control over the exact source snapshots supplied to each synthesis request, while preserving truthful provenance and historical evidence.
