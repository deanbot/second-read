import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { check, type Finding, type Identity, KINDS, type Kind, type Rules } from "./checks.ts";
import {
  configDir,
  findRepoConfig,
  loadRepoConfig,
  loadUserConfig,
  mergeRules,
  USER_FILE,
  USER_FILE_TEMPLATE,
} from "./config.ts";
import { findRealGh, isShim, parseGh, shimScript } from "./gh.ts";
import {
  commitMessage,
  exitStatus,
  HOOKS,
  type HookName,
  hooksDir,
  hooksInWorkTree,
  installHooks,
  installManaged,
  type Pushed,
  pushRange,
  readPushed,
  runPrevious,
  uninstallHooks,
  uninstallManaged,
} from "./git.ts";

export interface Io {
  argv: string[];
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  cwd: string;
  identity: () => Identity;
  // How to run this CLI again (the node binary and the script), for the hooks and the shim to call.
  command: string[];
  readStdin: () => Promise<Buffer>;
  out: (text: string) => void;
  err: (text: string) => void;
}

export const EXIT = { clean: 0, findings: 1, failed: 2 } as const;

const USAGE = `Usage:
  second-read check [--kind commit|issue|pr|comment|review]   check the text on stdin
  second-read init                                           write your config file
  second-read hooks install|uninstall                        add or remove the git hooks in this repository
  second-read shim install|uninstall [folder]                write or remove the gh shim

check exits 0 when the text is clean, 1 with findings, and 2 when the check itself fails.
`;

const FIX_TEXT = "fix the text and try again";


const KIND_NAMES: Record<Kind, string> = {
  commit: "this commit message",
  issue: "this issue",
  pr: "this pull request",
  comment: "this comment",
  review: "this review",
};

class UsageError extends Error {}

// The commands that check text. When one fails, whatever called it refuses the post.
const CHECKS = ["check", "hook", "gh-shim"];

export async function main(io: Io): Promise<number> {
  try {
    return await run(io);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (e instanceof UsageError) io.err(`second-read: ${message}\n\n${USAGE}`);
    else if (CHECKS.includes(io.argv[0] ?? "")) io.err(`second-read: the check failed: ${message}\n`);
    else io.err(`second-read: ${message}\n`);
    return EXIT.failed;
  }
}

async function run(io: Io): Promise<number> {
  const [command, ...args] = io.argv;
  switch (command) {
    case "check":
      return runCheck(io, parseCheckArgs(args));
    case "init":
      if (args.length > 0) throw new UsageError(`init takes no arguments`);
      return runInit(io);
    case "hooks":
      return runHooks(io, args);
    case "hook":
      return runHook(io, args);
    case "shim":
      return runShimSetup(io, args);
    case "gh-shim":
      return runShim(io, args);
    case "help":
    case "--help":
    case "-h":
      io.out(USAGE);
      return EXIT.clean;
    default:
      throw new UsageError(command === undefined ? "no command given" : `unknown command "${command}"`);
  }
}

function parseCheckArgs(args: string[]): { kind?: Kind } {
  let kind: Kind | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    let value: string | undefined;
    if (arg === "--kind") value = args[++i];
    else if (arg.startsWith("--kind=")) value = arg.slice("--kind=".length);
    else throw new UsageError(`unknown option "${arg}"`);
    if (value === undefined || !(KINDS as readonly string[]).includes(value)) {
      throw new UsageError(`--kind must be one of ${KINDS.join(", ")}`);
    }
    kind = value as Kind;
  }
  return kind === undefined ? {} : { kind };
}

// Your config and the repository's allowlist, from the repository at `io.cwd`: the one being posted to.
function loadRules(io: Io): { identity: Identity; rules: Rules } {
  const identity = io.identity();
  const user = loadUserConfig(join(configDir(io.env, io.platform, identity.home), USER_FILE));
  const repoPath = findRepoConfig(io.cwd);
  const repo = repoPath === undefined ? undefined : loadRepoConfig(repoPath, user.terms);
  return { identity, rules: mergeRules(user, repo) };
}

async function runCheck(io: Io, { kind }: { kind?: Kind }): Promise<number> {
  const { identity, rules } = loadRules(io);
  const text = (await io.readStdin()).toString("utf8");
  const findings = check(text, { identity, rules, ...(kind ? { kind } : {}) });
  if (findings.length === 0) return EXIT.clean;
  io.out(report([{ where: kind ? KIND_NAMES[kind] : "this text", findings }], FIX_TEXT));
  return EXIT.findings;
}

export interface Section {
  where: string;
  findings: Finding[];
}

