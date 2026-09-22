# Synthesis Tray — Project Specification

**Status:** Product baseline for maintainer adoption  
**Repository:** `duck-lint/Synthesis-Tray`  
**Reference point:** Published `master` implementation and project documentation reviewed 2026-09-22. This document describes the reviewed baseline, not an independent verification of a user's installed plugin.

## 1. Purpose and product boundary

Synthesis Tray is a desktop Obsidian plugin for composing an explicit OpenAI synthesis request from user-selected authored material and a local conversation. Its defining contract is **user-governed context composition**: the user decides which material is supplied, and the plugin preserves what was actually supplied.

The plugin may offer efficient ways to carry out a user's explicit selection, but it must not independently decide which vault material is relevant. A source being discoverable, linked, or mentioned does not authorize supplying its content. Selection of context and sending that context to OpenAI are separate user actions.

This document governs Synthesis Tray itself. It does not define Symphony's agent roles, host permissions, orchestration, or deployment configuration. See [`authority.md`](authority.md) for how product decisions are authorized and conflicting evidence is resolved.

## 2. Baseline: currently implemented behavior

The statements in this section are grounded in the reviewed repository, rather than promises about future work. Recheck the actual task branch before relying on a particular implementation detail.

### 2.1 Explicit capture

- Users can add an editor selection, a heading region, a whole Markdown note, a folder's Markdown notes, or a snapshot of another conversation.
- A selection captures the selected text, not an inferred surrounding passage. A heading capture uses its identified heading region. Whole-note and folder captures preserve Markdown content, including frontmatter and literal embed syntax; they do not execute embeds.
- Folder capture gathers Markdown notes beneath the chosen folder, orders them deterministically by path, and associates newly captured items with a folder capture group.
- Conversation capture uses the other thread's visible user/assistant transcript as one source. It does not recursively retrieve that thread's historical source snapshots.
- An explicit whole-note capture from an editor can use its current buffer; folder capture reads vault files. Do not claim unsaved-buffer capture for another entry point without verifying it.

### 2.2 Active tray and source identity

- There is one active tray shared across threads. Thread-specific model and reasoning settings are separate from tray membership.
- Each tray item records a source path, scope, content snapshot, capture time, and any applicable heading, conversation, or group metadata.
- Exact duplicate suppression currently compares source path, scope, heading path, content snapshot, and conversation identity fields. Same-path content with different snapshots is not automatically identical.
- Canonical source numbering follows insertion order; the interface presents recent entries first without changing their canonical identifiers.
- Folder captures appear as groups. Display grouping must not erase the individual source identity or change request source order.
- The tray may be edited before sending. Do not conflate an active tray item with a completed turn's immutable historical source snapshot.

### 2.3 Linked material

- Outgoing wikilinks from explicit notes can be shown as authored relationship metadata, including unresolved identities.
- Destination-note content enters context only after a distinct user selection. The implementation supports individual and bulk linked-note selection and promotion to an explicit root.
- Linked destinations are subordinate context associated with parent-to-destination selections, deduplicated for requests, and limited to one hop from explicit roots.
- A link's name, alias, or resolution is **not** evidence for the destination's contents. Do not silently follow links, expand embeds, or treat linked content as an autonomous relevance decision.

### 2.4 Request and conversation lifecycle

- The active tray is context for the **next** user-initiated Send, not an instruction to keep supplying it on subsequent turns.
- Requests use the configured system prompt, visible prior conversation, selected source snapshots, the current visible user message, and selected inference parameters.
- A successful completed turn stores source snapshots and moves the used active tray to the previous-tray state, clearing the active tray. Previous trays can be recalled without rereading source notes.
- An unsuccessful or aborted request must not be represented as a successful turn or silently dispose of its draft/context. Verify the relevant error path when changing this behavior.
- Assistant-text references are inserted as visible, editable quoted composer content; they are not concealed context or edits to historical messages.

### 2.5 Provenance, citations, and usage

- Sources are serialized with stable request-local identifiers such as `[S1]`. Localized citations such as `[S1:L42-L48]` refer to numbered lines in the **stored snapshot for that turn**, not the current vault file or its original line coordinates.
- Historical inspection opens the stored snapshot; inspecting a currently existing note is a separate operation.
- Local token totals are approximate `o200k_base` estimates, displayed in system, conversation, tray, and draft buckets. They are not provider billing figures and must not imply a guaranteed model context limit.
- Completed turns can retain provider usage, actual model/reasoning provenance, and reasoning tokens as a subset of output tokens. Historical provenance must not be rewritten with new-thread defaults.

### 2.6 Storage, external transmission, and limits

- Conversations, tray state, and historical source snapshots are stored locally in the plugin's SQLite database. That database contains authored content; it is not merely a metadata cache.
- The OpenAI key is read from Obsidian SecretStorage. The plugin persists the configured secret identifier, not the resolved key value.
- Authored vault files are read-only to the plugin. Material is sent to OpenAI only as part of the user-initiated synthesis request, under the documented request contract; adding context does not itself send it.
- The reviewed project is desktop-only. It does not currently provide autonomous retrieval/RAG, external live web search, PDFs/images/attachments as sources, branching, prior-turn editing/regeneration, or background synthesis requests.
- New threads default to Luna · High; supported model, reasoning, and verbosity choices are implemented in the current branch and should be checked there rather than hard-coded from this descriptive inventory.

