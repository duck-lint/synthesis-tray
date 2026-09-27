import { Editor, MarkdownView, Menu, Notice, Plugin, TAbstractFile, TFile, TFolder, WorkspaceLeaf } from "obsidian";
import { captureConversation, captureFolderWholeNotes, captureHeading, captureSelection, captureWholeNote, offsetAtPosition } from "./capture/capture";
import { prepareSearchCapture, stageSearchItems, validatePreparedSearchSources } from "./capture/searchCapture";
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
import { chooseAction, confirmAction, ModalActionValidation, ModalCloseRegistration } from "./view/interactionModal";
import { chooseSearchLeaf, NativeSearchSnapshot, readNativeSearch, sameNativeSearchSnapshot } from "./search/nativeSearch";

interface SearchOperation {
  readonly controller: AbortController;
  readonly completion: Promise<void>;
  resolveCompletion: (() => void) | null;
  progressNotice: Notice | null;
  cancelButton: HTMLButtonElement | null;
  cancelButtonClick: (() => void) | null;
  closeConfirmation: (() => void) | null;
  commitPromise: Promise<MutationResult> | null;
  persistenceStarted: boolean;
  cleanedUp: boolean;
}

type MutationResult = "committed" | "skipped";

interface MutationHandle {
  isLive(): boolean;
  tryStartPersistence(): boolean;
  persist(operation: () => Promise<void>): Promise<boolean>;
}

interface MutationRecord {
  readonly operation: (mutation: MutationHandle) => Promise<void>;
  readonly promise: Promise<MutationResult>;
  resolve: ((result: MutationResult) => void) | null;
  reject: ((error: unknown) => void) | null;
  phase: "queued" | "running-prewrite" | "persistence-started" | "settled";
  settled: boolean;
  detached: boolean;
}

interface SendOperation {
  readonly controller: AbortController;
}

export default class SynthesisTrayPlugin extends Plugin {
  declare settings: PluginSettings;
  state!: PersistedState;
  database!: SynthesisDatabase;
  lastError: string | null = null;
  private initialization: Promise<void> = Promise.resolve();
  private requestController: AbortController | null = null;
  private legacyMigrationModel: SynthesisModel = LEGACY_DEFAULT_MODEL;
  private readonly tokenCounts = new TokenCountCache();
  private readonly linkedContentCache = new Map<string, string>();
  private conversationRevision = 0;
  private trayRevision = 0;
  private mutationQueue: MutationRecord[] = [];
  private mutationDispatcherRunning = false;
  private mutationShutdown: Promise<void> = Promise.resolve();
  private mutationAdmissionClosed = false;
  private unloadPromise: Promise<void> | null = null;
  private unloading = false;
  private activeSearchOperation: SearchOperation | null = null;
  private activeSendOperation: SendOperation | null = null;

  private enqueueMutation(operation: (mutation: MutationHandle) => Promise<void>): Promise<MutationResult> {
    if (this.unloading) return Promise.resolve("skipped");
    let resolve!: (result: MutationResult) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<MutationResult>((nextResolve, nextReject) => { resolve = nextResolve; reject = nextReject; });
    const record: MutationRecord = { operation, promise, resolve, reject, phase: "queued", settled: false, detached: false };
    this.mutationQueue.push(record);
    void this.dispatchMutations();
    return promise;
  }

  private settleMutation(record: MutationRecord, result: MutationResult): void {
    if (record.settled) return;
    record.settled = true;
    record.phase = "settled";
    record.resolve?.(result);
    record.resolve = null;
  }

  private mutationHandle(record: MutationRecord): MutationHandle {
    const isLive = (): boolean => !this.unloading && !record.detached && record.phase !== "settled";
    const tryStartPersistence = (): boolean => {
      if (!isLive() || record.phase !== "running-prewrite") return false;
      record.phase = "persistence-started";
      return true;
    };
    return {
      isLive,
      tryStartPersistence,
      persist: async (operation) => {
        if (!tryStartPersistence()) return false;
        await operation();
        return true;
      },
    };
  }

  private async dispatchMutations(): Promise<void> {
    if (this.mutationDispatcherRunning) return;
    this.mutationDispatcherRunning = true;
    try {
      while (this.mutationQueue.length > 0) {
        const record = this.mutationQueue.shift()!;
        if (record.settled) continue;
        if (this.unloading) {
          this.settleMutation(record, "skipped");
          continue;
        }
        record.phase = "running-prewrite";
        this.currentMutation = record;
        const mutation = this.mutationHandle(record);
        try {
          await record.operation(mutation);
          if (!record.settled) this.settleMutation(record, "committed");
        } catch (error) {
          if (!record.settled) record.reject?.(error);
          record.reject = null;
          this.settleMutation(record, "skipped");
        } finally {
          if (this.currentMutation === record) this.currentMutation = null;
        }
      }
    } finally {
      this.mutationDispatcherRunning = false;
    }
  }

