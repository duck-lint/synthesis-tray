import { Editor, MarkdownView, Menu, Notice, Plugin, TAbstractFile, TFile, TFolder, WorkspaceLeaf } from "obsidian";
import { captureConversation, captureFolderWholeNotes, captureHeading, captureSelection, captureWholeNote, offsetAtPosition } from "./capture/capture";
import { resolveOutgoingWikilinks } from "./capture/wikilinks";
import { SynthesisSettingTab } from "./settings";
import { mergeSettings } from "./state/settings";
import { SynthesisDatabase } from "./persistence/database";
import { addTrayItem, cloneLinkedContext, cloneTray, emptyLinkedContext, linkedContextForRequest, removeTrayItem, TrayRevealTarget } from "./state/tray";
import { afterSuccessfulTurn, clearedActiveTray, recalledPreviousTray } from "./state/turnLifecycle";
import { LEGACY_DEFAULT_MODEL, LEGACY_DEFAULT_REASONING_EFFORT, isReasoningEffortSupportedByModel, isSynthesisModel, migrateLegacyModel, LinkedContextSelection, LinkedContextSource, Message, PersistedState, PluginSettings, SourceSnapshot, Thread, TokenBreakdown, TrayItem, Turn, SynthesisModel, ReasoningEffort } from "./state/types";
import { newId, nowIso } from "./state/ids";
import { makeMessage, newThreadInferenceDefaults, titleFromFirstMessage } from "./state/thread";
import { buildResponsesRequest } from "./openai/requestBuilder";
import { requestSources } from "./openai/sourceSerializer";
import { streamResponse } from "./openai/client";
import { turnUsageFromProvider } from "./openai/usage";
import { countSerializedTrayTokens, TokenCountCache } from "./tokens/tokenizer";
import { VIEW_TYPE_SYNTHESIS, SynthesisView } from "./view/SynthesisView";
import { confirmAction } from "./view/interactionModal";

export default class SynthesisTrayPlugin extends Plugin {
  declare settings: PluginSettings;
  state!: PersistedState;
  database!: SynthesisDatabase;
  lastError: string | null = null;
  private initialization!: Promise<void>;
  private requestController: AbortController | null = null;
  private legacyMigrationModel: SynthesisModel = LEGACY_DEFAULT_MODEL;
  private readonly tokenCounts = new TokenCountCache();
  private readonly linkedContentCache = new Map<string, string>();
  private conversationRevision = 0;
  private trayRevision = 0;

