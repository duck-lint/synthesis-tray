import { ItemView, MarkdownRenderer, Notice, WorkspaceLeaf } from "obsidian";
import { buildRequestText } from "../openai/requestBuilder";
import { cloneTray } from "../state/tray";
import { Message, TokenBreakdown, TrayItem } from "../state/types";
import type { SynthesisTrayPlugin } from "../main";

export const VIEW_TYPE_SYNTHESIS = "synthesis-tray-view";

export class SynthesisView extends ItemView {
  private draft = "";
  private draftElement: HTMLTextAreaElement | null = null;
  private conversationElement: HTMLElement | null = null;
  private statusElement: HTMLElement | null = null;
  private tokenElement: HTMLElement | null = null;
  private streaming = false;
  private streamedAssistant = "";

  constructor(leaf: WorkspaceLeaf, private readonly plugin: SynthesisTrayPlugin) {
    super(leaf);
  }

  override getViewType(): string { return VIEW_TYPE_SYNTHESIS; }
  override getDisplayText(): string { return "Synthesis Tray"; }
  override getIcon(): string { return "messages-square"; }

  override async onOpen(): Promise<void> {
    await this.plugin.ready();
    this.render();
  }

  override async onClose(): Promise<void> {
    this.draftElement = null;
    this.conversationElement = null;
  }

  refresh(): void {
    if (this.containerEl.children.length > 0 && !this.streaming) this.render();
  }

  private render(): void {
    const root = this.containerEl;
    root.empty();
    root.addClass("synthesis-tray-view");
    const state = this.plugin.state;
    const thread = state.threads.find((candidate) => candidate.id === state.activeThreadId) ?? state.threads[0];
    if (!thread) return;

    const header = root.createDiv("synthesis-header");
    header.createEl("span", { text: "SYNTHESIS", cls: "synthesis-title" });
    const threadSelect = header.createEl("select", { cls: "synthesis-thread-select" });
    for (const candidate of state.threads) {
      const option = threadSelect.createEl("option", { text: candidate.title, value: candidate.id });
      option.selected = candidate.id === thread.id;
    }
    threadSelect.onchange = async () => {
      await this.plugin.switchThread(threadSelect.value);
      this.render();
    };
    const newButton = header.createEl("button", { text: "+", attr: { "aria-label": "New thread" } });
    newButton.onclick = () => void this.createThread();
    const renameButton = header.createEl("button", { text: "Rename", cls: "mod-muted" });
    renameButton.onclick = () => void this.renameThread(thread.id);
    const deleteButton = header.createEl("button", { text: "Delete", cls: "mod-warning" });
    deleteButton.onclick = () => void this.deleteThread(thread.id);

    this.conversationElement = root.createDiv("synthesis-conversation");
    for (const message of this.plugin.messagesFor(thread.id)) this.renderMessage(this.conversationElement, message);
    if (this.streaming) this.renderStreamingMessage(this.conversationElement);

    const composer = root.createDiv("synthesis-composer");
    this.draftElement = composer.createEl("textarea", { cls: "synthesis-draft", attr: { placeholder: "Ask about the selected material…" } });
    this.draftElement.value = this.draft;
    this.draftElement.disabled = this.streaming;
    this.draftElement.oninput = () => {
      this.draft = this.draftElement?.value ?? "";
      this.renderTokenCount();
    };
    const actions = composer.createDiv("synthesis-composer-actions");
    const send = actions.createEl("button", { text: this.streaming ? "Stop" : "Send", cls: "mod-cta" });
    send.disabled = !this.streaming && (!this.draft.trim() || !this.plugin.settings.secretName);
    send.onclick = () => this.streaming ? this.plugin.stopRequest() : void this.send();
    this.statusElement = composer.createDiv("synthesis-status");
    this.statusElement.setText(this.plugin.lastError ?? (this.plugin.settings.secretName ? "" : "Select an OpenAI secret in settings."));

    const trayPanel = root.createDiv("synthesis-tray-panel");
    const trayHeader = trayPanel.createDiv("synthesis-tray-header");
    trayHeader.createEl("span", { text: "SYNTHESIS TRAY", cls: "synthesis-section-title" });
    const recall = trayHeader.createEl("button", { text: "Recall previous tray", cls: "mod-muted" });
    recall.disabled = state.previousTray.length === 0;
    recall.onclick = () => void this.recall();
    const trayList = trayPanel.createDiv("synthesis-tray-list");
    if (state.activeTray.length === 0) trayList.createDiv({ text: "No manually selected sources.", cls: "synthesis-empty" });
    state.activeTray.forEach((item, index) => this.renderTrayItem(trayList, item, index));

    this.tokenElement = trayPanel.createDiv("synthesis-token-count");
    this.renderTokenCount();
  }

