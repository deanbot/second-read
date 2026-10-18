import { spawn, spawnSync } from "node:child_process";
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { constants as os } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { REPO_FILE } from "./config.ts";

export const HOOKS = ["commit-msg", "pre-push"] as const;
export type HookName = (typeof HOOKS)[number];

export const HOOK_MARKER = "# Added by second-read.";
// A hook that was already there is set aside under this suffix, and second-read's hook runs it after the check.
export const PREVIOUS = ".second-read-previous";

// Every hook git runs, from githooks(5), except push-to-checkout: when that one exists, git leaves the work tree
// update to it, so a stand-in that does nothing would leave the tree stale.
export const GIT_HOOKS = [
  "applypatch-msg", "pre-applypatch", "post-applypatch", "pre-commit", "pre-merge-commit", "prepare-commit-msg",
  "commit-msg", "post-commit", "pre-rebase", "post-checkout", "post-merge", "pre-push", "pre-receive", "update",
  "proc-receive", "post-receive", "post-update", "reference-transaction", "pre-auto-gc", "post-rewrite",
  "sendemail-validate", "fsmonitor-watchman", "p4-changelist", "p4-prepare-changelist", "p4-post-changelist",
  "p4-pre-submit", "post-index-change",
];

// Where the hooks go when the repository's own hooks folder is checked in, inside the git folder.
export const MANAGED = "second-read-hooks";
const RECORD = "second-read.previousHooksPath";

export class GitError extends Error {}

export function git(args: string[], cwd: string, env: NodeJS.ProcessEnv): string {
  const result = spawnSync("git", args, { cwd, env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw new GitError(`can't run git: ${result.error.message}`);
  if (result.status !== 0) throw new GitError(`git ${args[0]} failed: ${result.stderr.trim()}`);
  return result.stdout;
}

// Where git looks for hooks, core.hooksPath included.
export function hooksDir(cwd: string, env: NodeJS.ProcessEnv): string {
  return resolve(cwd, git(["rev-parse", "--git-path", "hooks"], cwd, env).trim());
}

// A hooks folder in the work tree (core.hooksPath set to a checked-in folder) holds repository files, and an
// installed hook names paths on this machine. The git folder itself is the one place in the work tree that's fine.
export function hooksInWorkTree(dir: string, cwd: string, env: NodeJS.ProcessEnv): boolean {
  const top = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, env, encoding: "utf8" });
  if (top.status !== 0) return false;
  const gitDir = resolve(cwd, git(["rev-parse", "--git-common-dir"], cwd, env).trim());
  const hooks = existingRealpath(dir);
  return isInside(hooks, existingRealpath(top.stdout.trim())) && !isInside(hooks, existingRealpath(gitDir));
}

function isInside(path: string, folder: string): boolean {
  return path === folder || path.startsWith(folder.endsWith(sep) ? folder : folder + sep);
}

// The real path of the nearest folder that exists, with the rest of the path after it.
function existingRealpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    const parent = dirname(path);
    return parent === path ? path : join(existingRealpath(parent), basename(path));
  }
}

export function shQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

// `command` runs the CLI: the node binary and the script, as they were when the hook was installed.
export function hookScript(command: string[]): string {
  const cli = command[command.length - 1]!;
  return `#!/bin/sh
${HOOK_MARKER} \`second-read hooks uninstall\` removes it and puts back any hook it set aside.
if [ ! -f ${shQuote(cli)} ]; then
  echo "second-read: the CLI this hook runs is gone; run \\"second-read hooks install\\" again" >&2
  exit 2
fi
exec ${command.map(shQuote).join(" ")} hook "$0" "$@"
`;
}

export function isOurs(path: string, marker: string): boolean {
  try {
    return readFileSync(path, "utf8").includes(marker);
  } catch {
    return false;
  }
}

