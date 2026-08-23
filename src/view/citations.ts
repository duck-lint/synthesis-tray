export interface CitationReference {
  sourceIndex: number;
  lineStart: number | null;
  lineEnd: number | null;
  raw: string;
}

const CITATION_TOKEN_PATTERN = /\[([^\]\r\n]+)\]/g;
const CITATION_ATOM_PATTERN = /^S(\d+)(?::L(\d+)(?:-L?(\d+))?)?$/;

function parseCitationAtom(atom: string): CitationReference | null {
  const match = atom.trim().match(CITATION_ATOM_PATTERN);
  if (!match) return null;
  return {
    sourceIndex: Number(match[1]),
    lineStart: match[2] ? Number(match[2]) : null,
    lineEnd: match[3] ? Number(match[3]) : match[2] ? Number(match[2]) : null,
    raw: `[${atom.trim()}]`,
  };
}

/** Parse one bracketed citation token, including semicolon-grouped references. */
function parseCitationToken(raw: string): CitationReference[] {
  const body = raw.match(/^\[([^\]\r\n]+)\]$/)?.[1];
  if (!body) return [];
  const atoms = body.split(";").map((atom) => atom.trim());
  const references = atoms.map(parseCitationAtom);
  return references.every((reference): reference is CitationReference => reference !== null) ? references : [];
}

export function parseCitationReferences(text: string): CitationReference[] {
  return [...text.matchAll(CITATION_TOKEN_PATTERN)].flatMap((match) => parseCitationToken(match[0]));
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
    const matches = [...text.matchAll(CITATION_TOKEN_PATTERN)]
      .map((match) => ({ match, references: parseCitationToken(match[0]) }))
      .filter(({ references }) => references.length > 0);
    if (matches.length === 0) continue;
    const fragment = document.createDocumentFragment();
    let cursor = 0;
    for (const { match, references } of matches) {
      const start = match.index ?? 0;
      if (start > cursor) fragment.append(document.createTextNode(text.slice(cursor, start)));
      const grouped = references.length > 1;
      if (grouped) fragment.append(document.createTextNode("["));
      references.forEach((citation, index) => {
        if (index > 0) fragment.append(document.createTextNode("; "));
        const button = document.createElement("button");
        button.type = "button";
        button.className = "synthesis-citation";
        button.textContent = grouped ? citation.raw.slice(1, -1) : citation.raw;
        button.setAttribute("aria-label", citation.lineStart === null
          ? `Inspect source S${citation.sourceIndex}`
          : `Inspect source S${citation.sourceIndex}, lines ${citation.lineStart} through ${citation.lineEnd}`);
        button.addEventListener("click", () => onCitation(citation));
        fragment.append(button);
      });
      if (grouped) fragment.append(document.createTextNode("]"));
      cursor = start + match[0].length;
    }
    if (cursor < text.length) fragment.append(document.createTextNode(text.slice(cursor)));
    textNode.replaceWith(fragment);
  }
}
