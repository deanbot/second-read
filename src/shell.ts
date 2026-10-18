// A bash command line, split into words the way bash would split it, far enough to find what a command posts. Text
// the shell fills in only when it runs, such as $BODY or $(date), is kept as its source between UNKNOWN and
// UNKNOWN_END, so a check can refuse what it can't read.

export const UNKNOWN = "\u{E000}";
export const UNKNOWN_END = "\u{E001}";

export type Stdin = { text: string } | { file: string };

// A file a command's output goes to, by redirection.
export interface Write {
  file: string;
  append: boolean;
}

export interface SimpleCommand {
  words: string[];
  // A heredoc, a here-string, a file, or the output of the command before it in a pipe.
  stdin?: Stdin;
  writes?: Write[];
}

// Commands in the order they'd run, with subshells, lists and pipes flattened, and the commands inside $(…) and
// backticks ahead of the one they're in. A keyword such as `if` or `do` in front of a command is dropped.
export function parseShell(source: string): SimpleCommand[] {
  return new Parser(source).list(false).map(({ words, stdin, writes }) => ({
    words,
    ...(stdin ? { stdin } : {}),
    ...(writes ? { writes } : {}),
  }));
}

// The text a command prints, when it's one that only prints what it's given: cat or tee of its stdin, echo, or
// printf with a plain format.
export function output(command: SimpleCommand): string | undefined {
  const [name, ...args] = command.words;
  if ((name === "cat" && args.every((a) => a === "-")) || name === "tee") {
    return command.stdin && "text" in command.stdin ? command.stdin.text : undefined;
  }
  if (name === "echo") {
    let newline = true;
    let escapes = false;
    while (args.length > 0 && /^-[neE]+$/.test(args[0]!)) {
      const flags = args.shift()!;
      if (flags.includes("n")) newline = false;
      if (flags.includes("e")) escapes = true;
      if (flags.includes("E")) escapes = false;
    }
    const text = args.join(" ");
    return (escapes ? unescape(text) : text) + (newline ? "\n" : "");
  }
  if (name === "printf") {
    const [format, ...rest] = args;
    if (format === undefined) return undefined;
    if (rest.length === 0 && !format.includes("%")) return unescape(format);
    if (rest.length === 1 && (format === "%s" || format === "%s\\n")) return rest[0] + (format === "%s" ? "" : "\n");
  }
  return undefined;
}

export function unknown(source: string): string {
  return UNKNOWN + source + UNKNOWN_END;
}

const META = new Set([" ", "\t", "\n", ";", "&", "|", "<", ">", "(", ")"]);
const LEADING_KEYWORDS = new Set(["if", "then", "else", "elif", "do", "while", "until", "!", "{", "time"]);
const CLOSING_KEYWORDS = new Set(["fi", "done", "esac", "}"]);
const REDIRECT = /^(\d*)(<<<|<<-|<<|<>|<&|<|>>|>&|>\||>|&>>|&>)/;

interface Draft {
  words: string[];
  stdin?: Stdin;
  writes?: Write[];
  pipedFrom?: Draft;
}

interface Heredoc {
  delimiter: string;
  quoted: boolean;
  stripTabs: boolean;
  draft: Draft;
}

class Parser {
  private i = 0;
  private pending: Heredoc[] = [];
  // The commands of substitutions read since the last command ended, which run ahead of the next.
  private substituted: Draft[] = [];
  private readonly s: string;

  constructor(source: string) {
    this.s = source;
  }