export function installHooks(dir: string, command: string[]): string[] {
  const done: string[] = [];
  for (const name of HOOKS) {
    const path = join(dir, name);
    const previous = path + PREVIOUS;
    if (existsSync(path) && !isOurs(path, HOOK_MARKER)) {
      if (existsSync(previous)) {
        throw new GitError(`${path} can't be set aside, because ${previous} is already there; nothing was installed`);
      }
    }
  }
  for (const name of HOOKS) {
    const path = join(dir, name);
    if (isOurs(path, HOOK_MARKER)) {
      writeFileSync(path, hookScript(command), { mode: 0o755 });
      done.push(`${name}: already installed, refreshed`);
      continue;
    }
    if (existsSync(path)) {
      renameSync(path, path + PREVIOUS);
      done.push(`${name}: installed; the hook that was there runs after the check`);
    } else done.push(`${name}: installed`);
    writeFileSync(path, hookScript(command), { mode: 0o755, flag: "wx" });
  }
  return done;
}

export function uninstallHooks(dir: string): string[] {
  const done: string[] = [];
  for (const name of HOOKS) {
    const path = join(dir, name);
    const previous = path + PREVIOUS;
    if (existsSync(path) && !isOurs(path, HOOK_MARKER)) {
      done.push(`${name}: left as it is; it isn't second-read's`);
      continue;
    }
    const ours = existsSync(path);
    if (ours) unlinkSync(path);
    if (existsSync(previous)) {
      renameSync(previous, path);
      done.push(`${name}: removed, and the hook it set aside is back`);
    } else done.push(ours ? `${name}: removed` : `${name}: not installed`);
  }
  return done;
}

// A stand-in for one of the repository's own hooks. git runs hooks from the top of the work tree (or the git
// folder, for the server-side ones), which is also where it resolves a relative core.hooksPath.
// It's plain sh, since some hooks run on every ref update.
export function forwarderScript(hooksPath: string, name: string): string {
  return `#!/bin/sh
${HOOK_MARKER} It runs the repository's own ${name} hook, if there is one.
hook=${shQuote(`${hooksPath.replace(/\/+$/, "")}/${name}`)}
[ -x "$hook" ] || exit 0
exec "$hook" "$@"
`;
}

function configGet(args: string[], cwd: string, env: NodeJS.ProcessEnv): string | undefined {
  const result = spawnSync("git", ["config", ...args], { cwd, env, encoding: "utf8" });
  if (result.status === 0) return result.stdout.replace(/\n$/, "");
  if (result.status === 1) return undefined;
  throw new GitError(`git config failed: ${result.stderr.trim()}`);
}

export function managedDir(cwd: string, env: NodeJS.ProcessEnv): string {
  return join(resolve(cwd, git(["rev-parse", "--git-common-dir"], cwd, env).trim()), MANAGED);
}

export interface ManagedInstall {
  dir: string;
  // The repository's hooks folder, as git expands core.hooksPath.
  hooksPath: string;
  done: string[];
}

// git runs these on every ref update and every index write, `git status` included, so a forwarder that starts sh
// each time slows rebases and editors down. They're forwarded only when the repository has them at install.
export const FREQUENT_HOOKS = ["reference-transaction", "post-index-change"];

// The repository's hooks folder the forwarders point at, kept so a later install can write them again.
const FORWARD_TO = "second-read.hooksPath";

// For a hooks folder in the work tree: second-read's hooks go in a folder inside the git folder, which this
// clone's core.hooksPath then points at. Each of the repository's hooks still runs, through a forwarder there.
export function installManaged(cwd: string, env: NodeJS.ProcessEnv, command: string[]): ManagedInstall {
  const dir = managedDir(cwd, env);
  const hooksPath = configGet(["--path", "--get", "core.hooksPath"], cwd, env);
  if (hooksPath === undefined) throw new GitError("core.hooksPath isn't set, so there's nothing to forward to");
  // A forwarder that pointed back into this folder would run itself forever.
  if (existingRealpath(resolve(cwd, hooksPath)) === existingRealpath(dir)) {
    throw new GitError(`core.hooksPath already points at ${dir}`);
  }
  const local = configGet(["--local", "--get", "core.hooksPath"], cwd, env);
  const done = writeManaged(dir, hooksPath, cwd, env, command);
  if (local === undefined) spawnSync("git", ["config", "--local", "--unset-all", RECORD], { cwd, env });
  else git(["config", "--local", RECORD, local], cwd, env);
  git(["config", "--local", FORWARD_TO, hooksPath], cwd, env);
  git(["config", "--local", "core.hooksPath", dir], cwd, env);
  return { dir, hooksPath, done };
}

