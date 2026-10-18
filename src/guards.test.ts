// Runs the built CLI's git hooks and gh shim in scratch repositories, as a user or agent would meet them.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

const scratch = mkdtempSync(join(tmpdir(), "second-read-guards-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

const TERM = "example-private-project";
const home = join(scratch, "home");
const config = join(scratch, "config");
const gitconfig = join(scratch, "gitconfig");
mkdirSync(home, { recursive: true });
mkdirSync(config, { recursive: true });
writeFileSync(join(config, "config.toml"), `terms = ["${TERM}"]\n`);
writeFileSync(gitconfig, "[user]\n\tname = Example\n\temail = example@example.com\n[init]\n\tdefaultBranch = main\n");

// git and second-read both read only the scratch folder: no global git config, no real second-read config.
const baseEnv: NodeJS.ProcessEnv = {
  PATH: process.env.PATH ?? "",
  HOME: home,
  GIT_CONFIG_GLOBAL: gitconfig,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
  SECOND_READ_CONFIG_DIR: config,
};

let count = 0;
function fresh(name: string): string {
  const dir = join(scratch, `${name}-${++count}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function run(command: string, args: string[], cwd: string, input = "", env: NodeJS.ProcessEnv = {}) {
  const result = spawnSync(command, args, { cwd, input, encoding: "utf8", env: { ...baseEnv, ...env } });
  if (result.error) throw result.error;
  return result;
}

function git(cwd: string, ...args: string[]) {
  const result = run("git", args, cwd);
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
}

function secondRead(cwd: string, args: string[], input = "", env: NodeJS.ProcessEnv = {}) {
  return run(process.execPath, [cli, ...args], cwd, input, env);
}

function repo(): string {
  const dir = fresh("repo");
  git(dir, "init", "-q");
  return dir;
}

function installed(): string {
  const dir = repo();
  assert.equal(secondRead(dir, ["hooks", "install"]).status, 0);
  return dir;
}

function commit(dir: string, message: string, files: Record<string, string> = {}) {
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  run("git", ["add", "-A"], dir);
  return run("git", ["commit", "-q", "--allow-empty", "-m", message], dir);
}

function head(dir: string): string {
  return git(dir, "rev-parse", "HEAD").trim();
}

// A hook that was there before second-read: it notes its arguments and input in a file beside the repository.
function foreignHook(path: string, log: string) {
  writeFileSync(path, `#!/bin/sh\necho "$(basename "$0") $*" >> '${log}'\ncat >> '${log}'\nexit 0\n`, { mode: 0o755 });
}

test("hooks install adds commit-msg and pre-push, and the hooks that were there still run", () => {
  const dir = repo();
  const hooks = join(dir, ".git", "hooks");
  const log = join(fresh("log"), "log");
  foreignHook(join(hooks, "commit-msg"), log);
  const before = readFileSync(join(hooks, "commit-msg"), "utf8");

  const result = secondRead(dir, ["hooks", "install"]);
  assert.equal(result.status, 0, result.stderr);
  for (const name of ["commit-msg", "pre-push"]) {
    assert.match(readFileSync(join(hooks, name), "utf8"), /Added by second-read/);
    assert.ok(statSync(join(hooks, name)).mode & 0o100);
  }
  assert.equal(readFileSync(join(hooks, "commit-msg.second-read-previous"), "utf8"), before);

  assert.equal(commit(dir, "Add the hook (#2)").status, 0);
  assert.match(readFileSync(log, "utf8"), /^commit-msg\.second-read-previous \.git\/COMMIT_EDITMSG/);
});

test("installing twice adds the hooks once, and keeps the hook that was set aside", () => {
  const dir = repo();
  const hooks = join(dir, ".git", "hooks");
  const log = join(fresh("log"), "log");
  foreignHook(join(hooks, "commit-msg"), log);
  const before = readFileSync(join(hooks, "commit-msg"), "utf8");
  assert.equal(secondRead(dir, ["hooks", "install"]).status, 0);
  const second = secondRead(dir, ["hooks", "install"]);
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /already installed/);
  assert.equal(readFileSync(join(hooks, "commit-msg.second-read-previous"), "utf8"), before);
  assert.equal(readFileSync(join(hooks, "commit-msg"), "utf8").split("Added by second-read").length, 2);

  assert.equal(commit(dir, "Add the hook (#2)").status, 0);
  assert.equal(readFileSync(log, "utf8").split("\n").filter((l) => l.startsWith("commit-msg")).length, 1);
});

test("hooks uninstall removes only its own hooks and puts back the one it set aside", () => {
  const dir = repo();
  const hooks = join(dir, ".git", "hooks");
  foreignHook(join(hooks, "commit-msg"), join(scratch, "unused"));
  const before = readFileSync(join(hooks, "commit-msg"), "utf8");
  assert.equal(secondRead(dir, ["hooks", "install"]).status, 0);
  assert.equal(secondRead(dir, ["hooks", "uninstall"]).status, 0);
  assert.equal(readFileSync(join(hooks, "commit-msg"), "utf8"), before);
  assert.ok(!existsSync(join(hooks, "pre-push")));
  assert.ok(!existsSync(join(hooks, "commit-msg.second-read-previous")));

  // A hook that isn't second-read's is never removed.
  const result = secondRead(dir, ["hooks", "uninstall"]);
  assert.match(result.stdout, /commit-msg: left as it is/);
  assert.equal(readFileSync(join(hooks, "commit-msg"), "utf8"), before);
});

test("hooks install respects core.hooksPath", () => {
  const dir = repo();
  const shared = join(fresh("shared-hooks"), "hooks");
  git(dir, "config", "core.hooksPath", shared);
  mkdirSync(join(dir, "sub"));
  assert.equal(secondRead(join(dir, "sub"), ["hooks", "install"]).status, 0);
  assert.ok(existsSync(join(shared, "commit-msg")));
  assert.ok(!existsSync(join(dir, ".git", "hooks", "commit-msg")));
  assert.equal(commit(dir, `Port ${TERM}`).status, 1);
});

// A repository whose hooks are checked in: each one notes its name, arguments, folder and input in a log.
function trackedHooks(names: string[], options: { global?: boolean } = {}) {
  const dir = repo();
  const log = join(fresh("log"), "log");
  mkdirSync(join(dir, ".githooks"));
  const hook = (name: string, version = "") =>
    writeFileSync(
      join(dir, ".githooks", name),
      `#!/bin/sh\necho "${name}${version} $* in $(pwd)" >> '${log}'\n` +
        (name === "pre-push" ? `cat >> '${log}'\n` : "") +
        "exit 0\n",
      { mode: 0o755 },
    );
  for (const name of names) hook(name);
  let env: NodeJS.ProcessEnv = {};
  if (options.global) {
    const global = join(fresh("gitconfig"), "gitconfig");
    copyFileSync(gitconfig, global);
    git(dir, "config", "-f", global, "core.hooksPath", ".githooks");
    env = { GIT_CONFIG_GLOBAL: global };
  } else git(dir, "config", "core.hooksPath", ".githooks");
  const read = () => (existsSync(log) ? readFileSync(log, "utf8") : "");
  return { dir, hook, read, env };
}

test("with a checked-in hooks folder, install puts the hooks inside the git folder, for this clone only", () => {
  const { dir, read } = trackedHooks(["commit-msg", "post-commit"]);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "Add the hooks (#10)");
  const before = read();

  const result = secondRead(dir, ["hooks", "install"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\.githooks is in the work tree, so the hooks went into .*second-read-hooks/);
  assert.match(result.stdout, /for this clone only \(it was "\.githooks"\)/);
  assert.match(result.stdout, /Running the repository's own setup step again, if it sets core\.hooksPath, turns/);
  const managed = git(dir, "config", "--local", "core.hooksPath").trim();
  assert.match(managed, /\.git[\\/]second-read-hooks$/);
  assert.equal(git(dir, "config", "--local", "second-read.previousHooksPath").trim(), ".githooks");
  assert.equal(git(dir, "status", "--porcelain", "--ignored"), "");

  // A refused commit runs none of the repository's hooks.
  assert.equal(commit(dir, `Port ${TERM}`).status, 1);
  assert.equal(read(), before);

  // A commit from a subfolder runs the repository's hooks from the top of the work tree.
  mkdirSync(join(dir, "sub"));
  const top = git(dir, "rev-parse", "--show-toplevel").trim();
  assert.equal(run("git", ["commit", "-q", "--allow-empty", "-m", "Clean (#10)"], join(dir, "sub")).status, 0);
  assert.equal(
    read().slice(before.length),
    `commit-msg .git/COMMIT_EDITMSG in ${top}\npost-commit  in ${top}\n`,
  );
});

test("the repository's hooks keep running as they change, and as new ones are added", () => {
  const { dir, hook, read } = trackedHooks(["commit-msg"]);
  assert.equal(secondRead(dir, ["hooks", "install"]).status, 0);
  hook("commit-msg", "-v2");
  hook("pre-commit");
  assert.equal(commit(dir, "Clean (#10)").status, 0);
  assert.match(read(), /^pre-commit {2}in .*\ncommit-msg-v2 \.git\/COMMIT_EDITMSG in /m);
});

test("the repository's pre-push gets git's input after the check", () => {
  const { dir, read } = trackedHooks(["pre-push"]);
  assert.equal(secondRead(dir, ["hooks", "install"]).status, 0);
  const remote = bareRemote(dir);
  git(dir, "commit", "-q", "--allow-empty", "--no-verify", "-m", `Port ${TERM}`);
  assert.equal(push(dir, "origin", "main").status, 1);
  assert.equal(read(), "");

  git(dir, "commit", "-q", "--amend", "--allow-empty", "--no-verify", "-m", "Clean (#10)");
  assert.equal(push(dir, "origin", "main").status, 0);
  const top = git(dir, "rev-parse", "--show-toplevel").trim();
  assert.equal(
    read(),
    `pre-push origin ${remote} in ${top}\nrefs/heads/main ${head(dir)} refs/heads/main ${"0".repeat(40)}\n`,
  );
});

test("a push with no pre-push of the repository's own goes through, however long git's input", () => {
  const { dir } = trackedHooks([]);
  assert.equal(secondRead(dir, ["hooks", "install"]).status, 0);
  bareRemote(dir);
  assert.equal(commit(dir, "Clean (#10)").status, 0);
  const sha = head(dir);
  const refs = Array.from({ length: 1000 }, (_, i) => `create refs/tags/release-${i} ${sha}\n`).join("");
  assert.equal(run("git", ["update-ref", "--stdin"], dir, refs).status, 0);
  const pushed = push(dir, "origin", "main", "--tags");
  assert.equal(pushed.status, 0, pushed.stderr);
});

test("a linked worktree runs its own copy of the repository's hooks, after the check", () => {
  const { dir, read } = trackedHooks(["commit-msg", "push-to-checkout"]);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "Add the hooks (#10)");
  const installed = secondRead(dir, ["hooks", "install"]);
  assert.match(installed.stdout, /\n {2}warning: the repository's push-to-checkout won't run/);
  const tree = join(fresh("worktree"), "tree");
  git(dir, "worktree", "add", "-q", "-b", "other", tree);
  writeFileSync(join(tree, ".githooks", "commit-msg"), `#!/bin/sh\necho "linked $(pwd)" >> '${join(tree, "log")}'\n`);
  const before = read();

  assert.equal(commit(tree, `Port ${TERM}`).status, 1);
  assert.equal(commit(tree, "Clean (#10)").status, 0);
  const top = git(tree, "rev-parse", "--show-toplevel").trim();
  assert.equal(readFileSync(join(tree, "log"), "utf8"), `linked ${top}\n`);
  assert.equal(read(), before);
});

test("the hooks git runs most often are forwarded only when the repository has them at install", () => {
  const { dir } = trackedHooks(["commit-msg"]);
  const result = secondRead(dir, ["hooks", "install"]);
  assert.match(result.stdout, /reference-transaction and post-index-change: not forwarded, since the repository/);
  const managed = git(dir, "config", "--local", "core.hooksPath").trim();
  assert.ok(!existsSync(join(managed, "reference-transaction")));
  assert.ok(!existsSync(join(managed, "post-index-change")));
  assert.ok(existsSync(join(managed, "post-commit")));

  const other = trackedHooks(["reference-transaction"]);
  const otherInstall = secondRead(other.dir, ["hooks", "install"]);
  assert.match(otherInstall.stdout, /\n {2}post-index-change: not forwarded, since the repository doesn't have it /);
  assert.equal(commit(other.dir, "Clean (#10)").status, 0);
  assert.match(other.read(), /^reference-transaction prepared in /m);
});

test("installing again writes the forwarders again, for hooks the repository has added since", () => {
  const { dir, hook, read } = trackedHooks(["push-to-checkout"]);
  assert.equal(secondRead(dir, ["hooks", "install"]).status, 0);
  const managed = git(dir, "config", "--local", "core.hooksPath").trim();
  hook("post-index-change");
  assert.ok(!existsSync(join(managed, "post-index-change")));

  const again = secondRead(dir, ["hooks", "install"]);
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /already installed in .*; wrote the hooks again, forwarding to \.githooks\./);
  assert.match(again.stdout, /reference-transaction: not forwarded/);
  assert.match(again.stdout, /warning: the repository's push-to-checkout won't run/);
  assert.ok(existsSync(join(managed, "post-index-change")));
  assert.equal(git(dir, "config", "--local", "core.hooksPath").trim(), managed);
  assert.equal(git(dir, "config", "--local", "second-read.previousHooksPath").trim(), ".githooks");
  assert.equal(commit(dir, "Clean (#10)", { "notes.txt": "one\n" }).status, 0);
  assert.match(read(), /^post-index-change /m);
});

test("installing twice keeps the recorded hooks folder, and uninstall puts core.hooksPath back", () => {
  const { dir, read } = trackedHooks(["commit-msg"]);
  assert.equal(secondRead(dir, ["hooks", "install"]).status, 0);
  const managed = git(dir, "config", "--local", "core.hooksPath").trim();
  const second = secondRead(dir, ["hooks", "install"]);
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /already installed/);
  assert.equal(git(dir, "config", "--local", "second-read.previousHooksPath").trim(), ".githooks");

  const result = secondRead(dir, ["hooks", "uninstall"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /core\.hooksPath: back to "\.githooks"/);
  assert.equal(git(dir, "config", "--local", "core.hooksPath").trim(), ".githooks");
  assert.equal(run("git", ["config", "--local", "--get-regexp", "^second-read\\."], dir).stdout, "");
  assert.ok(!existsSync(managed));
  assert.equal(commit(dir, `Port ${TERM}`).status, 0);
  assert.match(read(), /^commit-msg /);
});

test("uninstall unsets core.hooksPath in this clone when it came from the global config", () => {
  const { dir, env } = trackedHooks(["commit-msg"], { global: true });
  assert.equal(run(process.execPath, [cli, "hooks", "install"], dir, "", env).status, 0);
  const again = run(process.execPath, [cli, "hooks", "install"], dir, "", env);
  assert.match(again.stdout, /wrote the hooks again, forwarding to \.githooks\./);
  assert.equal(run("git", ["commit", "-q", "--allow-empty", "-m", `Port ${TERM}`], dir, "", env).status, 1);
  const result = run(process.execPath, [cli, "hooks", "uninstall"], dir, "", env);
  assert.match(result.stdout, /core\.hooksPath: unset in this clone/);
  assert.equal(run("git", ["config", "--local", "core.hooksPath"], dir, "", env).status, 1);
  assert.equal(run("git", ["config", "core.hooksPath"], dir, "", env).stdout.trim(), ".githooks");
});

test("uninstall leaves core.hooksPath alone when the repository's setup step has reset it", () => {
  const { dir } = trackedHooks(["commit-msg"]);
  assert.equal(secondRead(dir, ["hooks", "install"]).status, 0);
  const managed = git(dir, "config", "--local", "core.hooksPath").trim();
  git(dir, "config", "core.hooksPath", "other-hooks");
  const result = secondRead(dir, ["hooks", "uninstall"]);
  assert.match(result.stdout, /left as it is; it no longer points at second-read's hooks/);
  assert.equal(git(dir, "config", "--local", "core.hooksPath").trim(), "other-hooks");
  assert.ok(!existsSync(managed));
});

test("hooks install outside a repository fails", () => {
  const result = secondRead(fresh("plain"), ["hooks", "install"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /^second-read: git rev-parse failed/);
});

test("commit-msg refuses a message with a finding and prints the report", () => {
  const dir = installed();
  const refused = commit(dir, `Port the parser from ${TERM}`);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /1 finding in this commit message/);
  assert.match(refused.stderr, /1:22 +private term +"example-private-project"/);
  assert.equal(run("git", ["rev-parse", "--verify", "-q", "HEAD"], dir).status, 1);

  assert.equal(commit(dir, "Port the parser (#2)").status, 0);
});

// The scratch git config's user.email is example@example.com, which the default allowlist takes in.
test("commit-msg refuses the user's own address, unless their own file names it", () => {
  const dir = installed();
  writeFileSync(join(dir, ".second-read.toml"), 'allowed_emails = ["*@example.com"]\n');
  const signed = run("git", ["commit", "-q", "--allow-empty", "-s", "-m", "Sign off (#14)"], dir);
  assert.equal(signed.status, 1);
  assert.match(signed.stderr, /3:25 +your email +"example@example\.com"/);

  // An address set in the repository doesn't hide the global one.
  git(dir, "config", "user.email", "work@mail-example.co");
  const local = commit(dir, "Ask example@example.com or work@mail-example.co (#14)");
  assert.equal(local.status, 1);
  assert.match(local.stderr, /2 findings in this commit message/);

  const own = fresh("config");
  writeFileSync(join(own, "config.toml"), 'allowed_emails = ["example@example.com", "*@mail-example.co"]\n');
  const allowed = run("git", ["commit", "-q", "--allow-empty", "-s", "-m", "Sign off (#14)"], dir, "", {
    SECOND_READ_CONFIG_DIR: own,
  });
  assert.equal(allowed.status, 1);
  assert.match(allowed.stderr, /1 finding in this commit message.*\n {2}3:\d+ +your email +"work@mail-example\.co"/);
  git(dir, "config", "--unset", "user.email");
  const passed = run("git", ["commit", "-q", "--allow-empty", "-s", "-m", "Sign off (#14)"], dir, "", {
    SECOND_READ_CONFIG_DIR: own,
  });
  assert.equal(passed.status, 0, passed.stderr);
});

test("commit-msg checks what git will commit: no comment lines, nothing below the scissors", () => {
  const dir = installed();
  const editor = join(fresh("editor"), "editor");
  writeFileSync(editor, `#!/bin/sh\n{ echo "$MESSAGE"; cat "$1"; } > "$1.new" && mv "$1.new" "$1"\n`, { mode: 0o755 });
  writeFileSync(join(dir, `${TERM}.txt`), `${TERM}\n`);
  git(dir, "add", "-A");
  // The comments name the staged file, and `-v` puts its diff below the scissors line.
  const env = { GIT_EDITOR: editor, MESSAGE: "Add the notes (#2)" };
  assert.equal(run("git", ["commit", "-q", "-v"], dir, "", env).status, 0);
  const refused = run("git", ["commit", "-q", "-v", "--allow-empty"], dir, "", { ...env, MESSAGE: `Add ${TERM}` });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /1 finding in this commit message/);

  // Without -v, git cuts at the scissors line only for cleanup=scissors, so the lines below it are committed.
  const below = { ...env, MESSAGE: `Notes (#2)\n# ------------------------ >8 ------------------------\n${TERM}` };
  const scissors = run("git", ["commit", "-q", "--allow-empty"], dir, "", below);
  assert.equal(scissors.status, 1);
  assert.match(scissors.stderr, /2:1 +private term/);
  git(dir, "config", "commit.cleanup", "scissors");
  assert.equal(run("git", ["commit", "-q", "--allow-empty"], dir, "", below).status, 0);

  // Without an editor git keeps every line, so a line starting with "#" is checked too.
  assert.equal(commit(dir, `Notes\n\n# ${TERM}`).status, 1);
});

test("every guard refuses when the check itself fails", () => {
  const dir = installed();
  const broken = fresh("broken-config");
  writeFileSync(join(broken, "config.toml"), "terms = [\n");
  const env = { SECOND_READ_CONFIG_DIR: broken };
  const refused = run("git", ["commit", "-q", "--allow-empty", "-m", "Clean (#2)"], dir, "", env);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /the check failed/);

  assert.equal(commit(dir, "Clean (#2)").status, 0);
  const remote = bareRemote(dir);
  const push = run("git", ["push", "-q", "origin", "main"], dir, "", env);
  assert.notEqual(push.status, 0);
  assert.match(push.stderr, /the check failed/);
  assert.equal(run("git", ["rev-parse", "--verify", "-q", "main"], remote).status, 1);
});

test("a hook whose CLI is gone refuses", () => {
  const dir = repo();
  // A copy of the CLI installs the hooks and is then deleted, as an uninstalled package would be.
  const copy = fresh("cli");
  cpSync(dirname(cli), copy, { recursive: true });
  assert.equal(run(process.execPath, [join(copy, "cli.js"), "hooks", "install"], dir).status, 0);
  rmSync(copy, { recursive: true });
  const refused = commit(dir, "Clean (#2)");
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /the CLI this hook runs is gone/);
});

