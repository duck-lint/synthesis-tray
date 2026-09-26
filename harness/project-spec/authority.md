# Synthesis Tray — Product Authority

**Status:** Governance baseline for maintainer adoption  
**Scope:** Product meaning, source of truth, authorized changes, and evidence standards for `duck-lint/Synthesis-Tray`.

This document governs **Synthesis Tray**, not the runtime permissions, role topology, dispatch order, or lifecycle of Symphony. Orchestrator authority remains with Symphony's own host and documentation. A project issue authorizes a bounded engineering task; it does not grant an agent permission to invent product semantics.

## 1. Who decides

The human project maintainer owns product meaning, trade-offs, scope changes, and release/publication decisions. The implementation team may inspect, explain, propose, test, and implement within the accepted task. It may not convert an unapproved inference or convenient workaround into a new requirement.

Maintainer approval must be attributable to an actual explicit instruction or decision. Agent-authored issue comments, passing tests, an existing implementation accident, or third-party guidance do not independently confer product authority.

## 2. Authority order and conflict resolution

Use the following order **for product decisions**:

1. **Explicit current maintainer decisions:** an attributable decision may amend the baseline. If it changes enduring product meaning, update the governing documents in the same authorized change and record the decision; do not leave contradictory permanent authority behind.
2. **This document (`harness/project-spec/authority.md`):** determines decision ownership, conflict treatment, and evidentiary boundaries.
3. **`harness/project-spec/project-spec.md`:** governs the accepted product purpose, conceptual boundaries, and cross-feature invariants.
4. **Accepted issue requirements and acceptance criteria:** authorize the task's specific behavior only insofar as consistent with the higher-level product contract, or expressly approved as an amendment by the maintainer.
5. **Current source, tests, schemas, and observed runtime behavior:** establish what the product currently does and what changes are feasible. They are evidence, not automatic authorization to preserve bugs or redefine requirements.
6. **README, SECURITY, release notes, historical discussion, external examples, and third-party documentation:** provide useful descriptions, constraints, or background. Treat mismatches with the above as reconciliation work, not as silent permission to choose whichever source is convenient.

External platform API contracts, license obligations, and security constraints are real implementation constraints; they are not permission to silently change the intended feature. If a requested behavior is incompatible with those constraints, expose the contradiction with evidence and alternatives.

Do not use an authority hierarchy to erase new evidence: when a higher-level claim conflicts with demonstrated implementation or platform facts, report the conflict. The maintainer decides whether to revise intent, scope, or the governing document.

## 3. Interpretation protocol

Keep four statuses distinct in plans, findings, and final reports:

- **Established:** directly evidenced by the current task branch, tests, documentation, or a reproducible runtime observation; name the source and its limits.
- **Accepted but not implemented:** expressly authorized product behavior that the current branch does not yet deliver.
- **Proposed:** a feature, design, or interpretation awaiting an appropriate maintainer decision.
- **Unknown or unverified:** a claim for which the required evidence is unavailable or has not been collected.

An inference may motivate investigation if its premises and supporting observations are stated. An inference **without evidence** must not become a coding instruction. Distinguish failure to observe something from proof it does not exist; distinguish a mock's behavior from the host application's actual behavior.

Use exact language for selection, retrieval, capture, snapshot, source, provenance, and send:

- **Selection:** user authorization of a bounded set of material.
- **Capture:** conversion of that selected material into tray snapshot records.
- **Retrieval:** obtaining candidates; retrieval alone does not authorize inclusion.
- **Snapshot:** recorded content at a capture/turn boundary, not a live pointer to a file.
- **Provenance:** the recorded basis for why and how content entered the request.
- **Send:** user-initiated transmission of the assembled request to OpenAI.

Do not collapse those operations into a generic claim that the plugin "knows" which material to include.

## 4. Protected product decisions

The invariants in `project-spec.md` are standing constraints, especially explicit user inclusion, separate send authorization, snapshot fidelity, honest citations/provenance, stable identity, privacy, and read-only authored vault content.

The following are **not** implied by a feature request unless explicitly included in its accepted scope:

