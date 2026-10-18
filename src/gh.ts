import { accessSync, closeSync, constants, openSync, readSync, realpathSync, statSync } from "node:fs";
import { basename, delimiter, join, resolve } from "node:path";
import { KIND_NAMES, type Kind } from "./checks.ts";
import { shQuote } from "./git.ts";

export const SHIM_MARKER = "# Added by second-read: the gh shim.";

type Field = "title" | "body" | "bodyFile" | "name";

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
  // The command's other flags that take a value, as gh 2.92 has them. Every other flag is a switch, so in a group
  // of short flags, as in "-dt Title", the flags before the first that takes a value are switches.
  valued: string[];
  // Takes in the arguments after the command words, for a command that posts some of them.
  args?: (post: GhPost, args: string[]) => void;
  noun?: string;
  titleName?: string;
  bodyName?: string;
  fileName?: string;
  nameName?: string;
}

const text = (kind: Kind, valued: string[] = []): Posting => ({ kind, flags: TEXT_FLAGS, valued });
const comment = (valued: string[] = []): Posting => ({ kind: "comment", flags: COMMENT_FLAGS, valued });

const ISSUE_CREATE = ["--assignee", "-a", "--label", "-l", "--milestone", "-m", "--project", "-p", "--recover",
  "--template", "-T"];
const ISSUE_EDIT = ["--add-assignee", "--add-label", "--add-project", "--milestone", "-m", "--remove-assignee",
  "--remove-label", "--remove-project"];
const PR_CREATE = [...ISSUE_CREATE, "--base", "-B", "--head", "-H", "--reviewer", "-r"];
const PR_EDIT = [...ISSUE_EDIT, "--add-reviewer", "--base", "-B", "--remove-reviewer"];

// A post's kind only picks how it's checked, and these check like a comment; each has its own noun.
const release = (posting: Partial<Posting>): Posting => ({
  kind: "comment",
  flags: RELEASE_FLAGS,
  valued: ["--discussion-category", "--target"],
  noun: "this release",
  bodyName: "notes",
  nameName: "tag",
  ...posting,
});

// gh release create [<tag>] [<asset>...]
const releaseCreate = release({
  valued: ["--discussion-category", "--notes-start-tag", "--target"],
  args: (post, [tag]) => {
    if (tag !== undefined) post.names.push(tag);
  },
});

// A repository's name, from gh repo create [<name>] or gh repo rename [<new name>].
const repository = (posting: Partial<Posting>): Posting => ({
  kind: "comment",
  flags: DESCRIPTION_FLAGS,
  valued: [],
  noun: "this repository",
  bodyName: "description",
  ...posting,
});

const repoName = (post: GhPost, [name]: string[]) => {
  if (name !== undefined) post.names.push(name);
};

const repoCreate = repository({
  valued: ["--gitignore", "-g", "--homepage", "-h", "--license", "-l", "--remote", "-r", "--source", "-s", "--team",
    "-t", "--template", "-p"],
  args: repoName,
});

// A gist's files are a new post of their own, not lines added to the repository's files, so exempt_files never
// applies to them.
const gist = (posting: Partial<Posting>): Posting => ({
  kind: "comment",
  flags: { "--desc": "body", "-d": "body" },
  valued: [],
  noun: "this gist",
  bodyName: "description",
  fileName: "contents",
  nameName: "file name",
  ...posting,
});

// Each argument is a file to upload, "-" being stdin. With none, it uploads stdin when it's piped in. A file is
// uploaded under its own name, and stdin under the name --filename gives.
const gistCreate = gist({
  flags: { "--desc": "body", "-d": "body", "--filename": "name", "-f": "name" },
  args: (post, files) => {
    const named = post.names.at(-1);
    post.names = [];
    if (files.length === 0) {
      files = ["-"];
      post.stdinIfPiped = true;
    }
    post.bodyFiles.push(...files);
    for (const file of files) {
      if (file !== "-") post.names.push(basename(file));
      else if (named !== undefined) post.names.push(named);
    }
  },
});

