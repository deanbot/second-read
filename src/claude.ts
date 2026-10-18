// What a Claude Code tool call would post: the text of gh and git commands run through Bash, and the text of a
// GitHub tool from an MCP server.
import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { KIND_NAMES, type Kind } from "./checks.ts";
import { parseGh, postNames, postTexts } from "./gh.ts";
import { output, parseShell, type Stdin, UNKNOWN, UNKNOWN_END, unknown } from "./shell.ts";

export interface Post {
  where: string;
  kind: Kind;
  // Holds UNKNOWN where the shell fills the text in only when the command runs.
  text: string;
  // The folder the post is made from, whose repository's allowlist applies.
  cwd: string;
  // For a file's contents, its path in the repository, which may be exempt.
  file?: string;
  // A name the post gives, such as a repository's, checked as a branch name is.
  name?: boolean;
}

// The texts each command in a Bash tool call would post, read against the folder each one runs in.
export function bashPosts(command: string, cwd: string, home: string): Post[] {
  return scriptPosts(command, cwd, home, new Map());
}

// The hook runs before the command does, so a file the command writes on its way to posting it is read from the
// command, never from disk, where it may not exist yet or may hold an older text.
type Written = Map<string, string>;

function scriptPosts(script: string, cwd: string, home: string, written: Written): Post[] {
  const posts: Post[] = [];
  let dir = cwd;
  for (const command of parseShell(script)) {
    const words = unwrap(command.words);
    const name = basename(words[0] ?? "").replace(/\.exe$/i, "");
    const args = words.slice(1);
    const { stdin } = command;
    if (name === "cd" || name === "pushd") {
      const target = args.find((a) => !a.startsWith("-") || a === "-");
      if (target === undefined) dir = home;
      else if (target !== "-" && !target.includes(UNKNOWN)) dir = resolve(dir, target.replace(/^~(?=\/|$)/, home));
    } else if (/^(ba|z|da|k)?sh$/.test(name) && args[0] === "-c" && args[1] !== undefined) {
      if (!args[1].includes(UNKNOWN)) posts.push(...scriptPosts(args[1], dir, home, written));
    } else if (name === "eval") {
      const script = args.join(" ");
      if (!script.includes(UNKNOWN)) posts.push(...scriptPosts(script, dir, home, written));
    } else if (name === "gh") {
      posts.push(...ghPosts(args, stdin, dir, written));
    } else if (name === "git") {
      posts.push(...gitPosts(args, stdin, dir, written));
    }
    const printed = output({ ...command, words });
    const files = (command.writes ?? []).map((w) => ({ ...w, by: "this command" }));
    if (name === "tee") {
      const append = args.some((a) => /^-[^-]*a/.test(a) || a === "--append");
      for (const file of args.filter((a) => !a.startsWith("-"))) files.push({ file, append, by: "tee" });
    }
    for (const { file, append } of files) {
      if (file.includes(UNKNOWN)) continue;
      const path = resolve(dir, file);
      written.set(path, printed !== undefined && !append ? printed : unknown(`what ${words.join(" ")} writes to ${file}`));
    }
  }
  return posts;
}

// The command itself, past variable assignments and commands that run the one after them.
function unwrap(words: string[]): string[] {
  let i = 0;
  for (;;) {
    while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]!)) i++;
    const name = words[i];
    if (name === "env") {
      for (i++; i < words.length && (words[i]!.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]!)); i++) {
        if (/^(-u|--unset|-C|--chdir)$/.test(words[i]!)) i++;
      }
    } else if (name === "command" || name === "exec" || name === "nohup" || name === "time" || name === "builtin") {
      i++;
      while (i < words.length && words[i]!.startsWith("-")) i++;
    } else if (name === "sudo") {
      i = pastOptions(words, i + 1, "ugChpUTrtDR");
    } else if (name === "xargs") {
      // xargs adds arguments from its input, so the command's text is filled in only when it runs.
      let replace: string | undefined;
      i = pastOptions(words, i + 1,"adEILnPs", "eil", (flag, value) => {
        if (flag === "I") replace = value;
        if (flag === "i" || flag === "--replace") replace = value || "{}";
      });
      const added = unknown("the arguments xargs adds");
      const rest = words.slice(i);
      if (replace === undefined) return [...rest, added];
      return rest.map((w) => (w.includes(replace!) ? w.split(replace!).join(added) : w));
    } else {
      return words.slice(i);
    }
  }
}