function bareRemote(dir: string): string {
  const remote = fresh("remote");
  git(remote, "init", "-q", "--bare");
  git(dir, "remote", "add", "origin", remote);
  return remote;
}

function push(dir: string, ...args: string[]) {
  return run("git", ["push", "-q", ...args], dir);
}

test("pre-push checks the messages and added lines of the commits being pushed", () => {
  const dir = installed();
  bareRemote(dir);
  assert.equal(commit(dir, "Start (#2)", { "notes.txt": "one\ntwo\nthree\n" }).status, 0);
  assert.equal(push(dir, "origin", "main").status, 0);

  // Written with --no-verify, as if the hooks weren't installed when it was committed.
  writeFileSync(join(dir, "notes.txt"), `one\ntwo\nthree\nfour\nport of ${TERM}\n`);
  git(dir, "commit", "-q", "-a", "--no-verify", "-m", "More notes (#2)");
  const refused = push(dir, "origin", "main");
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /1 finding in the lines commit [0-9a-f]+ adds to notes\.txt/);
  assert.match(refused.stderr, /5:9 +private term/);
  assert.match(refused.stderr, /fix the commits and push again/);

  git(dir, "commit", "-q", "--amend", "--no-verify", "-a", "-m", `More notes from ${TERM}`);
  writeFileSync(join(dir, "notes.txt"), "one\ntwo\nthree\nfour\n");
  git(dir, "commit", "-q", "-a", "--no-verify", "-m", "Take it out (#2)");
  const message = push(dir, "origin", "main");
  assert.equal(message.status, 1);
  assert.match(message.stderr, /In the message of commit [0-9a-f]+:\n {2}1:17 +private term/);
  assert.match(message.stderr, /In the lines commit [0-9a-f]+ adds to notes\.txt:/);
});

