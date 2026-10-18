import { escapeRegExp, fold, type Folded, originalSpan, termPattern, wordPattern } from "./normalize.ts";

export const KINDS = ["commit", "issue", "pr", "comment", "review"] as const;
export type Kind = (typeof KINDS)[number];

export type Category =
  | "home path"
  | "temp folder"
  | "account name"
  | "machine name"
  | "email"
  | "money"
  | "private term";

// Who is running the check, on which machine. The CLI reads it from the OS; tests make it up.
export interface Identity {
  user: string;
  home: string;
  host: string;
  tempDirs: string[];
}

export interface Rules {
  terms: string[];
  allowedWords: string[];
  allowedEmails: string[];
  allowedPaths: string[];
}

export interface CheckOptions {
  kind?: Kind;
  identity: Identity;
  rules: Rules;
}

export interface Finding {
  category: Category;
  // The money word that matched, as `allowed_words` names it.
  word?: string;
  line: number;
  column: number;
  text: string;
  start: number;
  end: number;
}

interface Span {
  category: Category;
  word?: string;
  start: number;
  end: number;
}

export const DEFAULT_ALLOWED_EMAILS = [
  "*@users.noreply.github.com",
  "noreply@github.com",
  "git@github.com",
  "noreply@*",
  "no-reply@*",
  "*@users.noreply.gitlab.com",
  "*@example.com",
  "*@example.org",
  "*@example.net",
  "*@*.example",
  "*@*.test",
  "*@*.invalid",
];

// Generic places under the home folder that say nothing about the person.
export const DEFAULT_ALLOWED_PATHS = [
  "~/.config",
  "~/.local",
  "~/.cache",
  "~/.ssh",
  "~/.gitconfig",
  "~/.npmrc",
  "~/.bashrc",
  "~/.bash_profile",
  "~/.zshrc",
  "~/.profile",
];

// Account and machine names too generic to flag.
const GENERIC_NAMES = new Set([
  "admin", "app", "dev", "ec2-user", "guest", "localhost", "node", "nobody", "root", "runner", "ubuntu", "user",
  "vagrant",
]);

const TEMP_FOLDERS = ["/tmp", "/var/tmp", "/private/tmp", "/var/folders", "/private/var/folders"];

// Money and accounts, over folded text. Each entry is [word, pattern]; `allowed_words` switches off a word.
// A word that's also ordinary dev language (plan, tier, budget, quota) counts only beside a money word.
const MONEY: [string, string][] = [
  ["billing", "billing|billed"],
  ["invoice", "invoices?|invoiced"],
  ["payment", "payments?|(?:pay|paid|paying) for|pay as you go|pay-as-you-go"],
  ["subscription", "subscriptions?"],
  [
    "spending",
    "spend(?:ing)? (?:limits?|caps?|alerts?)|spending money" +
      "|(?:my|our|their|monthly|annual|yearly|personal|household|cloud) spending",
  ],
  ["budget", "(?:my|our|monthly|annual|yearly|weekly|personal|household|money|cash|spending) budgets?"],
  [
    "plan",
    "(?:free|paid|pro|max|plus|team|business|enterprise|premium|pricing|billing|monthly|annual|yearly) plans?" +
      "|(?:upgrade|downgrade|cancel|change)(?:s|d|ed|ing|led|ling)? (?:my|our|the|your|a|their) plan",
  ],
  ["tier", "(?:free|paid|pro|premium) tiers?"],
  ["pricing", "pricing"],
  [
    "usage limit",
    "usage (?:limits?|caps?|quotas?)|overage (?:charges?|fees?|costs?|pricing)" +
      "|(?:billing|plan|paid|subscription|account) quotas?",
  ],
  ["card", "credit cards?|debit cards?|bank accounts?|bank statements?"],
  ["refund", "refunds?|refunded|chargebacks?"],
  ["trial", "free trials?|trial period"],
];

// Amounts of money. A "$" before a single digit is left alone, since "$1" is usually a shell argument.
const AMOUNT =
  /(?<![\p{L}\p{N}$])(?:\$\s?(?:\d{1,3}(?:,\d{3})+|\d{2,}|\d(?=[.,]\d|\s?(?:k|m|bn)(?![\p{L}])|\s?(?:\/|a |per )))|[€£¥₹]\s?\d)[\d,]*(?:\.\d+)?(?:\s?(?:k|m|bn)(?![\p{L}]))?|(?<![\p{L}\p{N}.])\d[\d,]*(?:\.\d+)?\s?(?:usd|eur|gbp|dollars?|euros?|bucks)(?![\p{L}])/gu;

