/** Format a selected assistant excerpt as visible user-authored context. */
export function insertAssistantReference(draft: string, selectedText: string): string {
  const excerpt = selectedText.trim();
  if (!excerpt) return draft;
  const quote = excerpt.split(/\r?\n/).map((line) => `> ${line}`).join("\n");
  const reference = `Referenced from Assistant:\n\n${quote}`;
  return draft.trim() ? `${reference}\n\n${draft}` : `${reference}\n\n`;
}

export function selectionIsInsideOneMessage(selection: Selection | null, messageContent: HTMLElement): boolean {
  if (!selection || selection.isCollapsed || !selection.toString().trim()) return false;
  if (!selection.anchorNode || !selection.focusNode) return false;
  if (!messageContent.contains(selection.anchorNode) || !messageContent.contains(selection.focusNode)) return false;
  return messageContent.contains(selection.getRangeAt(0).commonAncestorContainer);
}