  // Commands up to the end, or up to the ")" that closes a $( or ( when `nested`.
  list(nested: boolean): Draft[] {
    const s = this.s;
    const out: Draft[] = [];
    let current: Draft = { words: [] };
    const finish = () => {
      out.push(...this.substituted.splice(0));
      const words = current.words;
      while (words.length > 0 && LEADING_KEYWORDS.has(words[0]!)) words.shift();
      if (words.every((w) => CLOSING_KEYWORDS.has(w))) words.length = 0;
      if (words.length > 0 || current.stdin) out.push(current);
      current = { words: [] };
    };
    while (this.i < s.length) {
      const c = s[this.i]!;
      if (c === " " || c === "\t") {
        this.i++;
      } else if (c === "\\" && s[this.i + 1] === "\n") {
        this.i += 2;
      } else if (c === "\n") {
        this.i++;
        finish();
        this.heredocs();
      } else if (c === "#") {
        while (this.i < s.length && s[this.i] !== "\n") this.i++;
      } else if (c === ")") {
        if (nested) break;
        this.i++;
      } else if (c === "(") {
        if (s.startsWith("((", this.i)) {
          this.skipParens();
        } else if (current.words.length === 0) {
          this.i++;
          const inner = this.list(true);
          this.i++;
          out.push(...inner);
        } else {
          this.i++;
        }
      } else if ((c === "<" || c === ">") && s[this.i + 1] === "(") {
        current.words.push(this.processSubstitution());
      } else if (REDIRECT.test(s.slice(this.i, this.i + 8))) {
        this.redirect(current);
      } else if (c === ";" || c === "&" || c === "|") {
        const op = /^(&&|\|\||;;|\|&|[;&|])/.exec(s.slice(this.i, this.i + 2))![0];
        this.i += op.length;
        finish();
        const last = out[out.length - 1];
        if ((op === "|" || op === "|&") && last) current.pipedFrom = last;
      } else {
        current.words.push(this.word().text);
      }
    }
    finish();
    for (const draft of out) {
      if (draft.pipedFrom === undefined || draft.stdin) continue;
      const from = draft.pipedFrom;
      draft.stdin = { text: output(from) ?? unknown(`the output of ${from.words.join(" ")}`) };
    }
    return out;
  }

  // A redirection, with any file descriptor in front of it, as in 2>&1. A heredoc's body is read when its line ends.
  private redirect(current: Draft) {
    const m = REDIRECT.exec(this.s.slice(this.i, this.i + 8))!;
    const fd = m[1]!;
    const op = m[2]!;
    this.i += m[0].length;
    while (this.s[this.i] === " " || this.s[this.i] === "\t") this.i++;
    const target = this.word();
    if (op === "<<" || op === "<<-") {
      this.pending.push({ delimiter: target.text, quoted: target.quoted, stripTabs: op === "<<-", draft: current });
    } else if (op === "<<<") {
      current.stdin = { text: target.text + "\n" };
    } else if (op === "<" && (fd === "" || fd === "0")) {
      current.stdin = { file: target.text };
    } else if ((op === ">" || op === ">|" || op === ">>") && (fd === "" || fd === "1")) {
      (current.writes ??= []).push({ file: target.text, append: op === ">>" });
    } else if (op === "&>" || op === "&>>") {
      (current.writes ??= []).push({ file: target.text, append: op === "&>>" });
    }
  }

  // The bodies of the heredocs the line just ended opened, in order.
  private heredocs() {
    const s = this.s;
    for (const heredoc of this.pending) {
      const lines: string[] = [];
      while (this.i < s.length) {
        const end = s.indexOf("\n", this.i);
        const stop = end < 0 ? s.length : end;
        let line = s.slice(this.i, stop);
        this.i = stop + 1;
        if (heredoc.stripTabs) line = line.replace(/^\t+/, "");
        if (line === heredoc.delimiter) break;
        lines.push(line + "\n");
      }
      const body = lines.join("");
      if (heredoc.quoted) {
        heredoc.draft.stdin = { text: body };
      } else {
        const expanded = new Parser(body);
        heredoc.draft.stdin = { text: expanded.doubleQuoted(true) };
        this.substituted.push(...expanded.substituted);
      }
    }
    this.pending = [];
  }

  word(): { text: string; quoted: boolean } {
    const s = this.s;
    let text = "";
    let quoted = false;
    while (this.i < s.length) {
      const c = s[this.i]!;
      if (META.has(c)) break;
      if (c === "\\") {
        const next = s[this.i + 1];
        this.i += 2;
        if (next !== undefined && next !== "\n") text += next;
        quoted = true;
      } else if (c === "'") {
        const end = s.indexOf("'", this.i + 1);
        const stop = end < 0 ? s.length : end;
        text += s.slice(this.i + 1, stop);
        this.i = stop + 1;
        quoted = true;
      } else if (c === '"') {
        this.i++;
        text += this.doubleQuoted(false);
        quoted = true;
      } else if (c === "$" && s[this.i + 1] === "'") {
        text += this.ansiC();
        quoted = true;
      } else if (c === "$" && s[this.i + 1] === '"') {
        this.i++;
      } else if (c === "$") {
        text += this.dollar();
      } else if (c === "`") {
        text += this.backtick();
      } else {
        text += c;
        this.i++;
      }
    }
    return { text, quoted };
  }