const EMAIL = /(?<![\p{L}\p{N}._%+-])[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.\p{L}{2,}(?![\p{L}\p{N}-])/gu;

const PATH_TAIL = "[^\\s'\"`<>()\\[\\]{}|,;]*";
const TRAILING_PUNCTUATION = /[.,:;!?]+$/;

export function check(input: string, options: CheckOptions): Finding[] {
  const { identity, rules } = options;
  const folded = fold(input);
  const allowedWords = new Set(rules.allowedWords.map((w) => collapse(fold(w).text)));
  const allowedPaths = [...DEFAULT_ALLOWED_PATHS, ...rules.allowedPaths].map(canonicalPath);
  const allowedEmails = [...DEFAULT_ALLOWED_EMAILS, ...rules.allowedEmails].map(globPattern);

  const spans: Span[] = [];
  // Text that's fine to post: an allowed email or path. A name or word inside it isn't a finding either.
  const allowed: [number, number][] = [];

  for (const prefix of homePrefixes(identity)) {
    const re = new RegExp(`(?<![\\w.-])${escapeRegExp(prefix)}(?![\\w.-])${PATH_TAIL}`, "gi");
    for (const m of input.matchAll(re)) spans.push(pathSpan("home path", m));
  }

  const tilde = new RegExp(`(?<![\\w~/.$-])(?:~|\\$HOME|\\$\\{HOME\\}|%USERPROFILE%)([\\\\/]${PATH_TAIL})`, "g");
  for (const m of input.matchAll(tilde)) {
    const span = pathSpan("home path", m);
    const path = canonicalPath("~" + input.slice(m.index + m[0].length - m[1]!.length, span.end));
    if (path === "~" || isAllowedPath(path, allowedPaths)) allowed.push([span.start, span.end]);
    else spans.push(span);
  }

  const temps = [...TEMP_FOLDERS, ...identity.tempDirs.map(trimSlash).filter((d) => d.length > 1)];
  for (const prefix of new Set(temps)) {
    const re = new RegExp(`(?<![\\w.~/$%-])${escapeRegExp(prefix)}(?![\\w.-])${PATH_TAIL}`, "g");
    for (const m of input.matchAll(re)) {
      const span = pathSpan("temp folder", m);
      if (isAllowedPath(canonicalPath(input.slice(span.start, span.end)), allowedPaths)) {
        allowed.push([span.start, span.end]);
      } else spans.push(span);
    }
  }

  for (const m of input.matchAll(EMAIL)) {
    const email = m[0].toLowerCase();
    const span: Span = { category: "email", start: m.index, end: m.index + m[0].length };
    if (allowedEmails.some((re) => re.test(email))) allowed.push([span.start, span.end]);
    else spans.push(span);
  }

  const names: [Category, string][] = [
    ["account name", identity.user],
    ["machine name", identity.host.split(".")[0] ?? ""],
  ];
  for (const [category, name] of names) {
    if (name.length < 3 || GENERIC_NAMES.has(name.toLowerCase())) continue;
    const re = termPattern(name);
    if (re) spans.push(...foldedSpans(folded, re, category, allowedWords));
  }

  for (const [word, source] of MONEY) {
    if (allowedWords.has(word)) continue;
    spans.push(...foldedSpans(folded, wordPattern(source), "money", allowedWords, word));
  }
  if (!allowedWords.has("amounts")) spans.push(...foldedSpans(folded, AMOUNT, "money", allowedWords, "amounts"));

  const shown = outsideAllowed(spans, allowed);

  // Private terms are never allowed, wherever they appear.
  shown.push(...termSpans(folded, rules.terms));

  return toFindings(input, outermost(shown));
}

// Only the private terms, for text whose other findings are the repository's own business, such as an exempt
// file's added lines. A term inside a path or an email is found here, where check reports the wider span.
export function checkTerms(input: string, terms: string[]): Finding[] {
  return toFindings(input, outermost(termSpans(fold(input), terms)));
}

function termSpans(folded: Folded, terms: string[]): Span[] {
  return terms.flatMap((term) => {
    const re = termPattern(term);
    return re ? foldedSpans(folded, re, "private term") : [];
  });
}

// An allowed path that takes in the whole home folder or a whole temp folder, which leaves that check nothing to do:
// "~" in any spelling, a temp folder's root, or a folder above one, such as "/var".
export function isBlanketPath(path: string): boolean {
  const allowed = [canonicalPath(path)];
  return ["~", ...TEMP_FOLDERS].some((root) => isAllowedPath(root, allowed));
}

// An allowed email pattern with no fixed domain: "*@*", "someone@*", "*@*.com". The domain must be written out,
// or be "*." and then one with a dot in it, as in "*@*.example.org". A pattern with no "@" matches no email.
export function isBlanketEmail(glob: string): boolean {
  const at = glob.lastIndexOf("@");
  if (at < 0) return false;
  const domain = glob.slice(at + 1);
  return domain.includes("*") && !/^\*\.[^*.]+(?:\.[^*.]+)+$/.test(domain);
}

function homePrefixes(identity: Identity): Set<string> {
  const prefixes = new Set<string>();
  const home = trimSlash(identity.home);
  if (home.length > 1) {
    prefixes.add(home);
    prefixes.add(home.replaceAll("\\", "/"));
  }
  if (identity.user) {
    for (const p of ["/Users/", "/home/", "C:\\Users\\", "C:/Users/"]) prefixes.add(p + identity.user);
  }
  return prefixes;
}

function pathSpan(category: Category, m: RegExpExecArray | RegExpMatchArray): Span {
  const text = m[0].replace(TRAILING_PUNCTUATION, "");
  return { category, start: m.index!, end: m.index! + text.length };
}

function foldedSpans(folded: Folded, re: RegExp, category: Category, allowed?: Set<string>, word?: string): Span[] {
  const spans: Span[] = [];
  for (const m of folded.text.matchAll(re)) {
    if (m[0].length === 0) continue;
    if (allowed?.has(collapse(m[0]))) continue;
    const [start, end] = originalSpan(folded, m.index, m.index + m[0].length);
    spans.push(word === undefined ? { category, start, end } : { category, word, start, end });
  }
  return spans;
}

// Keeps a span only when no other span contains it, so a path isn't also reported for the account name in it.
function outermost(spans: Span[]): Span[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start || b.end - a.end);
  const kept: Span[] = [];
  let reach = -1;
  for (const s of sorted) {
    if (s.end <= reach) continue;
    kept.push(s);
    reach = s.end;
  }
  return kept;
}

