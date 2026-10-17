// Text is folded before matching, so a term still matches when it's written in another case, with accents,
// in fullwidth or other compatibility forms, or with invisible characters inside it.

export interface Folded {
  text: string;
  // For each code unit of `text`, the range of the original character it came from.
  starts: number[];
  ends: number[];
}

const MARKS = /[\p{M}\p{Cf}]/gu;

export function foldChar(ch: string): string {
  return ch.normalize("NFKD").toLowerCase().normalize("NFKD").replace(MARKS, "");
}

export function fold(input: string): Folded {
  let text = "";
  const starts: number[] = [];
  const ends: number[] = [];
  let i = 0;
  for (const ch of input) {
    const folded = foldChar(ch);
    for (let k = 0; k < folded.length; k++) {
      starts.push(i);
      ends.push(i + ch.length);
    }
    text += folded;
    i += ch.length;
  }
  return { text, starts, ends };
}

// Maps a span of folded text back to the span of the original it was folded from.
export function originalSpan(folded: Folded, start: number, end: number): [number, number] {
  return [folded.starts[start]!, folded.ends[end - 1]!];
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

const PART_SEPARATOR = "[^\\p{L}\\p{N}]{0,3}";
const BEFORE = "(?<![\\p{L}\\p{N}])";
const AFTER = "(?![\\p{L}\\p{N}])";

// A term matches at word boundaries in folded text. Its words may be joined by spaces, hyphens, dots,
// underscores or nothing, so "Example Project" also matches "example-project" and "ExampleProject".
export function termPattern(term: string): RegExp | null {
  const parts = fold(term).text.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (parts.length === 0) return null;
  return new RegExp(BEFORE + parts.map(escapeRegExp).join(PART_SEPARATOR) + AFTER, "gu");
}

// A pattern over folded text, matched at word boundaries. A space in `source` matches any run of whitespace.
export function wordPattern(source: string): RegExp {
  return new RegExp(BEFORE + "(?:" + source.replaceAll(" ", "\\s+") + ")" + AFTER, "gu");
}