// Whether `dir`, where git looks for hooks, is the folder installManaged wrote.
export function isManagedDir(dir: string, cwd: string, env: NodeJS.ProcessEnv): boolean {
  return existingRealpath(dir) === existingRealpath(managedDir(cwd, env));
}

// A second install writes the whole folder again, forwarding to the same hooks folder as before, so it picks up
// a frequent hook the repository has added since, and any hook a newer second-read knows.
export function refreshManaged(cwd: string, env: NodeJS.ProcessEnv, command: string[]): ManagedInstall {
  const dir = managedDir(cwd, env);
  const hooksPath = configGet(["--local", "--get", FORWARD_TO], cwd, env);
  if (hooksPath === undefined) {
    throw new GitError(`${dir} doesn't say which hooks it forwards to; run "second-read hooks uninstall" first`);
  }
  return { dir, hooksPath, done: writeManaged(dir, hooksPath, cwd, env, command) };
}

function writeManaged(dir: string, hooksPath: string, cwd: string, env: NodeJS.ProcessEnv, command: string[]) {
  const top = git(["rev-parse", "--show-toplevel"], cwd, env).trim();
  const theirs = (name: string) => existsSync(resolve(top, hooksPath, name));
  mkdirSync(dir, { recursive: true });
  const skipped: string[] = [];
  for (const name of GIT_HOOKS) {
    const forwarder = forwarderScript(hooksPath, name);
    if ((HOOKS as readonly string[]).includes(name)) {
      writeFileSync(join(dir, name), hookScript(command), { mode: 0o755 });
      writeFileSync(join(dir, name + PREVIOUS), forwarder, { mode: 0o755 });
    } else if (FREQUENT_HOOKS.includes(name) && !theirs(name)) {
      rmSync(join(dir, name), { force: true });
      skipped.push(name);
    } else writeFileSync(join(dir, name), forwarder, { mode: 0o755 });
  }
  const done = HOOKS.map((name) => `${name}: installed; the repository's own ${name} runs after the check`);
  done.push(`every other hook githooks(5) lists runs the repository's own, from ${hooksPath}, but push-to-checkout`);
  if (skipped.length > 0) {
    done.push(
      `${skipped.join(" and ")}: not forwarded, since the repository doesn't have ` +
        `${skipped.length === 1 ? "it and git runs it" : "them and git runs them"} often; ` +
        `run "second-read hooks install" again after adding one`,
    );
  }
  if (theirs("push-to-checkout")) {
    done.push("warning: the repository's push-to-checkout won't run while second-read's hooks are installed");
  }
  return done;
}

// Undoes installManaged, or returns undefined when it was never run here. core.hooksPath goes back to what this
// clone had set, or is unset so a value from the global config shows through, unless something else has set it
// since: the repository's own setup step, say.
export function uninstallManaged(cwd: string, env: NodeJS.ProcessEnv): string[] | undefined {
  const dir = managedDir(cwd, env);
  if (!existsSync(dir)) return undefined;
  const done: string[] = [];
  const current = configGet(["--local", "--path", "--get", "core.hooksPath"], cwd, env);
  if (current !== undefined && existingRealpath(resolve(cwd, current)) === existingRealpath(dir)) {
    const previous = configGet(["--local", "--get", RECORD], cwd, env);
    if (previous === undefined) {
      git(["config", "--local", "--unset", "core.hooksPath"], cwd, env);
      done.push("core.hooksPath: unset in this clone, as it was");
    } else {
      git(["config", "--local", "core.hooksPath", previous], cwd, env);
      done.push(`core.hooksPath: back to ${JSON.stringify(previous)}`);
    }
  } else done.push("core.hooksPath: left as it is; it no longer points at second-read's hooks");
  spawnSync("git", ["config", "--local", "--remove-section", "second-read"], { cwd, env });
  rmSync(dir, { recursive: true, force: true });
  done.push(`removed ${dir}`);
  return done;
}

