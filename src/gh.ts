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

const RELEASE_FLAGS: Record<string, Field> = {
  "--title": "title",
  "-t": "title",
  "--notes": "body",
  "-n": "body",
  "--notes-file": "bodyFile",
  "-F": "bodyFile",
};

const DESCRIPTION_FLAGS: Record<string, Field> = { "--description": "body", "-d": "body" };

interface Posting {
  kind: Kind;
  flags: Record<string, Field>;
  // The other flags that take a value, so the value isn't read as an argument. Needed only with `args`.
  valued?: string[];
  // Takes in the arguments after the command words, for a command that posts some of them.
  args?: (post: GhPost, args: string[]) => void;
  noun?: string;
  titleName?: string;
  bodyName?: string;
  fileName?: string;
}

const text = (kind: Kind): Posting => ({ kind, flags: TEXT_FLAGS });
const comment: Posting = { kind: "comment", flags: COMMENT_FLAGS };

// A post's kind only picks how it's checked, and these check like a comment; each has its own noun.
const release: Posting = {
  kind: "comment",
  flags: RELEASE_FLAGS,
  noun: "this release",
  bodyName: "notes",
};

const repository: Posting = {
  kind: "comment",
  flags: DESCRIPTION_FLAGS,
  noun: "this repository",
  bodyName: "description",
};

// A gist's files are a new post of their own, not lines added to the repository's files, so exempt_files never
// applies to them.
const gist = (posting: Partial<Posting>): Posting => ({
  kind: "comment",
  flags: { "--desc": "body", "-d": "body" },
  noun: "this gist",
  bodyName: "description",
  fileName: "contents",
  ...posting,
});

// Each argument is a file to upload, "-" being stdin. With none, it uploads stdin when it's piped in.
const gistCreate = gist({
  valued: ["--filename", "-f"],
  args: (post, files) => {
    if (files.length > 0) {
      post.bodyFiles.push(...files);
    } else {
      post.bodyFiles.push("-");
      post.stdinIfPiped = true;
    }
  },
});

const label =(posting: Partial<Posting>): Posting => ({
  kind: "comment",
  flags: DESCRIPTION_FLAGS,
  valued: ["--color", "-c"],
  noun: "this label",
  titleName: "name",
  bodyName: "description",
  ...posting,
});

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
  release: { create: release, new: release, edit: release },
  gist: {
    create: gistCreate,
    new: gistCreate,
    // gh gist edit <gist> [<file>]: the file replaces the one --filename picks, or is uploaded under the name --add
    // gives. Without it, --add uploads the file it names.
    edit: gist({
      flags: { "--desc": "body", "-d": "body", "--add": "bodyFile", "-a": "bodyFile" },
      valued: ["--filename", "-f", "--remove", "-r"],
      args: (post, [, file]) => {
        if (file !== undefined) post.bodyFiles = [file];
      },
    }),
  },
  label: {
    create: label({
      args: (post, [name]) => {
        if (name !== undefined) post.title.push(name);
      },
    }),
    // The name it's given now is checked, not the one it had, so a label can be renamed.
    edit: label({ flags: { ...DESCRIPTION_FLAGS, "--name": "title", "-n": "title" } }),
  },
  repo: { create: repository, new: repository, edit: repository },
};

export interface GhPost {
  kind: Kind;
  // What the texts are called in a report.
  noun: string;
  titleName: string;
  bodyName: string;
  fileName: string;
  title: string[];
  body: string[];
  bodyFiles: string[];
  // Stdin is read only when it's piped in, never from a terminal.
  stdinIfPiped?: boolean;
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
    bodyName: posting.bodyName ?? "body",
    fileName: posting.fileName ?? posting.bodyName ?? "body",
    title: [],
    body: [],
    bodyFiles: [],
  };
  // The arguments, the command words first.
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") {
      positional.push(...args.slice(i + 1));
      break;
    }
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
      positional.push(arg);
      continue;
    }
    const field = posting.flags[name];
    if (field === undefined) {
      if (value === undefined && posting.valued?.includes(name)) i++;
      continue;
    }
    if (value === undefined) value = args[++i];
    if (value === undefined) continue;
    if (field === "bodyFile") post.bodyFiles.push(value);
    else post[field].push(value);
  }
  posting.args?.(post, positional.slice(2));
  return post;
}

// Each text a posting gh command sends, with where it goes. `read` gives a body file's text, "-" being stdin.
export function postTexts(post: GhPost, read: (file: string) => string): [string, string][] {
  const noun = post.noun;
  return [
    ...post.title.map((t): [string, string] => [`the ${post.titleName} of ${noun}`, t]),
    ...post.body.map((t): [string, string] => [`the ${post.bodyName} of ${noun}`, t]),
    ...post.bodyFiles.map((f): [string, string] => [
      f === "-" ? `the ${post.fileName} of ${noun}` : `the ${post.fileName} of ${noun}, from ${f}`,
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
