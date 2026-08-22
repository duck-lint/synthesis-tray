import { ItemView, MarkdownRenderer, Menu, Notice, WorkspaceLeaf } from "obsidian";
import { presentationTrayEntries, TrayPresentationEntry } from "../state/tray";
import { Message, SourceSnapshot, TokenBreakdown, TrayItem } from "../state/types";
import { shouldSendOnEnter } from "./composerKeyboard";
import { composerPresentation } from "./composerPresentation";
import { scrollConversationToMessageStart } from "./conversationScroll";
import { decorateRenderedCitations } from "./citations";
import { MODEL_OPTIONS, REASONING_OPTIONS } from "./inferenceControls";
import { sourceManifestEntries } from "./sourceManifest";
import { chooseAction, confirmAction, requestText } from "./interactionModal";
import { asPreviewSource, inferenceSummary, openSourceSnapshotPreview } from "./sourcePreview";
import type { SynthesisTrayPlugin } from "../main";

export const VIEW_TYPE_SYNTHESIS = "synthesis-tray-view";

interface RefreshOptions {
  revealTrayItemId?: string;
  preserveScroll?: boolean;
}

export class SynthesisView extends ItemView {
  private draft = "";
  private draftElement: HTMLTextAreaElement | null = null;
  private conversationElement: HTMLElement | null = null;
  private trayElement: HTMLElement | null = null;
  private statusElement: HTMLElement | null = null;
  private tokenElement: HTMLElement | null = null;
  private tokenBreakdownElement: HTMLElement | null = null;
  private streaming = false;
  private streamedAssistant = "";
  private pendingAssistantScrollTurnId: string | null = null;
  private pendingTrayRevealId: string | null = null;
  private trayCollapsed = false;
  private trayBasisPx: number | null = null;
  private expandedCaptureGroups = new Set<string>();

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
    this.trayElement = null;
  }

  refresh(options: RefreshOptions = {}): void {
    if (this.containerEl.children.length === 0) return;
    const preserveScroll = options.preserveScroll ?? true;
    const conversationScrollTop = this.conversationElement?.scrollTop ?? null;
    const trayScrollTop = this.trayElement?.scrollTop ?? null;
    const draftWasFocused = document.activeElement === this.draftElement;
    const selectionStart = this.draftElement?.selectionStart ?? null;
    const selectionEnd = this.draftElement?.selectionEnd ?? null;
    this.pendingTrayRevealId = options.revealTrayItemId ?? null;
    this.render();
    if (preserveScroll) {
      if (conversationScrollTop !== null && this.conversationElement) this.conversationElement.scrollTop = conversationScrollTop;
      if (trayScrollTop !== null && this.trayElement && !options.revealTrayItemId) this.trayElement.scrollTop = trayScrollTop;
    }
    if (draftWasFocused && this.draftElement) {
      this.draftElement.focus();
      if (selectionStart !== null && selectionEnd !== null) this.draftElement.setSelectionRange(selectionStart, selectionEnd);
    }
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
    const threadSelect = header.createEl("select", { cls: "synthesis-thread-select", attr: { "aria-label": "Current synthesis thread" } });
    for (const candidate of state.threads) {
      const option = threadSelect.createEl("option", { text: candidate.title, value: candidate.id });
      option.selected = candidate.id === thread.id;
    }
    threadSelect.disabled = this.streaming;
    threadSelect.onchange = () => void this.plugin.switchThread(threadSelect.value);

    const modelSelect = this.createInferenceSelect(header, "Model tier", MODEL_OPTIONS, thread.model, (model) => void this.plugin.updateThreadInference(thread.id, model, thread.reasoningEffort));
    modelSelect.disabled = this.streaming;
    const reasoningSelect = this.createInferenceSelect(header, "Reasoning effort", REASONING_OPTIONS, thread.reasoningEffort, (reasoningEffort) => void this.plugin.updateThreadInference(thread.id, thread.model, reasoningEffort));
    reasoningSelect.disabled = this.streaming;

    const newButton = header.createEl("button", { text: "+", attr: { "aria-label": "New thread" } });
    newButton.onclick = () => void this.createThread();
    const actionsButton = header.createEl("button", { text: "⋯", attr: { "aria-label": "Thread actions" } });
    actionsButton.onclick = (event) => this.showThreadMenu(event, thread.id);

    this.conversationElement = root.createDiv("synthesis-conversation");
    const targetTurnId = this.pendingAssistantScrollTurnId;
    let targetMessage: HTMLElement | null = null;
    const messages = this.plugin.messagesFor(thread.id);
    if (messages.length === 0 && !this.streaming) {
      this.conversationElement.createDiv({ text: "Start with a question, then add authored material when you want it in the next synthesis.", cls: "synthesis-conversation-empty" });
    }
    for (const message of messages) {
      const element = this.renderMessage(this.conversationElement, message);
      if (message.role === "assistant") this.renderSourceManifest(this.conversationElement, message.turnId);
      if (targetTurnId && message.role === "assistant" && message.turnId === targetTurnId) targetMessage = element;
    }
    if (this.streaming) this.renderStreamingMessage(this.conversationElement);

    const composer = root.createDiv("synthesis-composer");
    const presentation = composerPresentation(this.streaming, this.draft, Boolean(this.plugin.settings.secretName));
    const draftLabel = composer.createEl("label", { text: "Message", cls: "synthesis-visually-hidden" });
    this.draftElement = composer.createEl("textarea", { cls: "synthesis-draft", attr: { placeholder: "Ask about the selected material…", "aria-label": "Synthesis message" } });
    draftLabel.htmlFor = this.draftElement.id = `synthesis-draft-${thread.id}`;
    this.draftElement.value = this.draft;
    this.draftElement.disabled = presentation.textareaDisabled;
    this.draftElement.oninput = () => {
      this.draft = this.draftElement?.value ?? "";
      this.renderTokenCount();
    };
    this.draftElement.onkeydown = (event) => {
      const canSend = !this.streaming && Boolean(this.draftElement?.value.trim()) && Boolean(this.plugin.settings.secretName);
      if (!shouldSendOnEnter(event, canSend)) return;
      event.preventDefault();
      void this.send();
    };
    const actions = composer.createDiv("synthesis-composer-actions");
    const send = actions.createEl("button", { text: presentation.sendButtonText, cls: "mod-cta", attr: { "aria-label": presentation.sendButtonText === "Stop" ? "Stop synthesis" : "Send synthesis message" } });
    send.disabled = presentation.sendButtonDisabled;
    send.onclick = () => this.streaming ? this.plugin.stopRequest() : void this.send();
    this.statusElement = composer.createDiv("synthesis-status");
    this.statusElement.setAttr("role", this.plugin.lastError ? "alert" : "status");
    this.statusElement.setAttr("aria-live", "polite");
    this.statusElement.setText(this.streaming ? `Synthesizing from ${state.activeTray.length} selected source${state.activeTray.length === 1 ? "" : "s"}…` : (this.plugin.lastError ?? (this.plugin.settings.secretName ? "" : "Select an OpenAI secret in settings.")));

    const resizer = root.createDiv("synthesis-tray-resizer");
    resizer.setAttr("role", "separator");
    resizer.setAttr("aria-orientation", "horizontal");
    resizer.setAttr("aria-label", "Resize synthesis context");
    resizer.setAttr("tabindex", "0");
    const trayPanel = root.createDiv("synthesis-tray-panel");
    this.trayElement = trayPanel;
    if (this.trayBasisPx !== null) trayPanel.style.flexBasis = `${this.trayBasisPx}px`;
    trayPanel.classList.toggle("is-collapsed", this.trayCollapsed);
    this.configureResizer(resizer, trayPanel, root);

    const trayHeader = trayPanel.createDiv("synthesis-tray-header");
    const trayTitle = trayHeader.createDiv("synthesis-tray-title-block");
    trayTitle.createEl("span", { text: `NEXT SYNTHESIS CONTEXT · ${state.activeTray.length} source${state.activeTray.length === 1 ? "" : "s"}`, cls: "synthesis-section-title" });
    trayTitle.createEl("span", { text: "Shared across threads", cls: "synthesis-tray-shared" });
    const trayHeaderActions = trayHeader.createDiv("synthesis-tray-header-actions");
    const conversationSelect = trayHeaderActions.createEl("select", { cls: "synthesis-conversation-select", attr: { "aria-label": "Add conversation snapshot" } });
    conversationSelect.createEl("option", { text: "Add conversation snapshot", value: "" });
    for (const candidate of state.threads.filter((entry) => entry.id !== thread.id)) conversationSelect.createEl("option", { text: candidate.title, value: candidate.id });
    conversationSelect.disabled = this.streaming || state.threads.length <= 1;
    conversationSelect.onchange = async () => {
      const selectedThreadId = conversationSelect.value;
      conversationSelect.value = "";
      if (selectedThreadId) await this.plugin.addConversationToTray(selectedThreadId);
    };
    const collapse = trayHeaderActions.createEl("button", { text: this.trayCollapsed ? "Expand" : "Collapse", cls: "mod-muted", attr: { "aria-expanded": String(!this.trayCollapsed), "aria-label": this.trayCollapsed ? "Expand synthesis context" : "Collapse synthesis context" } });
    collapse.onclick = () => { this.trayCollapsed = !this.trayCollapsed; this.render(); };
    const recall = trayHeaderActions.createEl("button", { text: `Recall previous${state.previousTray.length ? ` (${state.previousTray.length})` : ""}`, cls: "mod-muted" });
    recall.disabled = state.previousTray.length === 0;
    recall.onclick = () => void this.recall();
    const clear = trayHeaderActions.createEl("button", { text: "Clear", cls: "mod-muted", attr: { "aria-label": "Clear active synthesis context" } });
    clear.disabled = state.activeTray.length === 0;
    clear.onclick = () => void this.clearTray();

    const tokenDetails = trayPanel.createEl("details", { cls: "synthesis-token-details" });
    this.tokenElement = tokenDetails.createEl("summary", { cls: "synthesis-token-count" });
    this.tokenBreakdownElement = tokenDetails.createDiv("synthesis-token-breakdown");
    this.renderTokenCount();

    if (!this.trayCollapsed) {
      const trayList = trayPanel.createDiv("synthesis-tray-list");
      if (state.activeTray.length === 0) {
        trayList.createDiv({ text: "No selected context. Add a selection, heading, note, or folder from an editor or file-explorer context menu. Nothing enters synthesis automatically.", cls: "synthesis-empty" });
      } else {
        for (const entry of presentationTrayEntries(state.activeTray)) this.renderTrayEntry(trayList, entry);
      }
    }

    if (targetMessage && this.conversationElement) scrollConversationToMessageStart(this.conversationElement, targetMessage);
    this.pendingAssistantScrollTurnId = null;
    this.pendingTrayRevealId = null;
  }

  private createInferenceSelect<T extends string>(container: HTMLElement, label: string, options: Array<{ value: T; label: string }>, selected: T, onChange: (value: T) => void): HTMLSelectElement {
    const select = container.createEl("select", { cls: "synthesis-inference-select", attr: { "aria-label": label } });
    for (const option of options) {
      const element = select.createEl("option", { text: option.label, value: option.value });
      element.selected = option.value === selected;
    }
    select.onchange = () => onChange(select.value as T);
    return select;
  }

  private showThreadMenu(event: MouseEvent, threadId: string): void {
    const menu = new Menu();
    menu.addItem((item) => item.setTitle("Rename thread").onClick(() => void this.renameThread(threadId)));
    menu.addItem((item) => item.setTitle("Delete thread").setWarning(true).onClick(() => void this.deleteThread(threadId)));
    menu.showAtMouseEvent(event);
  }

  private renderMessage(container: HTMLElement, message: Message): HTMLElement {
    const item = container.createDiv(`synthesis-message synthesis-message-${message.role}`);
    item.createDiv({ text: message.role === "user" ? "You" : "Assistant", cls: "synthesis-message-role" });
    if (message.role === "assistant") {
      const markdown = item.createDiv("synthesis-message-content");
      void MarkdownRenderer.render(this.app, message.content, markdown, "", this.plugin).then(() => {
        decorateRenderedCitations(markdown, (citation) => {
          const source = this.plugin.state.sourceSnapshots.find((candidate) => candidate.turnId === message.turnId && candidate.sourceIndex === citation.sourceIndex);
          if (source) openSourceSnapshotPreview(this.app, source, source.sourceIndex, citation.lineStart, citation.lineEnd);
        });
      });
      const turn = this.plugin.turnFor(message.turnId);
      if (turn) {
        const usage = this.plugin.usageForTurn(message.turnId);
        const metadata = item.createDiv("synthesis-message-metadata");
        metadata.setText(inferenceSummary(turn.model, turn.reasoningEffort, usage?.inputTokens ?? null, usage?.outputTokens ?? null, usage?.cachedInputTokens ?? null));
      }
    } else item.createDiv({ text: message.content, cls: "synthesis-message-content" });
    return item;
  }

  private renderStreamingMessage(container: HTMLElement): void {
    const item = container.createDiv("synthesis-message synthesis-message-assistant");
    item.createDiv({ text: "Assistant", cls: "synthesis-message-role" });
    item.createDiv({ text: this.streamedAssistant || "…", cls: "synthesis-message-content synthesis-streaming" });
  }

  private renderTrayEntry(container: HTMLElement, entry: TrayPresentationEntry): void {
    if (entry.kind === "item") {
      this.renderTrayItem(container, entry.item, entry.index);
      return;
    }
    const groupDetails = container.createEl("details", { cls: "synthesis-tray-group" });
    groupDetails.open = this.expandedCaptureGroups.has(entry.group.id) || entry.items.length <= 20;
    if (entry.items.some(({ item }) => item.id === this.pendingTrayRevealId)) groupDetails.open = true;
    groupDetails.ontoggle = () => {
      if (groupDetails.open) this.expandedCaptureGroups.add(entry.group.id);
      else this.expandedCaptureGroups.delete(entry.group.id);
    };
    const summary = groupDetails.createEl("summary", { cls: "synthesis-tray-group-summary" });
    summary.createEl("span", { text: entry.group.label, cls: "synthesis-tray-path" });
    summary.createEl("span", { text: `${entry.items.length} notes`, cls: "synthesis-tray-scope" });
    for (const { item, index } of entry.items) this.renderTrayItem(groupDetails, item, index);
    if (this.pendingTrayRevealId && entry.items.some(({ item }) => item.id === this.pendingTrayRevealId)) {
      groupDetails.querySelector<HTMLElement>(`[data-tray-id="${CSS.escape(this.pendingTrayRevealId)}"]`)?.scrollIntoView({ block: "nearest" });
    }
  }

  private renderTrayItem(container: HTMLElement, item: TrayItem, index: number): void {
    const row = container.createDiv("synthesis-tray-item");
    row.dataset.trayId = item.id;
    const metadata = row.createDiv("synthesis-tray-metadata");
    metadata.createEl("strong", { text: `S${index + 1}`, cls: "synthesis-source-id" });
    metadata.createEl("span", { text: readableScope(item.scope), cls: "synthesis-tray-scope" });
    metadata.createEl("span", { text: item.scope === "conversation" && item.conversationTitle ? `Conversation snapshot: ${item.conversationTitle}` : item.sourcePath, cls: "synthesis-tray-path" });
    if (item.headingPath) metadata.createEl("span", { text: item.headingPath.join(" › "), cls: "synthesis-tray-heading" });
    const actions = row.createDiv("synthesis-tray-item-actions");
    const preview = actions.createEl("button", { text: "Preview", cls: "mod-muted", attr: { "aria-label": `Preview S${index + 1} snapshot` } });
    preview.onclick = () => openSourceSnapshotPreview(this.app, asPreviewSource(item), index + 1, null, null, false);
    const remove = actions.createEl("button", { text: "×", cls: "synthesis-remove", attr: { "aria-label": `Remove S${index + 1}` } });
    remove.onclick = () => void this.plugin.removeTrayItem(item.id);
    if (item.id === this.pendingTrayRevealId) window.setTimeout(() => row.scrollIntoView({ block: "nearest" }), 0);
  }

  private renderTokenCount(): void {
    if (!this.tokenElement || !this.tokenBreakdownElement) return;
    const thread = this.plugin.state.threads.find((candidate) => candidate.id === this.plugin.state.activeThreadId);
    if (!thread) return;
    const breakdown = this.plugin.tokenBreakdown(thread.id, this.draft);
    this.tokenElement.setText(`≈ ${breakdown.total.toLocaleString()} next-request tokens`);
    this.tokenBreakdownElement.empty();
    for (const [label, value] of [["System", breakdown.system], ["Conversation", breakdown.conversation], ["Tray", breakdown.tray], ["Message", breakdown.draft]] as Array<[string, number]>) {
      const row = this.tokenBreakdownElement.createDiv("synthesis-token-row");
      row.createEl("span", { text: label });
      row.createEl("strong", { text: value.toLocaleString() });
    }
  }

  private configureResizer(resizer: HTMLElement, trayPanel: HTMLElement, root: HTMLElement): void {
    const setBasis = (clientY: number): void => {
      const bounds = root.getBoundingClientRect();
      const minimum = 128;
      const maximum = Math.max(minimum, bounds.height - 220);
      this.trayBasisPx = Math.min(maximum, Math.max(minimum, bounds.bottom - clientY));
      trayPanel.style.flexBasis = `${this.trayBasisPx}px`;
    };
    let moving = false;
    const stop = (): void => {
      if (!moving) return;
      moving = false;
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", stop);
    };
    const move = (event: PointerEvent): void => { if (moving) setBasis(event.clientY); };
    resizer.addEventListener("pointerdown", (event) => {
      moving = true;
      resizer.setPointerCapture?.(event.pointerId);
      document.addEventListener("pointermove", move);
      document.addEventListener("pointerup", stop);
    });
    resizer.addEventListener("keydown", (event) => {
      const bounds = root.getBoundingClientRect();
      const current = this.trayBasisPx ?? bounds.height * 0.35;
      if (event.key === "ArrowUp") { event.preventDefault(); setBasis(bounds.bottom - current - 24); }
      if (event.key === "ArrowDown") { event.preventDefault(); setBasis(bounds.bottom - current + 24); }
    });
  }

  private async send(): Promise<void> {
    if (this.streaming) return;
    const draft = (this.draftElement?.value ?? this.draft).trim();
    if (!draft) return;
    this.streaming = true;
    this.streamedAssistant = "";
    this.render();
    let completedTurnId: string | null = null;
    try {
      const completedTurn = await this.plugin.send(draft, (delta) => {
        this.streamedAssistant += delta;
        if (this.conversationElement) {
          this.conversationElement.empty();
          const thread = this.plugin.state.threads.find((candidate) => candidate.id === this.plugin.state.activeThreadId);
          if (thread) for (const message of this.plugin.messagesFor(thread.id)) this.renderMessage(this.conversationElement, message);
          this.renderStreamingMessage(this.conversationElement);
        }
      });
      completedTurnId = completedTurn?.id ?? null;
      this.draft = "";
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) new Notice(error instanceof Error ? error.message : "Synthesis request failed.");
    } finally {
      this.finishRequest(completedTurnId);
    }
  }

  private renderSourceManifest(container: HTMLElement, turnId: string): void {
    const sources = this.plugin.state.sourceSnapshots.filter((source) => source.turnId === turnId).sort((a, b) => a.sourceIndex - b.sourceIndex);
    if (sources.length === 0) return;
    const manifest = container.createEl("details", { cls: "synthesis-source-manifest" });
    manifest.createEl("summary", { text: `Sources used in this turn · ${sources.length}` });
    for (const source of sources) {
      const entry = sourceManifestEntries([source])[0];
      const details = manifest.createEl("details", { cls: "synthesis-source-entry" });
      const summary = details.createEl("summary");
      summary.createEl("strong", { text: `S${source.sourceIndex}`, cls: "synthesis-source-id" });
      summary.createEl("span", { text: entry.identity });
      const body = details.createDiv("synthesis-source-entry-body");
      body.createEl("span", { text: "Snapshot supplied to this turn", cls: "synthesis-snapshot-label" });
      body.createEl("span", { text: readableScope(source.scope), cls: "synthesis-tray-scope" });
      if (source.headingPath) body.createEl("span", { text: source.headingPath.join(" › "), cls: "synthesis-tray-heading" });
      const view = body.createEl("button", { text: "View snapshot", cls: "mod-muted", attr: { "aria-label": `View supplied snapshot for S${source.sourceIndex}` } });
      view.onclick = () => openSourceSnapshotPreview(this.app, source, source.sourceIndex);
    }
  }

  private finishRequest(completedTurnId: string | null): void {
    this.streaming = false;
    this.streamedAssistant = "";
    this.pendingAssistantScrollTurnId = completedTurnId;
    this.render();
  }

  private async recall(): Promise<void> {
    if (this.plugin.state.activeTray.length > 0) {
      const replace = await chooseAction(this.app, "Recall previous tray", "Replace the current tray with the previous successful tray?", [{ label: "Cancel", value: false }, { label: "Replace", value: true, cls: "mod-cta" }], false);
      if (!replace) return;
    }
    await this.plugin.recallPreviousTray();
  }

  private async createThread(): Promise<void> {
    let clear = false;
    if (this.plugin.state.activeTray.length > 0) {
      const choice = await chooseAction(this.app, "New synthesis thread", "An active tray is present. Choose whether to keep or clear it.", [{ label: "Cancel", value: null }, { label: "Keep tray", value: false }, { label: "Clear tray", value: true, cls: "mod-cta" }], null);
      if (choice === null) return;
      clear = choice;
    }
    await this.plugin.createThread(clear);
  }

  private async renameThread(threadId: string): Promise<void> {
    const thread = this.plugin.state.threads.find((candidate) => candidate.id === threadId);
    if (!thread) return;
    const title = await requestText(this.app, "Rename thread", "Enter a new thread name.", thread.title);
    if (title) await this.plugin.renameThread(threadId, title);
  }

  private async deleteThread(threadId: string): Promise<void> {
    if (!await confirmAction(this.app, "Delete thread", "Delete this thread and its local conversation history?")) return;
    await this.plugin.deleteThread(threadId);
  }

  private async clearTray(): Promise<void> {
    if (this.plugin.state.activeTray.length === 0) return;
    if (!await confirmAction(this.app, "Clear tray", "Remove all items from the active synthesis tray? Previous tray and conversation history are preserved.")) return;
    await this.plugin.clearActiveTray();
  }
}

function readableScope(scope: TrayItem["scope"]): string {
  if (scope === "whole_note") return "Whole note";
  if (scope === "highlight") return "Highlight";
  if (scope === "heading") return "Heading";
  return "Conversation snapshot";
}