  override async onload(): Promise<void> {
    const storedSettings = await this.loadData() as (Partial<PluginSettings> & { model?: unknown }) | null;
    this.legacyMigrationModel = migrateLegacyModel(storedSettings?.model);
    if (storedSettings?.model && storedSettings.model !== "gpt-5.6" && !isSynthesisModel(storedSettings.model)) {
      new Notice("The previous model setting was not a supported GPT-5.6 tier; new thread configuration defaults to Luna · High.");
    }
    this.settings = mergeSettings(storedSettings);
    await this.saveSettings();
    // Keep the persisted location vault-relative and predictable for backup/tools.
    const pluginDirectory = `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
    const databasePath = `${pluginDirectory}/conversations.sqlite3`;
    const wasmPath = `${pluginDirectory}/sql-wasm.wasm`;
    this.database = new SynthesisDatabase(this.app.vault.adapter, databasePath, wasmPath);

    // Register non-persistence UI surfaces first so a storage failure does not
    // prevent the plugin from being enabled or its settings from being opened.
    this.registerView(VIEW_TYPE_SYNTHESIS, (leaf) => new SynthesisView(leaf, this));
    this.addSettingTab(new SynthesisSettingTab(this.app, this));
    this.addCommands();
    this.registerEvent(this.app.workspace.on("editor-menu", (menu, editor, view) => this.addEditorMenu(menu, editor, view as MarkdownView)));
    this.registerEvent(this.app.workspace.on("file-menu", (menu, file) => this.addFileMenu(menu, file as TAbstractFile)));

    this.initialization = this.initialize().catch((error) => this.handleInitializationFailure(error));
    await this.initialization;
  }

  override async onunload(): Promise<void> {
    this.stopRequest();
    await this.database?.close();
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_SYNTHESIS);
  }

  async ready(): Promise<void> { await this.initialization; }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    if (this.state) this.refreshViews();
  }

  private async initialize(): Promise<void> {
    this.state = await this.database.load(LEGACY_DEFAULT_MODEL, LEGACY_DEFAULT_REASONING_EFFORT, this.legacyMigrationModel);
    if (this.state.threads.length === 0) {
      const thread = this.newThreadRecord("New synthesis thread");
      this.state.threads = [thread];
      this.state.activeThreadId = thread.id;
      await this.database.putThread(thread);
      await this.database.setActiveThread(thread.id, this.state.activeTray, this.state.previousTray, this.state.activeLinkedContext, this.state.previousLinkedContext);
    } else if (!this.state.activeThreadId || !this.state.threads.some((thread) => thread.id === this.state.activeThreadId)) {
      this.state.activeThreadId = this.state.threads[0].id;
      await this.database.setActiveThread(this.state.activeThreadId, this.state.activeTray, this.state.previousTray, this.state.activeLinkedContext, this.state.previousLinkedContext);
    }
  }

  private handleInitializationFailure(error: unknown): void {
    const detail = error instanceof Error ? error.message : String(error);
    this.lastError = `Local SQLite persistence could not be initialized: ${detail}`;
    this.state = {
      threads: [], messages: [], turns: [], turnUsage: [], sourceSnapshots: [], activeTray: [], previousTray: [], activeLinkedContext: emptyLinkedContext(), previousLinkedContext: emptyLinkedContext(), activeThreadId: null,
    };
    console.error("[Synthesis Tray] Local SQLite initialization failed", error);
    new Notice(this.lastError);
  }

  private newThreadRecord(title: string): Thread {
    const timestamp = nowIso();
    return { id: newId("thread"), title, createdAt: timestamp, updatedAt: timestamp, ...newThreadInferenceDefaults() };
  }

  private addCommands(): void {
    this.addCommand({ id: "open-synthesis-tray", name: "Open synthesis tray", callback: () => void this.openView() });
    this.addCommand({ id: "add-selection-to-synthesis", name: "Add selection to synthesis", editorCallback: (editor, view) => void this.addSelection(view as MarkdownView, editor) });
    this.addCommand({ id: "add-heading-to-synthesis", name: "Add heading to synthesis", editorCallback: (editor, view) => void this.addHeading(view as MarkdownView, editor) });
    this.addCommand({ id: "add-note-to-synthesis", name: "Add note to synthesis", callback: () => void this.addCurrentNote() });
    this.addCommand({ id: "recall-previous-tray", name: "Recall previous tray", callback: () => void this.recallPreviousTray() });
    this.addCommand({ id: "new-synthesis-thread", name: "New synthesis thread", callback: () => void this.createThread(false) });
  }

  private addEditorMenu(menu: Menu, editor: Editor, view: MarkdownView): void {
    if (!view?.file) return;
    if (editor.getSelection()) menu.addItem((item) => item.setTitle("Add selection to synthesis").setIcon("text-select").onClick(() => void this.addSelection(view, editor)));
    menu.addItem((item) => item.setTitle("Add heading to synthesis").setIcon("heading").onClick(() => void this.addHeading(view, editor)));
    menu.addItem((item) => item.setTitle("Add note to synthesis").setIcon("file-plus").onClick(() => void this.addNote(view.file!, editor.getValue())));
  }

  private addFileMenu(menu: Menu, file: TAbstractFile): void {
    if (file instanceof TFolder) {
      menu.addItem((item) => item.setTitle("Add folder to synthesis").setIcon("folder-plus").onClick(() => void this.addFolder(file)));
      return;
    }
    if (!(file instanceof TFile) || file.extension !== "md") return;
    menu.addItem((item) => item.setTitle("Add note to synthesis").setIcon("file-plus").onClick(() => void this.addNote(file)));
  }

  async openView(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_SYNTHESIS)[0];
    if (existing) return void this.app.workspace.revealLeaf(existing);
    const leaf = this.app.workspace.getRightLeaf(false) ?? this.app.workspace.getLeaf(true);
    await leaf.setViewState({ type: VIEW_TYPE_SYNTHESIS, active: true });
    await this.app.workspace.revealLeaf(leaf);
  }

  messagesFor(threadId: string): Message[] {
    return this.state.messages.filter((message) => message.threadId === threadId).sort((a, b) => {
      const created = a.createdAt.localeCompare(b.createdAt);
      if (created !== 0) return created;
      if (a.turnId !== b.turnId) return a.turnId.localeCompare(b.turnId);
      return a.role === "user" ? -1 : 1;
    });
  }

  tokenBreakdown(threadId: string, draft: string): TokenBreakdown {
    this.tokenCounts.updateSystem(this.settings.systemPrompt);
    this.tokenCounts.updateConversation(threadId, this.conversationRevision, this.messagesFor(threadId));
    const trayForTokens = this.state.activeTray.map((item) => ({ ...item, outgoingWikilinks: this.outgoingWikilinks(item) }));
    this.tokenCounts.updateTray(this.trayRevision, trayForTokens, this.state.activeLinkedContext);
    return this.tokenCounts.breakdown(draft, threadId);
  }

  outgoingWikilinks(item: TrayItem) {
    return item.outgoingWikilinks ?? resolveOutgoingWikilinks(this.app, item);
  }

  linkedSelection(parentSourceId: string, destinationSourceId: string): LinkedContextSelection | undefined {
    return this.state.activeLinkedContext.selections.find((selection) => selection.parentSourceId === parentSourceId && selection.destinationSourceId === destinationSourceId);
  }

  linkedSource(destinationSourceId: string): LinkedContextSource | undefined {
    return this.state.activeLinkedContext.sources.find((source) => source.destinationSourceId === destinationSourceId);
  }

  linkedTokenEstimate(parentSourceId: string, destinationSourceId: string): number | null {
    const source = this.linkedSource(destinationSourceId);
    const selection = this.linkedSelection(parentSourceId, destinationSourceId);
    if (!source || !selection) return null;
    const without = {
      sources: this.state.activeLinkedContext.sources.filter((candidate) => candidate.destinationSourceId !== destinationSourceId),
      selections: this.state.activeLinkedContext.selections.filter((candidate) => candidate.destinationSourceId !== destinationSourceId),
    };
    return Math.max(0, countSerializedTrayTokens(this.state.activeTray, this.state.activeLinkedContext) - countSerializedTrayTokens(this.state.activeTray, without));
  }

  async linkedBulkTokenEstimate(parentSourceId: string, destinationSourceIds: string[]): Promise<number | null> {
    const parent = this.state.activeTray.find((item) => item.id === parentSourceId);
    if (!parent) return null;
    const next = cloneLinkedContext(this.state.activeLinkedContext);
    for (const destination of this.outgoingWikilinks(parent).filter((link) => link.destinationSourceId && destinationSourceIds.includes(link.destinationSourceId))) {
      const destinationSourceId = destination.destinationSourceId!;
      if (!next.selections.some((selection) => selection.parentSourceId === parentSourceId && selection.destinationSourceId === destinationSourceId)) next.selections.push({ parentSourceId, destinationSourceId, authoredTarget: destination.authoredTarget, displayText: destination.displayText });
      if (this.state.activeTray.some((item) => item.sourcePath === destination.destinationPath) || next.sources.some((source) => source.destinationSourceId === destinationSourceId)) continue;
      const destinationPath = destination.destinationPath;
      const file = destinationPath ? this.app.vault.getAbstractFileByPath(destinationPath) : null;
      if (!(file instanceof TFile)) return null;
      let content = this.linkedContentCache.get(destinationSourceId);
      if (content === undefined) {
        content = await this.app.vault.read(file);
        this.linkedContentCache.set(destinationSourceId, content);
      }
      next.sources.push({ destinationSourceId, sourcePath: file.path, scope: "whole_note", contentSnapshot: content, addedAt: nowIso() });
    }
    return Math.max(0, countSerializedTrayTokens(this.state.activeTray, next) - countSerializedTrayTokens(this.state.activeTray, this.state.activeLinkedContext));
  }

  async addSelection(view: MarkdownView, editor: Editor): Promise<void> {
    if (!view?.file) return;
    const item = captureSelection(view.file.path, editor.getValue(), editor);
    if (item) await this.addTray(item);
  }

  async addHeading(view: MarkdownView, editor: Editor): Promise<void> {
    if (!view?.file) return;
    const source = editor.getValue();
    const cursor = editor.getCursor();
    const item = captureHeading(view.file.path, source, offsetAtPosition(source, cursor.line, cursor.ch));
    if (!item) new Notice("Place the cursor inside a Markdown heading region first.");
    else await this.addTray(item);
  }

  async addCurrentNote(): Promise<void> {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (view?.file) await this.addNote(view.file, view.editor.getValue());
  }

  private async addNote(file: TFile, currentBuffer?: string): Promise<void> {
    const source = currentBuffer ?? await this.app.vault.read(file);
    await this.addTray(captureWholeNote(file.path, source));
  }

  async addConversationToTray(threadId: string): Promise<void> {
    if (threadId === this.state.activeThreadId) return void new Notice("Choose a different conversation thread.");
    const thread = this.state.threads.find((candidate) => candidate.id === threadId);
    if (!thread) return;
    const messages = this.messagesFor(thread.id);
    if (messages.length === 0) return void new Notice("That conversation has no visible messages to add.");
    await this.addTray(captureConversation(thread, messages));
  }

  private async addFolder(folder: TFolder): Promise<void> {
    const prefix = folder.path ? `${folder.path}/` : "";
    const files = this.app.vault.getMarkdownFiles()
      .filter((file) => file.path.startsWith(prefix))
      .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    if (files.length === 0) return void new Notice(`No Markdown notes found beneath "${folder.path || folder.name}".`);
    if (!await confirmAction(this.app, "Add folder to synthesis", `Add ${files.length} Markdown notes from "${folder.path || folder.name}" to synthesis?`)) return;
    const captureGroup = { id: newId("capture-group"), kind: "folder" as const, label: folder.path || folder.name };
    const items = captureFolderWholeNotes(await Promise.all(files.map(async (file) => ({ path: file.path, extension: file.extension, source: await this.app.vault.read(file) }))), captureGroup);
    await this.addTrayItems(items, `Added ${items.length} Markdown notes from "${folder.path || folder.name}" to synthesis.`, { kind: "capture-group", id: captureGroup.id });
  }

  private async addTray(item: TrayItem): Promise<void> {
    await this.addTrayItems([item], `Added S${this.state.activeTray.length + 1}: ${item.sourcePath}`);
  }

  private async addTrayItems(items: TrayItem[], successNotice: string, deliberateReveal?: TrayRevealTarget): Promise<void> {
    let nextTray = this.state.activeTray;
    let added = 0;
    const addedItems: TrayItem[] = [];
    for (const item of items) {
      const prepared = { ...item, outgoingWikilinks: resolveOutgoingWikilinks(this.app, item) };
      const result = addTrayItem(nextTray, prepared);
      if (result.duplicate) continue;
      nextTray = result.tray;
      added += 1;
      addedItems.push(prepared);
    }
    if (added === 0) return void new Notice("That exact snapshot is already in the synthesis tray.");
    this.state.activeTray = nextTray;
    this.trayRevision += 1;
    await this.database.setMeta(this.state.activeTray, this.state.previousTray, this.state.activeThreadId, this.state.activeLinkedContext, this.state.previousLinkedContext);
    new Notice(successNotice);
    this.refreshViews({ revealTrayTarget: deliberateReveal ?? { kind: "item", id: addedItems.at(-1)!.id } });
  }

  async removeTrayItem(id: string): Promise<void> {
    this.state.activeTray = removeTrayItem(this.state.activeTray, id);
    const remainingParents = new Set(this.state.activeTray.map((item) => item.id));
    const selections = this.state.activeLinkedContext.selections.filter((selection) => remainingParents.has(selection.parentSourceId));
    const destinationIds = new Set(selections.map((selection) => selection.destinationSourceId));
    const sources = this.state.activeLinkedContext.sources.filter((source) => destinationIds.has(source.destinationSourceId));
    for (const selection of selections) {
      if (sources.some((source) => source.destinationSourceId === selection.destinationSourceId)) continue;
      const parent = this.state.activeTray.find((item) => item.id === selection.parentSourceId);
      const destination = parent && this.outgoingWikilinks(parent).find((link) => link.destinationSourceId === selection.destinationSourceId);
      const file = destination?.destinationPath ? this.app.vault.getAbstractFileByPath(destination.destinationPath) : null;
      if (file instanceof TFile) sources.push({ destinationSourceId: selection.destinationSourceId, sourcePath: file.path, scope: "whole_note", contentSnapshot: await this.app.vault.read(file), addedAt: nowIso() });
    }
    this.state.activeLinkedContext = { selections, sources };
    this.trayRevision += 1;
    await this.database.setMeta(this.state.activeTray, this.state.previousTray, this.state.activeThreadId, this.state.activeLinkedContext, this.state.previousLinkedContext);
    this.refreshViews();
  }

  async addLinkedContexts(parentSourceId: string, destinationSourceIds: string[]): Promise<void> {
    const parent = this.state.activeTray.find((item) => item.id === parentSourceId);
    if (!parent) return;
    const destinations = this.outgoingWikilinks(parent).filter((destination) => destination.destinationSourceId && destinationSourceIds.includes(destination.destinationSourceId));
    const selections = [...this.state.activeLinkedContext.selections];
    const sources = [...this.state.activeLinkedContext.sources];
    let added = 0;
    for (const destination of destinations) {
      const destinationSourceId = destination.destinationSourceId!;
      const alreadyExplicit = this.state.activeTray.some((item) => item.sourcePath === destination.destinationPath);
      if (!alreadyExplicit && !sources.some((source) => source.destinationSourceId === destinationSourceId)) {
        const file = destination.destinationPath ? this.app.vault.getAbstractFileByPath(destination.destinationPath) : null;
        if (!(file instanceof TFile)) continue;
        sources.push({ destinationSourceId, sourcePath: file.path, scope: "whole_note", contentSnapshot: await this.app.vault.read(file), addedAt: nowIso() });
      }
      if (!selections.some((selection) => selection.parentSourceId === parentSourceId && selection.destinationSourceId === destinationSourceId)) {
        selections.push({ parentSourceId, destinationSourceId, authoredTarget: destination.authoredTarget, displayText: destination.displayText });
        added += 1;
      }
    }
    if (added === 0) return;
    this.state.activeLinkedContext = { sources, selections };
    this.trayRevision += 1;
    await this.database.setMeta(this.state.activeTray, this.state.previousTray, this.state.activeThreadId, this.state.activeLinkedContext, this.state.previousLinkedContext);
    new Notice(`Added ${added} linked note${added === 1 ? "" : "s"} to the synthesis context.`);
    this.refreshViews({ revealTrayTarget: { kind: "item", id: parentSourceId } });
  }

  async removeLinkedContext(parentSourceId: string, destinationSourceId: string): Promise<void> {
    const selections = this.state.activeLinkedContext.selections.filter((selection) => !(selection.parentSourceId === parentSourceId && selection.destinationSourceId === destinationSourceId));
    const destinationIds = new Set(selections.map((selection) => selection.destinationSourceId));
    this.state.activeLinkedContext = { selections, sources: this.state.activeLinkedContext.sources.filter((source) => destinationIds.has(source.destinationSourceId)) };
    this.trayRevision += 1;
    await this.database.setMeta(this.state.activeTray, this.state.previousTray, this.state.activeThreadId, this.state.activeLinkedContext, this.state.previousLinkedContext);
    this.refreshViews({ preserveScroll: true });
  }

  async promoteLinkedContext(destinationSourceId: string): Promise<void> {
    const source = this.linkedSource(destinationSourceId);
    if (!source || this.state.activeTray.some((item) => item.sourcePath === source.sourcePath)) return;
    await this.addTray(captureWholeNote(source.sourcePath, source.contentSnapshot));
  }

  async clearActiveTray(): Promise<void> {
    if (this.state.activeTray.length === 0) return;
    const previousActiveTray = cloneTray(this.state.activeTray);
    const previousPreviousTray = cloneTray(this.state.previousTray);
    const previousActiveLinkedContext = cloneLinkedContext(this.state.activeLinkedContext);
    const previousPreviousLinkedContext = cloneLinkedContext(this.state.previousLinkedContext);
    const nextTrayState = clearedActiveTray(this.state);
    this.state.activeTray = nextTrayState.activeTray;
    this.state.previousTray = nextTrayState.previousTray;
    this.state.activeLinkedContext = emptyLinkedContext();
    this.trayRevision += 1;
    try {
      await this.database.setMeta(this.state.activeTray, this.state.previousTray, this.state.activeThreadId, this.state.activeLinkedContext, this.state.previousLinkedContext);
    } catch (error) {
      this.state.activeTray = previousActiveTray;
      this.state.previousTray = previousPreviousTray;
      this.state.activeLinkedContext = previousActiveLinkedContext;
      this.state.previousLinkedContext = previousPreviousLinkedContext;
      throw error;
    }
    new Notice("Active synthesis tray cleared.");
    this.refreshViews();
  }

  async recallPreviousTray(): Promise<void> {
    if (this.state.previousTray.length === 0) return;
    this.state.activeTray = recalledPreviousTray(this.state).activeTray;
    this.state.activeLinkedContext = cloneLinkedContext(this.state.previousLinkedContext);
    this.trayRevision += 1;
    await this.database.setMeta(this.state.activeTray, this.state.previousTray, this.state.activeThreadId, this.state.activeLinkedContext, this.state.previousLinkedContext);
    this.refreshViews();
  }

  async send(draft: string, onDelta: (delta: string) => void): Promise<Turn | null> {
    await this.ready();
    if (!draft.trim()) return null;
    if (!this.settings.secretName) throw new Error("Select an OpenAI secret in the plugin settings before sending.");
    const secret = await this.app.secretStorage.getSecret(this.settings.secretName);
    if (!secret) throw new Error("The selected OpenAI secret is unavailable.");
    const thread = this.state.threads.find((candidate) => candidate.id === this.state.activeThreadId);
    if (!thread) throw new Error("No active synthesis thread.");
    const trayForTurn = cloneTray(this.state.activeTray).map((item) => ({ ...item, outgoingWikilinks: this.outgoingWikilinks(item) }));
    const linkedForTurn = linkedContextForRequest(trayForTurn, cloneLinkedContext(this.state.activeLinkedContext));
    const priorMessages = this.messagesFor(thread.id);
    const request = buildResponsesRequest(this.settings, thread, thread.id, priorMessages, trayForTurn, draft, linkedForTurn);
    const controller = new AbortController();
    this.requestController = controller;
    this.lastError = null;
    try {
      const response = await streamResponse(secret, request, { onDelta }, controller.signal);
      const turnId = newId("turn");
      const user = makeMessage(thread, "user", draft, turnId);
      const assistant = makeMessage(thread, "assistant", response.output, turnId);
      const turn: Turn = { id: turnId, threadId: thread.id, userMessageId: user.id, assistantMessageId: assistant.id, createdAt: nowIso(), model: thread.model, reasoningEffort: thread.reasoningEffort };
      const usage = response.usage ? turnUsageFromProvider(turnId, response.usage) : null;
      const sources: SourceSnapshot[] = requestSources(trayForTurn, linkedForTurn).map((requestSource, index) => ({
        id: newId("source"), turnId, sourceIndex: index + 1, sourcePath: requestSource.item.sourcePath, scope: requestSource.item.scope, headingPath: "headingPath" in requestSource.item && requestSource.item.headingPath ? [...requestSource.item.headingPath] : null, contentSnapshot: requestSource.item.contentSnapshot, provenanceKind: requestSource.provenanceKind, parentSourceIds: requestSource.parentSourceIds, ...(requestSource.destinationSourceId ? { relationship: "outgoing_wikilink" as const, destinationSourceId: requestSource.destinationSourceId } : {}), ...(requestSource.provenanceKind === "explicit" ? { outgoingWikilinks: (requestSource.item as TrayItem).outgoingWikilinks ? (requestSource.item as TrayItem).outgoingWikilinks!.map((link) => ({ ...link })) : [] } : {}), ...("captureGroup" in requestSource.item && requestSource.item.captureGroup ? { captureGroup: { ...requestSource.item.captureGroup } } : {}),
      }));
      const updatedThread = { ...thread, title: this.messagesFor(thread.id).length === 0 ? titleFromFirstMessage(draft) : thread.title, updatedAt: nowIso() };
      await this.database.commitTurn(updatedThread, user, assistant, turn, sources, trayForTurn, usage ?? undefined, linkedForTurn);
      this.state.messages = [...this.state.messages, user, assistant];
      this.conversationRevision += 1;
      this.state.turns = [...this.state.turns, turn];
      if (usage) this.state.turnUsage = [...this.state.turnUsage, usage];
      this.state.sourceSnapshots = [...this.state.sourceSnapshots, ...sources];
      this.state.threads = this.state.threads.map((candidate) => candidate.id === thread.id ? updatedThread : candidate);
      const nextTrayState = afterSuccessfulTurn(trayForTurn);
      this.state.previousTray = nextTrayState.previousTray;
      this.state.activeTray = nextTrayState.activeTray;
      this.state.previousLinkedContext = cloneLinkedContext(linkedForTurn);
      this.state.activeLinkedContext = emptyLinkedContext();
      this.trayRevision += 1;
      return turn;
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) this.lastError = error instanceof Error ? error.message : "Synthesis request failed.";
      throw error;
    } finally {
      this.requestController = null;
    }
  }

  stopRequest(): void { this.requestController?.abort(); }

  async createThread(clearTray: boolean): Promise<void> {
    const thread = this.newThreadRecord("New synthesis thread");
    this.state.threads = [...this.state.threads, thread];
    this.state.activeThreadId = thread.id;
    if (clearTray) {
      this.state.activeTray = [];
      this.state.activeLinkedContext = emptyLinkedContext();
      this.trayRevision += 1;
    }
    await this.database.putThread(thread);
    await this.database.setMeta(this.state.activeTray, this.state.previousTray, thread.id, this.state.activeLinkedContext, this.state.previousLinkedContext);
    this.refreshViews({ preserveScroll: false });
  }

  async updateThreadInference(threadId: string, model: SynthesisModel, reasoningEffort: ReasoningEffort): Promise<void> {
    if (!isReasoningEffortSupportedByModel(model, reasoningEffort)) throw new Error(`Reasoning effort "${reasoningEffort}" is not supported by ${model}.`);
    const existing = this.state.threads.find((candidate) => candidate.id === threadId);
    if (!existing) return;
    const updated = { ...existing, model, reasoningEffort, updatedAt: nowIso() };
    this.state.threads = this.state.threads.map((thread) => thread.id === threadId ? updated : thread);
    await this.database.putThread(updated);
    this.refreshViews({ preserveScroll: true });
  }

  async switchThread(threadId: string): Promise<void> {
    if (!this.state.threads.some((thread) => thread.id === threadId)) return;
    this.state.activeThreadId = threadId;
    await this.database.setMeta(this.state.activeTray, this.state.previousTray, threadId, this.state.activeLinkedContext, this.state.previousLinkedContext);
    this.refreshViews({ preserveScroll: false });
  }

  async renameThread(threadId: string, title: string): Promise<void> {
    this.state.threads = this.state.threads.map((thread) => thread.id === threadId ? { ...thread, title, updatedAt: nowIso() } : thread);
    const thread = this.state.threads.find((candidate) => candidate.id === threadId);
    if (thread) await this.database.putThread(thread);
    this.refreshViews();
  }

  async deleteThread(threadId: string): Promise<void> {
    if (this.state.threads.length <= 1) return void new Notice("Keep at least one synthesis thread.");
    await this.database.deleteThread(threadId);
    this.state.threads = this.state.threads.filter((thread) => thread.id !== threadId);
    this.state.messages = this.state.messages.filter((message) => message.threadId !== threadId);
    const turnIds = new Set(this.state.turns.filter((turn) => turn.threadId === threadId).map((turn) => turn.id));
    this.state.turns = this.state.turns.filter((turn) => turn.threadId !== threadId);
    this.state.turnUsage = this.state.turnUsage.filter((usage) => !turnIds.has(usage.turnId));
    this.conversationRevision += 1;
    this.state.sourceSnapshots = this.state.sourceSnapshots.filter((source) => !turnIds.has(source.turnId));
    if (this.state.activeThreadId === threadId) this.state.activeThreadId = this.state.threads[0].id;
    await this.database.setMeta(this.state.activeTray, this.state.previousTray, this.state.activeThreadId, this.state.activeLinkedContext, this.state.previousLinkedContext);
    this.refreshViews();
  }

  turnFor(turnId: string): Turn | undefined { return this.state.turns.find((turn) => turn.id === turnId); }

  usageForTurn(turnId: string) { return this.state.turnUsage.find((usage) => usage.turnId === turnId); }

  private refreshViews(options?: { revealTrayTarget?: TrayRevealTarget; preserveScroll?: boolean }): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_SYNTHESIS)) {
      const view = leaf.view;
      if (view instanceof SynthesisView) view.refresh(options);
    }
  }
}

export { SynthesisTrayPlugin };