  private closeMutationAdmission(): void {
    if (this.mutationAdmissionClosed) return;
    this.mutationAdmissionClosed = true;
    // Queued records must settle independently of the record currently holding
    // the dispatcher. This is the unload linearization point for plugin work.
    for (const record of this.mutationQueue.splice(0)) this.settleMutation(record, "skipped");
    const active = this.currentMutation;
    if (!active) {
      this.mutationShutdown = Promise.resolve();
      return;
    }
    if (active.phase !== "persistence-started") {
      active.detached = true;
      this.settleMutation(active, "skipped");
      this.mutationShutdown = Promise.resolve();
      return;
    }
    this.mutationShutdown = active.promise.then(() => undefined, () => undefined);
  }

  private currentMutation: MutationRecord | null = null;

  private async drainMutationsForUnload(): Promise<void> {
    const active = this.currentMutation;
    if (active && active.phase === "persistence-started") await this.mutationShutdown;
  }

  private searchLeafForView(view: unknown): WorkspaceLeaf | null {
    const leaves = this.app.workspace.getLeavesOfType("search");
    return leaves.find((leaf) => leaf === view || (leaf as unknown as { view?: unknown }).view === view) ?? null;
  }

  /** Views use this to suppress their own finalizer while plugin teardown is in progress. */
  isSendLifecycleLive(): boolean { return !this.unloading; }

  private sendOperationIsLive(operation: SendOperation): boolean {
    return !this.unloading && this.activeSendOperation === operation && !operation.controller.signal.aborted;
  }

  private invalidateSendOperation(): void {
    const operation = this.activeSendOperation;
    this.activeSendOperation = null;
    operation?.controller.abort();
  }

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
    this.registerEvent((this.app.workspace as unknown as { on: (name: string, callback: (menu: Menu, view: unknown) => void) => unknown }).on("search:results-menu", (menu, view) => {
      const leaf = this.searchLeafForView(view);
      const result = readNativeSearch(this.app, leaf);
      menu.addItem((item) => item.setTitle("Add all results to tray").setIcon("files").setDisabled(!result.ok).onClick(() => void this.addAllSearchResults(leaf)));
    }) as never);

