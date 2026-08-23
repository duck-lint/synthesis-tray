import { App, Modal } from "obsidian";
import { HistoricalSnapshotCandidate } from "./sourceManifest";
import { diffSnapshotLines } from "./snapshotDiff";
import { SourceSnapshot } from "../state/types";

function scopeLabel(source: SourceSnapshot): string {
  if (source.scope === "whole_note") return "Whole note";
  if (source.scope === "highlight") return "Highlight";
  if (source.scope === "heading") return `Heading${source.headingPath ? ` · ${source.headingPath.join(" › ")}` : ""}`;
  return "Conversation snapshot";
}

function candidateLabel(candidate: HistoricalSnapshotCandidate): string {
  return `Turn ${candidate.source.turnId}${candidate.turnCreatedAt ? ` · ${candidate.turnCreatedAt}` : ""} · ${scopeLabel(candidate.source)}`;
}

function orderedSnapshots(first: HistoricalSnapshotCandidate, second: HistoricalSnapshotCandidate): [HistoricalSnapshotCandidate, HistoricalSnapshotCandidate] {
  const firstKey = `${first.turnCreatedAt ?? ""}\u0000${first.source.turnId}\u0000${first.source.id}`;
  const secondKey = `${second.turnCreatedAt ?? ""}\u0000${second.source.turnId}\u0000${second.source.id}`;
  return firstKey <= secondKey ? [first, second] : [second, first];
}

export function openSnapshotComparisonChooser(app: App, current: HistoricalSnapshotCandidate, candidates: HistoricalSnapshotCandidate[]): void {
  new SnapshotComparisonChooserModal(app, current, candidates).open();
}

class SnapshotComparisonChooserModal extends Modal {
  constructor(app: App, private readonly current: HistoricalSnapshotCandidate, private readonly candidates: HistoricalSnapshotCandidate[]) { super(app); }

  override onOpen(): void {
    this.setTitle("Compare snapshots");
    this.contentEl.createEl("p", { text: `${this.current.source.sourcePath} · choose another stored snapshot. This compares immutable text only.` });
    const select = this.contentEl.createEl("select", { attr: { "aria-label": "Historical snapshot to compare" } });
    for (const candidate of this.candidates) {
      const option = select.createEl("option", { text: candidateLabel(candidate), value: candidate.source.id });
      if (!candidate.compatibleScope) option.text += " · different scope";
    }
    const actions = this.contentEl.createDiv("synthesis-modal-actions");
    actions.createEl("button", { text: "Cancel" }).onclick = () => this.close();
    actions.createEl("button", { text: "Compare", cls: "mod-cta" }).onclick = () => {
      const candidate = this.candidates.find((entry) => entry.source.id === select.value);
      if (!candidate) return;
      const [older, newer] = orderedSnapshots(this.current, candidate);
      this.close();
      new SnapshotDiffModal(this.app, older, newer).open();
    };
  }
}

class SnapshotDiffModal extends Modal {
  constructor(app: App, private readonly older: HistoricalSnapshotCandidate, private readonly newer: HistoricalSnapshotCandidate) { super(app); }

  override onOpen(): void {
    this.setTitle("Compare snapshots");
    this.contentEl.createEl("strong", { text: this.older.source.sourcePath });
    const labels = this.contentEl.createDiv("synthesis-diff-labels");
    labels.createEl("span", { text: `Older · ${candidateLabel(this.older)}` });
    labels.createEl("span", { text: `Newer · ${candidateLabel(this.newer)}` });
    if (!this.older.compatibleScope || !this.newer.compatibleScope) this.contentEl.createDiv({ text: `Comparison scope differs: ${scopeLabel(this.older.source)} → ${scopeLabel(this.newer.source)}.`, cls: "synthesis-snapshot-note" });
    const result = diffSnapshotLines(this.older.source.contentSnapshot, this.newer.source.contentSnapshot);
    if (result.boundedFallback) this.contentEl.createDiv({ text: "Large snapshots used a bounded prefix/suffix comparison.", cls: "synthesis-snapshot-note" });
    else if (result.displayTruncated) this.contentEl.createDiv({ text: "Only the first and last diff lines are shown.", cls: "synthesis-snapshot-note" });
    const pre = this.contentEl.createEl("pre", { cls: "synthesis-diff-preview" });
    for (const line of result.lines) {
      const row = pre.createDiv(`synthesis-diff-line is-${line.kind}`);
      row.createEl("span", { text: line.oldLine === null ? "" : `L${line.oldLine}`, cls: "synthesis-diff-line-number" });
      row.createEl("span", { text: line.newLine === null ? "" : `L${line.newLine}`, cls: "synthesis-diff-line-number" });
      row.createEl("span", { text: line.kind === "added" ? "+" : line.kind === "removed" ? "−" : " ", cls: "synthesis-diff-marker" });
      row.createEl("span", { text: line.text, cls: "synthesis-diff-text" });
    }
  }
}
