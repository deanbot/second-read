import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  ConfigError,
  configDir,
  exemptMatcher,
  findRepoConfig,
  loadRepoConfig,
  loadUserConfig,
  mergeRules,
  USER_FILE_TEMPLATE,
} from "./config.ts";

const scratch = mkdtempSync(join(tmpdir(), "second-read-config-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

function write(name: string, text: string): string {
  const path = join(scratch, name);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
  return path;
}

test("the config folder follows the platform's convention, and the override wins", () => {
  assert.equal(configDir({}, "darwin", "/Users/example"), "/Users/example/.config/second-read");
  assert.equal(configDir({ XDG_CONFIG_HOME: "/x/config" }, "linux", "/home/example"), "/x/config/second-read");
  assert.equal(configDir({ APPDATA: "/x/Roaming" }, "win32", "/x"), join("/x/Roaming", "second-read"));
  assert.equal(configDir({ SECOND_READ_CONFIG_DIR: "/x/sr", XDG_CONFIG_HOME: "/y" }, "linux", "/h"), "/x/sr");
});

test("a missing user file is an empty config", () => {
  assert.deepEqual(loadUserConfig(join(scratch, "missing", "config.toml")), {
    terms: [],
    allowedWords: [],
    allowedEmails: [],
    allowedPaths: [],
  });
});

test("the user file holds terms and allowlists", () => {
  const path = write(
    "user/config.toml",
    'terms = ["example-private-project"]\nallowed_words = ["billing"]\nallowed_emails = ["*@example.org"]\n' +
      'allowed_paths = ["~/src"]\n',
  );
  assert.deepEqual(loadUserConfig(path), {
    terms: ["example-private-project"],
    allowedWords: ["billing"],
    allowedEmails: ["*@example.org"],
    allowedPaths: ["~/src"],
  });
});

test("the init template parses, and has no terms", () => {
  assert.deepEqual(loadUserConfig(write("template/config.toml", USER_FILE_TEMPLATE)).terms, []);
});

test("a user file with an unknown key, a wrong type or bad syntax is an error", () => {
  for (const text of ['term = ["x"]', 'terms = "x"', "terms = [", "[allow]"]) {
    assert.throws(() => loadUserConfig(write("bad/config.toml", text)), ConfigError, text);
  }
});

test("a repository file holds an allowlist only", () => {
  const path = write("repo-a/.second-read.toml", 'allowed_words = ["subscription"]\n');
  assert.deepEqual(loadRepoConfig(path, []), {
    allowedWords: ["subscription"],
    allowedEmails: [],
    allowedPaths: [],
    exemptFiles: [],
  });
  const withTerms = write("repo-b/.second-read.toml", 'terms = ["x"]\n');
  assert.throws(() => loadRepoConfig(withTerms, []), /never in a repository/);
});

test("a private term in a repository file is an error, however it's written", () => {
  const path = write("repo-c/.second-read.toml", '\n# from ExamplePrivateProject\nallowed_words = ["billing"]\n');
  assert.throws(() => loadRepoConfig(path, ["example-private-project"]), /line 2 names one of your private terms/);
});

test("the repository file is found at or above the working folder, up to the top of the repository", () => {
  const repo = join(scratch, "walk", "repo");
  mkdirSync(join(repo, ".git"), { recursive: true });
  mkdirSync(join(repo, "a", "b"), { recursive: true });
  write("walk/.second-read.toml", "");
  assert.equal(findRepoConfig(join(repo, "a", "b")), undefined);
  const path = write("walk/repo/.second-read.toml", "");
  assert.equal(findRepoConfig(join(repo, "a", "b")), path);
});

test("outside a git repository there is no repository file, even one in a parent folder", () => {
  const outside = join(scratch, "outside", "a", "b");
  mkdirSync(outside, { recursive: true });
  write("outside/.second-read.toml", 'allowed_words = ["billing"]\n');
  write("outside/a/b/.second-read.toml", 'allowed_words = ["billing"]\n');
  assert.equal(findRepoConfig(outside), undefined);
});

test("rules join both allowlists and take terms from the user only", () => {
  const user = { terms: ["t"], allowedWords: ["a"], allowedEmails: ["b"], allowedPaths: ["c"] };
  const repo = { allowedWords: ["d"], allowedEmails: ["e"], allowedPaths: ["f"] };
  assert.deepEqual(mergeRules(user, repo), {
    terms: ["t"],
    allowedWords: ["a", "d"],
    allowedEmails: ["b", "e"],
    allowedPaths: ["c", "f"],
  });
});

test("a repository file that allows a whole home or temp folder is an error", () => {
  const home = ["~", "~/", "$HOME", "${HOME}", "%USERPROFILE%\\"];
  for (const entry of [...home, "/tmp", "/tmp/", "/var/folders", "/var", "/private", ""]) {
    const path = write("repo-d/.second-read.toml", `allowed_paths = [${JSON.stringify(entry)}]\n`);
    assert.throws(() => loadRepoConfig(path, []), /allowed_paths entry .* takes in the whole home folder/, entry);
  }
  const path = write("repo-d/.second-read.toml", 'allowed_paths = ["~/.config/some-tool", "/tmp/example-tool"]\n');
  assert.deepEqual(loadRepoConfig(path, []).allowedPaths, ["~/.config/some-tool", "/tmp/example-tool"]);
});

test("a repository file with an email pattern that has no fixed domain is an error", () => {
  for (const entry of ["*@*", "someone@*", "*@*.com", "*@example.*", "*@*example.com", "*@*.*"]) {
    const path = write("repo-e/.second-read.toml", `allowed_emails = [${JSON.stringify(entry)}]\n`);
    assert.throws(() => loadRepoConfig(path, []), /allowed_emails entry .* has no fixed domain/, entry);
  }
  const allowed = ["*@example.com", "someone@example.org", "*@*.example.org", "*@*.example.co.uk"];
  const path = write("repo-e/.second-read.toml", `allowed_emails = ${JSON.stringify(allowed)}\n`);
  assert.deepEqual(loadRepoConfig(path, []).allowedEmails, allowed);
});

test("a repository file can exempt files from the added-lines check, but not every file", () => {
  const path = write("repo-f/.second-read.toml", 'exempt_files = ["src/**/*.test.ts", "fixtures/"]\n');
  assert.deepEqual(loadRepoConfig(path, []).exemptFiles, ["src/**/*.test.ts", "fixtures/"]);
  for (const entry of ["**", "*", "**/*", "**/**", "*/**", "./**", "/**", "/", "./", "", "*?", "**/?*", "**/??*"]) {
    const blanket = write("repo-f/.second-read.toml", `exempt_files = [${JSON.stringify(entry)}]\n`);
    assert.throws(() => loadRepoConfig(blanket, []), /exempt_files entry .* takes in every file/, entry);
  }
  const narrow = write("repo-f/.second-read.toml", 'exempt_files = ["?", "**/??.ts"]\n');
  assert.deepEqual(loadRepoConfig(narrow, []).exemptFiles, ["?", "**/??.ts"]);
  const wrong = write("repo-f/.second-read.toml", 'exempt_files = "src/**"\n');
  assert.throws(() => loadRepoConfig(wrong, []), /"exempt_files" must be an array of strings/);
});

test("exempt_files belongs to a repository only", () => {
  const path = write("user-exempt/config.toml", 'exempt_files = ["src/a.ts"]\n');
  assert.throws(() => loadUserConfig(path), /unknown key "exempt_files"/);
});

test("an exempt glob matches paths from the top of the repository", () => {
  const exempt = exemptMatcher(["src/**/*.test.ts", "src/checks.ts", "fixtures/", "docs/?.md"]);
  for (const file of ["src/checks.test.ts", "src/a/b/c.test.ts", "src/checks.ts", "fixtures/a/b.txt", "docs/a.md"]) {
    assert.ok(exempt(file), file);
  }
  const kept = ["checks.test.ts", "lib/src/a.test.ts", "src/checks.ts.orig", "src/Checks.ts", "fixtures", "docs/ab.md"];
  for (const file of [...kept, "src/a.test.tsx", "srcx/a.test.ts", "docs/a/b.md"]) assert.ok(!exempt(file), file);
  assert.ok(exemptMatcher(["*.md"])("README.md"));
  assert.ok(!exemptMatcher(["*.md"])("docs/a.md"));
  assert.ok(exemptMatcher(["./a+b (1).txt"])("a+b (1).txt"));
  assert.ok(!exemptMatcher([])("a.txt"));
});

test("the user's own file can allow anything, since it never leaves the machine", () => {
  const path = write("user-blanket/config.toml", 'allowed_paths = ["~", "/tmp"]\nallowed_emails = ["*@*"]\n');
  assert.deepEqual(loadUserConfig(path).allowedEmails, ["*@*"]);
});
