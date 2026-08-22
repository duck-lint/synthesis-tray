export interface CitationReference {
  sourceIndex: number;
  lineStart: number | null;
  lineEnd: number | null;
  raw: string;
}

const CITATION_PATTERN = /\[S(\d+)(?::L(\d+)(?:-L?(\d+))?)?\]/g;

export function parseCitationReferences(text: string): CitationReference[] {
  return [...text.matchAll(CITATION_PATTERN)].map((match) => ({
    sourceIndex: Number(match[1]),
    lineStart: match[2] ? Number(match[2]) : null,
    lineEnd: match[3] ? Number(match[3]) : match[2] ? Number(match[2]) : null,
    raw: match[0],
  }));
}

export function citationContextIsEligible(ancestorNames: string[]): boolean {
  const excluded = new Set(["PRE", "CODE", "A", "BUTTON"]);
  return !ancestorNames.some((name) => excluded.has(name.toUpperCase()));
}

/** Decorate only plain rendered text; code, links, and existing controls stay inert. */
export function decorateRenderedCitations(root: HTMLElement, onCitation: (citation: CitationReference) => void): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  let current: Node | null;
  while ((current = walker.nextNode())) textNodes.push(current as Text);

  for (const textNode of textNodes) {
    const parent = textNode.parentElement;
    if (!parent || parent.closest(".synthesis-citation")) continue;
    const ancestors: string[] = [];
    let ancestor: HTMLElement | null = parent;
    while (ancestor) {
      ancestors.push(ancestor.tagName);
      ancestor = ancestor.parentElement;
    }
    if (!citationContextIsEligible(ancestors)) continue;
    const text = textNode.nodeValue ?? "";
    const matches = [...text.matchAll(CITATION_PATTERN)];
    if (matches.length === 0) continue;
    const fragment = document.createDocumentFragment();
    let cursor = 0;
    for (const match of matches) {
      const start = match.index ?? 0;
      if (start > cursor) fragment.append(document.createTextNode(text.slice(cursor, start)));
      const citation = parseCitationReferences(match[0])[0];
      const button = document.createElement("button");
      button.type = "button";
      button.className = "synthesis-citation";
      button.textContent = citation.raw;
      button.setAttribute("aria-label", citation.lineStart === null
        ? `Inspect source S${citation.sourceIndex}`
        : `Inspect source S${citation.sourceIndex}, lines ${citation.lineStart} through ${citation.lineEnd}`);
      button.addEventListener("click", () => onCitation(citation));
      fragment.append(button);
      cursor = start + match[0].length;
    }
    if (cursor < text.length) fragment.append(document.createTextNode(text.slice(cursor)));
    textNode.replaceWith(fragment);
  }
}
