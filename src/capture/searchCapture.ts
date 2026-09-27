import { CaptureGroup, TrayItem } from "../state/types";
import { addTrayItem, trayIdentity } from "../state/tray";
import { captureWholeNote } from "./capture";

export interface SearchCaptureFile { path: string; extension: string; }
export interface SearchCaptureVault {
  getAbstractFileByPath(path: string): unknown;
  read(file: unknown): Promise<string>;
}

export interface SearchPreparationProgress { completed: number; total: number; phase: "preparing" | "validating"; }
export interface PreparedSearchCapture {
  group: CaptureGroup;
  /** Every distinct eligible file read during preparation, including exact duplicates. */
  selectedItems: TrayItem[];
  /** The subset of selectedItems that is new to the active tray. */
  items: TrayItem[];
  duplicateCount: number;
  progress: SearchPreparationProgress;
}

export type SearchPreparationResult =
  | { ok: true; prepared: PreparedSearchCapture }
  | { ok: false; reason: "cancelled" | "missing-file" | "ineligible-file" | "read-failed" | "changed-content"; paths: string[]; detail: string };

type VaultReadResult =
  | { kind: "content"; content: string }
  | { kind: "cancelled" }
  | { kind: "failed"; error: unknown };

/**
 * Settles the operation when its signal aborts, while still observing the
 * underlying read so a later rejection cannot become an unhandled rejection.
 * Obsidian's vault read is not claimed to be platform-cancellable here.
 */
async function readVaultContent(vault: SearchCaptureVault, file: unknown, signal?: AbortSignal): Promise<VaultReadResult> {
  if (signal?.aborted) return { kind: "cancelled" };

  let readPromise: Promise<string>;
  try {
    readPromise = Promise.resolve(vault.read(file));
  } catch (error) {
    return { kind: "failed", error };
  }

  return new Promise<VaultReadResult>((resolve) => {
    let settled = false;
    const settle = (result: VaultReadResult): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const onAbort = (): void => settle({ kind: "cancelled" });

    signal?.addEventListener("abort", onAbort, { once: true });
    // Both handlers are attached before waiting on the operation signal. A
    // late result is intentionally consumed but cannot publish into capture.
    readPromise.then(
      (content) => settle({ kind: "content", content }),
      (error) => settle({ kind: "failed", error }),
    );
    if (signal?.aborted) onAbort();
  });
}

export async function validatePreparedSearchSources(vault: SearchCaptureVault, items: TrayItem[], signal?: AbortSignal): Promise<SearchPreparationResult | null> {
  for (const item of items) {
    if (signal?.aborted) return { ok: false, reason: "cancelled", paths: [], detail: "Search capture validation was cancelled." };
    const file = vault.getAbstractFileByPath(item.sourcePath);
    if (!isMarkdownFile(file) || file.path !== item.sourcePath) return { ok: false, reason: file ? "ineligible-file" : "missing-file", paths: [item.sourcePath], detail: `Search source changed before commit: ${item.sourcePath}` };
    const read = await readVaultContent(vault, file, signal);
    if (read.kind === "cancelled") return { ok: false, reason: "cancelled", paths: [], detail: "Search capture validation was cancelled." };
    if (read.kind === "failed") return { ok: false, reason: "read-failed", paths: [item.sourcePath], detail: read.error instanceof Error ? read.error.message : `Could not read ${item.sourcePath}` };
    const content = read.content;
    if (content !== item.contentSnapshot) return { ok: false, reason: "changed-content", paths: [item.sourcePath], detail: `Search source content changed before commit: ${item.sourcePath}` };
  }
  return null;
}

function isMarkdownFile(value: unknown): value is SearchCaptureFile {
  return Boolean(value && typeof value === "object" && typeof (value as SearchCaptureFile).path === "string" && typeof (value as SearchCaptureFile).extension === "string" && (value as SearchCaptureFile).extension.toLowerCase() === "md");
}

