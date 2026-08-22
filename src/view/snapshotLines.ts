export interface SnapshotLine {
  number: number;
  text: string;
}

export function snapshotLines(content: string): SnapshotLine[] {
  return content.split(/\r?\n/).map((text, index) => ({ number: index + 1, text }));
}
