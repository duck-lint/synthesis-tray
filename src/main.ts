import { Editor, MarkdownView, Menu, Notice, Plugin, TAbstractFile, TFile, TFolder, WorkspaceLeaf } from "obsidian";
import { captureConversation, captureFolderWholeNotes, captureHeading, captureSelection, captureWholeNote, offsetAtPosition } from "./capture/capture";
import { SynthesisSettingTab } from "./settings";
import { mergeSettings } from "./state/settings";
import { SynthesisDatabase } from "./persistence/database";
import { addTrayItem, cloneTray, removeTrayItem } from "./state/tray";
import { afterSuccessfulTurn, recalledPreviousTray } from "./state/turnLifecycle";
import { Message, PersistedState, PluginSettings, SourceSnapshot, Thread, TokenBreakdown, TrayItem, Turn } from "./state/types";
import { newId, nowIso } from "./state/ids";
import { makeMessage, titleFromFirstMessage } from "./state/thread";
import { buildResponsesRequest } from "./openai/requestBuilder";
import { streamResponse } from "./openai/client";
import { turnUsageFromProvider } from "./openai/usage";
import { countNextRequest } from "./tokens/tokenizer";
import { VIEW_TYPE_SYNTHESIS, SynthesisView } from "./view/SynthesisView";

export default class SynthesisTrayPlugin extends Plugin {
  declare settings: PluginSettings;
  state!: PersistedState;
  database!: SynthesisDatabase;
  lastError: string | null = null;
  private initialization!: Promise<void>;
  private requestController: AbortController | null = null;