- autonomous relevance selection, indexing, RAG, or semantic ranking;
- following wikilinks or expanding embeds without separate selection;
- silent truncation, substitution, or summarization of selected evidence;
- new external transmissions, background requests, or telemetry;
- replacement of a persisted snapshot with current vault contents;
- rewriting historical inference provenance or source numbering;
- schema redesign, new infrastructure, dependency additions, or compatibility machinery merely for convenience;
- changing Symphony's host authority or agent permissions.

A bulk action can remain explicit selection when the exact set is defined, reviewable, and affirmatively chosen by the user. It cannot claim "all" when its integration can establish only some results.

## 5. What the team may decide locally

Within the approved behavior and actual project constraints, implementation choices are delegated when they do not change product meaning or enlarge authority: names of internal helpers, narrow module boundaries, deterministic algorithms, test fixtures, and mechanical changes required for the accepted contract.

A team may correct an evidenced implementation defect without asking the maintainer to select ordinary code-level tactics, provided the correction remains inside the approved issue and does not broaden its scope. Keep defect repair separate from optional redesign.

When alternatives have equivalent externally observable behavior, prefer the smallest coherent change compatible with existing contracts. Do not add an abstraction, fallback, migration path, or new setting just because it appears prudent; provide its evidenced need and trade-off first.

## 6. Escalation: when a product decision is required

Surface a concrete question when the evidence establishes a material choice among product meanings or shows that the accepted task cannot be delivered as specified. Examples:

- A native application API cannot provide the complete result set required by a proposed "add all" operation.
- Implementing a request would silently expand content beyond the user's explicit selection.
- A change requires replacing historical data, weakening privacy, or introducing new external access.
- Two authoritative instructions specify incompatible outcomes, or acceptance criteria are materially ambiguous.
- The only feasible alternatives differ in observable behavior, supported environments, or data-loss risk.

An escalation should state: **requirement → observed evidence → exact blocker → bounded alternatives and consequences → decision requested**. Provide a smallest viable path if supported. Do not present a speculative workaround as already approved.

Do **not** escalate ordinary test failures, formatting preferences, routine code decisions, or mechanical defects when a correction is already authorized and evidence points to it. Conversely, do not label a material product substitution as a mere implementation detail.

## 7. Evidence and completion claims

Every substantive claim must be scoped to its evidence:

- **Static review:** proves what inspected code or documentation says; not that a desktop workflow works.
- **Unit/integration tests:** prove the stated cases in their test environment; mocks do not establish undocumented Obsidian behavior.
- **Real desktop UAT:** can establish the tested Obsidian version, workflow, and fixtures; it is not universal compatibility proof.
- **Build/type checks:** establish that the checked revision meets those mechanical gates, not semantic acceptance.
- **Persistence tests:** must cover actual save/reload and failure behavior relevant to the changed boundary.

Report the exact revision, commands, results, UAT status, relevant failure cases, and residual limitations. Use **not run** when appropriate. Never assert "complete," "atomic," "all results," "safe," or "backward compatible" on the strength of tests that did not exercise those properties.

A Symphony lifecycle-complete issue is a workflow state, not maintainer acceptance, a commit, a merge, publication, or release readiness. Final disposition belongs to the maintainer under the runtime's actual operational contract.

`.symphony-substrate/obsidian-1.13.7` is inspection substrate, not project source and not acceptance evidence for live behavior. Static inspection can establish implementation shape; it cannot establish that the Search view behaves that way at runtime.

## 8. Change and publication discipline

Before implementation: inspect the current branch and applicable specification, locate the affected authority/data boundaries, identify regression risks, and establish a plan with measurable acceptance evidence.

During implementation: preserve existing contracts outside the issue; avoid unrelated refactors, unrequested compatibility scaffolding, destructive data operations, or changes to secrets and private vault content. Use synthetic/redacted fixtures in publicly visible evidence.

At completion: explain what changed, what remains only proposed, what was tested, what was not tested, and where behavior differs from the accepted issue. Do not quietly alter product docs to make an incomplete implementation appear compliant.

When a maintainer approves a lasting change, update `project-spec.md`, this file if governance changed, and applicable README/SECURITY material so they do not contradict one another. Do not turn speculative future features into present-tense product claims.

These product documents do not themselves authorize direct commits to the default branch, issue closure, publication, or any other repository mutation beyond the permissions and actions actually granted for the task.