  private renderMessage(container: HTMLElement, message: Message): void {
    const item = container.createDiv(`synthesis-message synthesis-message-${message.role}`);
    item.createDiv({ text: message.role === "user" ? "You" : "Assistant", cls: "synthesis-message-role" });
    if (message.role === "assistant") void MarkdownRenderer.render(this.app, message.content, item, "", this.plugin);
    else item.createDiv({ text: message.content, cls: "synthesis-message-content" });
  }

  private renderStreamingMessage(container: HTMLElement): void {
    const item = container.createDiv("synthesis-message synthesis-message-assistant");
    item.createDiv({ text: "Assistant", cls: "synthesis-message-role" });
    item.createDiv({ text: this.streamedAssistant || "…", cls: "synthesis-message-content synthesis-streaming" });
  }

  private renderTrayItem(container: HTMLElement, item: TrayItem, index: number): void {
    const row = container.createDiv("synthesis-tray-item");
    const metadata = row.createDiv("synthesis-tray-metadata");
    metadata.createEl("strong", { text: `S${index + 1}` });
    metadata.createEl("span", { text: item.sourcePath, cls: "synthesis-tray-path" });
    metadata.createEl("span", { text: item.scope, cls: "synthesis-tray-scope" });
    if (item.headingPath) metadata.createEl("span", { text: `§ ${item.headingPath.join(" > ")}`, cls: "synthesis-tray-heading" });
    const remove = row.createEl("button", { text: "×", cls: "synthesis-remove", attr: { "aria-label": `Remove S${index + 1}` } });
    remove.onclick = () => void this.plugin.removeTrayItem(item.id);
  }

  private renderTokenCount(): void {
    if (!this.tokenElement) return;
    const thread = this.plugin.state.threads.find((candidate) => candidate.id === this.plugin.state.activeThreadId);
    if (!thread) return;
    const breakdown = this.plugin.tokenBreakdown(thread.id, this.draft);
    this.tokenElement.setText(`≈ ${breakdown.total.toLocaleString()} tokens  (system ${breakdown.system.toLocaleString()} · conversation ${breakdown.conversation.toLocaleString()} · tray ${breakdown.tray.toLocaleString()} · draft ${breakdown.draft.toLocaleString()})`);
  }

  private async send(): Promise<void> {
    const draft = this.draft.trim();
    if (!draft) return;
    this.streaming = true;
    this.streamedAssistant = "";
    this.render();
    try {
      await this.plugin.send(draft, (delta) => {
        this.streamedAssistant += delta;
        if (this.conversationElement) {
          this.conversationElement.empty();
          const thread = this.plugin.state.threads.find((candidate) => candidate.id === this.plugin.state.activeThreadId);
          if (thread) for (const message of this.plugin.messagesFor(thread.id)) this.renderMessage(this.conversationElement, message);
          this.renderStreamingMessage(this.conversationElement);
          this.conversationElement.scrollTop = this.conversationElement.scrollHeight;
        }
      });
      this.draft = "";
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) new Notice(error instanceof Error ? error.message : "Synthesis request failed.");
    } finally {
      this.streaming = false;
      this.streamedAssistant = "";
      this.render();
    }
  }

  private async recall(): Promise<void> {
    if (this.plugin.state.activeTray.length > 0) {
      const answer = window.prompt("Replace the current tray with the previous successful tray? Type REPLACE to confirm.");
      if (answer !== "REPLACE") return;
    }
    await this.plugin.recallPreviousTray();
  }

  private async createThread(): Promise<void> {
    let clear = false;
    if (this.plugin.state.activeTray.length > 0) {
      const answer = window.prompt("A tray is active. Type KEEP, CLEAR, or CANCEL.");
      if (!answer || answer.toUpperCase() === "CANCEL") return;
      if (!["KEEP", "CLEAR"].includes(answer.toUpperCase())) return;
      clear = answer.toUpperCase() === "CLEAR";
    }
    await this.plugin.createThread(clear);
  }

  private async renameThread(threadId: string): Promise<void> {
    const thread = this.plugin.state.threads.find((candidate) => candidate.id === threadId);
    if (!thread) return;
    const title = window.prompt("Thread name", thread.title)?.trim();
    if (title) await this.plugin.renameThread(threadId, title);
  }

  private async deleteThread(threadId: string): Promise<void> {
    if (!window.confirm("Delete this thread and its local conversation history?")) return;
    await this.plugin.deleteThread(threadId);
  }
}
