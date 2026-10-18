import { accessSync, closeSync, constants, openSync, readSync, realpathSync, statSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { KIND_NAMES, type Kind } from "./checks.ts";
import { shQuote } from "./git.ts";

export const SHIM_MARKER = "# Added by second-read: the gh shim.";

type Field = "title" | "body" | "bodyFile";

const TEXT_FLAGS: Record<string, Field> = {
  "--title": "title",
  "-t": "title",
  "--body": "body",
  "-b": "body",
  "--body-file": "bodyFile",
  "-F": "bodyFile",
};

// Closing or reopening with a comment posts the comment.
const COMMENT_FLAGS: Record<string, Field> = { "--comment": "body", "-c": "body" };

// A merge commit's message: its subject and body.
const MERGE_FLAGS: Record<string, Field> = {
  "--subject": "title",
  "-t": "title",
  "--body": "body",
  "-b": "body",
  "--body-file": "bodyFile",
  "-F": "bodyFile",
};

interface Posting {
  kind: Kind;
  flags: Record<string, Field>;
  noun?: string;
  titleName?: string;
}

const text = (kind: Kind): Posting => ({ kind, flags: TEXT_FLAGS });
const comment: Posting = { kind: "comment", flags: COMMENT_FLAGS };

const POSTS: Record<string, Record<string, Posting>> = {
  issue: {
    create: text("issue"),
    new: text("issue"),
    edit: text("issue"),
    comment: text("comment"),
    close: comment,
    reopen: comment,
  },
  pr: {
    create: text("pr"),
    new: text("pr"),
    edit: text("pr"),
    comment: text("comment"),
    review: text("review"),
    close: comment,
    reopen: comment,
    merge: { kind: "commit", flags: MERGE_FLAGS, noun: "this merge commit", titleName: "subject" },
  },
};

export interface GhPost {
  kind: Kind;
  // What the texts are called in a report.
  noun: string;
  titleName: string;
  title: string[];
  body: string[];
  bodyFiles: string[];
}

// The text a posting gh command sends, or undefined for any other command, which passes straight through.
export function parseGh(args: string[]): GhPost | undefined {
  // The command words come first, with only -R and its value among them.
  const words: string[] = [];
  for (let i = 0; i < args.length && words.length < 2; i++) {
    const arg = args[i]!;
    if (arg === "--") break;
    if (arg === "-R" || arg === "--repo") i++;
    else if (!arg.startsWith("-")) words.push(arg);
  }
  const posting = POSTS[words[0] ?? ""]?.[words[1] ?? ""];
  if (posting === undefined) return undefined;
  const post: GhPost = {
    kind: posting.kind,
    noun: posting.noun ?? KIND_NAMES[posting.kind],
    titleName: posting.titleName ?? "title",
    title: [],
    body: [],
    bodyFiles: [],
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") break;
    if (arg === "-R" || arg === "--repo") {
      i++;
      continue;
    }
    let name: string | undefined;
    let value: string | undefined;
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      name = eq < 0 ? arg : arg.slice(0, eq);
      if (eq >= 0) value = arg.slice(eq + 1);
    } else if (arg.startsWith("-") && arg.length > 1) {
      // A short flag takes its value from the next argument, or joined: "-tTitle" or "-t=Title".
      name = arg.slice(0, 2);
      if (arg.length > 2) value = arg.slice(arg[2] === "=" ? 3 : 2);
    } else {
      continue;
    }
    const field = posting.flags[name];
    if (field === undefined) continue;
    if (value === undefined) value = args[++i];
    if (value === undefined) continue;
    if (field === "bodyFile") post.bodyFiles.push(value);
    else post[field].push(value);
  }
  return post;
}

// Each text a posting gh command sends, with where it goes. `read` gives a body file's text, "-" being stdin.
export function postTexts(post: GhPost, read: (file: string) => string): [string, string][] {
  const noun = post.noun;
  return [
    ...post.title.map((t): [string, string] => [`the ${post.titleName} of ${noun}`, t]),
    ...post.body.map((t): [string, string] => [`the body of ${noun}`, t]),
    ...post.bodyFiles.map((f): [string, string] => [
      f === "-" ? `the body of ${noun}` : `the body of ${noun}, from ${f}`,
      read(f),
    ]),
  ];
}

export function shimScript(command: string[]): string {
  return `#!/bin/sh
${SHIM_MARKER} It checks what gh is about to post, then runs the real gh.
exec ${command.map(shQuote).join(" ")} gh-shim "$0" "$@"
`;
}

// The first gh on PATH that isn't this shim: its own folder is skipped, and so is any other copy of the shim,
// so it can never call itself.
export function findRealGh(
  pathEnv: string,
  cwd: string,
  platform: NodeJS.Platform,
  skipDirs: string[],
): string | undefined {
  const skip = new Set(skipDirs.map(real));
  const names = platform === "win32" ? ["gh.exe", "gh.cmd", "gh.bat", "gh"] : ["gh"];
  for (const entry of pathEnv.split(delimiter)) {
    const dir = resolve(cwd, entry);
    if (skip.has(real(dir))) continue;
    for (const name of names) {
      const path = join(dir, name);
      if (isExecutableFile(path) && !isShim(path)) return path;
    }
  }
  return undefined;
}

export function isShim(path: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const head = Buffer.alloc(512);
    const read = readSync(fd, head, 0, head.length, 0);
    return head.subarray(0, read).toString("utf8").includes(SHIM_MARKER);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}
