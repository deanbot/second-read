import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  check,
  checkTerms,
  type Finding,
  type Identity,
  KIND_NAMES,
  KINDS,
  type Kind,
  maskTerms,
  type Rules,
} from "./checks.ts";
import {
  CONFIG_DIR_VARIABLE,
  type ConfigFolder,
  configFolder,
  exemptMatcher,
  insideRepository,
  isAccountConfigDir,
  findRepoConfig,
  loadRepoConfig,
  loadUserConfig,
  mergeRules,
  pluginConfigDir,
  USER_FILE,
  USER_FILE_TEMPLATE,
} from "./config.ts";
import { bashPosts, firstUnknown, isGithubTool, mcpPosts, type Post } from "./claude.ts";
import { JUDGING, judgeRefusal, modelCheck } from "./judge.ts";
import { findRealGh, globNames, isShim, parseGh, postNames, postTexts, shimScript } from "./gh.ts";
import {
  type AllowlistChange,
  allowlistChanges,
  commitMessage,
  exitStatus,
  HOOKS,
  type HookName,
  hooksDir,
  hooksInWorkTree,
  installHooks,
  installManaged,
  isManagedDir,
  type Pushed,
  type PushedRef,
  pushRange,
  readPushed,
  refreshManaged,
  runPrevious,
  uninstallHooks,
  uninstallManaged,
} from "./git.ts";
import { UNKNOWN } from "./shell.ts";

