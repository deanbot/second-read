import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { constants as os } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";

export const HOOKS = ["commit-msg", "pre-push"] as const;
export type HookName = (typeof HOOKS)[number];

export const HOOK_MARKER = "# Added by second-read.";
// A hook that was already there is set aside under this suffix, and second-read's hook runs it after the check.
export const PREVIOUS = ".second-read-previous";

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
  if (result.error) throw new GitError(`can't run ${previous}: ${result.error.message}`);
  return exitStatus(result);
}

export function exitStatus(result: { status: number | null; signal: NodeJS.Signals | null }): number {
  if (result.status !== null) return result.status;
  const number = result.signal ? os.signals[result.signal] : undefined;
  return number === undefined ? 1 : 128 + number;
}

// The text git will commit. With an editor, git drops comment lines and everything below the scissors line,
// which is where `git commit -v` puts the diff. Without one (`git commit -m`), it keeps every line.
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
  const lines = raw.split("\n");
  const kept: string[] = [];
  for (const line of lines) {
    if (/^\S+ -+ >8 -+$/.test(line) && (auto || line.startsWith(comment + " "))) break;
    if (!auto && cleanup !== "scissors" && line.startsWith(comment)) continue;
    kept.push(line);
  }
  return kept.join("\n");
}

export interface Pushed {
  kind: "message" | "added";
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
  // The remote's old tip, when it's here too. After a force push it may not be, and the remote's refs cover it.
  const exclude: string[] = [];
  if (include.length > 0 && remoteShas.length > 0) {
    const known = spawnSync("git", ["cat-file", "--batch-check=%(objectname) %(objecttype)"], {
      cwd,
      env,
      input: remoteShas.join("\n") + "\n",
      encoding: "utf8",
    });
    if (known.status !== 0) throw new GitError(`git cat-file failed: ${known.stderr.trim()}`);
    for (const line of known.stdout.split("\n")) {
      const [sha, type] = line.split(" ");
      if (sha && type === "commit") exclude.push(sha);
    }
  }
  return { include, exclude };
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

function hunkStart(line: string): number {
  const match = /^@@+ (?:-\S+ )+\+(\d+)/.exec(line);
  return match ? Number(match[1]) : 0;
}