test("pre-push reads an added line that starts with ++ as an added line, not a header", () => {
  const dir = installed();
  bareRemote(dir);
  writeFileSync(join(dir, "notes.txt"), `++ ${TERM}\n`);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "--no-verify", "-m", "Notes (#2)");
  const refused = push(dir, "origin", "main");
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /1:4 +private term/);
});

// Pushes a "side" and a "main" that each change the second line of notes.txt, and starts merging side into main.
function conflict(dir: string, side: string, main: string, verify = true) {
  bareRemote(dir);
  assert.equal(commit(dir, "Start (#15)", { "notes.txt": "one\ntwo\nthree\n" }).status, 0);
  git(dir, "switch", "-q", "-c", "side");
  assert.equal(commit(dir, "Side (#15)", { "notes.txt": `one\n${side}\nthree\n` }).status, 0);
  git(dir, "switch", "-q", "main");
  assert.equal(commit(dir, "Main (#15)", { "notes.txt": `one\n${main}\nthree\n` }).status, 0);
  const pushed = push(dir, ...(verify ? [] : ["--no-verify"]), "origin", "main", "side");
  assert.equal(pushed.status, 0, pushed.stderr);
  assert.notEqual(run("git", ["merge", "-q", "side"], dir).status, 0);
}

function resolve(dir: string, file: string, text: string) {
  writeFileSync(join(dir, file), text);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "--no-verify", "--no-edit");
}