// The index past a command's options, as in `sudo -u someone`. `valued` names the short options that take a value,
// and `joined` those that take one only when it's joined on, as in xargs -i{}.
function pastOptions(
  words: string[],
  start: number,
  valued: string,
  joined = "",
  seen: (flag: string, value: string) => void = () => {},
): number {
  let i = start;
  for (; i < words.length && words[i]!.startsWith("-"); i++) {
    const word = words[i]!;
    if (word === "--") return i + 1;
    if (word.startsWith("--")) {
      const eq = word.indexOf("=");
      seen(eq < 0 ? word : word.slice(0, eq), eq < 0 ? "" : word.slice(eq + 1));
      continue;
    }
    for (let j = 1; j < word.length; j++) {
      const flag = word[j]!;
      if (!valued.includes(flag)) {
        if (joined.includes(flag) && j + 1 < word.length) {
          seen(flag, word.slice(j + 1));
          break;
        }
        seen(flag, "");
        continue;
      }
      const value = j + 1 < word.length ? word.slice(j + 1) : (words[++i] ?? "");
      seen(flag, value);
      break;
    }
  }
  return i;
}

// A file's text, or stdin's for "-". A name the shell fills in is kept as the text, so it's refused unread.
function reader(stdin: Stdin | undefined, dir: string, written: Written): (file: string) => string {
  const load = (file: string) => {
    if (file.includes(UNKNOWN)) return file;
    const path = resolve(dir, file);
    return written.get(path) ?? readFileSync(path, "utf8");
  };
  return (file) => {
    if (file !== "-") return load(file);
    if (stdin === undefined) return "";
    return "text" in stdin ? stdin.text : load(stdin.file);
  };
}

function ghPosts(args: string[], stdin: Stdin | undefined, dir: string, written: Written): Post[] {
  if (args[0] === "api") return ghApiPosts(args.slice(1), reader(stdin, dir, written), dir);
  const post = parseGh(args);
  if (!post) return [];
  return [
    ...postNames(post).map(([where, text]) => ({ where, kind: post.kind, text, cwd: dir, name: true })),
    ...postTexts(post, reader(stdin, dir, written)).map(([where, text]) => ({ where, kind: post.kind, text, cwd: dir })),
  ];
}

const GH_API_VALUE_FLAGS = new Set(["-X", "--method", "-f", "--raw-field", "-F", "--field", "-H", "--header", "-q",
  "--jq", "-t", "--template", "-p", "--preview", "--hostname", "--cache", "--input"]);

