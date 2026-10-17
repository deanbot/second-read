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
  assert.match(installed.stdout, /but push-to-checkout\n {2}warning: the repository's push-to-checkout won't run/);
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
