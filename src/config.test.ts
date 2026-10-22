import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  ConfigError,
  configFolder,
  exemptMatcher,
  findRepoConfig,
  insideRepository,
  isAccountConfigDir,
  loadRepoConfig,
  loadUserConfig,
  mergeRules,
  pluginConfigDir,
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
  const dir = (env: NodeJS.ProcessEnv, platform: NodeJS.Platform, home: string) => configFolder(env, platform, home).dir;
  assert.equal(dir({}, "darwin", "/Users/example"), "/Users/example/.config/second-read");
  assert.equal(dir({ XDG_CONFIG_HOME: "/x/config" }, "linux", "/home/example"), "/x/config/second-read");
  assert.equal(dir({ APPDATA: "/x/Roaming" }, "win32", "/x"), join("/x/Roaming", "second-read"));
  assert.equal(dir({}, "win32", "/x"), join("/x", "AppData", "Roaming", "second-read"));
  assert.equal(dir({ SECOND_READ_CONFIG_DIR: "/x/sr", XDG_CONFIG_HOME: "/y" }, "linux", "/h"), "/x/sr");
  // Each folder names the variable that chose it, for a message.
  assert.deepEqual(configFolder({ XDG_CONFIG_HOME: "~/c" }, "linux", "/h"), { dir: "/h/c/second-read", variable: "XDG_CONFIG_HOME", value: "/h/c" });
  assert.deepEqual(configFolder({}, "linux", "/h"), { dir: "/h/.config/second-read", variable: "HOME", value: "/h" });
});