export interface Io {
  argv: string[];
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  cwd: string;
  identity: () => Identity;
  // The home folder the OS account names, which no environment variable changes, if there is one.
  accountHome: () => string | undefined;
  // How to run this CLI again (the node binary and the script), for the hooks and the shim to call.
  command: string[];
  readStdin: () => Promise<Buffer>;
  stdinIsTTY?: boolean;
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

class UsageError extends Error {}

// The commands that check text. When one fails, whatever called it refuses the post.
const CHECKS = ["check", "hook", "gh-shim", "claude-hook"];

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
    case "claude-hook":
      if (args.length > 0) throw new UsageError(`claude-hook takes no arguments`);
      return runClaudeHook(io);
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

// Your config and the repository's allowlist, from the repository at `cwd`: the one being posted to. The plugin's
// config_dir option names your config file on purpose, so there a missing one is a mistake, and the check fails
// rather than go on without your terms.
function loadRules(
  io: Io,
  cwd = io.cwd,
  userFile?: string,
): { identity: Identity; rules: Rules; exemptFiles: string[] } {
  const identity = io.identity();
  if (userFile !== undefined && !existsSync(userFile)) {
    throw new Error(
      `second-read's config_dir option is ${dirname(userFile)}, which has no ${USER_FILE}. Put one there, or ` +
        `clear the option in /config or /plugin, so the check can read your private terms`,
    );
  }
  const user = loadUserConfig(userFile ?? defaultUserFile(io));
  const repoPath = findRepoConfig(cwd);
  const repo = repoPath === undefined ? undefined : loadRepoConfig(repoPath, user.terms);
  return { identity, rules: mergeRules(user, repo), exemptFiles: repo?.exemptFiles ?? [] };
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

// `hideTerms` leaves out the text of a private term's finding, for a report an agent reads: the line and column
// say where to fix it. `quote` quotes every other finding's text.
export function report(
  sections: Section[],
  fix: string,
  { hideTerms = false, quote = JSON.stringify as (text: string) => string } = {},
): string {
  const total = sections.reduce((n, s) => n + s.findings.length, 0);
  const count = total === 1 ? "1 finding" : `${total} findings`;
  const rows = (findings: Finding[]) =>
    findings.map((f) => {
      const position = `${f.line}:${f.column}`;
      const category = f.word ? `${f.category} (${f.word})` : f.category;
      const text = hideTerms && f.category === "private term" ? "(not shown)" : quote(f.text);
      return `  ${position.padEnd(7)} ${category.padEnd(22)} ${text}\n`;
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
  if (action === "install" && isManagedDir(dir, io.cwd, io.env)) {
    const managed = refreshManaged(io.cwd, io.env, io.command);
    io.out(
      `second-read: already installed in ${managed.dir}; wrote the hooks again, forwarding to ` +
        `${managed.hooksPath}.\n${list(managed.done)}`,
    );
    return EXIT.clean;
  }
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
  const { identity, rules, exemptFiles } = loadRules(io);
  const exempt = exemptMatcher(exemptFiles);
  let input: Buffer | undefined;
  let sections: Section[];
  let changes: AllowlistChange[] = [];
  const found: PushFound = { commits: 0, tags: new Set(), tagNames: new Set(), names: [] };
  if ((name as HookName) === "commit-msg") {
    const file = gitArgs[0];
    if (file === undefined) throw new Error("commit-msg was given no message file");
    const message = commitMessage(readFileSync(resolve(io.cwd, file), "utf8"), io.cwd, io.env);
    sections = [{ where: KIND_NAMES.commit, findings: check(message, { identity, rules, kind: "commit" }) }];
  } else {
    input = await io.readStdin();
    const range = pushRange(input.toString("utf8"), io.cwd, io.env);
    sections = [];
    for (const ref of range.refs) {
      const findings = checkName(ref.name, identity, rules);
      if (findings.length === 0) continue;
      sections.push({ where: `the name of ${ref.kind} ${ref.name}`, findings });
      found.names.push(ref);
    }
    const tagRefs = new Set(range.refs.filter((r) => r.kind === "tag").map((r) => r.name));
    await readPushed(range, gitArgs[0] ?? "", io.cwd, io.env, (pushed) => {
      // An annotated tag holds its own name, which goes with it whatever the ref is called. Either way the fix is
      // a new tag: rewriting it with git tag -f keeps the name.
      if (pushed.kind === "tag" && tagRefs.has(pushed.commit)) {
        const flagged = found.names.findIndex((r) => r.kind === "tag" && r.name === pushed.commit);
        if (flagged >= 0) {
          found.names.splice(flagged, 1);
          found.tagNames.add(pushed.commit);
        }
      } else if (pushed.kind === "tag") {
        const findings = checkName(pushed.commit, identity, rules);
        if (findings.length > 0) {
          sections.push({ where: `the name written in tag ${pushed.commit}`, findings });
          found.tagNames.add(pushed.commit);
        }
      }
      const findings = checkPushed(pushed, identity, rules, exempt);
      if (findings.length === 0) return;
      sections.push({ where: pushedWhere(pushed), findings });
      if (pushed.kind === "tag") found.tags.add(pushed.commit);
      else found.commits++;
    });
    changes = unreviewed(allowlistChanges(range, gitArgs[0] ?? "", io.cwd, io.env), io.env[ALLOWLIST_REVIEWED]);
  }
  sections = sections.filter((s) => s.findings.length > 0);
  if (sections.length > 0) {
    io.err(report(sections, name === "commit-msg" ? FIX_TEXT : pushFix(found)));
  }
  if (changes.length > 0) io.err(allowlistReport(changes));
  if (sections.length > 0 || changes.length > 0) return EXIT.findings;
  return runPrevious(resolve(io.cwd, hookPath), gitArgs, io.cwd, io.env, input);
}

// Names the versions of .second-read.toml someone has read, by blob id, and the commits that delete one, so a
// push that brings only those goes through. An id stands for that change only: a later change is refused again,
// even with the variable left set.
export const ALLOWLIST_REVIEWED = "SECOND_READ_ALLOWLIST_REVIEWED";

function unreviewed(changes: AllowlistChange[], reviewed: string | undefined): AllowlistChange[] {
  const ids = new Set((reviewed ?? "").toLowerCase().split(/[\s,]+/));
  return changes.filter((c) => !ids.has(c.id.toLowerCase()));
}

// The allowlist decides what the check lets through, and the push is checked against the version it brings.
function allowlistReport(changes: AllowlistChange[]): string {
  const rows = changes.map((c) =>
    c.deleted ? `  commit ${c.commit} deletes ${c.file}\n` : `  commit ${c.commit} changes ${c.file}, blob ${c.id}\n`,
  );
  const ids = [...new Set(changes.map((c) => c.id))].join(" ");
  return (
    `second-read: this push changes the repository's allowlist, which decides what the check lets through.\n` +
    rows.join("") +
    `A person should read each change (git show <commit> -- <file>) before it's pushed. ` +
    `If it's meant, push again with ${ALLOWLIST_REVIEWED}="${ids}"; ` +
    `it covers only these changes.\n`
  );
}

interface PushFound {
  commits: number;
  // Annotated tags whose messages have findings.
  tags: Set<string>;
  // Annotated tags whose own names have findings.
  tagNames: Set<string>;
  // Refs whose names on the remote have findings, but for the annotated tags above.
  names: PushedRef[];
}

function pushFix(found: PushFound): string {
  // A tag that needs a new name gets a new message along with it.
  const tags = [...found.tags].filter((t) => !found.tagNames.has(t)).length;
  const tag = `the ${tags === 1 ? "tag" : "tags"} with git tag -f -a`;
  const fixes: string[] = [];
  if (found.commits > 0) fixes.push(tags > 0 ? `fix the commits, and ${tag}` : "fix the commits");
  else if (tags > 0) fixes.push(`fix ${tag}`);
  if (found.tagNames.size > 0) {
    const noun = found.tagNames.size === 1 ? "the tag" : "the tags";
    fixes.push(`move ${noun} to a clean name (git tag -a <new name> <commit>, then git tag -d <old name>)`);
  }
  if (found.names.length > 0) {
    const kinds = new Set(found.names.map((r) => r.kind));
    const kind = kinds.size === 1 ? [...kinds][0]! : "ref";
    const noun = found.names.length === 1 ? kind : kind === "branch" ? "branches" : `${kind}s`;
    const how: string[] = [];
    if (kinds.has("branch")) how.push("git branch -m");
    if (kinds.has("tag")) how.push("git tag <new name> <old name>");
    fixes.push(`push the ${noun} under a new name${how.length > 0 ? ` (${how.join(", or ")})` : ""}`);
  }
  if (fixes.length === 1 && fixes[0] === "fix the commits") return "fix the commits and push again";
  return `${fixes.join(", ")}, and push again`;
}

// A ref name joins its words with - _ / or . where a message has spaces, and a money phrase of more than one word
// matches only across spaces. So the name is checked again with those read as spaces, which keeps every column
// where it was. Only money comes from that pass: an email or a path in the name has to be read as it is.
function checkName(name: string, identity: Identity, rules: Rules): Finding[] {
  const findings = check(name, { identity, rules, kind: "commit" });
  const spaced = check(name.replace(/[-_/.]/g, " "), { identity, rules, kind: "commit" }).filter(
    (f) => f.category === "money" && !findings.some((g) => f.start < g.end && g.start < f.end),
  );
  if (spaced.length === 0) return findings;
  const quoted = spaced.map((f) => ({ ...f, text: name.slice(f.start, f.end) }));
  return [...findings, ...quoted].sort((a, b) => a.start - b.start);
}

// An exempt file's added lines are checked for private terms and the user's own addresses only, which no
// repository can allow. Messages and tags are always checked in full.
function checkPushed(pushed: Pushed, identity: Identity, rules: Rules, exempt: (file: string) => boolean): Finding[] {
  const findings =
    pushed.kind === "added" && pushed.file !== undefined && exempt(pushed.file)
      ? checkTerms(pushed.text, { identity, rules })
      : check(pushed.text, { identity, rules, kind: "commit" });
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
  const dir = folder === undefined ? join(ownConfigDir(io).dir, "bin") : resolve(io.cwd, folder);
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
    if (post.bodyFiles.includes("-") && !(post.stdinIfPiped && io.stdinIsTTY)) input = await io.readStdin();
    const stdin = input?.toString("utf8") ?? "";
    const texts = postTexts(post, (file) => (file === "-" ? stdin : readFileSync(resolve(io.cwd, file), "utf8")));
    const sections = [
      ...postNames(post, (pattern) => globNames(pattern, io.cwd)).map(([where, name]) => ({
        where,
        findings: checkName(name, identity, rules),
      })),
      ...texts.map(([where, text]) => ({ where, findings: check(text, { identity, rules, kind: post.kind }) })),
    ].filter((s) => s.findings.length > 0);
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

// What the Claude Code plugin's PreToolUse hook runs, with the tool call as JSON on stdin. A post with findings, or
// one that can't be checked, is denied, and the reason goes to Claude. A post the word check passes then goes to
// the model check, unless the user turned it off. Otherwise it prints nothing and the call
// goes on as it would have: allowing it would skip the user's own permission prompt.
//
// The reason goes into the session, so it never holds one of the user's private terms: not in a finding, a file's
// name, a quoted command or the model check's answer. The config is read only for a call that posts something.
async function runClaudeHook(io: Io): Promise<number> {
  const failed = (e: unknown) =>
    `second-read: the check failed, so this call was stopped: ${e instanceof Error ? e.message : String(e)}\n`;
  let reason: string | undefined;
  const userFile = claudeUserFile(io);
  try {
    reason = claudeRefusal(io, JSON.parse((await io.readStdin()).toString("utf8")), userFile);
  } catch (e) {
    reason = failed(e);
  }
  if (reason !== undefined) {
    try {
      if (userFile instanceof Error) throw userFile;
      reason = maskTerms(reason, loadUserConfig(userFile ?? defaultUserFile(io)).terms);
    } catch (e) {
      // Without the terms the reason can't be masked, so it's replaced by why they couldn't be read.
      reason = failed(e);
    }
    const decision = { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason };
    io.out(`${JSON.stringify({ hookSpecificOutput: decision })}\n`);
  }
  return EXIT.clean;
}

// Your config file, unless the plugin's config_dir option names one.
function defaultUserFile(io: Io): string {
  const folder = ownConfigDir(io);
  const path = join(folder.dir, USER_FILE);
  // A missing file is the same as no terms, so a folder that has none, such as / or /var/empty, would switch
  // the term check off wherever the variable that chose it is set, a repository's own settings included. Only the
  // account's own default folder may go without one; a folder that's meant to be empty holds a config.toml with no
  // terms in it.
  if (!folder.own && !existsSync(path)) {
    throw new Error(
      `${folderName(folder)}, which has no ${USER_FILE}, so the check can't tell whether you have private terms. ` +
        `If it's meant to have none, write one with no terms: ${folder.variable}=${shellQuote(folder.value)} ` +
        `second-read init`,
    );
  }
  return path;
}

// Your config folder. A repository's own settings can set every variable that chooses it, so one in any git
// repository is refused, wherever the check runs from: a config there says whatever that repository wants. The
// account's own default folder is the exception, since no repository's settings can choose it.
function ownConfigDir(io: Io): ConfigFolder & { own: boolean } {
  const folder = configFolder(io.env, io.platform, io.identity().home);
  const own = isAccountConfigDir(folder.dir, io.platform, io.accountHome());
  const top = own ? undefined : insideRepository(folder.dir);
  if (top !== undefined) {
    throw new Error(
      `${folderName(folder)}, inside the repository at ${top}. A repository's own settings can set ` +
        `${folder.variable}, so it can't name a folder in a repository; point it outside every repository, or unset it`,
    );
  }
  return { ...folder, own };
}

function folderName({ dir, variable, value }: ConfigFolder): string {
  if (variable === CONFIG_DIR_VARIABLE) return `${variable} is ${dir}`;
  return `${variable} is ${value}, so your config folder is ${dir}`;
}

function shellQuote(text: string): string {
  return /^[\w@%+=:,./~-]+$/.test(text) ? text : `'${text.replaceAll("'", `'\\''`)}'`;
}

// The config file the plugin's config_dir option names, if it's set. An option that can't be read is kept as the
// error, so it stops only the calls that post.
function claudeUserFile(io: Io): string | Error | undefined {
  try {
    const dir = pluginConfigDir(io.env, io.identity().home);
    return dir === undefined ? undefined : join(dir, USER_FILE);
  } catch (e) {
    return e instanceof Error ? e : new Error(String(e));
  }
}

function claudeRefusal(io: Io, call: unknown, userFile: string | Error | undefined): string | undefined {
  if (call === null || typeof call !== "object") throw new Error("the hook was given no tool call");
  const { tool_name: tool, tool_input: input, cwd: callCwd } = call as Record<string, unknown>;
  const cwd = typeof callCwd === "string" ? callCwd : io.cwd;
  let posts: Post[] = [];
  if (tool === "Bash") {
    const command = (input as { command?: unknown } | undefined)?.command;
    if (typeof command !== "string") throw new Error("the Bash call has no command");
    posts = bashPosts(command, cwd, io.env.HOME || io.env.USERPROFILE || cwd);
  } else if (typeof tool === "string" && isGithubTool(tool)) {
    posts = mcpPosts(tool, input, cwd);
  }
  if (posts.length === 0) return undefined;
  if (userFile instanceof Error) throw userFile;
  const unread = posts.filter((p) => p.text.includes(UNKNOWN));
  if (unread.length > 0) {
    const rows = unread.map((p) => `  ${p.where}: ${firstUnknown(p.text)}\n`);
    return (
      `second-read: can't check what this command posts, since the shell fills part of it in only when it runs.\n` +
      rows.join("") +
      `Nothing was posted; write the text out in the command, or in a file passed by its path, and try again.\n`
    );
  }
  const rules = new Map<string, ReturnType<typeof loadRules>>();
  const sections = posts
    .map((post) => {
      if (!rules.has(post.cwd)) rules.set(post.cwd, loadRules(io, post.cwd, userFile));
      const { identity, rules: merged, exemptFiles } = rules.get(post.cwd)!;
      const exempt = post.file !== undefined && exemptMatcher(exemptFiles)(post.file);
      const options = { identity, rules: merged, kind: post.kind };
      if (post.name) return { where: post.where, findings: checkName(post.text, identity, merged) };
      return { where: post.where, findings: exempt ? checkTerms(post.text, options) : check(post.text, options) };
    })
    .filter((s) => s.findings.length > 0);
  // Every post has the same user config, whichever repository it goes to. A value is masked before it's quoted:
  // quoting escapes a newline or a backslash, which would keep a term in it from being found afterwards.
  const terms = [...rules.values()][0]?.rules.terms ?? [];
  const quote = (text: string) => JSON.stringify(maskTerms(text, terms));
  if (sections.length > 0) return report(sections, FIX_TEXT, { hideTerms: true, quote });
  // A file's contents are code, which the word check covers. Everything else is prose the model reads.
  const prose = posts.filter((p) => p.file === undefined).map(({ where, text }) => ({ where, text }));
  const { on, model } = modelCheck(io.env);
  if (!on || prose.length === 0 || io.env[JUDGING]) return undefined;
  const { transcript_path: transcriptPath, prompt_id: promptId } = call as Record<string, unknown>;
  return judgeRefusal(prose, transcriptPath, {
    env: io.env,
    model,
    quote,
    ...(typeof promptId === "string" ? { promptId } : {}),
  });
}

function runInit(io: Io): number {
  const { dir } = ownConfigDir(io);
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