// Runs the hook that was set aside at install, if there is one, with the same arguments and input.
export function runPrevious(hookPath: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, input?: Buffer) {
  const previous = hookPath + PREVIOUS;
  try {
    accessSync(previous, constants.X_OK);
  } catch {
    return 0;
  }
  const result = spawnSync(previous, args, {
    cwd,
    env,
    stdio: [input === undefined ? "inherit" : "pipe", "inherit", "inherit"],
    ...(input === undefined ? {} : { input }),
  });
  // A hook that exits without reading all its input isn't a failure; git doesn't treat it as one either.
  const unread = (result.error as NodeJS.ErrnoException | undefined)?.code === "EPIPE" && result.status !== null;
  if (result.error && !unread) throw new GitError(`can't run ${previous}: ${result.error.message}`);
  return exitStatus(result);
}

export function exitStatus(result: { status: number | null; signal: NodeJS.Signals | null }): number {
  if (result.status !== null) return result.status;
  const number = result.signal ? os.signals[result.signal] : undefined;
  return number === undefined ? 1 : 128 + number;
}

// The text git will commit. With an editor, git drops comment lines, and with `git commit -v` everything below
// the scissors line, which is where the diff goes. Without an editor (`git commit -m`), it keeps every line.
export function commitMessage(raw: string, cwd: string, env: NodeJS.ProcessEnv): string {
  if (env.GIT_EDITOR === ":") return raw;
  let comment = "#";
  let cleanup = "strip";
  const config = spawnSync(
    "git",
    ["config", "--get-regexp", "^(core\\.comment(char|string)|commit\\.cleanup)$"],
    { cwd, env, encoding: "utf8" },
  );
  if (config.status === 0) {
    for (const line of config.stdout.split("\n")) {
      const space = line.indexOf(" ");
      if (space < 0) continue;
      const key = line.slice(0, space);
      const value = line.slice(space + 1);
      if (key === "commit.cleanup") cleanup = value;
      else comment = value;
    }
  } else if (config.status !== 1) {
    throw new GitError(`git config failed: ${config.stderr.trim()}`);
  }
  if (cleanup === "verbatim" || cleanup === "whitespace") return raw;
  // With "auto", git picks a comment character that no line starts with, so no line can be told apart as one.
  const auto = comment === "auto";
  let lines = raw.split("\n");
  // git cuts at the scissors line for cleanup=scissors or `-v`. A diff below it is the sign of `-v`.
  const isScissors = (line: string) => /^\S+ -+ >8 -+$/.test(line) && (auto || line.startsWith(comment + " "));
  const scissors = lines.findIndex(isScissors);
  if (scissors >= 0) {
    const below = lines.slice(scissors + 1);
    if (cleanup === "scissors" || below.some((line) => line.startsWith("diff --git "))) lines = lines.slice(0, scissors);
  }
  if (auto || cleanup === "scissors") return lines.join("\n");
  return lines.filter((line) => !line.startsWith(comment)).join("\n");
}

export interface Pushed {
  kind: "message" | "added" | "tag";
  // The commit's short sha, or the tag's name.
  commit: string;
  file?: string;
  text: string;
  // For added lines, each text line's line number in the file.
  lines?: number[];
}

const ZERO = /^0+$/;

export interface PushRange {
  include: string[];
  exclude: string[];
  // Annotated tags being pushed. A tag's message is public even when the remote has its commit.
  tags: string[];
}