export function report(sections: Section[], fix: string): string {
  const total = sections.reduce((n, s) => n + s.findings.length, 0);
  const count = total === 1 ? "1 finding" : `${total} findings`;
  const rows = (findings: Finding[]) =>
    findings.map((f) => {
      const position = `${f.line}:${f.column}`;
      const category = f.word ? `${f.category} (${f.word})` : f.category;
      return `  ${position.padEnd(7)} ${category.padEnd(22)} ${JSON.stringify(f.text)}\n`;
    });
  if (sections.length === 1) {
    const [only] = sections as [Section];
    return `second-read: ${count} in ${only.where}. Nothing was changed; ${fix}.\n${rows(only.findings).join("")}`;
  }
  const body = sections.map((s) => `In ${s.where}:\n${rows(s.findings).join("")}`);
  return `second-read: ${count}. Nothing was changed; ${fix}.\n${body.join("")}`;
}

function runHooks(io: Io, args: string[]): number {
  const [action, ...rest] = args;
  if ((action !== "install" && action !== "uninstall") || rest.length > 0) {
    throw new UsageError(`hooks takes "install" or "uninstall"`);
  }
  const list = (done: string[]) => done.map((line) => `  ${line}\n`).join("");
  if (action === "uninstall") {
    const managed = uninstallManaged(io.cwd, io.env);
    if (managed) {
      io.out(`second-read: removed the hooks from this clone.\n${list(managed)}`);
      return EXIT.clean;
    }
  }
  const dir = hooksDir(io.cwd, io.env);
  // The installed hooks name paths on this machine, so they never go in a checked-in hooks folder.
  if (action === "install" && hooksInWorkTree(dir, io.cwd, io.env)) {
    const managed = installManaged(io.cwd, io.env, io.command);
    io.out(
      `second-read: ${managed.hooksPath} is in the work tree, so the hooks went into ${managed.dir}, and ` +
        `core.hooksPath points there now, for this clone only (it was ${JSON.stringify(managed.hooksPath)}).\n` +
        list(managed.done) +
        `Running the repository's own setup step again, if it sets core.hooksPath, turns the guards off; ` +
        `run "second-read hooks install" after it.\n`,
    );
    return EXIT.clean;
  }
  if (action === "install") mkdirSync(dir, { recursive: true });
  const done = action === "install" ? installHooks(dir, io.command) : uninstallHooks(dir);
  io.out(`second-read: ${dir}\n${list(done)}`);
  return EXIT.clean;
}

// What an installed hook runs: `second-read hook <the hook's own path> <git's arguments>`.
async function runHook(io: Io, args: string[]): Promise<number> {
  const [hookPath, ...gitArgs] = args;
  const name = hookPath === undefined ? undefined : basename(hookPath);
  if (hookPath === undefined || !(HOOKS as readonly string[]).includes(name!)) {
    throw new UsageError(`hook is run by the git hooks that "second-read hooks install" adds`);
  }
  const { identity, rules } = loadRules(io);
  let input: Buffer | undefined;
  let sections: Section[];
  const found = { commits: 0, tags: 0 };
  if ((name as HookName) === "commit-msg") {
    const file = gitArgs[0];
    if (file === undefined) throw new Error("commit-msg was given no message file");
    const message = commitMessage(readFileSync(resolve(io.cwd, file), "utf8"), io.cwd, io.env);
    sections = [{ where: KIND_NAMES.commit, findings: check(message, { identity, rules, kind: "commit" }) }];
  } else {
    input = await io.readStdin();
    const range = pushRange(input.toString("utf8"), io.cwd, io.env);
    sections = [];
    await readPushed(range, gitArgs[0] ?? "", io.cwd, io.env, (pushed) => {
      const findings = checkPushed(pushed, identity, rules);
      if (findings.length === 0) return;
      sections.push({ where: pushedWhere(pushed), findings });
      found[pushed.kind === "tag" ? "tags" : "commits"]++;
    });
  }
  sections = sections.filter((s) => s.findings.length > 0);
  if (sections.length > 0) {
    io.err(report(sections, name === "commit-msg" ? FIX_TEXT : pushFix(found)));
    return EXIT.findings;
  }
  return runPrevious(resolve(io.cwd, hookPath), gitArgs, io.cwd, io.env, input);
}

function pushFix({ commits, tags }: { commits: number; tags: number }): string {
  const tag = `the ${tags === 1 ? "tag" : "tags"} with git tag -f -a`;
  if (commits === 0) return `fix ${tag}, and push again`;
  return tags === 0 ? "fix the commits and push again" : `fix the commits, and ${tag}, and push again`;
}