    this.initialization = this.initialize().catch((error) => this.handleInitializationFailure(error));
    await this.initialization;
  }

  override async onunload(): Promise<void> {
    if (this.unloadPromise) return this.unloadPromise;
    this.unloadPromise = (async () => {
      this.unloading = true;
      this.closeMutationAdmission();
      const searchOperation = this.activeSearchOperation;
      searchOperation?.controller.abort();
      searchOperation?.closeConfirmation?.();
      this.stopRequest();
      await this.drainMutationsForUnload();
      // Initialization owns database.load/open/migration and its follow-on
      // writes. It must settle before close, including when unload overlaps it.
      await this.initialization;
      if (searchOperation) await searchOperation.completion;
      await this.database?.close();
      this.app.workspace.detachLeavesOfType(VIEW_TYPE_SYNTHESIS);
    })();
    return this.unloadPromise;
  }

  async ready(): Promise<void> { await this.initialization; }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    if (this.state) this.refreshViews();
  }

  private async initialize(): Promise<void> {
    if (this.unloading) return;
    const loadedState = await this.database.load(LEGACY_DEFAULT_MODEL, LEGACY_DEFAULT_REASONING_EFFORT, this.legacyMigrationModel);
    if (this.unloading) return;
    if (loadedState.threads.length === 0) {
      const thread = this.newThreadRecord("New synthesis thread");
      const nextState = { ...loadedState, threads: [thread], activeThreadId: thread.id };
      const result = await this.enqueueMutation(async (mutation) => {
        const persisted = await mutation.persist(async () => {
          await this.database.putThread(thread);
          await this.database.setActiveThread(thread.id, nextState.activeTray, nextState.previousTray, nextState.activeLinkedContext, nextState.previousLinkedContext);
        });
        if (!persisted || !mutation.isLive()) return;
      });
      if (result !== "committed" || this.unloading) return;
      this.state = nextState;
    } else if (!loadedState.activeThreadId || !loadedState.threads.some((thread) => thread.id === loadedState.activeThreadId)) {
      const activeThreadId = loadedState.threads[0].id;
      const nextState = { ...loadedState, activeThreadId };
      const result = await this.enqueueMutation(async (mutation) => {
        const persisted = await mutation.persist(() => this.database.setActiveThread(activeThreadId, nextState.activeTray, nextState.previousTray, nextState.activeLinkedContext, nextState.previousLinkedContext));
        if (!persisted || !mutation.isLive()) return;
      });
      if (result !== "committed" || this.unloading) return;
      this.state = nextState;
    } else {
      this.state = loadedState;
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
    this.addCommand({ id: "add-all-search-results-to-synthesis", name: "Add all search results to synthesis", callback: () => void this.addAllSearchResults() });
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

  private beginSearchOperation(): SearchOperation | null {
    if (this.unloading || this.activeSearchOperation) return null;
    let resolveCompletion: (() => void) | null = null;
    const operation: SearchOperation = {
      controller: new AbortController(),
      completion: new Promise<void>((resolve) => { resolveCompletion = resolve; }),
      resolveCompletion: null,
      progressNotice: null,
      cancelButton: null,
      cancelButtonClick: null,
      closeConfirmation: null,
      commitPromise: null,
      persistenceStarted: false,
      cleanedUp: false,
    };
    operation.resolveCompletion = resolveCompletion;
    this.activeSearchOperation = operation;
    return operation;
  }

  private searchOperationIsLive(operation: SearchOperation): boolean {
    return !this.unloading && this.activeSearchOperation === operation && !operation.controller.signal.aborted;
  }

  private clearSearchProgress(operation: SearchOperation): void {
    operation.cancelButton?.removeEventListener("click", operation.cancelButtonClick!);
    if (operation.cancelButton) {
      operation.cancelButton.disabled = true;
      operation.cancelButton.remove();
    }
    operation.cancelButton = null;
    operation.cancelButtonClick = null;
    operation.progressNotice?.hide();
    operation.progressNotice = null;
  }

  private finishSearchOperation(operation: SearchOperation): void {
    if (operation.cleanedUp) return;
    operation.cleanedUp = true;
    this.clearSearchProgress(operation);
    operation.closeConfirmation = null;
    if (this.activeSearchOperation === operation) this.activeSearchOperation = null;
    operation.resolveCompletion?.();
    operation.resolveCompletion = null;
  }

  private searchNotice(operation: SearchOperation, message: string): void {
    if (this.searchOperationIsLive(operation)) new Notice(message);
  }

  async addAllSearchResults(invokingLeaf: WorkspaceLeaf | null = null): Promise<void> {
    // Reserve the lifecycle slot synchronously. This must precede ready(), because
    // onunload can otherwise close the database while this invocation is suspended.
    const operation = this.beginSearchOperation();
    if (!operation) return;
    try {
      await this.ready();
      if (!this.searchOperationIsLive(operation)) return;
      const selected = chooseSearchLeaf(this.app, invokingLeaf);
      if (!selected.ok) return void this.searchNotice(operation, selected.detail);
      const snapshot: NativeSearchSnapshot = selected.snapshot;
      if (snapshot.files.length === 0) return void this.searchNotice(operation, `The completed Search has no eligible Markdown notes. ${snapshot.excludedNonMarkdown.length} non-Markdown result${snapshot.excludedNonMarkdown.length === 1 ? "" : "s"} excluded.`);
      const capturedRevision = this.trayRevision;
      const group = { id: newId("capture-group"), kind: "search" as const, label: snapshot.query };
      const progressNotice = new Notice(`Preparing ${snapshot.files.length} Search result${snapshot.files.length === 1 ? "" : "s"}…`, 0);
      operation.progressNotice = progressNotice;
      const cancelButton = document.createElement("button");
      cancelButton.type = "button";
      cancelButton.textContent = "Cancel";
      cancelButton.setAttribute("aria-label", "Cancel Search result preparation");
      const cancelButtonClick = (): void => operation.controller.abort();
      operation.cancelButtonClick = cancelButtonClick;
      operation.cancelButton = cancelButton;
      cancelButton.addEventListener("click", cancelButtonClick);
      progressNotice.messageEl.append(" ", cancelButton);
      let lastProgress = "";
      let preparation;
      try {
        preparation = await prepareSearchCapture(this.app.vault, snapshot.files.map((file) => file.path), this.state.activeTray, group, (progress) => {
          if (!this.searchOperationIsLive(operation)) return;
          const message = `Preparing Search results · ${progress.completed}/${progress.total}`;
          if (message !== lastProgress) { progressNotice.setMessage(message); progressNotice.messageEl.append(" ", cancelButton); lastProgress = message; }
        }, operation.controller.signal);
      } catch (error) {
        this.searchNotice(operation, `Search capture failed; the synthesis tray was unchanged. ${error instanceof Error ? error.message : String(error)}`);
        return;
      } finally {
        this.clearSearchProgress(operation);
      }
      if (!this.searchOperationIsLive(operation)) return;
      if (!preparation.ok) return void this.searchNotice(operation, `Search capture cancelled or invalidated: ${preparation.detail}`);
      const sourceFailure = await validatePreparedSearchSources(this.app.vault, preparation.prepared.selectedItems, operation.controller.signal);
      if (!this.searchOperationIsLive(operation)) return;
      if (sourceFailure?.ok === false) return void this.searchNotice(operation, `Search capture invalidated: ${sourceFailure.detail}`);

      const searchStateIsFresh = (): boolean => {
        if (capturedRevision !== this.trayRevision) {
          this.searchNotice(operation, "The tray changed while the Search preview was being prepared. Prepare the import again.");
          return false;
        }
        const current = sameNativeSearchSnapshot(this.app, snapshot);
        if (!current.ok) {
          this.searchNotice(operation, `Search preview is stale: ${current.detail}`);
          return false;
        }
        return true;
      };

      if (!searchStateIsFresh()) return;
      if (preparation.prepared.items.length === 0) {
        return void this.searchNotice(operation, `All ${preparation.prepared.duplicateCount} eligible Search result${preparation.prepared.duplicateCount === 1 ? "" : "s"} are already present as exact snapshots.`);
      }

      // Preview and commit must share one fully serialized representation. In
      // particular, outgoing wikilinks are serialized metadata, so deriving
      // them only during commit would make the confirmation estimate false.
      const enrichedCurrentTray = this.state.activeTray.map((item) => ({ ...item, outgoingWikilinks: resolveOutgoingWikilinks(this.app, item) }));
      const enrichedCandidates = preparation.prepared.items.map((item) => ({ ...item, outgoingWikilinks: resolveOutgoingWikilinks(this.app, item) }));
      const staged = stageSearchItems(enrichedCurrentTray, enrichedCandidates);
      const additionalTokens = Math.max(0, countSerializedTrayTokens(staged.tray, this.state.activeLinkedContext) - countSerializedTrayTokens(enrichedCurrentTray, this.state.activeLinkedContext));
      const thread = this.state.threads.find((candidate) => candidate.id === this.state.activeThreadId);
      const projected = thread ? this.tokenBreakdown(thread.id, "").total + additionalTokens : additionalTokens;
      const excluded = snapshot.excludedNonMarkdown.length;
      const alreadyPresent = preparation.prepared.duplicateCount;
      const message = [
        `Search: ${snapshot.query}`,
        `Results: ${snapshot.files.length + excluded} distinct resolved files`,
        `Eligible Markdown notes: ${snapshot.files.length}`,
        `Already present: ${alreadyPresent}`,
        `Unsupported: ${excluded}`,
        `New sources: ${preparation.prepared.items.length}`,
        `Estimated additional tray tokens: +${additionalTokens.toLocaleString()}`,
        `Projected request total: ≈${projected.toLocaleString()}`,
      ].join("\n");
      if (!this.searchOperationIsLive(operation)) return;
      // Keep this as the final synchronous gate before opening confirmation.
      // Commit-time checks remain necessary for races after the modal action.
      if (!searchStateIsFresh()) return;
      const registerClose: ModalCloseRegistration = (close) => { operation.closeConfirmation = close; };
      const validateConfirmation: ModalActionValidation<boolean> = async () => {
        const sourceFailure = await validatePreparedSearchSources(this.app.vault, preparation.prepared.selectedItems, operation.controller.signal);
        if (!this.searchOperationIsLive(operation)) return false;
        if (sourceFailure?.ok === false) {
          this.searchNotice(operation, `Search capture invalidated: ${sourceFailure.detail}`);
          return false;
        }
        return searchStateIsFresh();
      };
      const confirmed = await chooseAction(this.app, "Add search results to Synthesis Tray?", message, [{ label: "Cancel", value: false }, { label: `Add ${preparation.prepared.items.length} notes`, value: true, cls: "mod-cta" }], false, registerClose, validateConfirmation);
      operation.closeConfirmation = null;
      if (!confirmed || !this.searchOperationIsLive(operation)) return;
      const commitPromise = this.enqueueMutation(async (mutation) => {
        // Queue admission is not persistence start. The operation may have been
        // unloaded while an earlier mutation kept this callback waiting.
        if (!this.searchOperationIsLive(operation) || !mutation.isLive()) return;
        if (capturedRevision !== this.trayRevision) throw new Error("The tray changed while the Search preview was open. Prepare the import again.");
        const current = sameNativeSearchSnapshot(this.app, snapshot);
        if (!current.ok) throw new Error(`Search preview is stale: ${current.detail}`);
        const sourceFailure = await validatePreparedSearchSources(this.app.vault, preparation.prepared.selectedItems, operation.controller.signal);
        if (!this.searchOperationIsLive(operation) || !mutation.isLive()) return;
        if (sourceFailure?.ok === false) throw new Error(`Search capture invalidated: ${sourceFailure.detail}`);
        if (staged.added.length === 0) throw new Error("All Search sources became exact duplicates before commit.");
        if (!this.searchOperationIsLive(operation) || !mutation.isLive()) return;
        operation.persistenceStarted = true;
        const persisted = await mutation.persist(() => this.database.setMeta(staged.tray, this.state.previousTray, this.state.activeThreadId, this.state.activeLinkedContext, this.state.previousLinkedContext));
        if (!persisted || !this.searchOperationIsLive(operation) || !mutation.isLive()) return;
        this.state.activeTray = staged.tray;
        this.trayRevision += 1;
        this.searchNotice(operation, `Added ${staged.added.length} Search note${staged.added.length === 1 ? "" : "s"} to the synthesis tray. ${staged.duplicateCount} exact duplicate${staged.duplicateCount === 1 ? "" : "s"} skipped.`);
        this.refreshViews({ revealTrayTarget: { kind: "capture-group", id: group.id } });
      });
      operation.commitPromise = commitPromise;
      try {
        await commitPromise;
      } catch (error) {
        this.searchNotice(operation, error instanceof Error ? error.message : "Search capture failed; the synthesis tray was unchanged.");
      }
    } finally {
      this.finishSearchOperation(operation);
    }
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
    let addedItems: TrayItem[] = [];
    const mutationResult = await this.enqueueMutation(async (mutation) => {
      let nextTray = this.state.activeTray;
      for (const item of items) {
        const prepared = { ...item, outgoingWikilinks: resolveOutgoingWikilinks(this.app, item) };
        const result = addTrayItem(nextTray, prepared);
        if (result.duplicate) continue;
        nextTray = result.tray;
        addedItems.push(prepared);
      }
      if (addedItems.length === 0) return;
      const persisted = await mutation.persist(() => this.database.setMeta(nextTray, this.state.previousTray, this.state.activeThreadId, this.state.activeLinkedContext, this.state.previousLinkedContext));
      if (!persisted || !mutation.isLive()) return;
      this.state.activeTray = nextTray;
      this.trayRevision += 1;
    });
    if (mutationResult !== "committed" || this.unloading) return;
    if (addedItems.length === 0) return void new Notice("That exact snapshot is already in the synthesis tray.");
    new Notice(successNotice);
    this.refreshViews({ revealTrayTarget: deliberateReveal ?? { kind: "item", id: addedItems.at(-1)!.id } });
  }

  async removeTrayItem(id: string): Promise<void> {
    const mutationResult = await this.enqueueMutation(async (mutation) => {
      const nextTray = removeTrayItem(this.state.activeTray, id);
      const remainingParents = new Set(nextTray.map((item) => item.id));
      const selections = this.state.activeLinkedContext.selections.filter((selection) => remainingParents.has(selection.parentSourceId));
      const destinationIds = new Set(selections.map((selection) => selection.destinationSourceId));
      const sources = this.state.activeLinkedContext.sources.filter((source) => destinationIds.has(source.destinationSourceId));
      for (const selection of selections) {
        if (sources.some((source) => source.destinationSourceId === selection.destinationSourceId)) continue;
        const parent = nextTray.find((item) => item.id === selection.parentSourceId);
        const destination = parent && this.outgoingWikilinks(parent).find((link) => link.destinationSourceId === selection.destinationSourceId);
        const file = destination?.destinationPath ? this.app.vault.getAbstractFileByPath(destination.destinationPath) : null;
        if (file instanceof TFile) sources.push({ destinationSourceId: selection.destinationSourceId, sourcePath: file.path, scope: "whole_note", contentSnapshot: await this.app.vault.read(file), addedAt: nowIso() });
      }
      const nextLinked = { selections, sources };
      const persisted = await mutation.persist(() => this.database.setMeta(nextTray, this.state.previousTray, this.state.activeThreadId, nextLinked, this.state.previousLinkedContext));
      if (!persisted || !mutation.isLive()) return;
      this.state.activeTray = nextTray;
      this.state.activeLinkedContext = nextLinked;
      this.trayRevision += 1;
    });
    if (mutationResult !== "committed" || this.unloading) return;
    this.refreshViews();
  }

  async addLinkedContexts(parentSourceId: string, destinationSourceIds: string[]): Promise<void> {
    let added = 0;
    const mutationResult = await this.enqueueMutation(async (mutation) => {
      const parent = this.state.activeTray.find((item) => item.id === parentSourceId);
      if (!parent) return;
      const destinations = this.outgoingWikilinks(parent).filter((destination) => destination.destinationSourceId && destinationSourceIds.includes(destination.destinationSourceId));
      const selections = [...this.state.activeLinkedContext.selections];
      const sources = [...this.state.activeLinkedContext.sources];
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
      const nextLinked = { sources, selections };
      const persisted = await mutation.persist(() => this.database.setMeta(this.state.activeTray, this.state.previousTray, this.state.activeThreadId, nextLinked, this.state.previousLinkedContext));
      if (!persisted || !mutation.isLive()) return;
      this.state.activeLinkedContext = nextLinked;
      this.trayRevision += 1;
    });
    if (mutationResult !== "committed" || this.unloading || added === 0) return;
    new Notice(`Added ${added} linked note${added === 1 ? "" : "s"} to the synthesis context.`);
    this.refreshViews({ revealTrayTarget: { kind: "item", id: parentSourceId } });
  }

  async removeLinkedContext(parentSourceId: string, destinationSourceId: string): Promise<void> {
    const mutationResult = await this.enqueueMutation(async (mutation) => {
      const selections = this.state.activeLinkedContext.selections.filter((selection) => !(selection.parentSourceId === parentSourceId && selection.destinationSourceId === destinationSourceId));
      const destinationIds = new Set(selections.map((selection) => selection.destinationSourceId));
      const nextLinked = { selections, sources: this.state.activeLinkedContext.sources.filter((source) => destinationIds.has(source.destinationSourceId)) };
      const persisted = await mutation.persist(() => this.database.setMeta(this.state.activeTray, this.state.previousTray, this.state.activeThreadId, nextLinked, this.state.previousLinkedContext));
      if (!persisted || !mutation.isLive()) return;
      this.state.activeLinkedContext = nextLinked;
      this.trayRevision += 1;
    });
    if (mutationResult !== "committed" || this.unloading) return;
    this.refreshViews({ preserveScroll: true });
  }

  async promoteLinkedContext(destinationSourceId: string): Promise<void> {
    const source = this.linkedSource(destinationSourceId);
    if (!source || this.state.activeTray.some((item) => item.sourcePath === source.sourcePath)) return;
    await this.addTray(captureWholeNote(source.sourcePath, source.contentSnapshot));
  }

  async clearActiveTray(): Promise<void> {
    if (this.state.activeTray.length === 0) return;
    const mutationResult = await this.enqueueMutation(async (mutation) => {
      const nextTrayState = clearedActiveTray(this.state);
      const nextLinked = emptyLinkedContext();
      const persisted = await mutation.persist(() => this.database.setMeta(nextTrayState.activeTray, nextTrayState.previousTray, this.state.activeThreadId, nextLinked, this.state.previousLinkedContext));
      if (!persisted || !mutation.isLive()) return;
      this.state.activeTray = nextTrayState.activeTray;
      this.state.previousTray = nextTrayState.previousTray;
      this.state.activeLinkedContext = nextLinked;
      this.trayRevision += 1;
    });
    if (mutationResult !== "committed" || this.unloading) return;
    new Notice("Active synthesis tray cleared.");
    this.refreshViews();
  }

  async recallPreviousTray(): Promise<void> {
    if (this.state.previousTray.length === 0) return;
    const mutationResult = await this.enqueueMutation(async (mutation) => {
      const nextTray = recalledPreviousTray(this.state).activeTray;
      const nextLinked = cloneLinkedContext(this.state.previousLinkedContext);
      const persisted = await mutation.persist(() => this.database.setMeta(nextTray, this.state.previousTray, this.state.activeThreadId, nextLinked, this.state.previousLinkedContext));
      if (!persisted || !mutation.isLive()) return;
      this.state.activeTray = nextTray;
      this.state.activeLinkedContext = nextLinked;
      this.trayRevision += 1;
    });
    if (mutationResult !== "committed" || this.unloading) return;
    this.refreshViews();
  }

  async send(draft: string, onDelta: (delta: string) => void): Promise<Turn | null> {
    if (!draft.trim()) return null;
    const operation: SendOperation = { controller: new AbortController() };
    this.activeSendOperation = operation;
    try {
      await this.ready();
      if (!this.sendOperationIsLive(operation)) return null;
      if (!this.settings.secretName) throw new Error("Select an OpenAI secret in the plugin settings before sending.");
      const secret = await this.app.secretStorage.getSecret(this.settings.secretName);
      if (!this.sendOperationIsLive(operation)) return null;
      if (!secret) throw new Error("The selected OpenAI secret is unavailable.");
      const thread = this.state.threads.find((candidate) => candidate.id === this.state.activeThreadId);
      if (!thread) throw new Error("No active synthesis thread.");
      const startRevision = this.trayRevision;
      const trayForTurn = cloneTray(this.state.activeTray).map((item) => ({ ...item, outgoingWikilinks: this.outgoingWikilinks(item) }));
      const linkedForTurn = linkedContextForRequest(trayForTurn, cloneLinkedContext(this.state.activeLinkedContext));
      const priorMessages = this.messagesFor(thread.id);
      const request = buildResponsesRequest(this.settings, thread, thread.id, priorMessages, trayForTurn, draft, linkedForTurn);
      this.requestController = operation.controller;
      this.lastError = null;
      const response = await streamResponse(secret, request, {
        onDelta: (delta) => {
          if (this.sendOperationIsLive(operation)) onDelta(delta);
        },
      }, operation.controller.signal);
      if (!this.sendOperationIsLive(operation)) return null;
      const turnId = newId("turn");
      const user = makeMessage(thread, "user", draft, turnId);
      const assistant = makeMessage(thread, "assistant", response.output, turnId);
      const turn: Turn = { id: turnId, threadId: thread.id, userMessageId: user.id, assistantMessageId: assistant.id, createdAt: nowIso(), model: thread.model, reasoningEffort: thread.reasoningEffort };
      const usage = response.usage ? turnUsageFromProvider(turnId, response.usage) : null;
      const sources: SourceSnapshot[] = requestSources(trayForTurn, linkedForTurn).map((requestSource, index) => ({
        id: newId("source"), turnId, sourceIndex: index + 1, sourcePath: requestSource.item.sourcePath, scope: requestSource.item.scope, headingPath: "headingPath" in requestSource.item && requestSource.item.headingPath ? [...requestSource.item.headingPath] : null, contentSnapshot: requestSource.item.contentSnapshot, provenanceKind: requestSource.provenanceKind, parentSourceIds: requestSource.parentSourceIds, ...(requestSource.destinationSourceId ? { relationship: "outgoing_wikilink" as const, destinationSourceId: requestSource.destinationSourceId } : {}), ...(requestSource.provenanceKind === "explicit" ? { outgoingWikilinks: (requestSource.item as TrayItem).outgoingWikilinks ? (requestSource.item as TrayItem).outgoingWikilinks!.map((link) => ({ ...link })) : [] } : {}), ...("captureGroup" in requestSource.item && requestSource.item.captureGroup ? { captureGroup: { ...requestSource.item.captureGroup } } : {}),
      }));
      const updatedThread = { ...thread, title: this.messagesFor(thread.id).length === 0 ? titleFromFirstMessage(draft) : thread.title, updatedAt: nowIso() };
      const commitResult = await this.enqueueMutation(async (mutation) => {
        if (!this.sendOperationIsLive(operation)) return;
        const conflicted = this.trayRevision !== startRevision;
        const currentActiveTray = conflicted ? cloneTray(this.state.activeTray) : [];
        const currentActiveLinkedContext = conflicted ? cloneLinkedContext(this.state.activeLinkedContext) : emptyLinkedContext();
        const persisted = await mutation.persist(() => this.database.commitTurn(updatedThread, user, assistant, turn, sources, trayForTurn, usage ?? undefined, linkedForTurn, currentActiveTray, currentActiveLinkedContext, this.state.activeThreadId));
        if (!persisted || !mutation.isLive()) return;
        this.state.messages = [...this.state.messages, user, assistant];
        this.conversationRevision += 1;
        this.state.turns = [...this.state.turns, turn];
        if (usage) this.state.turnUsage = [...this.state.turnUsage, usage];
        this.state.sourceSnapshots = [...this.state.sourceSnapshots, ...sources];
        this.state.threads = this.state.threads.map((candidate) => candidate.id === thread.id ? updatedThread : candidate);
        const nextTrayState = afterSuccessfulTurn(trayForTurn);
        this.state.previousTray = nextTrayState.previousTray;
        this.state.activeTray = currentActiveTray;
        this.state.previousLinkedContext = cloneLinkedContext(linkedForTurn);
        this.state.activeLinkedContext = currentActiveLinkedContext;
        this.trayRevision += 1;
        if (conflicted) new Notice("Synthesis sent; tray changes made while it streamed were preserved.");
      });
      return commitResult === "committed" ? turn : null;
    } catch (error) {
      if (!this.sendOperationIsLive(operation)) return null;
      if (!(error instanceof DOMException && error.name === "AbortError")) this.lastError = error instanceof Error ? error.message : "Synthesis request failed.";
      throw error;
    } finally {
      if (this.requestController === operation.controller) this.requestController = null;
      if (this.activeSendOperation === operation) this.activeSendOperation = null;
    }
  }

  stopRequest(): void {
    this.invalidateSendOperation();
    this.requestController?.abort();
  }

  async createThread(clearTray: boolean): Promise<void> {
    const thread = this.newThreadRecord("New synthesis thread");
    const mutationResult = await this.enqueueMutation(async (mutation) => {
      const nextTray = clearTray ? [] : this.state.activeTray;
      const nextLinked = clearTray ? emptyLinkedContext() : this.state.activeLinkedContext;
      const persisted = await mutation.persist(async () => {
        await this.database.putThread(thread);
        await this.database.setMeta(nextTray, this.state.previousTray, thread.id, nextLinked, this.state.previousLinkedContext);
      });
      if (!persisted || !mutation.isLive()) return;
      this.state.threads = [...this.state.threads, thread];
      this.state.activeThreadId = thread.id;
      if (clearTray) this.state.activeTray = nextTray;
      if (clearTray) this.state.activeLinkedContext = nextLinked;
      this.trayRevision += 1;
    });
    if (mutationResult !== "committed" || this.unloading) return;
    this.refreshViews({ preserveScroll: false });
  }

  async updateThreadInference(threadId: string, model: SynthesisModel, reasoningEffort: ReasoningEffort): Promise<void> {
    if (!isReasoningEffortSupportedByModel(model, reasoningEffort)) throw new Error(`Reasoning effort "${reasoningEffort}" is not supported by ${model}.`);
    const mutationResult = await this.enqueueMutation(async (mutation) => {
      const existing = this.state.threads.find((candidate) => candidate.id === threadId);
      if (!existing) return;
      const updated = { ...existing, model, reasoningEffort, updatedAt: nowIso() };
      const persisted = await mutation.persist(() => this.database.putThread(updated));
      if (!persisted || !mutation.isLive()) return;
      this.state.threads = this.state.threads.map((thread) => thread.id === threadId ? updated : thread);
    });
    if (mutationResult !== "committed" || this.unloading) return;
    this.refreshViews({ preserveScroll: true });
  }

  async switchThread(threadId: string): Promise<void> {
    if (!this.state.threads.some((thread) => thread.id === threadId)) return;
    const mutationResult = await this.enqueueMutation(async (mutation) => {
      const persisted = await mutation.persist(() => this.database.setMeta(this.state.activeTray, this.state.previousTray, threadId, this.state.activeLinkedContext, this.state.previousLinkedContext));
      if (!persisted || !mutation.isLive()) return;
      this.state.activeThreadId = threadId;
    });
    if (mutationResult !== "committed" || this.unloading) return;
    this.refreshViews({ preserveScroll: false });
  }

  async renameThread(threadId: string, title: string): Promise<void> {
    const mutationResult = await this.enqueueMutation(async (mutation) => {
      const existing = this.state.threads.find((candidate) => candidate.id === threadId);
      if (!existing) return;
      const thread = { ...existing, title, updatedAt: nowIso() };
      const persisted = await mutation.persist(() => this.database.putThread(thread));
      if (!persisted || !mutation.isLive()) return;
      this.state.threads = this.state.threads.map((candidate) => candidate.id === threadId ? thread : candidate);
    });
    if (mutationResult !== "committed" || this.unloading) return;
    this.refreshViews();
  }

  async deleteThread(threadId: string): Promise<void> {
    if (this.state.threads.length <= 1) return void new Notice("Keep at least one synthesis thread.");
    const mutationResult = await this.enqueueMutation(async (mutation) => {
      const remainingThreads = this.state.threads.filter((thread) => thread.id !== threadId);
      const nextActiveThreadId = this.state.activeThreadId === threadId ? remainingThreads[0].id : this.state.activeThreadId;
      const persisted = await mutation.persist(async () => {
        await this.database.deleteThread(threadId);
        await this.database.setMeta(this.state.activeTray, this.state.previousTray, nextActiveThreadId, this.state.activeLinkedContext, this.state.previousLinkedContext);
      });
      if (!persisted || !mutation.isLive()) return;
      this.state.threads = remainingThreads;
      this.state.messages = this.state.messages.filter((message) => message.threadId !== threadId);
      const turnIds = new Set(this.state.turns.filter((turn) => turn.threadId === threadId).map((turn) => turn.id));
      this.state.turns = this.state.turns.filter((turn) => turn.threadId !== threadId);
      this.state.turnUsage = this.state.turnUsage.filter((usage) => !turnIds.has(usage.turnId));
      this.conversationRevision += 1;
      this.state.sourceSnapshots = this.state.sourceSnapshots.filter((source) => !turnIds.has(source.turnId));
      this.state.activeThreadId = nextActiveThreadId;
    });
    if (mutationResult !== "committed" || this.unloading) return;
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