// Reads git's pre-push input: one "<local ref> <local sha> <remote ref> <remote sha>" line per ref being pushed.
// The commits to check are those reachable from what's pushed and not already on the remote.
export function pushRange(stdin: string, cwd: string, env: NodeJS.ProcessEnv): PushRange {
  const include: string[] = [];
  const remoteShas: string[] = [];
  for (const line of stdin.split("\n")) {
    if (line.trim() === "") continue;
    const [, localSha, , remoteSha] = line.trim().split(/\s+/);
    if (!localSha || !remoteSha) throw new GitError(`unexpected pre-push input: ${JSON.stringify(line)}`);
    // A deleted branch pushes nothing.
    if (ZERO.test(localSha)) continue;
    include.push(localSha);
    if (!ZERO.test(remoteSha)) remoteShas.push(remoteSha);
  }
  if (include.length === 0) return { include, exclude: [], tags: [] };
  const types = objectTypes([...include, ...remoteShas], cwd, env);
  // The remote's old tip, when it's here too. After a force push it may not be, and the remote's refs cover it.
  const exclude = remoteShas.filter((sha) => types.get(sha) === "commit");
  const tags = include.filter((sha) => types.get(sha) === "tag");
  return { include, exclude, tags };
}

function objectTypes(shas: string[], cwd: string, env: NodeJS.ProcessEnv): Map<string, string> {
  const known = spawnSync("git", ["cat-file", "--batch-check=%(objectname) %(objecttype)"], {
    cwd,
    env,
    input: shas.join("\n") + "\n",
    encoding: "utf8",
  });
  if (known.status !== 0) throw new GitError(`git cat-file failed: ${known.stderr.trim()}`);
  const types = new Map<string, string>();
  for (const line of known.stdout.split("\n")) {
    const [sha, type] = line.split(" ");
    if (sha && type) types.set(sha, type);
  }
  return types;
}

// An annotated tag's name and message, without its signature. A tag of a tag is followed down to the end.
export function tagMessages(sha: string, cwd: string, env: NodeJS.ProcessEnv): Pushed[] {
  const found: Pushed[] = [];
  let next: string | undefined = sha;
  while (next !== undefined && found.length < 100) {
    const raw = git(["cat-file", "tag", next], cwd, env);
    const split = raw.indexOf("\n\n");
    const headers = (split < 0 ? raw : raw.slice(0, split)).split("\n");
    const header = (key: string) => headers.find((h) => h.startsWith(key + " "))?.slice(key.length + 1);
    let message = split < 0 ? "" : raw.slice(split + 2);
    const signature = message.search(/^-----BEGIN (?:PGP|SSH) SIGNATURE-----$/m);
    if (signature >= 0) message = message.slice(0, signature);
    found.push({ kind: "tag", commit: header("tag") ?? next, text: message });
    next = header("type") === "tag" ? header("object") : undefined;
  }
  return found;
}