function checkPushed(pushed: Pushed, identity: Identity, rules: Rules): Finding[] {
  const findings = check(pushed.text, { identity, rules, kind: "commit" });
  // Added lines are reported by their line number in the file.
  return pushed.lines ? findings.map((f) => ({ ...f, line: pushed.lines![f.line - 1] ?? f.line })) : findings;
}

function pushedWhere(pushed: Pushed): string {
  if (pushed.kind === "tag") return `the message of tag ${pushed.commit}`;
  return pushed.kind === "message"
    ? `the message of commit ${pushed.commit}`
    : `the lines commit ${pushed.commit} adds to ${pushed.file}`;
}

function runShimSetup(io: Io, args: string[]): number {
  const [action, folder, ...rest] = args;
  if ((action !== "install" && action !== "uninstall") || rest.length > 0) {
    throw new UsageError(`shim takes "install" or "uninstall", and optionally a folder`);
  }
  if (io.platform === "win32") throw new Error("the gh shim is a shell script, and Windows isn't supported yet");
  const dir =
    folder === undefined ? join(configDir(io.env, io.platform, io.identity().home), "bin") : resolve(io.cwd, folder);
  const path = join(dir, "gh");
  const theirs = existsSync(path) && !isShim(path);
  if (action === "uninstall") {
    if (theirs) io.out(`second-read: ${path} isn't the shim; it was left as it is.\n`);
    else if (existsSync(path)) {
      unlinkSync(path);
      io.out(`second-read: removed ${path}.\n`);
    } else io.out(`second-read: there's no shim at ${path}.\n`);
    return EXIT.clean;
  }
  if (theirs) throw new Error(`${path} is already there and isn't the shim; nothing was written`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, shimScript(io.command), { mode: 0o755 });
  io.out(
    `second-read: wrote ${path}.\n` +
      `Put its folder ahead of the real gh on PATH, for example in your shell's startup file:\n\n` +
      `  export PATH=${JSON.stringify(dir)}:"$PATH"\n`,
  );
  return EXIT.clean;
}

// What the shim runs: `second-read gh-shim <the shim's own path> <gh's arguments>`. A posting command is
// checked first; every command then runs the real gh with the same arguments and input.
async function runShim(io: Io, args: string[]): Promise<number> {
  const [shimPath, ...ghArgs] = args;
  if (shimPath === undefined) {
    throw new UsageError(`gh-shim is run by the gh shim that "second-read shim install" writes`);
  }
  const post = parseGh(ghArgs);
  let input: Buffer | undefined;
  if (post) {
    const { identity, rules } = loadRules(io);
    const noun = KIND_NAMES[post.kind];
    const texts: [string, string][] = [
      ...post.title.map((t): [string, string] => [`the title of ${noun}`, t]),
      ...post.body.map((t): [string, string] => [`the body of ${noun}`, t]),
    ];
    for (const file of post.bodyFiles) {
      if (file === "-") {
        input ??= await io.readStdin();
        texts.push([`the body of ${noun}`, input.toString("utf8")]);
      } else texts.push([`the body of ${noun}, from ${file}`, readFileSync(resolve(io.cwd, file), "utf8")]);
    }
    const sections = texts
      .map(([where, text]) => ({ where, findings: check(text, { identity, rules, kind: post.kind }) }))
      .filter((s) => s.findings.length > 0);
    if (sections.length > 0) {
      io.err(report(sections, FIX_TEXT));
      return EXIT.findings;
    }
  }
  const gh = findRealGh(io.env.PATH ?? "", io.cwd, io.platform, [dirname(resolve(io.cwd, shimPath))]);
  if (gh === undefined) {
    io.err(`second-read: can't find the real gh on PATH, after the shim's own folder\n`);
    return 127;
  }
  const result = spawnSync(gh, ghArgs, {
    cwd: io.cwd,
    env: io.env,
    stdio: [input === undefined ? "inherit" : "pipe", "inherit", "inherit"],
    ...(input === undefined ? {} : { input }),
  });
  if (result.error) throw new Error(`can't run ${gh}: ${result.error.message}`);
  return exitStatus(result);
}

function runInit(io: Io): number {
  const dir = configDir(io.env, io.platform, io.identity().home);
  const path = join(dir, USER_FILE);
  if (existsSync(path)) {
    io.out(`second-read: ${path} already exists; it was left as it is.\n`);
    return EXIT.clean;
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(path, USER_FILE_TEMPLATE, { mode: 0o600, flag: "wx" });
  io.out(
    `second-read: wrote ${path}.\n` +
      `Add a private term by putting it in the terms list, one per line:\n\n` +
      `  terms = [\n    "example-private-project",\n  ]\n`,
  );
  return EXIT.clean;
}