  override async onload(): Promise<void> {
    this.settings = mergeSettings(await this.loadData());
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

  async saveSettings(): Promise<void> { await this.saveData(this.settings); }

  private async initialize(): Promise<void> {
    this.state = await this.database.load();
    if (this.state.threads.length === 0) {
      const thread = this.newThreadRecord("New synthesis thread");
      this.state.threads = [thread];
      this.state.activeThreadId = thread.id;
      await this.database.putThread(thread);
      await this.database.setActiveThread(thread.id, this.state.activeTray, this.state.previousTray);
    } else if (!this.state.activeThreadId || !this.state.threads.some((thread) => thread.id === this.state.activeThreadId)) {
      this.state.activeThreadId = this.state.threads[0].id;
      await this.database.setActiveThread(this.state.activeThreadId, this.state.activeTray, this.state.previousTray);
    }
  }

  private handleInitializationFailure(error: unknown): void {
    const detail = error instanceof Error ? error.message : String(error);
    this.lastError = `Local SQLite persistence could not be initialized: ${detail}`;
    this.state = {
      threads: [], messages: [], turns: [], turnUsage: [], sourceSnapshots: [], activeTray: [], previousTray: [], activeThreadId: null,
    };
    console.error("[Synthesis Tray] Local SQLite initialization failed", error);
    new Notice(this.lastError);
  }

  private newThreadRecord(title: string): Thread {
    const timestamp = nowIso();
    return { id: newId("thread"), title, createdAt: timestamp, updatedAt: timestamp };
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
    return countNextRequest(this.settings.systemPrompt, this.messagesFor(threadId), this.state.activeTray, draft);
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
    if (!window.confirm(`Add ${files.length} Markdown notes from "${folder.path || folder.name}" to synthesis?`)) return;
    const items = captureFolderWholeNotes(await Promise.all(files.map(async (file) => ({ path: file.path, extension: file.extension, source: await this.app.vault.read(file) }))));
    await this.addTrayItems(items, `Added ${items.length} Markdown notes from "${folder.path || folder.name}" to synthesis.`);
  }

  private async addTray(item: TrayItem): Promise<void> {
    await this.addTrayItems([item], `Added S${this.state.activeTray.length + 1}: ${item.sourcePath}`);
  }

  private async addTrayItems(items: TrayItem[], successNotice: string): Promise<void> {
    let nextTray = this.state.activeTray;
    let added = 0;
    for (const item of items) {
      const result = addTrayItem(nextTray, item);
      if (result.duplicate) continue;
      nextTray = result.tray;
      added += 1;
    }
    if (added === 0) return void new Notice("That exact snapshot is already in the synthesis tray.");
    this.state.activeTray = nextTray;
    await this.database.setMeta(this.state.activeTray, this.state.previousTray, this.state.activeThreadId);
    new Notice(successNotice);
    this.refreshViews();
  }

  async removeTrayItem(id: string): Promise<void> {
    this.state.activeTray = removeTrayItem(this.state.activeTray, id);
    await this.database.setMeta(this.state.activeTray, this.state.previousTray, this.state.activeThreadId);
    this.refreshViews();
  }

  async recallPreviousTray(): Promise<void> {
    if (this.state.previousTray.length === 0) return;
    this.state.activeTray = recalledPreviousTray(this.state).activeTray;
    await this.database.setMeta(this.state.activeTray, this.state.previousTray, this.state.activeThreadId);
    this.refreshViews();
  }

  async send(draft: string, onDelta: (delta: string) => void): Promise<Turn | null> {
    await this.ready();
    if (!draft.trim()) return null;
    if (!this.settings.secretName) throw new Error("Select an OpenAI secret in the plugin settings before sending.");
    if (!this.settings.model.trim()) throw new Error("Enter an OpenAI model name in the plugin settings.");
    const secret = await this.app.secretStorage.getSecret(this.settings.secretName);
    if (!secret) throw new Error("The selected OpenAI secret is unavailable.");
    const thread = this.state.threads.find((candidate) => candidate.id === this.state.activeThreadId);
    if (!thread) throw new Error("No active synthesis thread.");
    const trayForTurn = cloneTray(this.state.activeTray);
    const priorMessages = this.messagesFor(thread.id);
    const request = buildResponsesRequest(this.settings, priorMessages, trayForTurn, draft);
    const controller = new AbortController();
    this.requestController = controller;
    this.lastError = null;
    try {
      const response = await streamResponse(secret, request, { onDelta }, controller.signal);
      const turnId = newId("turn");
      const user = makeMessage(thread, "user", draft, turnId);
      const assistant = makeMessage(thread, "assistant", response.output, turnId);
      const turn: Turn = { id: turnId, threadId: thread.id, userMessageId: user.id, assistantMessageId: assistant.id, createdAt: nowIso() };
      const usage = response.usage ? turnUsageFromProvider(turnId, response.usage) : null;
      const sources: SourceSnapshot[] = trayForTurn.map((item, index) => ({
        id: newId("source"), turnId, sourceIndex: index + 1, sourcePath: item.sourcePath, scope: item.scope, headingPath: item.headingPath ? [...item.headingPath] : null, contentSnapshot: item.contentSnapshot,
      }));
      const updatedThread = { ...thread, title: this.messagesFor(thread.id).length === 0 ? titleFromFirstMessage(draft) : thread.title, updatedAt: nowIso() };
      await this.database.commitTurn(updatedThread, user, assistant, turn, sources, trayForTurn, usage ?? undefined);
      this.state.messages = [...this.state.messages, user, assistant];
      this.state.turns = [...this.state.turns, turn];
      if (usage) this.state.turnUsage = [...this.state.turnUsage, usage];
      this.state.sourceSnapshots = [...this.state.sourceSnapshots, ...sources];
      this.state.threads = this.state.threads.map((candidate) => candidate.id === thread.id ? updatedThread : candidate);
      const nextTrayState = afterSuccessfulTurn(trayForTurn);
      this.state.previousTray = nextTrayState.previousTray;
      this.state.activeTray = nextTrayState.activeTray;
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
    if (clearTray) this.state.activeTray = [];
    await this.database.putThread(thread);
    await this.database.setMeta(this.state.activeTray, this.state.previousTray, thread.id);
    this.refreshViews();
  }

  async switchThread(threadId: string): Promise<void> {
    if (!this.state.threads.some((thread) => thread.id === threadId)) return;
    this.state.activeThreadId = threadId;
    await this.database.setMeta(this.state.activeTray, this.state.previousTray, threadId);
    this.refreshViews();
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
    this.state.sourceSnapshots = this.state.sourceSnapshots.filter((source) => !turnIds.has(source.turnId));
    if (this.state.activeThreadId === threadId) this.state.activeThreadId = this.state.threads[0].id;
    await this.database.setMeta(this.state.activeTray, this.state.previousTray, this.state.activeThreadId);
    this.refreshViews();
  }

  private refreshViews(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_SYNTHESIS)) {
      const view = leaf.view;
      if (view instanceof SynthesisView) view.refresh();
    }
  }
}

export { SynthesisTrayPlugin };