const label = (posting: Partial<Posting>): Posting => ({
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
    create: text("issue", ISSUE_CREATE),
    new: text("issue", ISSUE_CREATE),
    edit: text("issue", ISSUE_EDIT),
    comment: text("comment"),
    close: comment(["--duplicate-of", "--reason", "-r"]),
    reopen: comment(),
  },
  pr: {
    create: text("pr", PR_CREATE),
    new: text("pr", PR_CREATE),
    edit: text("pr", PR_EDIT),
    comment: text("comment"),
    review: text("review"),
    close: comment(),
    reopen: comment(),
    merge: {
      kind: "commit",
      flags: MERGE_FLAGS,
      valued: ["--author-email", "-A", "--match-head-commit"],
      noun: "this merge commit",
      titleName: "subject",
    },
  },
  release: {
    create: releaseCreate,
    new: releaseCreate,
    // The tag it's given now is checked, not the one it had, so a release's tag can be renamed.
    edit: release({ flags: { ...RELEASE_FLAGS, "--tag": "name" } }),
  },
  gist: {
    create: gistCreate,
    new: gistCreate,
    // gh gist edit <gist> [<file>]: the file replaces the one --filename picks, or is uploaded under the name --add
    // gives. Without it, --add uploads the file it names.
    edit: gist({
      flags: { "--desc": "body", "-d": "body", "--add": "bodyFile", "-a": "bodyFile" },
      valued: ["--filename", "-f", "--remove", "-r"],
      args: (post, [, file]) => {
        const added = post.bodyFiles.at(-1);
        if (added !== undefined) post.names.push(basename(added));
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
  repo: {
    create: repoCreate,
    new: repoCreate,
    edit: repository({
      valued: ["--add-topic", "--default-branch", "--homepage", "-h", "--remove-topic",
        "--squash-merge-commit-message", "--visibility"],
    }),
    rename: repository({ flags: {}, args: repoName }),
  },
};

export interface GhPost {
  kind: Kind;
  // What the texts are called in a report.
  noun: string;
  titleName: string;
  bodyName: string;
  fileName: string;
  nameName: string;
  title: string[];
  body: string[];
  bodyFiles: string[];
  // Names the command gives, public once it runs: a repository's, a release's tag, a gist file's.
  names: string[];
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
    nameName: posting.nameName ?? "name",
    title: [],
    body: [],
    bodyFiles: [],
    names: [],
  };
  const takesValue = (flag: string) =>
    flag in posting.flags || posting.valued.includes(flag) || flag === "-R" || flag === "--repo";
  // The arguments, the command words first.
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") {
      positional.push(...args.slice(i + 1));
      break;
    }
    let name: string | undefined;
    let value: string | undefined;
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      name = eq < 0 ? arg : arg.slice(0, eq);
      if (eq >= 0) value = arg.slice(eq + 1);
    } else if (arg.startsWith("-") && arg.length > 1) {
      const flag = shortFlag(arg, takesValue);
      if (flag === undefined) continue;
      ({ name, value } = flag);
    } else {
      positional.push(arg);
      continue;
    }
    const field = posting.flags[name];
    if (field === undefined) {
      if (value === undefined && takesValue(name)) i++;
      continue;
    }
    if (value === undefined) value = args[++i];
    if (value === undefined) continue;
    if (field === "bodyFile") post.bodyFiles.push(value);
    else if (field === "name") post.names.push(value);
    else post[field].push(value);
  }
  posting.args?.(post, positional.slice(2));
  return post;
}

// A group of short flags, read as gh reads them: the first that takes a value takes the rest of the argument, past
// an "=", or the next argument, which `value` is left undefined for. Those before it are switches, and a switch
// given "=" takes the rest as its own. Undefined when the group is all switches.
export function shortFlag(
  arg: string,
  takesValue: (flag: string) => boolean,
): { name: string; value: string | undefined } | undefined {
  let j = 1;
  for (; j < arg.length && !takesValue(`-${arg[j]}`); j++) {
    if (arg[j + 1] === "=" && j + 2 < arg.length) return undefined;
  }
  if (j === arg.length) return undefined;
  if (j + 1 === arg.length) return { name: `-${arg[j]}`, value: undefined };
  return { name: `-${arg[j]}`, value: arg.slice(arg[j + 1] === "=" && j + 2 < arg.length ? j + 2 : j + 1) };
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

// Each name a posting gh command gives, with where it goes. A name is checked as a branch name is.
export function postNames(post: GhPost): [string, string][] {
  return post.names.map((n) => [`the ${post.nameName} of ${post.noun}`, n]);
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