function outsideAllowed(spans: Span[], allowed: [number, number][]): Span[] {
  if (allowed.length === 0) return spans;
  const sortedAllowed = [...allowed].sort((a, b) => a[0] - b[0]);
  const kept: Span[] = [];
  let next = 0;
  let reach = -1;
  for (const s of [...spans].sort((a, b) => a.start - b.start)) {
    while (next < sortedAllowed.length && sortedAllowed[next]![0] <= s.start) {
      reach = Math.max(reach, sortedAllowed[next]![1]);
      next++;
    }
    if (s.end > reach) kept.push(s);
  }
  return kept;
}

// Spans arrive sorted by start, so line and column are counted in one pass over the input.
function toFindings(input: string, spans: Span[]): Finding[] {
  let i = 0;
  let line = 1;
  let column = 1;
  return spans.map((s) => {
    while (i < s.start) {
      const code = input.codePointAt(i)!;
      if (code === 0x0a) {
        line++;
        column = 1;
      } else column++;
      i += code > 0xffff ? 2 : 1;
    }
    const finding: Finding = {
      category: s.category,
      line,
      column,
      text: input.slice(s.start, s.end),
      start: s.start,
      end: s.end,
    };
    if (s.word !== undefined) finding.word = s.word;
    return finding;
  });
}

function canonicalPath(path: string): string {
  const p = path
    .replaceAll("\\", "/")
    .replace(/^(?:\$HOME|\$\{HOME\}|%USERPROFILE%)(?=\/|$)/, "~");
  return trimSlash(p);
}

function isAllowedPath(path: string, allowed: string[]): boolean {
  return allowed.some((a) => path === a || path.startsWith(a + "/"));
}

function globPattern(glob: string): RegExp {
  const source = glob.toLowerCase().split("*").map(escapeRegExp).join("[^@\\s]*");
  return new RegExp(`^${source}$`, "u");
}

function trimSlash(path: string): string {
  return path.length > 1 ? path.replace(/[\\/]+$/, "") : path;
}

function collapse(s: string): string {
  return s.trim().replace(/\s+/g, " ");
}