// Streams each pushed commit's message and the lines it adds, one file at a time. Merge commits show no diff,
// so only their messages are read; the commits they bring in are read on their own.
export async function readPushed(
  range: PushRange,
  remote: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  onText: (pushed: Pushed) => void,
): Promise<void> {
  if (range.include.length === 0) return;
  for (const tag of range.tags) for (const pushed of tagMessages(tag, cwd, env)) onText(pushed);
  const args = [
    "-c", "core.quotePath=false",
    "log", "--no-color", "--no-ext-diff", "--no-textconv", "--diff-merges=off", "-M", "-p", "-U0",
    "--src-prefix=a/", "--dst-prefix=b/", "--format=format:%x01%h%n%B%x02",
    ...range.include, "--not", ...range.exclude, `--remotes=${remote}`, "--",
  ];
  const child = spawn("git", args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
  const exited = new Promise<number | null>((done, fail) => {
    child.on("error", fail);
    child.on("close", done);
  });

  let commit = "";
  let state: "none" | "message" | "header" | "hunk" = "none";
  let message: string[] = [];
  let file: string | undefined;
  let added: string[] = [];
  let lines: number[] = [];
  let next = 0;

  const flushFile = () => {
    if (file !== undefined && added.length > 0) onText({ kind: "added", commit, file, text: added.join("\n"), lines });
    file = undefined;
    added = [];
    lines = [];
  };

  for await (const line of createInterface({ input: child.stdout, crlfDelay: Infinity })) {
    if (line.startsWith("\x01")) {
      flushFile();
      commit = line.slice(1);
      message = [];
      state = "message";
    } else if (state === "message") {
      const end = line.indexOf("\x02");
      if (end < 0) {
        message.push(line);
        continue;
      }
      if (end > 0) message.push(line.slice(0, end));
      onText({ kind: "message", commit, text: message.join("\n") });
      state = "none";
    } else if (line.startsWith("diff --git ")) {
      flushFile();
      state = "header";
    } else if (state === "header") {
      // "+++" names the file only here, before the first hunk. Inside a hunk, "+++x" is an added "++x".
      if (line.startsWith("+++ ")) {
        const name = line.slice(4);
        file = name === "/dev/null" ? undefined : name.replace(/^b\//, "");
      } else if (line.startsWith("@@")) {
        state = "hunk";
        next = hunkStart(line);
      }
    } else if (state === "hunk") {
      if (line.startsWith("@@")) next = hunkStart(line);
      else if (line.startsWith("+")) {
        added.push(line.slice(1));
        lines.push(next++);
      } else if (line.startsWith(" ")) next++;
    }
  }
  flushFile();
  const status = await exited;
  if (status !== 0) throw new GitError(`git log failed: ${stderr.trim()}`);
}

export interface AllowlistChange {
  commit: string;
  file: string;
  deleted: boolean;
  // What a review names to let the change through: the file's blob after the commit, or for a deletion, the
  // commit itself, since the blob it deletes may be one an earlier review already named.
  id: string;
}

// Every change the pushed commits make to a .second-read.toml, in any folder, since the nearest one applies.
// Merge commits are skipped, as readPushed skips them; the commits they bring in are read on their own.
export function allowlistChanges(range: PushRange, remote: string, cwd: string, env: NodeJS.ProcessEnv) {
  const changes: AllowlistChange[] = [];
  if (range.include.length === 0) return changes;
  const out = git(
    [
      "log", "--no-color", "--no-renames", "--diff-merges=off", "--raw", "--no-abbrev", "-z", "--format=format:%x01%H",
      ...range.include, "--not", ...range.exclude, `--remotes=${remote}`, "--",
    ],
    cwd,
    env,
  );
  // With -z: "\x01<commit>\n:<modes> <old> <new> <status>\0<path>\0" and then one more ":…\0<path>\0" per file.
  let commit = "";
  let raw: string[] | undefined;
  for (let token of out.split("\0")) {
    if (raw !== undefined) {
      const [, , , blob, status] = raw;
      const lower = token.toLowerCase();
      // macOS and Windows folders usually ignore case, so ".Second-Read.toml" is found there too.
      if (lower === REPO_FILE || lower.endsWith("/" + REPO_FILE)) {
        const deleted = status === "D";
        changes.push({ commit, file: token, deleted, id: deleted ? commit : blob! });
      }
      raw = undefined;
      continue;
    }
    if (token.startsWith("\x01")) {
      const newline = token.indexOf("\n");
      commit = token.slice(1, newline < 0 ? undefined : newline);
      token = newline < 0 ? "" : token.slice(newline + 1);
    }
    if (token.startsWith(":")) raw = token.slice(1).split(" ");
  }
  return changes;
}

function hunkStart(line: string): number {
  const match = /^@@+ (?:-\S+ )+\+(\d+)/.exec(line);
  return match ? Number(match[1]) : 0;
}
