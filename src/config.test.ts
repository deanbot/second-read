import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  ConfigError,
  configDir,
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
  assert.deepEqual(loadRepoConfig(path, []), { allowedWords: ["subscription"], allowedEmails: [], allowedPaths: [] });
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