// gh api sends its fields, or the --input file, and switches to POST when it has either. A GraphQL query that
// isn't a mutation only reads.
function ghApiPosts(args: string[], read: (file: string) => string, dir: string): Post[] {
  let endpoint: string | undefined;
  let method: string | undefined;
  let input: string | undefined;
  const fields: { field: string; typed: boolean }[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    let name: string;
    let value: string | undefined;
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      name = eq < 0 ? arg : arg.slice(0, eq);
      if (eq >= 0) value = arg.slice(eq + 1);
    } else if (arg.startsWith("-") && arg.length > 1) {
      name = arg.slice(0, 2);
      if (arg.length > 2) value = arg.slice(arg[2] === "=" ? 3 : 2);
    } else {
      endpoint ??= arg;
      continue;
    }
    if (!GH_API_VALUE_FLAGS.has(name)) continue;
    if (value === undefined) value = args[++i];
    if (value === undefined) continue;
    if (name === "-X" || name === "--method") method = value.toUpperCase();
    else if (name === "--input") input = value;
    else if (name === "-f" || name === "--raw-field") fields.push({ field: value, typed: false });
    else if (name === "-F" || name === "--field") fields.push({ field: value, typed: true });
  }
  method ??= fields.length > 0 || input !== undefined ? "POST" : "GET";
  if (method === "GET" || method === "HEAD") return [];
  const target = `gh api ${endpoint ?? ""}`.trim();
  const kind = apiKind(endpoint ?? "");
  const texts: [string, string][] = [];
  for (const { field, typed } of fields) {
    const eq = field.indexOf("=");
    const key = eq < 0 ? field : field.slice(0, eq);
    if (eq < 0 || DESTINATION_KEYS.has(key)) continue;
    const value = field.slice(eq + 1);
    texts.push([`the ${key} field of ${target}`, typed && value.startsWith("@") ? read(value.slice(1)) : value]);
  }
  if (endpoint === "graphql") {
    const query = texts.find(([where]) => where.startsWith("the query field"))?.[1];
    if (query !== undefined && !query.includes(UNKNOWN) && !/\bmutation\b/.test(query)) return [];
  }
  if (input !== undefined) {
    const text = read(input);
    const where = input === "-" ? `the body of ${target}` : `the body of ${target}, from ${input}`;
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      texts.push([where, text]);
    }
    if (json !== undefined) for (const [path, leaf] of leaves(json)) texts.push([`${path} in ${where}`, leaf]);
  }
  return texts.map(([where, text]) => ({ where, kind, text, cwd: dir }));
}

function apiKind(endpoint: string): Kind {
  if (/comments/.test(endpoint)) return "comment";
  if (/reviews/.test(endpoint)) return "review";
  if (/pulls/.test(endpoint)) return "pr";
  if (/issues/.test(endpoint)) return "issue";
  if (/commits|git\/|contents/.test(endpoint)) return "commit";
  return "comment";
}

interface MessageOptions {
  where: string;
  // Short options that take a value, and those that take one only when it's joined on, as in -S<key>.
  short: string;
  joined: string;
  long: Record<string, "message" | "file" | "trailer" | "value">;
}

const COMMIT: MessageOptions = {
  where: KIND_NAMES.commit,
  short: "mFCct",
  joined: "Su",
  long: {
    "--message": "message",
    "--file": "file",
    "--trailer": "trailer",
    "--author": "value",
    "--date": "value",
    "--reuse-message": "value",
    "--reedit-message": "value",
    "--fixup": "value",
    "--squash": "value",
    "--template": "value",
    "--cleanup": "value",
    "--pathspec-from-file": "value",
  },
};

const TAG: MessageOptions = {
  where: "this tag message",
  short: "mFu",
  joined: "n",
  long: {
    "--message": "message",
    "--file": "file",
    "--trailer": "trailer",
    "--local-user": "value",
    "--cleanup": "value",
    "--sort": "value",
    "--format": "value",
    "--contains": "value",
    "--no-contains": "value",
    "--merged": "value",
    "--no-merged": "value",
    "--points-at": "value",
  },
};

const GIT_VALUE_OPTIONS = new Set(["-c", "--git-dir", "--work-tree", "--namespace", "--config-env", "--super-prefix"]);

// The messages git commit and git tag are given. A push is the pre-push hook's to check, since only git knows
// what it sends.
function gitPosts(args: string[], stdin: Stdin | undefined, cwd: string, written: Written): Post[] {
  let dir = cwd;
  let i = 0;
  for (; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "-C") {
      const to = args[++i];
      if (to !== undefined && !to.includes(UNKNOWN)) dir = resolve(dir, to);
    } else if (GIT_VALUE_OPTIONS.has(arg)) i++;
    else if (!arg.startsWith("-")) break;
  }
  const command = args[i];
  const options = command === "commit" ? COMMIT : command === "tag" ? TAG : undefined;
  if (options === undefined) return [];
  return messages(args.slice(i + 1), options, reader(stdin, dir, written)).map(([where, text]) => ({
    where,
    kind: "commit",
    text,
    cwd: dir,
  }));
}