test("pre-push checks the lines a conflict resolution adds, by their line number in the file", () => {
  const dir = installed();
  conflict(dir, "side", "main");
  resolve(dir, "notes.txt", `one\nside\nport of ${TERM}\nmain\nthree\n`);
  const short = git(dir, "rev-parse", "--short", "HEAD").trim();
  const refused = push(dir, "origin", "main");
  assert.equal(refused.status, 1);
  const where = `1 finding in the lines commit ${short} adds to notes\\.txt\\. `;
  assert.match(refused.stderr, new RegExp(`${where}.*\\n {2}3:9 +private term`));
  assert.match(refused.stderr, /fix the commits and push again/);
});

test("a merge of clean branches goes through, and so does one that keeps each side's lines as they are", () => {
  const plain = installed();
  bareRemote(plain);
  assert.equal(commit(plain, "Start (#15)", { "notes.txt": "one\ntwo\nthree\n" }).status, 0);
  git(plain, "switch", "-q", "-c", "side");
  assert.equal(commit(plain, "Side (#15)", { "notes.txt": "one\ntwo\nthree, side\n" }).status, 0);
  git(plain, "switch", "-q", "main");
  assert.equal(commit(plain, "Main (#15)", { "notes.txt": "one, main\ntwo\nthree\n" }).status, 0);
  git(plain, "merge", "-q", "--no-ff", "--no-edit", "side");
  const merged = push(plain, "origin", "main", "side");
  assert.equal(merged.status, 0, merged.stderr);

  const clean = installed();
  conflict(clean, "side", "main");
  resolve(clean, "notes.txt", "one\nside\nmain\nthree\n");
  const pushed = push(clean, "origin", "main");
  assert.equal(pushed.status, 0, pushed.stderr);

  // Each side's line is already on the remote, so the merge brings nothing new, even where the line has a finding.
  const dir = installed();
  conflict(dir, `side of ${TERM}`, `main of ${TERM}`, false);
  resolve(dir, "notes.txt", `one\nside of ${TERM}\nmain of ${TERM}\nthree\n`);
  const kept = push(dir, "origin", "main");
  assert.equal(kept.status, 0, kept.stderr);
});

test("pre-push checks the lines an octopus merge adds that are in none of its parents", () => {
  const dir = installed();
  bareRemote(dir);
  assert.equal(commit(dir, "Start (#15)", { "notes.txt": "one\ntwo\n" }).status, 0);
  for (const branch of ["a", "b"]) {
    git(dir, "switch", "-q", "-c", branch, "main");
    writeFileSync(join(dir, `${branch}.txt`), `${branch} of ${TERM}\n`);
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "--no-verify", "-m", `Add ${branch} (#15)`);
  }
  git(dir, "switch", "-q", "main");
  assert.equal(commit(dir, "Main (#15)", { "main.txt": "main\n" }).status, 0);
  assert.equal(push(dir, "--no-verify", "origin", "main", "a", "b").status, 0);

  git(dir, "merge", "-q", "--no-commit", "--no-ff", "a", "b");
  resolve(dir, "notes.txt", `one\nport of ${TERM}\ntwo\n`);
  assert.equal(git(dir, "rev-list", "--parents", "-1", "HEAD").trim().split(" ").length, 4);
  const short = git(dir, "rev-parse", "--short", "HEAD").trim();
  const refused = push(dir, "origin", "main");
  assert.equal(refused.status, 1);
  const where = `1 finding in the lines commit ${short} adds to notes\\.txt\\. `;
  assert.match(refused.stderr, new RegExp(`${where}.*\\n {2}2:9 +private term`));
  assert.doesNotMatch(refused.stderr, /adds to [ab]\.txt/);
});

test("a new branch checks only the commits the remote doesn't have yet", () => {
  const dir = installed();
  bareRemote(dir);
  git(dir, "commit", "-q", "--allow-empty", "--no-verify", "-m", `Old ${TERM}`);
  assert.equal(run("git", ["push", "-q", "--no-verify", "origin", "main"], dir).status, 0);

  git(dir, "switch", "-q", "-c", "feature");
  assert.equal(commit(dir, "Clean (#2)").status, 0);
  const pushed = push(dir, "origin", "feature");
  assert.equal(pushed.status, 0, pushed.stderr);

  git(dir, "switch", "-q", "-c", "other");
  git(dir, "commit", "-q", "--allow-empty", "--no-verify", "-m", `New ${TERM}`);
  const refused = push(dir, "origin", "other");
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /1 finding in the message of commit/);
});

test("a deleted branch is skipped, and a force push checks the commits being pushed", () => {
  const dir = installed();
  const remote = bareRemote(dir);
  assert.equal(commit(dir, "Start (#2)").status, 0);
  git(dir, "switch", "-q", "-c", "feature");
  assert.equal(commit(dir, "Feature (#2)").status, 0);
  assert.equal(push(dir, "origin", "main", "feature").status, 0);

  git(dir, "commit", "-q", "--amend", "--allow-empty", "--no-verify", "-m", `Feature from ${TERM}`);
  const refused = push(dir, "--force", "origin", "feature");
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /1 finding in the message of commit/);

  // The amended commit is still here, but deleting the branch pushes nothing.
  const deleted = push(dir, "origin", "--delete", "feature");
  assert.equal(deleted.status, 0, deleted.stderr);
  assert.equal(run("git", ["rev-parse", "--verify", "-q", "feature"], remote).status, 1);
});

test("pre-push checks the message of an annotated tag, even on a commit the remote has", () => {
  const dir = installed();
  bareRemote(dir);
  assert.equal(commit(dir, "Release (#2)").status, 0);
  assert.equal(push(dir, "origin", "main").status, 0);

  git(dir, "tag", "-a", "v1", "-m", `Ported from ${TERM}`);
  const refused = push(dir, "origin", "v1");
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /1 finding in the message of tag v1\. .*\n {2}1:13 +private term/);
  assert.match(refused.stderr, /fix the tag with git tag -f -a, and push again\./);

  // A commit and a tag together name both fixes.
  git(dir, "commit", "-q", "--allow-empty", "--no-verify", "-m", `More from ${TERM}`);
  const both = push(dir, "origin", "main", "v1");
  assert.equal(both.status, 1);
  assert.match(both.stderr, /fix the commits, and the tag with git tag -f -a, and push again\./);
  git(dir, "reset", "-q", "--hard", "HEAD~1");
  git(dir, "tag", "-f", "-a", "v1", "-m", "First release (#2)");
  assert.equal(push(dir, "origin", "v1").status, 0);

  git(dir, "tag", "v2");
  assert.equal(push(dir, "origin", "v2").status, 0);
});