export async function prepareSearchCapture(
  vault: SearchCaptureVault,
  paths: string[],
  existingTray: TrayItem[],
  group: CaptureGroup,
  onProgress: (progress: SearchPreparationProgress) => void = () => undefined,
  signal?: AbortSignal,
  concurrency = 4,
): Promise<SearchPreparationResult> {
  const orderedPaths = [...new Set(paths)].sort((a, b) => a.localeCompare(b));
  if (signal?.aborted) return { ok: false, reason: "cancelled", paths: [], detail: "Search capture preparation was cancelled." };
  const selectedItems: TrayItem[] = [];
  const prepared: TrayItem[] = [];
  const duplicateIdentities = new Set(existingTray.map((item) => trayIdentity(item)));
  let cursor = 0;
  let failure: SearchPreparationResult | null = null;
  const preparationController = new AbortController();
  const abortPreparation = (): void => {
    if (!preparationController.signal.aborted) preparationController.abort();
  };
  const forwardAbort = (): void => abortPreparation();
  signal?.addEventListener("abort", forwardAbort, { once: true });
  if (signal?.aborted) abortPreparation();
  const preparationSignal = preparationController.signal;
  const recordFailure = (result: SearchPreparationResult): void => {
    if (failure !== null) return;
    failure = result;
    // Release sibling workers that may be waiting on unabortable reads. Their
    // late settlements are observed by readVaultContent and are discarded.
    abortPreparation();
  };
  onProgress({ completed: 0, total: orderedPaths.length, phase: "preparing" });
  const worker = async (): Promise<void> => {
    while (failure === null && !preparationSignal.aborted) {
      const index = cursor++;
      if (index >= orderedPaths.length) return;
      const path = orderedPaths[index];
      const file = vault.getAbstractFileByPath(path);
      if (!isMarkdownFile(file) || file.path !== path) { recordFailure({ ok: false, reason: file ? "ineligible-file" : "missing-file", paths: [path], detail: `Search source is no longer eligible: ${path}` }); return; }
      const read = await readVaultContent(vault, file, preparationSignal);
      if (read.kind === "cancelled") {
        if (failure === null && signal?.aborted) recordFailure({ ok: false, reason: "cancelled", paths: [], detail: "Search capture preparation was cancelled." });
        return;
      }
      if (read.kind === "failed") { recordFailure({ ok: false, reason: "read-failed", paths: [path], detail: read.error instanceof Error ? read.error.message : `Could not read ${path}` }); return; }
      if (failure !== null || preparationSignal.aborted) return;
      const content = read.content;
      const item = captureWholeNote(path, content);
      selectedItems.push(item);
      if (!duplicateIdentities.has(trayIdentity(item)) && !prepared.some((candidate) => trayIdentity(candidate) === trayIdentity(item))) prepared.push(item);
      onProgress({ completed: Math.min(index + 1, orderedPaths.length), total: orderedPaths.length, phase: "preparing" });
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, orderedPaths.length || 1)) }, () => worker()));
  } finally {
    signal?.removeEventListener("abort", forwardAbort);
  }
  if (failure) return failure;
  if (signal?.aborted) return { ok: false, reason: "cancelled", paths: [], detail: "Search capture preparation was cancelled." };
  selectedItems.sort((a, b) => a.sourcePath.localeCompare(b.sourcePath));
  prepared.sort((a, b) => a.sourcePath.localeCompare(b.sourcePath));
  onProgress({ completed: orderedPaths.length, total: orderedPaths.length, phase: "validating" });
  const withGroup = (item: TrayItem): TrayItem => ({ ...item, captureGroup: { ...group } });
  return { ok: true, prepared: { group, selectedItems: selectedItems.map(withGroup), items: prepared.map(withGroup), duplicateCount: selectedItems.length - prepared.length, progress: { completed: orderedPaths.length, total: orderedPaths.length, phase: "validating" } } };
}

/** Applies the same identity rule as the eventual commit without mutating live tray state. */
export function stageSearchItems(existingTray: TrayItem[], items: TrayItem[]): { tray: TrayItem[]; added: TrayItem[]; duplicateCount: number } {
  let tray = existingTray;
  const added: TrayItem[] = [];
  for (const item of items) {
    const result = addTrayItem(tray, item);
    if (result.duplicate) continue;
    tray = result.tray;
    added.push(item);
  }
  return { tray, added, duplicateCount: items.length - added.length };
}
