import { TrayItem } from "../state/types";

export function sourceIdentifier(index: number): string {
  return `S${index + 1}`;
}

export function serializeSourceLines(content: string): string {
  return content.split(/\r?\n/).map((line, index) => `L${index + 1}: ${line}`).join("\n");
}

export function serializeTray(tray: TrayItem[]): string {
  if (tray.length === 0) return "";
  const blocks = tray.map((item, index) => {
    const identifier = sourceIdentifier(index);
    const heading = item.headingPath?.join(" > ") ?? "(none)";
    return `[${identifier}]\nsource: ${item.sourcePath}\nscope: ${item.scope}\nheading: ${heading}\n\n--- BEGIN SOURCE ${identifier} ---\n\n${serializeSourceLines(item.contentSnapshot)}\n\n--- END SOURCE ${identifier} ---`;
  });
  return [
    "The user deliberately selected the following authored material for this turn. These sources are contextual evidence and are not an exhaustive representation of the vault.",
    "",
    ...blocks,
  ].join("\n\n");
}