test("every variable that chooses the config folder takes ~ for the home folder, as settings files hand it over unexpanded, and no relative path", () => {
  const dir = (env: NodeJS.ProcessEnv, home = "/home/example") => configFolder(env, "linux", home).dir;
  assert.equal(dir({ SECOND_READ_CONFIG_DIR: "~/sr" }), "/home/example/sr");
  assert.equal(dir({ SECOND_READ_CONFIG_DIR: "~" }), "/home/example");
  assert.equal(dir({ XDG_CONFIG_HOME: "~/c" }), "/home/example/c/second-read");
  assert.equal(configFolder({ APPDATA: "~/r" }, "win32", "/x").dir, join("/x/r", "second-read"));
  for (const value of ["sr", "./sr", "../sr", "~sr", " /x/sr"]) {
    assert.throws(() => dir({ SECOND_READ_CONFIG_DIR: value }), /SECOND_READ_CONFIG_DIR is .*, which isn't an absolute path/, value);
    assert.throws(() => dir({ XDG_CONFIG_HOME: value }), /XDG_CONFIG_HOME is .*, which isn't an absolute path/, value);
    assert.throws(() => configFolder({ APPDATA: value }, "win32", "/x"), /APPDATA is .*, which isn't an absolute path/, value);
  }
  // A relative home folder makes ~ relative too.
  for (const home of [".", "h", ""]) {
    assert.throws(() => dir({}, home), /HOME is .*, which isn't an absolute path/, home);
    assert.throws(() => dir({ XDG_CONFIG_HOME: "~/c" }, home), /XDG_CONFIG_HOME/, home);
  }
});

test("the account's own config folder is the default one under the account's home, by its real path", () => {
  const account = join(scratch, "account");
  mkdirSync(join(account, ".config", "second-read"), { recursive: true });
  symlinkSync(join(account, ".config"), join(scratch, "account-config-link"));
  const own = (dir: string, home: string | undefined = account) => isAccountConfigDir(dir, "linux", home);
  assert.equal(own(join(account, ".config", "second-read")), true);
  assert.equal(own(join(scratch, "account-config-link", "second-read")), true);
  assert.equal(own(join(scratch, "other", ".config", "second-read")), false);
  assert.equal(own(join(account, "second-read")), false);
  // With no account home, or a relative one, no folder is the account's.
  assert.equal(isAccountConfigDir(join(account, ".config", "second-read"), "linux", undefined), false);
  assert.equal(own(".config/second-read", "."), false);
  assert.equal(isAccountConfigDir(join(account, "AppData", "Roaming", "second-read"), "win32", account), true);
});

test("insideRepository finds a folder in any repository's work tree or .git, through links", () => {
  const repo = join(scratch, "inside", "repo");
  mkdirSync(join(repo, ".git"), { recursive: true });
  mkdirSync(join(repo, "src", "deep"), { recursive: true });
  mkdirSync(join(scratch, "inside", "outside"), { recursive: true });
  symlinkSync(join(repo, "src"), join(scratch, "inside", "link-in"));
  symlinkSync(join(scratch, "inside", "outside"), join(repo, "link-out"));
  const inside = [repo, join(repo, "cfg"), join(repo, "..cfg"), join(repo, ".git", "cfg"), join(repo, "src", "deep")];
  // The repository is named by its real path.
  for (const dir of [...inside, join(scratch, "inside", "link-in", "x"), join(repo, "missing", "deeper")]) {
    assert.equal(insideRepository(dir), realpathSync(repo), dir);
  }
  // A folder named like the repository, or one a link in the repository points out to, isn't in it.
  for (const dir of [join(scratch, "inside", "repo-other"), join(scratch, "inside", "outside"), join(repo, "link-out")]) {
    assert.equal(insideRepository(dir), undefined, dir);
  }
  // A linked worktree or a submodule has a .git file, not a folder.
  const worktree = join(scratch, "inside", "worktree");
  mkdirSync(worktree, { recursive: true });
  writeFileSync(join(worktree, ".git"), `gitdir: ${join(repo, ".git", "worktrees", "w")}\n`);
  assert.equal(insideRepository(join(worktree, "cfg")), realpathSync(worktree));
});

test("the plugin's config_dir option is an absolute folder, ~ for the home folder, or unset when blank", () => {
  const home = "/Users/example";
  assert.equal(pluginConfigDir({}, home), undefined);
  assert.equal(pluginConfigDir({ CLAUDE_PLUGIN_OPTION_CONFIG_DIR: "  " }, home), undefined);
  assert.equal(pluginConfigDir({ CLAUDE_PLUGIN_OPTION_CONFIG_DIR: " /x/sr " }, home), "/x/sr");
  assert.equal(pluginConfigDir({ CLAUDE_PLUGIN_OPTION_CONFIG_DIR: "~/sr" }, home), "/Users/example/sr");
  assert.equal(pluginConfigDir({ CLAUDE_PLUGIN_OPTION_CONFIG_DIR: "~" }, home), home);
  // SECOND_READ_CONFIG_DIR is what everything else reads; the option doesn't fall back to it.
  assert.equal(pluginConfigDir({ SECOND_READ_CONFIG_DIR: "/x/empty" }, home), undefined);
  for (const value of ["sr", "./sr", "~sr", "~other/sr"]) {
    assert.throws(() => pluginConfigDir({ CLAUDE_PLUGIN_OPTION_CONFIG_DIR: value }, home), ConfigError, value);
  }
});

test("a missing user file is an empty config", () => {
  assert.deepEqual(loadUserConfig(join(scratch, "missing", "config.toml")), {
    terms: [],
    allowedWords: [],
    allowedEmails: [],
    allowedPaths: [],
    allowedNames: [],
  });
});

test("the user file holds terms and allowlists", () => {
  const path = write(
    "user/config.toml",
    'terms = ["example-private-project"]\nallowed_words = ["billing"]\nallowed_emails = ["*@example.org"]\n' +
      'allowed_paths = ["~/src"]\nallowed_names = ["juniper"]\n',
  );
  assert.deepEqual(loadUserConfig(path), {
    terms: ["example-private-project"],
    allowedWords: ["billing"],
    allowedEmails: ["*@example.org"],
    allowedPaths: ["~/src"],
    allowedNames: ["juniper"],
  });
});

test("allowed names belong in the user's own file, never a repository's", () => {
  const path = write("repo-names/.second-read.toml", 'allowed_names = ["juniper"]\n');
  assert.throws(() => loadRepoConfig(path, []), /allowed_names belongs in your own config file/);
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

test("rules join both allowlists and take terms and allowed names from the user only", () => {
  const user = { terms: ["t"], allowedWords: ["a"], allowedEmails: ["b"], allowedPaths: ["c"], allowedNames: ["g"] };
  const repo = { allowedWords: ["d"], allowedEmails: ["e"], allowedPaths: ["f"] };
  assert.deepEqual(mergeRules(user, repo), {
    terms: ["t"],
    allowedWords: ["a", "d"],
    allowedEmails: ["b", "e"],
    allowedPaths: ["c", "f"],
    allowedNames: ["g"],
    userAllowedEmails: ["b"],
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
  const blankets = ["**", "*", "**/*", "**/**", "*/**", "./**", "/**", "/", "./", "", "*?", "**/?*", "**/??*"];
  for (const entry of [...blankets, "*.*", "**/*.*", "**/*.?*", "**/?*.*"]) {
    const blanket = write("repo-f/.second-read.toml", `exempt_files = [${JSON.stringify(entry)}]\n`);
    assert.throws(() => loadRepoConfig(blanket, []), /exempt_files entry .* takes in nearly every file/, entry);
  }
  const narrower = ["?", "**/??.ts", "**/.*", "**/*.md", "src/**"];
  const narrow = write("repo-f/.second-read.toml", `exempt_files = ${JSON.stringify(narrower)}\n`);
  assert.deepEqual(loadRepoConfig(narrow, []).exemptFiles, narrower);
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