test("pre-push checks the name a push gives each branch and tag on the remote", () => {
  const dir = installed();
  const remote = bareRemote(dir);
  assert.equal(commit(dir, "Start (#11)").status, 0);
  assert.equal(push(dir, "origin", "main").status, 0);

  git(dir, "switch", "-q", "-c", `feature/${TERM}`);
  const refused = push(dir, "origin", `feature/${TERM}`);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, new RegExp(`1 finding in the name of branch feature/${TERM}\\. .*\\n {2}1:9 +private term`));
  assert.match(refused.stderr, /push the branch under a new name \(git branch -m\), and push again\./);
  assert.equal(run("git", ["rev-parse", "--verify", "-q", `feature/${TERM}`], remote).status, 1);

  // Only the remote name is sent.
  const renamed = push(dir, "origin", "HEAD:feature/clean");
  assert.equal(renamed.status, 0, renamed.stderr);

  git(dir, "commit", "-q", "--allow-empty", "--no-verify", "-m", `More from ${TERM}`);
  const both = push(dir, "origin", `feature/${TERM}`);
  assert.equal(both.status, 1);
  assert.match(both.stderr, /fix the commits, push the branch under a new name .*, and push again\./);

  // A lightweight tag on a commit the remote has brings no commits, and its name is still checked.
  git(dir, "tag", `${TERM}-v1`, "main");
  const tag = push(dir, "origin", `${TERM}-v1`);
  assert.equal(tag.status, 1);
  assert.match(tag.stderr, new RegExp(`1 finding in the name of tag ${TERM}-v1\\.`));
  assert.match(tag.stderr, /push the tag under a new name \(git tag <new name> <old name>\), and push again\./);

  git(dir, "update-ref", `refs/notes/${TERM}`, "main");
  const ref = push(dir, "origin", `refs/notes/${TERM}`);
  assert.equal(ref.status, 1);
  assert.match(ref.stderr, new RegExp(`the name of ref refs/notes/${TERM}\\.`));
  assert.match(ref.stderr, /push the ref under a new name, and push again\./);

  const mixed = push(dir, "origin", `feature/${TERM}`, `${TERM}-v1`);
  assert.equal(mixed.status, 1);
  assert.match(mixed.stderr, /push the refs under a new name \(git branch -m, or git tag <new name> <old name>\)/);
});

test("a name joined with hyphens or slashes is read with spaces for money phrases, and quoted as it is", () => {
  const dir = installed();
  bareRemote(dir);
  assert.equal(commit(dir, "Start (#11)").status, 0);
  const names: [string, number, string, string][] = [
    ["paid-plan", 1, "plan", "paid-plan"],
    ["fix/upgrade_my.plan", 5, "plan", "upgrade_my.plan"],
    ["credit-card", 1, "card", "credit-card"],
    ["usage-limits", 1, "usage limit", "usage-limits"],
  ];
  for (const [branch, column, word, text] of names) {
    const refused = push(dir, "origin", `main:${branch}`);
    assert.equal(refused.status, 1, branch);
    assert.match(refused.stderr, new RegExp(`\\n {2}1:${column} +money \\(${word}\\) +"${text}"\\n`));
  }
});

test("a branch whose name is already on the remote is refused on update, and can be deleted", () => {
  const dir = installed();
  const remote = bareRemote(dir);
  git(dir, "switch", "-q", "-c", TERM);
  assert.equal(commit(dir, "Start (#11)").status, 0);
  assert.equal(run("git", ["push", "-q", "--no-verify", "origin", TERM], dir).status, 0);

  assert.equal(commit(dir, "More (#11)").status, 0);
  const refused = push(dir, "origin", TERM);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, new RegExp(`in the name of branch ${TERM}\\.`));

  const deleted = push(dir, "origin", "--delete", TERM);
  assert.equal(deleted.status, 0, deleted.stderr);
  assert.equal(run("git", ["rev-parse", "--verify", "-q", TERM], remote).status, 1);
});

test("pre-push checks the name written in an annotated tag, whatever the remote calls it", () => {
  const dir = installed();
  bareRemote(dir);
  assert.equal(commit(dir, "Release (#11)").status, 0);
  git(dir, "tag", "-a", TERM, "-m", "First release (#11)");
  const refused = push(dir, "origin", `refs/tags/${TERM}:refs/tags/v1`);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, new RegExp(`1 finding in the name written in tag ${TERM}\\.`));
  const move = new RegExp(
    String.raw`move the tag to a clean name \(git tag -a <new name> <commit>, then git tag -d <old name>\), ` +
      String.raw`and push again\.`,
  );
  assert.match(refused.stderr, move);

  // Rewriting it keeps the name, so it's refused again.
  git(dir, "tag", "-f", "-a", TERM, "-m", "First release, again (#11)");
  assert.match(push(dir, "origin", `refs/tags/${TERM}:refs/tags/v1`).stderr, move);

  // A tag pushed under its own name is reported once, with the same fix.
  const same = push(dir, "origin", TERM);
  assert.equal(same.status, 1);
  assert.match(same.stderr, new RegExp(`1 finding in the name of tag ${TERM}\\.`));
  assert.match(same.stderr, move);

  // A new tag takes a new message too, so a finding in both is one fix.
  git(dir, "tag", "-f", "-a", TERM, "-m", `Ported from ${TERM}`);
  const twice = push(dir, "origin", `refs/tags/${TERM}:refs/tags/v1`);
  assert.equal(twice.status, 1);
  assert.match(twice.stderr, /2 findings\. Nothing was changed; move the tag to a clean name .*, and push again\./);
  assert.doesNotMatch(twice.stderr, /git tag -f -a/);

  // Following the fix goes through.
  git(dir, "tag", "-a", "v1", "HEAD", "-m", "First release (#11)");
  git(dir, "tag", "-d", TERM);
  const clean = push(dir, "origin", "v1");
  assert.equal(clean.status, 0, clean.stderr);
});

test("pre-push passes git's input on to the hook it set aside", () => {
  const dir = repo();
  const log = join(fresh("log"), "log");
  foreignHook(join(dir, ".git", "hooks", "pre-push"), log);
  assert.equal(secondRead(dir, ["hooks", "install"]).status, 0);
  const remote = bareRemote(dir);
  assert.equal(commit(dir, "Start (#2)").status, 0);
  assert.equal(push(dir, "origin", "main").status, 0);
  const sha = head(dir);
  assert.equal(
    readFileSync(log, "utf8"),
    `pre-push.second-read-previous origin ${remote}\nrefs/heads/main ${sha} refs/heads/main ${"0".repeat(40)}\n`,
  );
});

test("the repository's allowlist comes from the repository the hook runs in", () => {
  const dir = installed();
  writeFileSync(join(dir, ".second-read.toml"), 'allowed_words = ["billing"]\n');
  assert.equal(commit(dir, "Fix the billing page (#2)").status, 0);
  rmSync(join(dir, ".second-read.toml"));
  assert.equal(commit(dir, "Fix the billing page again (#2)").status, 1);
});

function blob(dir: string, rev: string): string {
  return git(dir, "rev-parse", rev).trim();
}

function pushReviewed(dir: string, ids: string, ...args: string[]) {
  return run("git", ["push", "-q", ...args], dir, "", { SECOND_READ_ALLOWLIST_REVIEWED: ids });
}