// Each -m is a paragraph of the one message.
function messages(args: string[], options: MessageOptions, read: (file: string) => string): [string, string][] {
  const paragraphs: string[] = [];
  const texts: [string, string][] = [];
  const take = (kind: string, value: string) => {
    if (kind === "message") paragraphs.push(value);
    else if (kind === "trailer") texts.push([`a trailer of ${options.where}`, value]);
    else if (kind === "file") texts.push([value === "-" ? options.where : `${options.where}, from ${value}`, read(value)]);
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") break;
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const kind = options.long[eq < 0 ? arg : arg.slice(0, eq)];
      if (kind === undefined) continue;
      const value = eq < 0 ? args[++i] : arg.slice(eq + 1);
      if (value !== undefined) take(kind, value);
    } else if (arg.startsWith("-")) {
      // Short options cluster, as in -am "message".
      for (let j = 1; j < arg.length; j++) {
        const flag = arg[j]!;
        if (options.joined.includes(flag)) break;
        if (!options.short.includes(flag)) continue;
        const value = j + 1 < arg.length ? arg.slice(j + 1) : args[++i];
        if (value !== undefined) take(flag === "m" ? "message" : flag === "F" ? "file" : "value", value);
        break;
      }
    }
  }
  if (paragraphs.length > 0) texts.unshift([options.where, paragraphs.join("\n\n")]);
  return texts;
}

// Keys that name where a post goes, such as the account a repository belongs to, not what it says.
const DESTINATION_KEYS = new Set(["owner", "repo"]);

// An MCP tool whose server or name says GitHub, in any case, including one a plugin bundles.
export function isGithubTool(name: string): boolean {
  return name.startsWith("mcp__") && /github/i.test(name);
}

// Every string a GitHub tool is given, but for tools that only read. A file's contents are checked as the lines a
// push would add to it.
export function mcpPosts(toolName: string, input: unknown, cwd: string): Post[] {
  const tool = toolName.slice(toolName.lastIndexOf("__") + 2);
  if (/^(get|list|search|read)_|_read$/.test(tool)) return [];
  const kind = toolKind(tool);
  const posts: Post[] = [];
  const walk = (value: unknown, path: string) => {
    if (typeof value === "string") {
      posts.push({ where: `${path || "the input"} of ${tool}`, kind, text: value, cwd });
    } else if (Array.isArray(value)) {
      value.forEach((v, i) => walk(v, `${path}[${i}]`));
    } else if (value !== null && typeof value === "object") {
      const entries = Object.entries(value);
      const record = value as Record<string, unknown>;
      const isFile = typeof record.path === "string" && typeof record.content === "string";
      if (isFile) {
        const file = record.path as string;
        posts.push({ where: `${file}, as ${tool} writes it`, kind: "commit", text: record.content as string, cwd, file });
      }
      for (const [key, v] of entries) {
        if (DESTINATION_KEYS.has(key) || (isFile && key === "content")) continue;
        walk(v, path ? `${path}.${key}` : key);
      }
    }
  };
  walk(input, "");
  return posts;
}

function toolKind(tool: string): Kind {
  if (/comment/.test(tool)) return "comment";
  if (/review/.test(tool)) return "review";
  if (/pull/.test(tool)) return "pr";
  if (/issue/.test(tool)) return "issue";
  if (/commit|file|push|branch|tag/.test(tool)) return "commit";
  return "comment";
}

// The JSON string values in a request body, each with its path.
function leaves(value: unknown, path = ""): [string, string][] {
  if (typeof value === "string") return [[path || "the text", value]];
  if (Array.isArray(value)) return value.flatMap((v, i) => leaves(v, `${path}[${i}]`));
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, v]) =>
    DESTINATION_KEYS.has(key) ? [] : leaves(v, path ? `${path}.${key}` : key),
  );
}

// The shell source of the first thing in a text that the shell fills in.
export function firstUnknown(text: string): string {
  const start = text.indexOf(UNKNOWN);
  const end = text.indexOf(UNKNOWN_END, start);
  return text.slice(start + 1, end < 0 ? undefined : end);
}
