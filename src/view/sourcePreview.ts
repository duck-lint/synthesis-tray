import { App, Modal, TFile } from "obsidian";
import { Scope, TrayItem } from "../state/types";
import { snapshotLines } from "./snapshotLines";

export interface PreviewSource {
  sourcePath: string;
  scope: Scope;
  headingPath: string[] | null;
  contentSnapshot: string;
  conversationTitle?: string;
}

export function openSourceSnapshotPreview(app: App, source: PreviewSource, sourceIndex: number, lineStart: number | null = null, lineEnd: number | null = null, historical = true): void {
  new SourceSnapshotModal(app, source, sourceIndex, lineStart, lineEnd, historical).open();
}

class SourceSnapshotModal extends Modal {
  constructor(
    app: App,
    private readonly source: PreviewSource,
    private readonly sourceIndex: number,
    private readonly lineStart: number | null,
    private readonly lineEnd: number | null,
    private readonly historical: boolean,
  ) { super(app); }

  override onOpen(): void {
    this.setTitle(this.historical ? `S${this.sourceIndex} · Snapshot supplied to this turn` : `S${this.sourceIndex} · Selected snapshot`);
    const identity = this.contentEl.createDiv("synthesis-snapshot-identity");
    identity.createEl("strong", { text: this.source.scope === "conversation" && this.source.conversationTitle ? `Conversation snapshot: ${this.source.conversationTitle}` : this.source.sourcePath });
    identity.createEl("span", { text: readableScope(this.source.scope), cls: "synthesis-tray-scope" });
    if (this.source.headingPath) identity.createEl("span", { text: this.source.headingPath.join(" › "), cls: "synthesis-tray-heading" });
    this.contentEl.createEl("p", { text: this.historical ? "This is the immutable source snapshot supplied to the historical request. Line numbers are relative to this snapshot." : "This is the immutable source snapshot currently selected for the next request. Line numbers are relative to this snapshot.", cls: "synthesis-snapshot-note" });
    const pre = this.contentEl.createEl("pre", { cls: "synthesis-snapshot-preview" });
    for (const line of snapshotLines(this.source.contentSnapshot)) {
      const row = pre.createDiv("synthesis-snapshot-line");
      row.dataset.lineNumber = String(line.number);
      if (this.lineStart !== null && line.number >= this.lineStart && line.number <= (this.lineEnd ?? this.lineStart)) row.addClass("is-cited");
      row.createEl("span", { text: `L${line.number}:`, cls: "synthesis-snapshot-line-number" });
      row.createEl("span", { text: line.text });
    }
    const actions = this.contentEl.createDiv("synthesis-modal-actions");
    const file = this.source.scope === "conversation" ? null : this.app.vault.getAbstractFileByPath(this.source.sourcePath);
    if (file instanceof TFile) {
      actions.createEl("button", { text: "Open current note" }).onclick = () => {
        void this.app.workspace.getLeaf(false).openFile(file);
        this.close();
      };
    }
    if (this.lineStart !== null) {
      window.setTimeout(() => this.contentEl.querySelector<HTMLElement>(".synthesis-snapshot-line.is-cited")?.scrollIntoView({ block: "center" }), 0);
    }
  }
}

function readableScope(scope: Scope): string {
  if (scope === "whole_note") return "Whole note";
  if (scope === "highlight") return "Highlight";
  if (scope === "heading") return "Heading";
  return "Conversation snapshot";
}

export function asPreviewSource(item: TrayItem): PreviewSource {
  return item;
}