test("pre-push refuses a change to the repository's allowlist until its blob id is given", () => {
  const dir = installed();
  bareRemote(dir);
  assert.equal(commit(dir, "Start (#7)", { "notes.txt": "one\n" }).status, 0);
  assert.equal(push(dir, "origin", "main").status, 0);

  assert.equal(commit(dir, "Allow a word (#7)", { ".second-read.toml": 'allowed_words = ["billing"]\n' }).status, 0);
  const id = blob(dir, "HEAD:.second-read.toml");
  const refused = push(dir, "origin", "main");
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /this push changes the repository's allowlist/);
  assert.match(refused.stderr, new RegExp(`commit [0-9a-f]+ changes \\.second-read\\.toml, blob ${id}\\n`));
  assert.match(refused.stderr, new RegExp(`SECOND_READ_ALLOWLIST_REVIEWED="${id}"`));

  // Any other value, "1" included, is refused too.
  for (const value of ["1", "0".repeat(40)]) {
    assert.equal(pushReviewed(dir, value, "origin", "main").status, 1);
  }
  const pushed = pushReviewed(dir, id, "origin", "main");
  assert.equal(pushed.status, 0, pushed.stderr);

  // The id covers that version only: a later change is refused even with the variable left set.
  const more = 'allowed_words = ["billing"]\nallowed_paths = ["~/.config/example-tool"]\n';
  assert.equal(commit(dir, "Allow more (#7)", { ".second-read.toml": more }).status, 0);
  const later = pushReviewed(dir, id, "origin", "main");
  assert.equal(later.status, 1);
  assert.match(later.stderr, new RegExp(`blob ${blob(dir, "HEAD:.second-read.toml")}`));
});

test("the review still checks everything else the push brings", () => {
  const dir = installed();
  bareRemote(dir);
  assert.equal(commit(dir, "Start (#7)").status, 0);
  git(dir, "switch", "-q", "-c", "feature");
  writeFileSync(join(dir, ".second-read.toml"), 'allowed_words = ["billing"]\n');
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "--no-verify", "-m", `Allow a word for ${TERM}`);
  const id = blob(dir, "HEAD:.second-read.toml");
  const both = push(dir, "origin", "feature");
  assert.equal(both.status, 1);
  assert.match(both.stderr, /1 finding in the message of commit/);
  assert.match(both.stderr, /this push changes the repository's allowlist/);
  const refused = pushReviewed(dir, id, "origin", "feature");
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /private term/);
  assert.doesNotMatch(refused.stderr, /allowlist/);
});

test("pre-push sees an allowlist in a subfolder, a change that only removes lines, a rename and a deletion", () => {
  const dir = installed();
  bareRemote(dir);
  mkdirSync(join(dir, "sub"));
  const list = ["allowed_paths = [", '  "~/.config/one",', '  "~/.config/two",', "]", ""];
  assert.equal(commit(dir, "Start (#7)", { "sub/allow.txt": list.join("\n") }).status, 0);
  assert.equal(push(dir, "origin", "main").status, 0);
  const file = join(dir, "sub", ".second-read.toml");
  const cases: [string, () => void][] = [
    ["rename", () => git(dir, "mv", "sub/allow.txt", "sub/.second-read.toml")],
    ["remove a line", () => writeFileSync(file, list.toSpliced(2, 1).join("\n"))],
  ];
  for (const [what, change] of cases) {
    change();
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "--no-verify", "-m", `${what} (#7)`);
    const id = blob(dir, "HEAD:sub/.second-read.toml");
    const refused = push(dir, "origin", "main");
    assert.equal(refused.status, 1, what);
    assert.match(refused.stderr, new RegExp(`changes sub/\\.second-read\\.toml, blob ${id}\\n`), what);
    const pushed = pushReviewed(dir, id, "origin", "main");
    assert.equal(pushed.status, 0, `${what}: ${pushed.stderr}`);
  }

  // A deletion is named by its commit, so the id of the version it deletes, if it's still set, doesn't cover it.
  const last = blob(dir, "HEAD:sub/.second-read.toml");
  git(dir, "rm", "-q", "sub/.second-read.toml");
  git(dir, "commit", "-q", "--no-verify", "-m", "Delete (#7)");
  const stale = pushReviewed(dir, last, "origin", "main");
  assert.equal(stale.status, 1);
  assert.match(stale.stderr, new RegExp(`commit ${head(dir)} deletes sub/\\.second-read\\.toml\\n`));
  assert.match(stale.stderr, new RegExp(`SECOND_READ_ALLOWLIST_REVIEWED="${head(dir)}"`));
  const pushed = pushReviewed(dir, head(dir), "origin", "main");
  assert.equal(pushed.status, 0, pushed.stderr);
});

test("pre-push refuses a merge whose resolution writes a new allowlist, but not one that takes a side's", () => {
  const dir = installed();
  bareRemote(dir);
  const file = join(dir, ".second-read.toml");
  assert.equal(commit(dir, "Start (#7)", { ".second-read.toml": "allowed_paths = []\n" }).status, 0);
  assert.equal(pushReviewed(dir, blob(dir, "HEAD:.second-read.toml"), "origin", "main").status, 0);
  git(dir, "switch", "-q", "-c", "side");
  writeFileSync(file, 'allowed_paths = ["~/.config/one"]\n');
  git(dir, "commit", "-q", "-a", "--no-verify", "-m", "Side (#7)");
  git(dir, "switch", "-q", "main");
  writeFileSync(file, 'allowed_paths = ["~/.config/two"]\n');
  git(dir, "commit", "-q", "-a", "--no-verify", "-m", "Main (#7)");
  // Each side's version is reviewed and pushed.
  const sides = `${blob(dir, "main:.second-read.toml")} ${blob(dir, "side:.second-read.toml")}`;
  assert.equal(pushReviewed(dir, sides, "origin", "main", "side").status, 0);

  assert.notEqual(run("git", ["merge", "-q", "side"], dir).status, 0);
  writeFileSync(file, 'allowed_paths = ["~/.config/one", "~/.config/two", "~/.config/three"]\n');
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "--no-verify", "--no-edit");
  const id = blob(dir, "HEAD:.second-read.toml");
  const refused = pushReviewed(dir, sides, "origin", "main");
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, new RegExp(`commit ${head(dir)} changes \\.second-read\\.toml, blob ${id}\\n`));
  assert.equal(pushReviewed(dir, id, "origin", "main").status, 0);

  // A merge that takes one side's version unchanged brings nothing new to read.
  git(dir, "reset", "-q", "--hard", "HEAD~1");
  git(dir, "switch", "-q", "-c", "other");
  assert.notEqual(run("git", ["merge", "-q", "side"], dir).status, 0);
  git(dir, "checkout", "-q", "--theirs", ".second-read.toml");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "--no-verify", "--no-edit");
  const pushed = push(dir, "origin", "other");
  assert.equal(pushed.status, 0, pushed.stderr);
});

test("pre-push names a file with a space in it as it is", () => {
  const dir = installed();
  bareRemote(dir);
  mkdirSync(join(dir, "sub dir"));
  writeFileSync(join(dir, "sub dir", "notes.txt"), `${TERM}\n`);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "--no-verify", "-m", "Notes (#7)");
  const refused = push(dir, "origin", "main");
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /adds to sub dir\/notes\.txt\. /);
});

test("a blanket entry in the repository's allowlist fails the check", () => {
  const dir = installed();
  writeFileSync(join(dir, ".second-read.toml"), 'allowed_paths = ["~"]\n');
  const refused = commit(dir, "Clean (#7)");
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /the check failed: .*allowed_paths entry "~"/);
  const checked = secondRead(dir, ["check"], "Clean\n");
  assert.equal(checked.status, 2);
});

