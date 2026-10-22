// Runs CI's change check (.github/scripts/changed.mjs) in scratch repositories, as the workflow runs it.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../.github/scripts/changed.mjs", import.meta.url));

const scratch = mkdtempSync(join(tmpdir(), "second-read-ci-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

const gitconfig = join(scratch, "gitconfig");
writeFileSync(gitconfig, "[user]\n\tname = Example\n\temail = example@example.com\n[init]\n\tdefaultBranch = main\n");
const env: NodeJS.ProcessEnv = {
  PATH: process.env.PATH ?? "",
  HOME: scratch,
  GIT_CONFIG_GLOBAL: gitconfig,
  GIT_CONFIG_NOSYSTEM: "1",
};

function run(command: string, args: string[], cwd: string) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", env });
  if (result.error) throw result.error;
  return result;
}

function git(cwd: string, ...args: string[]) {
  const result = run("git", args, cwd);
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

let count = 0;
// A repository with one commit holding a README and some code; returns its folder and that commit.
function repo(): { dir: string; base: string } {
  const dir = join(scratch, `repo-${++count}`);
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "README.md"), "# Example\n");
  writeFileSync(join(dir, "src", "main.ts"), "export {};\n");
  git(dir, "init", "-q");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "Start");
  return { dir, base: git(dir, "rev-parse", "HEAD") };
}

function write(dir: string, name: string, text = "changed\n") {
  mkdirSync(dirname(join(dir, name)), { recursive: true });
  writeFileSync(join(dir, name), text);
}

function commit(dir: string): string {
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "--allow-empty", "-m", "Change");
  return git(dir, "rev-parse", "HEAD");
}

function changed(dir: string, base: string, head: string): string {
  const result = run(process.execPath, [script, base, head], dir);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test("a change to Markdown files only skips the tests", () => {
  const { dir, base } = repo();
  write(dir, "README.md");
  write(dir, "docs/guide.md");
  assert.equal(changed(dir, base, commit(dir)), "tests=false\n");
});

test("a change that touches any other file runs the tests", () => {
  const { dir, base } = repo();
  write(dir, "README.md");
  write(dir, "src/main.ts");
  assert.equal(changed(dir, base, commit(dir)), "tests=true\n");
});

test("renaming or deleting code counts as a code change", () => {
  const renamed = repo();
  renameSync(join(renamed.dir, "src", "main.ts"), join(renamed.dir, "src", "main.md"));
  assert.equal(changed(renamed.dir, renamed.base, commit(renamed.dir)), "tests=true\n");

  const deleted = repo();
  rmSync(join(deleted.dir, "src", "main.ts"));
  assert.equal(changed(deleted.dir, deleted.base, commit(deleted.dir)), "tests=true\n");
});

test("only a lowercase .md ending counts as Markdown", () => {
  for (const name of ["NOTES.MD", "notes.md.ts", "docs.md/index.ts", "notes.markdown", ".md-config"]) {
    const { dir, base } = repo();
    write(dir, name);
    assert.equal(changed(dir, base, commit(dir)), "tests=true\n", name);
  }
});

test("names with spaces, newlines or non-ASCII letters are read whole", () => {
  const markdown = repo();
  write(markdown.dir, "docs/two words.md");
  write(markdown.dir, "docs/line\nbreak.md");
  write(markdown.dir, "docs/café.md");
  assert.equal(changed(markdown.dir, markdown.base, commit(markdown.dir)), "tests=false\n");

  // A newline can't split a code file's name into a part that ends in .md.
  const code = repo();
  write(code.dir, "src/fake.md\nreal.ts");
  assert.equal(changed(code.dir, code.base, commit(code.dir)), "tests=true\n");
});

test("anything it can't tell runs the tests", () => {
  const { dir, base } = repo();
  const empty = commit(dir);
  assert.equal(changed(dir, base, empty), "tests=true\n", "no changed files");
  assert.equal(changed(dir, "0".repeat(40), empty), "tests=true\n", "a new branch's zero sha");
  assert.equal(changed(dir, "", empty), "tests=true\n", "no base");
  assert.equal(changed(dir, "1".repeat(40), empty), "tests=true\n", "a commit that isn't there");
  assert.equal(changed(dir, "--output=x.md", empty), "tests=true\n", "an option as the base");
  assert.ok(!existsSync(join(dir, "x.md")), "an option as the base is read as a commit, not obeyed");
});

test("a pull request's merge commit is checked against its first parent", () => {
  const { dir } = repo();
  git(dir, "switch", "-q", "-c", "docs");
  write(dir, "README.md");
  commit(dir);
  git(dir, "switch", "-q", "main");
  write(dir, "src/main.ts");
  commit(dir);
  git(dir, "merge", "-q", "--no-ff", "-m", "Merge", "docs");
  // The code change came in on main, so the pull request itself changes only Markdown.
  assert.equal(changed(dir, "HEAD^1", "HEAD"), "tests=false\n");
});

test("CI runs again when a pull request's base branch changes", () => {
  // A Markdown-only pull request stacked on a code branch, retargeted to main, merges that code untested unless
  // the retarget (an `edited` event) runs CI again.
  const workflow = readFileSync(fileURLToPath(new URL("../.github/workflows/ci.yml", import.meta.url)), "utf8");
  const types = /^  pull_request:\n(?:    #.*\n)*    types: \[([^\]]*)\]$/m.exec(workflow)?.[1]?.split(/,\s*/);
  assert.deepEqual(types?.sort(), ["edited", "opened", "reopened", "synchronize"]);
});
