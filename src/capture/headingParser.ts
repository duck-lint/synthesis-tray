export interface ParsedHeading {
  level: number;
  text: string;
  path: string[];
  start: number;
  end: number;
}

interface MarkdownLine {
  text: string;
  start: number;
  end: number;
}

function linesWithOffsets(source: string): MarkdownLine[] {
  const lines: MarkdownLine[] = [];
  let start = 0;
  for (const line of source.split(/(\r?\n)/)) {
    if (line === "\n" || line === "\r\n") {
      if (lines.length > 0) lines[lines.length - 1].end = start + line.length;
      start += line.length;
      continue;
    }
    lines.push({ text: line, start, end: start + line.length });
    start += line.length;
  }
  if (source.length > 0 && lines.length > 0 && lines[lines.length - 1].end === lines[lines.length - 1].start) {
    lines[lines.length - 1].end = source.length;
  }
  return lines;
}

function headingMatch(line: string): { level: number; text: string } | null {
  const match = /^( {0,3})(#{1,6})(?:[ \t]+|$)(.*?)[ \t]*#*[ \t]*$/.exec(line);
  return match ? { level: match[2].length, text: match[3] } : null;
}

/** Parse ATX headings while ignoring fenced code blocks. */
export function parseMarkdownHeadings(source: string): ParsedHeading[] {
  const lines = linesWithOffsets(source);
  const headings: Array<Omit<ParsedHeading, "path" | "end">> = [];
  let fence: string | null = null;

  for (const line of lines) {
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(line.text);
    if (fenceMatch) {
      if (fence === null) fence = fenceMatch[1][0];
      else if (fenceMatch[1][0] === fence) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const match = headingMatch(line.text);
    if (match) headings.push({ level: match.level, text: match.text, start: line.start });
  }

  return headings.map((heading, index) => {
    const nextBoundary = headings.slice(index + 1).find((candidate) => candidate.level <= heading.level);
    const end = nextBoundary?.start ?? source.length;
    const parents = headings
      .slice(0, index)
      .filter((candidate) => candidate.level < heading.level)
      .reduce<ParsedHeading[]>((stack, candidate) => {
        while (stack.length > 0 && stack[stack.length - 1].level >= candidate.level) stack.pop();
        stack.push({ ...candidate, path: [], end: source.length });
        return stack;
      }, []);
    return {
      ...heading,
      path: [...parents.map((parent) => parent.text), heading.text],
      end,
    };
  });
}

export function headingContainingOffset(source: string, offset: number): ParsedHeading | null {
  const headings = parseMarkdownHeadings(source);
  return headings.filter((heading) => offset >= heading.start && offset < heading.end).at(-1) ?? null;
}

export function extractHeadingRegion(source: string, offset: number): { content: string; heading: ParsedHeading } | null {
  const heading = parseMarkdownHeadings(source).filter((candidate) => candidate.start <= offset && offset < candidate.end).at(-1);
  return heading ? { content: source.slice(heading.start, heading.end), heading } : null;
}