// Lines a repository's tests might hold on purpose: money, a home path, a temp folder and an email.
const FIXTURE =
  'const plan = "Upgrade to the paid plan for $20 a month";\nconst saved = "~/notes/today.md";\n' +
  'const log = "/tmp/out.log";\nconst to = "someone@corp.co";\n';

test("pre-push checks an exempt file's added lines for private terms only", () => {
  const dir = installed();
  bareRemote(dir);
  mkdirSync(join(dir, "src"));
  const exempt = { ".second-read.toml": 'exempt_files = ["src/**/*.test.ts"]\n' };
  assert.equal(commit(dir, "Exempt the tests (#9)", exempt).status, 0);
  // Adding an exemption is a change to the allowlist, so it waits for a review like any other.
  assert.match(push(dir, "origin", "main").stderr, /this push changes the repository's allowlist/);
  assert.equal(pushReviewed(dir, blob(dir, "HEAD:.second-read.toml"), "origin", "main").status, 0);

  assert.equal(commit(dir, "Add tests (#9)", { "src/a.test.ts": FIXTURE }).status, 0);
  const pushed = push(dir, "origin", "main");
  assert.equal(pushed.status, 0, pushed.stderr);

  assert.equal(commit(dir, "Add code (#9)", { "src/a.ts": FIXTURE }).status, 0);
  const refused = push(dir, "origin", "main");
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /5 findings in the lines commit [0-9a-f]+ adds to src\/a\.ts\. /);
  git(dir, "reset", "-q", "--hard", "HEAD~1");

  // A private term is found even inside a path, where the full check reports only the path.
  assert.equal(commit(dir, "Add more tests (#9)", { "src/b.test.ts": `const dir = "/tmp/${TERM}/x";\n` }).status, 0);
  const term = push(dir, "origin", "main");
  assert.equal(term.status, 1);
  assert.match(term.stderr, /1 finding in the lines commit \w+ adds to src\/b\.test\.ts\. .*\n {2}1:19 +private term/);
  git(dir, "reset", "-q", "--hard", "HEAD~1");

  // So is the user's own address.
  const own = { "src/b.test.ts": 'const to = "example@example.com";\n' };
  assert.equal(commit(dir, "Add more tests (#14)", own).status, 0);
  const email = push(dir, "origin", "main");
  assert.equal(email.status, 1);
  assert.match(email.stderr, /1 finding in the lines commit \w+ adds to src\/b\.test\.ts\. .*\n {2}1:13 +your email/);
  git(dir, "reset", "-q", "--hard", "HEAD~1");

  // Messages are checked in full, whatever files the commit touches.
  writeFileSync(join(dir, "src", "c.test.ts"), FIXTURE);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "--no-verify", "-m", "Test the paid plan page (#9)");
  const message = push(dir, "origin", "main");
  assert.equal(message.status, 1);
  assert.match(message.stderr, /1 finding in the message of commit [0-9a-f]+\. .*\n {2}1:10 +money \(plan\)/);
  git(dir, "reset", "-q", "--hard", "HEAD~1");

  git(dir, "tag", "-a", "v1", "-m", "Paid plan tests");
  assert.match(push(dir, "origin", "v1").stderr, /1 finding in the message of tag v1\./);
});

test("a conflict resolution in an exempt file is checked for private terms only", () => {
  const dir = installed();
  bareRemote(dir);
  mkdirSync(join(dir, "src"));
  assert.equal(commit(dir, "Exempt the tests (#15)", { ".second-read.toml": 'exempt_files = ["src/**"]\n' }).status, 0);
  assert.equal(pushReviewed(dir, blob(dir, "HEAD:.second-read.toml"), "origin", "main").status, 0);
  assert.equal(commit(dir, "Start (#15)", { "src/a.test.ts": "one\n" }).status, 0);
  git(dir, "switch", "-q", "-c", "side");
  assert.equal(commit(dir, "Side (#15)", { "src/a.test.ts": "side\n" }).status, 0);
  git(dir, "switch", "-q", "main");
  assert.equal(commit(dir, "Main (#15)", { "src/a.test.ts": "main\n" }).status, 0);
  assert.equal(push(dir, "origin", "main", "side").status, 0);

  assert.notEqual(run("git", ["merge", "-q", "side"], dir).status, 0);
  resolve(dir, "src/a.test.ts", FIXTURE);
  const pushed = push(dir, "origin", "main");
  assert.equal(pushed.status, 0, pushed.stderr);

  git(dir, "switch", "-q", "-c", "other", "main~1");
  assert.notEqual(run("git", ["merge", "-q", "side"], dir).status, 0);
  resolve(dir, "src/a.test.ts", `const dir = "/tmp/${TERM}/x";\n`);
  const refused = push(dir, "origin", "other");
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /1 finding in the lines commit \w+ adds to src\/a\.test\.ts\. .*\n {2}1:19 +private/);
});

test("the check and the gh shim read an exempt file in full", () => {
  const { cwd, gh, called } = shimSetup();
  mkdirSync(join(cwd, "src"));
  writeFileSync(join(cwd, ".second-read.toml"), 'exempt_files = ["src/**"]\n');
  writeFileSync(join(cwd, "src", "body.md"), FIXTURE);
  const checked = secondRead(cwd, ["check"], FIXTURE);
  assert.equal(checked.status, 1);
  assert.match(checked.stdout, /5 findings in this text/);
  const refused = gh(["pr", "create", "--title", "Tests (#9)", "--body-file", "src/body.md"]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /5 findings in the body of this pull request, from src\/body\.md/);
  // A gist is a post of its own, so the files it uploads are never exempt.
  const gist = gh(["gist", "create", "src/body.md"]);
  assert.equal(gist.status, 1);
  assert.match(gist.stderr, /5 findings in the contents of this gist, from src\/body\.md/);
  assert.ok(!called());
});

test("an exempt_files glob that takes in every file fails the check", () => {
  const dir = installed();
  writeFileSync(join(dir, ".second-read.toml"), 'exempt_files = ["**"]\n');
  const refused = commit(dir, "Clean (#9)");
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /the check failed: .*exempt_files entry "\*\*" is made only of wildcards/);
  assert.equal(secondRead(dir, ["check"], "Clean\n").status, 2);
});

// The shim, in a folder ahead of a fake gh that notes its arguments and input and exits 3.
function shimSetup() {
  const shimDir = fresh("shim");
  const fakeDir = fresh("fake-gh");
  const log = join(fakeDir, "log");
  writeFileSync(
    join(fakeDir, "gh"),
    `#!/bin/sh\nprintf '%s\\n' "$@" > '${log}.args'\ncat > '${log}.stdin'\nexit 3\n`,
    { mode: 0o755 },
  );
  const installed = secondRead(scratch, ["shim", "install", shimDir]);
  assert.equal(installed.status, 0, installed.stderr);
  const cwd = repo();
  const PATH = [shimDir, fakeDir, process.env.PATH ?? ""].join(delimiter);
  const gh = (args: string[], input = "", env: NodeJS.ProcessEnv = {}) =>
    run(join(shimDir, "gh"), args, cwd, input, { PATH, ...env });
  const called = () => existsSync(`${log}.args`);
  const args = () => readFileSync(`${log}.args`, "utf8");
  const stdin = () => readFileSync(`${log}.stdin`, "utf8");
  return { shimDir, fakeDir, cwd, PATH, gh, called, args, stdin };
}

