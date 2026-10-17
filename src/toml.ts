// The small part of TOML the config files need: top-level keys set to strings, booleans or arrays of strings,
// with comments. Anything else is an error, so a file never means something other than what it says.

export type TomlValue = string | boolean | string[];

export class TomlError extends Error {
  line: number;
  constructor(message: string, line: number) {
    super(`line ${line}: ${message}`);
    this.line = line;
  }
}

export function parseToml(source: string): Record<string, TomlValue> {
  return new Parser(source).document();
}

class Parser {
  private s: string;
  private i = 0;
  private line = 1;

  constructor(source: string) {
    this.s = source.replace(/^﻿/, "");
  }

  document(): Record<string, TomlValue> {
    const out: Record<string, TomlValue> = Object.create(null);
    for (;;) {
      this.skipBlankLines();
      if (this.done()) return out;
      if (this.peek() === "[") throw this.error("tables aren't supported; put every key at the top level");
      const keyLine = this.line;
      const key = this.key();
      this.skipSpace();
      this.expect("=");
      this.skipSpace();
      const value = this.value();
      if (Object.hasOwn(out, key)) throw new TomlError(`"${key}" is set more than once`, keyLine);
      out[key] = value;
      this.skipSpace();
      this.skipComment();
      if (!this.done() && !this.newline()) throw this.error("expected the end of the line");
    }
  }

  private key(): string {
    if (this.peek() === '"' || this.peek() === "'") return this.string();
    const m = /^[A-Za-z0-9_-]+/.exec(this.s.slice(this.i));
    if (!m) throw this.error("expected a key");
    this.i += m[0].length;
    return m[0];
  }

  private value(): TomlValue {
    const c = this.peek();
    if (c === '"' || c === "'") return this.string();
    if (c === "[") return this.array();
    for (const word of ["true", "false"]) {
      if (this.s.startsWith(word, this.i) && !/[A-Za-z0-9_-]/.test(this.s[this.i + word.length] ?? "")) {
        this.i += word.length;
        return word === "true";
      }
    }
    throw this.error("expected a string, a boolean or an array of strings");
  }

  private array(): string[] {
    this.expect("[");
    const items: string[] = [];
    for (;;) {
      this.skipBlankLines();
      if (this.peek() === "]") break;
      const c = this.peek();
      if (c !== '"' && c !== "'") throw this.error("arrays may hold only strings");
      items.push(this.string());
      this.skipBlankLines();
      if (this.peek() === ",") {
        this.i++;
        continue;
      }
      if (this.peek() !== "]") throw this.error('expected "," or "]"');
    }
    this.expect("]");
    return items;
  }

  private string(): string {
    const quote = this.peek();
    if (this.s.startsWith(quote.repeat(3), this.i)) throw this.error("multi-line strings aren't supported");
    this.i++;
    let out = "";
    for (;;) {
      if (this.done()) throw this.error("unterminated string");
      const c = this.s[this.i]!;
      if (c === "\n" || c === "\r") throw this.error("unterminated string");
      this.i++;
      if (c === quote) return out;
      if (c === "\\" && quote === '"') {
        out += this.escape();
        continue;
      }
      out += c;
    }
  }

  private escape(): string {
    const c = this.s[this.i++];
    const simple: Record<string, string> = { '"': '"', "\\": "\\", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
    if (c !== undefined && Object.hasOwn(simple, c)) return simple[c]!;
    if (c === "u" || c === "U") {
      const length = c === "u" ? 4 : 8;
      const hex = this.s.slice(this.i, this.i + length);
      if (!new RegExp(`^[0-9A-Fa-f]{${length}}$`).test(hex)) throw this.error("bad unicode escape");
      this.i += length;
      const code = parseInt(hex, 16);
      if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) throw this.error("bad unicode escape");
      return String.fromCodePoint(code);
    }
    throw this.error("unknown escape");
  }

  private skipSpace(): void {
    while (this.peek() === " " || this.peek() === "\t") this.i++;
  }

  private skipComment(): void {
    if (this.peek() !== "#") return;
    while (!this.done() && this.peek() !== "\n" && this.peek() !== "\r") this.i++;
  }

  private skipBlankLines(): void {
    for (;;) {
      this.skipSpace();
      this.skipComment();
      if (!this.newline()) return;
    }
  }

  private newline(): boolean {
    if (this.s.startsWith("\r\n", this.i)) this.i += 2;
    else if (this.peek() === "\n") this.i++;
    else return false;
    this.line++;
    return true;
  }

  private expect(c: string): void {
    if (this.peek() !== c) throw this.error(`expected "${c}"`);
    this.i++;
  }

  private peek(): string {
    return this.s[this.i] ?? "";
  }

  private done(): boolean {
    return this.i >= this.s.length;
  }

  private error(message: string): TomlError {
    return new TomlError(message, this.line);
  }
}