  // The inside of "…", up to and past its closing quote. A heredoc's body reads the same way, to its end, with
  // quotes in it kept as they are.
  doubleQuoted(heredoc: boolean): string {
    const s = this.s;
    const escapable = heredoc ? "$`\\" : '$`"\\';
    let text = "";
    while (this.i < s.length) {
      const c = s[this.i]!;
      if (c === '"' && !heredoc) {
        this.i++;
        return text;
      }
      if (c === "\\" && s[this.i + 1] === "\n") {
        this.i += 2;
      } else if (c === "\\" && escapable.includes(s[this.i + 1] ?? "")) {
        text += s[this.i + 1];
        this.i += 2;
      } else if (c === "$") {
        text += this.dollar();
      } else if (c === "`") {
        text += this.backtick();
      } else {
        text += c;
        this.i++;
      }
    }
    return text;
  }

  // $name, ${…}, $((…)) and $(…). A command substitution is read when its command only prints what it's given, as
  // in "$(cat <<'EOF' … EOF)", and shell strips the newlines it ends with.
  private dollar(): string {
    const s = this.s;
    const start = this.i;
    const next = s[this.i + 1] ?? "";
    if (s.startsWith("$((", this.i)) {
      this.i++;
      this.skipParens();
      return unknown(s.slice(start, this.i));
    }
    if (next === "(") {
      this.i += 2;
      const inner = this.inner(() => this.list(true));
      if (s[this.i] === ")") this.i++;
      const text = inner.length === 1 ? output(inner[0]!) : undefined;
      return text === undefined ? unknown(s.slice(start, this.i)) : text.replace(/\n+$/, "");
    }
    if (next === "{") {
      let depth = 0;
      for (this.i++; this.i < s.length; this.i++) {
        if (s[this.i] === "{") depth++;
        if (s[this.i] === "}" && --depth === 0) break;
      }
      this.i++;
      return unknown(s.slice(start, this.i));
    }
    if (/[A-Za-z_]/.test(next)) {
      this.i++;
      while (/[A-Za-z0-9_]/.test(s[this.i] ?? "")) this.i++;
      return unknown(s.slice(start, this.i));
    }
    if (/[0-9@*#?$!-]/.test(next)) {
      this.i += 2;
      return unknown(s.slice(start, this.i));
    }
    this.i++;
    return "$";
  }

  // `…`, whose command is read with the backslashes before $, ` and \ taken out.
  private backtick(): string {
    const s = this.s;
    const start = this.i;
    let source = "";
    for (this.i++; this.i < s.length && s[this.i] !== "`"; this.i++) {
      if (s[this.i] === "\\" && "$`\\".includes(s[this.i + 1] ?? "")) this.i++;
      source += s[this.i] ?? "";
    }
    this.i++;
    this.inner(() => new Parser(source).list(false));
    return unknown(s.slice(start, this.i));
  }

  private processSubstitution(): string {
    const start = this.i;
    this.i += 2;
    this.inner(() => this.list(true));
    this.i++;
    return unknown(this.s.slice(start, this.i));
  }

  // The commands a substitution runs, kept to run ahead of the command it's in.
  private inner(read: () => Draft[]): Draft[] {
    const outer = this.substituted;
    this.substituted = [];
    const commands = read();
    this.substituted = outer;
    outer.push(...commands);
    return commands;
  }

  // From an opening "(" past the ")" that closes it.
  private skipParens() {
    let depth = 0;
    for (; this.i < this.s.length; this.i++) {
      if (this.s[this.i] === "(") depth++;
      if (this.s[this.i] === ")" && --depth === 0) break;
    }
    this.i++;
  }

  // $'…', with its backslash escapes.
  private ansiC(): string {
    const s = this.s;
    let raw = "";
    for (this.i += 2; this.i < s.length && s[this.i] !== "'"; this.i++) {
      if (s[this.i] === "\\") raw += s[this.i++];
      raw += s[this.i] ?? "";
    }
    this.i++;
    return unescape(raw);
  }
}

const ESCAPES: Record<string, string> = {
  n: "\n",
  t: "\t",
  r: "\r",
  a: "\x07",
  b: "\b",
  e: "\x1b",
  E: "\x1b",
  f: "\f",
  v: "\v",
  "\\": "\\",
  "'": "'",
  '"': '"',
  "?": "?",
};

// The backslash escapes of $'…', echo -e and printf.
function unescape(text: string): string {
  return text.replace(/\\(x[0-9A-Fa-f]{1,2}|u[0-9A-Fa-f]{1,4}|U[0-9A-Fa-f]{1,8}|0?[0-7]{1,3}|.)/gs, (all, code: string) => {
    if (/^[xuU]/.test(code)) return String.fromCodePoint(parseInt(code.slice(1), 16));
    if (/^[0-7]/.test(code)) return String.fromCodePoint(parseInt(code, 8));
    return ESCAPES[code] ?? all;
  });
}