test("the gh shim refuses a post with a finding, and never runs gh", () => {
  const { gh, called } = shimSetup();
  const cases: string[][] = [
    ["issue", "create", "--title", `Port ${TERM}`, "--body", "Clean"],
    ["issue", "new", "-t", "Clean", "-b", `Port ${TERM}`],
    ["issue", "edit", "4", `--body=Port ${TERM}`],
    ["issue", "comment", "4", `-bPort ${TERM}`],
    ["pr", "create", "-t=Clean", "--body", `Port ${TERM}`],
    ["pr", "new", "--title", `Port ${TERM}`],
    ["pr", "edit", "5", "-t", `Port ${TERM}`],
    ["pr", "comment", "5", "--body", `Port ${TERM}`],
    ["pr", "review", "5", "--comment", "-b", `Port ${TERM}`],
    ["issue", "-R", "example/repo", "create", "-t", `Port ${TERM}`],
    ["issue", "close", "4", "--comment", `Port ${TERM}`],
    ["issue", "reopen", "4", `-cPort ${TERM}`],
    ["pr", "close", "5", "-d", "-c", `Port ${TERM}`],
    ["pr", "reopen", "5", `--comment=Port ${TERM}`],
    ["pr", "merge", "5", "--squash", "--subject", `Port ${TERM}`],
    ["pr", "merge", "5", "-t", "Clean", "-b", `Port ${TERM}`],
    ["release", "create", "v1", "--title", `Port ${TERM}`],
    ["release", "new", "v1", "-d", "-n", `Port ${TERM}`],
    ["release", "edit", "v1", `--notes=Port ${TERM}`],
    ["gist", "create", "--public", "-d", `Port ${TERM}`],
    ["gist", "edit", "abc123", `--desc=Port ${TERM}`],
    ["label", "create", TERM, "--color", "ff0000"],
    ["label", "create", "-c", "ff0000", "-f", "bug", "--description", `Port ${TERM}`],
    ["label", "edit", "bug", "--name", TERM],
    ["label", "edit", "bug", `-dPort ${TERM}`],
    ["repo", "create", "example/repo", "--private", "-d", `Port ${TERM}`],
    ["repo", "edit", `--description=Port ${TERM}`],
  ];
  for (const args of cases) {
    const result = gh(args);
    assert.equal(result.status, 1, args.join(" "));
    assert.match(result.stderr, /private term +"example-private-project"/, args.join(" "));
    assert.equal(result.stdout, "");
  }
  assert.ok(!called());
});

test("the gh shim names the title and the body apart", () => {
  const { gh } = shimSetup();
  const result = gh(["pr", "create", "--title", `Port ${TERM}`, "--body", `From ${TERM}`]);
  assert.match(result.stderr, /^second-read: 2 findings\. /);
  assert.match(result.stderr, /In the title of this pull request:\n {2}1:6 /);
  assert.match(result.stderr, /In the body of this pull request:\n {2}1:6 /);
});

test("the gh shim checks body files and stdin bodies", () => {
  const { gh, cwd, called } = shimSetup();
  writeFileSync(join(cwd, "body.md"), `Port ${TERM}\n`);
  const fromFile = gh(["issue", "comment", "4", "--body-file", "body.md"]);
  assert.equal(fromFile.status, 1);
  assert.match(fromFile.stderr, /in the body of this comment, from body\.md/);
  const fromStdin = gh(["pr", "review", "5", "--approve", "-F", "-"], `Looks good.\n\nPort ${TERM}\n`);
  assert.equal(fromStdin.status, 1);
  assert.match(fromStdin.stderr, /3:6 +private term/);
  assert.ok(!called());
});

test("the gh shim checks release notes files and the files a gist uploads", () => {
  const { gh, cwd, called } = shimSetup();
  writeFileSync(join(cwd, "notes.md"), `Port ${TERM}\n`);
  const notes = gh(["release", "create", "v1", "-F", "notes.md"]);
  assert.equal(notes.status, 1);
  assert.match(notes.stderr, /in the notes of this release, from notes\.md/);
  writeFileSync(join(cwd, "clean.md"), "Clean\n");
  const files = gh(["gist", "create", "clean.md", "notes.md"]);
  assert.equal(files.status, 1);
  assert.match(files.stderr, /in the contents of this gist, from notes\.md/);
  const added = gh(["gist", "edit", "abc123", "--add", "notes.md"]);
  assert.equal(added.status, 1);
  assert.match(added.stderr, /in the contents of this gist, from notes\.md/);
  for (const args of [["gist", "create"], ["gist", "create", "-"], ["gist", "edit", "abc123", "-a", "new.md", "-"]]) {
    const piped = gh(args, `Port ${TERM}\n`);
    assert.equal(piped.status, 1, args.join(" "));
    assert.match(piped.stderr, /1 finding in the contents of this gist\. .*\n {2}1:6 +private term/, args.join(" "));
  }
  assert.ok(!called());
  assert.equal(gh(["gist", "create", "clean.md", "-d", "Clean"]).status, 3);
  assert.equal(gh(["label", "create", "bug", "-d", "Something is broken"]).status, 3);
});

test("the gh shim runs the real gh with the same arguments and input, and returns its exit code", () => {
  const { gh, args, stdin } = shimSetup();
  const argv = ["pr", "create", "--title", "Add the guards (#2)", "--body-file", "-", "--draft"];
  const body = "What changed.\n\nCloses #2\n";
  const result = gh(argv, body);
  assert.equal(result.status, 3, result.stderr);
  assert.equal(args(), argv.join("\n") + "\n");
  assert.equal(stdin(), body);
});

test("any other gh command passes straight through, gh api included", () => {
  const { gh, args, stdin } = shimSetup();
  const argv = ["api", "repos/example/repo/issues", "-f", `body=Port ${TERM}`];
  assert.equal(gh(argv, "input\n").status, 3);
  assert.equal(args(), argv.join("\n") + "\n");
  assert.equal(stdin(), "input\n");
  assert.equal(gh(["issue", "list", "--search", TERM]).status, 3);
});

test("the gh shim never calls itself, even with a second copy on PATH", () => {
  const { shimDir, fakeDir, gh } = shimSetup();
  const copy = fresh("shim-copy");
  copyFileSync(join(shimDir, "gh"), join(copy, "gh"));
  chmodSync(join(copy, "gh"), 0o755);
  const PATH = [shimDir, copy, shimDir, fakeDir].join(delimiter);
  assert.equal(gh(["issue", "list"], "", { PATH }).status, 3);

  const missing = gh(["issue", "list"], "", { PATH: [shimDir, copy].join(delimiter) });
  assert.equal(missing.status, 127);
  assert.match(missing.stderr, /can't find the real gh/);
});

test("the gh shim refuses when the check itself fails", () => {
  const { gh, called } = shimSetup();
  const broken = fresh("broken-config");
  writeFileSync(join(broken, "config.toml"), "terms = [\n");
  const env = { SECOND_READ_CONFIG_DIR: broken };
  const result = gh(["issue", "create", "-t", "Clean", "-b", "Clean"], "", env);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /the check failed/);
  const missingFile = gh(["issue", "comment", "4", "-F", "no-such-file.md"]);
  assert.equal(missingFile.status, 2);
  assert.ok(!called());
});

test("the gh shim uses the allowlist of the repository it runs in", () => {
  const { gh, cwd } = shimSetup();
  assert.equal(gh(["issue", "create", "-t", "The billing page", "-b", "Clean"]).status, 1);
  writeFileSync(join(cwd, ".second-read.toml"), 'allowed_words = ["billing"]\n');
  assert.equal(gh(["issue", "create", "-t", "The billing page", "-b", "Clean"]).status, 3);
});

test("shim install never overwrites another gh, and uninstall removes only the shim", () => {
  const { shimDir, fakeDir } = shimSetup();
  const refused = secondRead(scratch, ["shim", "install", fakeDir]);
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /isn't the shim/);
  assert.match(secondRead(scratch, ["shim", "uninstall", fakeDir]).stdout, /left as it is/);
  assert.ok(existsSync(join(fakeDir, "gh")));
  assert.equal(secondRead(scratch, ["shim", "uninstall", shimDir]).status, 0);
  assert.ok(!existsSync(join(shimDir, "gh")));
});