## 3. Governing product invariants

The following are requirements for changes, not merely descriptions of the code currently observed:

1. **Explicit inclusion:** every content-bearing source supplied to a request must trace to a deliberate user selection. A bulk operation can satisfy this with one explicit action covering a clearly identified, reviewable set.
2. **Separate send boundary:** capture, preview, filtering, and recall do not independently invoke the OpenAI API. No hidden or background send is authorized.
3. **Truthful provenance:** distinguish authored metadata, explicit source content, opted-in linked content, live vault state, and historical snapshots. Do not invent content, line coordinates, or source relationships.
4. **Snapshot fidelity:** capture the material defined by the selected operation, preserve its exact content at capture, and retain immutable completed-turn snapshots. Do not silently refresh historical evidence.
5. **Stable identities:** source identifiers, duplicate handling, ordering, and group membership must remain coherent across UI presentation, serialization, persistence, and reload.
6. **No silent loss:** do not silently truncate context, drop selected sources, substitute search results, overwrite old snapshots, or present a partial operation as complete. Surface material failure and preserve recoverable state.
7. **Privacy by boundary:** keep secrets out of source, logs, issue reports, and persisted content fields; do not introduce telemetry or new external data flows without explicit approval and documentation.
8. **Read-only authorship:** do not write, rename, or modify users' authored vault notes as a side effect of synthesis or capture.
9. **Scope discipline:** prefer extending existing capture, tray, serializer, persistence, and UI contracts over building competing mechanisms. New features are not authorization for unrelated redesigns.

A task that materially changes an invariant needs an explicit maintainer decision and corresponding specification/documentation update; an agent cannot silently redefine it in implementation.

## 4. Conceptual and implementation boundaries

| Concept | Governing distinction | Relevant current code |
| --- | --- | --- |
| Capture | User action defines which content becomes a snapshot. | `src/capture/capture.ts`, `src/main.ts` |
| Tray state | Mutable next-request selection, with exact duplicate handling. | `src/state/tray.ts`, `src/state/types.ts` |
| Linked context | Separate selection relationship; not implied by a wikilink. | `src/capture/wikilinks.ts`, `src/state/tray.ts` |
| Request assembly | Explicit snapshots become numbered request sources. | `src/openai/sourceSerializer.ts`, `src/openai/requestBuilder.ts` |
| Turn lifecycle | Successful completion freezes turn evidence and advances tray state. | `src/state/turnLifecycle.ts`, `src/main.ts` |
| Persistence | SQLite stores active/previous and historical state. | `src/persistence/database.ts` |
| Presentation | Tray groups, previews, search/filter UI, citations, and inference controls. | `src/view/` |
| Cost visibility | Approximate local estimates versus provider-reported usage. | `src/tokens/`, `src/openai/usage.ts` |

These locations are navigation aids, not a license to assume they remain unchanged. Inspect the current working branch before editing.

## 5. Change requirements and validation

For each task, establish the current state from code, tests, and available runtime evidence; identify which product contract the request changes; write an implementation plan; then validate both the changed seam and adjacent invariants.

Minimum engineering evidence:

- Focused tests for new contracts and failure modes, plus relevant regression coverage for capture, identity, linked inclusion, serialization, lifecycle, and persistence when touched.
- `npm test`, a TypeScript check appropriate to the project's configuration, `npm run build`, and `git diff --check`; report exact commands and results rather than claiming tests that were not run.
- Desktop Obsidian verification for UI integration, native application internals, event lifecycle, or other behavior a test double cannot prove. State the Obsidian version and distinguish **passed**, **failed**, and **not run**.
- Explicit verification of migration and reload behavior whenever persisted data contracts change. Preserve prior saved source and provenance records.
- An evidence-based account of error handling and recovery when changing async capture, request, or SQLite mutation flows.

A successful build establishes compilation/bundling, not native Search completeness, UI correctness, API compatibility, persistence durability, or release readiness.

## 6. Scope register: not yet implemented or authorized by this baseline

The proposed **Add all native Obsidian search results to tray** issue is a scoped feature proposal, not a current capability or an amendment to this baseline by itself. Its native-search completeness, eligibility, bulk-confirmation, grouping, concurrency, and UAT requirements must be evaluated and implemented under the issue's own acceptance criteria. If native Search cannot expose complete results reliably, report that limitation rather than substituting an invented equivalent.

Other possible extensions—autonomous retrieval, indexing, ranking, new source formats, background activity, branching, publishing, or an alternative persistence architecture—remain outside baseline scope unless separately authorized. A proposed design, a TODO, or an agent's plausible inference does not establish accepted product behavior.

## 7. Maintenance

Update this document when a maintainer accepts a change to product meaning, supported capabilities, or the governing invariants. Keep descriptions of what exists distinct from what is accepted but unimplemented, proposed, and experimentally observed. Prefer precise amendments tied to the relevant issue and evidence over speculative roadmap entries.
