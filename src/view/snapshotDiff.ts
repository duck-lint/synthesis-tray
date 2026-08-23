export type SnapshotDiffKind = "context" | "added" | "removed";

export interface SnapshotDiffLine {
  kind: SnapshotDiffKind;
  text: string;
  oldLine: number | null;
  newLine: number | null;
}

export interface SnapshotDiffResult {
  lines: SnapshotDiffLine[];
  boundedFallback: boolean;
  displayTruncated: boolean;
}

function contentLines(content: string): string[] {
  return content.length === 0 ? [] : content.split(/\r?\n/);
}

function limitDiffLines(lines: SnapshotDiffLine[], maxLines = 4_000): SnapshotDiffLine[] {
  if (lines.length <= maxLines) return lines;
  const head = Math.floor(maxLines / 2);
  const tail = maxLines - head - 1;
  return [
    ...lines.slice(0, head),
    { kind: "context", text: `… ${lines.length - head - tail} diff lines omitted for display …`, oldLine: null, newLine: null },
    ...lines.slice(-tail),
  ];
}

function boundedDiff(oldLines: string[], newLines: string[]): SnapshotDiffLine[] {
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < oldLines.length - prefix && suffix < newLines.length - prefix && oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]) suffix += 1;
  const lines: SnapshotDiffLine[] = [];
  for (let index = 0; index < prefix; index += 1) lines.push({ kind: "context", text: oldLines[index], oldLine: index + 1, newLine: index + 1 });
  for (let index = prefix; index < oldLines.length - suffix; index += 1) lines.push({ kind: "removed", text: oldLines[index], oldLine: index + 1, newLine: null });
  for (let index = prefix; index < newLines.length - suffix; index += 1) lines.push({ kind: "added", text: newLines[index], oldLine: null, newLine: index + 1 });
  for (let index = suffix; index > 0; index -= 1) {
    const oldLine = oldLines.length - index + 1;
    const newLine = newLines.length - index + 1;
    lines.push({ kind: "context", text: oldLines[oldLine - 1], oldLine, newLine });
  }
  return limitDiffLines(lines);
}

/** Line-oriented LCS diff with a bounded fallback for pathological inputs. */
export function diffSnapshotLines(oldContent: string, newContent: string, maxCells = 2_000_000): SnapshotDiffResult {
  const oldLines = contentLines(oldContent);
  const newLines = contentLines(newContent);
  if (oldLines.length === 0 || newLines.length === 0) {
    const lines = oldLines.length === 0
      ? newLines.map((text, index) => ({ kind: "added" as const, text, oldLine: null, newLine: index + 1 }))
      : oldLines.map((text, index) => ({ kind: "removed" as const, text, oldLine: index + 1, newLine: null }));
    const limited = limitDiffLines(lines);
    return { lines: limited, boundedFallback: false, displayTruncated: limited.length !== lines.length };
  }
  if (oldLines.length * newLines.length > maxCells) {
    const lines = boundedDiff(oldLines, newLines);
    return { lines, boundedFallback: true, displayTruncated: lines.some((line) => line.text.includes("diff lines omitted for display")) };
  }
  const table = Array.from({ length: oldLines.length + 1 }, () => new Uint32Array(newLines.length + 1));
  for (let oldIndex = oldLines.length - 1; oldIndex >= 0; oldIndex -= 1) {
    for (let newIndex = newLines.length - 1; newIndex >= 0; newIndex -= 1) {
      table[oldIndex][newIndex] = oldLines[oldIndex] === newLines[newIndex]
        ? table[oldIndex + 1][newIndex + 1] + 1
        : Math.max(table[oldIndex + 1][newIndex], table[oldIndex][newIndex + 1]);
    }
  }
  const lines: SnapshotDiffLine[] = [];
  let oldIndex = 0;
  let newIndex = 0;
  while (oldIndex < oldLines.length && newIndex < newLines.length) {
    if (oldLines[oldIndex] === newLines[newIndex]) {
      lines.push({ kind: "context", text: oldLines[oldIndex], oldLine: oldIndex + 1, newLine: newIndex + 1 });
      oldIndex += 1;
      newIndex += 1;
    } else if (table[oldIndex + 1][newIndex] >= table[oldIndex][newIndex + 1]) {
      lines.push({ kind: "removed", text: oldLines[oldIndex], oldLine: oldIndex + 1, newLine: null });
      oldIndex += 1;
    } else {
      lines.push({ kind: "added", text: newLines[newIndex], oldLine: null, newLine: newIndex + 1 });
      newIndex += 1;
    }
  }
  while (oldIndex < oldLines.length) lines.push({ kind: "removed", text: oldLines[oldIndex], oldLine: oldIndex + 1, newLine: null }), oldIndex += 1;
  while (newIndex < newLines.length) lines.push({ kind: "added", text: newLines[newIndex], oldLine: null, newLine: newIndex + 1 }), newIndex += 1;
  const limited = limitDiffLines(lines);
  return { lines: limited, boundedFallback: false, displayTruncated: limited.length !== lines.length };
}
