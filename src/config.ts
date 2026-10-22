import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { isBlanketEmail, isBlanketPath, type Rules } from "./checks.ts";
import { escapeRegExp, fold, termPattern } from "./normalize.ts";
import { parseToml, type TomlValue } from "./toml.ts";

export const USER_FILE = "config.toml";
export const REPO_FILE = ".second-read.toml";

export class ConfigError extends Error {}

export interface UserConfig {
  terms: string[];
  allowedWords: string[];
  allowedEmails: string[];
  allowedPaths: string[];
  allowedNames: string[];
}

export type Allowlists = Omit<UserConfig, "terms" | "allowedNames">;

export interface RepoConfig extends Allowlists {
  // Globs of the files whose added lines pre-push checks for private terms only.
  exemptFiles: string[];
}

const ALLOW_KEYS = { allowed_words: "allowedWords", allowed_emails: "allowedEmails", allowed_paths: "allowedPaths" };

// The platform's config folder. SECOND_READ_CONFIG_DIR overrides it, which is how tests keep away from the real one.
export function configDir(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, home: string): string {
  if (env.SECOND_READ_CONFIG_DIR) return env.SECOND_READ_CONFIG_DIR;
  if (platform === "win32") return join(env.APPDATA || join(home, "AppData", "Roaming"), "second-read");
  return join(env.XDG_CONFIG_HOME || join(home, ".config"), "second-read");
}

// The Claude Code plugin's own config folder, from its config_dir option, which Claude Code gives only to the
// plugin's hooks. It lets the hooks read the user's terms in a session whose own commands read an empty
// SECOND_READ_CONFIG_DIR. Unset or blank, the hooks find the config as everything else does.
export const PLUGIN_CONFIG_DIR = "CLAUDE_PLUGIN_OPTION_CONFIG_DIR";

export function pluginConfigDir(env: NodeJS.ProcessEnv, home: string): string | undefined {
  const value = env[PLUGIN_CONFIG_DIR]?.trim();
  if (!value) return undefined;
  const dir = value.replace(/^~(?=[/\\]|$)/, home);
  if (!isAbsolute(dir)) {
    throw new ConfigError(`second-read's config_dir option is ${JSON.stringify(value)}, which isn't an absolute path`);
  }
  return dir;
}

// A missing user file means no private terms yet, not a failure: the other checks still run.
export function loadUserConfig(path: string): UserConfig {
  if (!existsSync(path)) return { terms: [], allowedWords: [], allowedEmails: [], allowedPaths: [], allowedNames: [] };
  const values = parseFile(path);
  return {
    terms: stringList(values, "terms", path),
    ...allowLists(values, path, ["terms", "allowed_names"]),
    allowedNames: stringList(values, "allowed_names", path),
  };
}

// A repository's file holds only an allowlist. It's checked in, so a private term in it would be posted.
export function loadRepoConfig(path: string, terms: string[]): RepoConfig {
  const source = readText(path);
  const values = parseText(source, path);
  if (Object.hasOwn(values, "terms")) {
    throw new ConfigError(`${path}: private terms belong in your own config file, never in a repository`);
  }
  if (Object.hasOwn(values, "allowed_names")) {
    throw new ConfigError(
      `${path}: allowed_names belongs in your own config file, since naming your account or machine in a ` +
        `repository posts it`,
    );
  }
  const folded = fold(source).text;
  for (const term of terms) {
    const match = termPattern(term)?.exec(folded);
    if (match) {
      const line = folded.slice(0, match.index).split("\n").length;
      throw new ConfigError(`${path}: line ${line} names one of your private terms; take it out of the repository`);
    }
  }
  // Anyone who can change the repository can change this file, so it can't switch a whole check off.
  // The user's own file can, since it never leaves the machine.
  const lists = allowLists(values, path, ["exempt_files"]);
  for (const entry of lists.allowedPaths) {
    if (isBlanketPath(entry)) {
      throw new ConfigError(
        `${path}: allowed_paths entry ${JSON.stringify(entry)} takes in the whole home folder or a temp folder; ` +
          `a repository can allow only narrower paths`,
      );
    }
  }
  for (const entry of lists.allowedEmails) {
    if (isBlanketEmail(entry)) {
      throw new ConfigError(
        `${path}: allowed_emails entry ${JSON.stringify(entry)} has no fixed domain; ` +
          `a repository has to name one, as in "*@example.com"`,
      );
    }
  }
  const exemptFiles = stringList(values, "exempt_files", path);
  for (const entry of exemptFiles) {
    if (isBlanketGlob(entry)) {
      throw new ConfigError(
        `${path}: exempt_files entry ${JSON.stringify(entry)} is made only of wildcards, so it takes in nearly ` +
          `every file; a repository can exempt only narrower globs, as in "src/**/*.test.ts"`,
      );
    }
  }
  return { ...lists, exemptFiles };
}

// A glob over paths from the top of the repository. "*" and "?" stay within one folder, "**" takes in any number of
// folders, and a glob ending in "/" takes in everything under that folder. Case counts, as it does in git.
export function exemptMatcher(globs: string[]): (file: string) => boolean {
  if (globs.length === 0) return () => false;
  const patterns = globs.map((glob) => {
    const segments = globSegments(glob);
    let source = "";
    segments.forEach((segment, i) => {
      const last = i === segments.length - 1;
      if (segment === "**") source += last ? ".*" : "(?:[^/]*/)*";
      else {
        source += segment.split("").map((c) => (c === "*" ? "[^/]*" : c === "?" ? "[^/]" : escapeRegExp(c))).join("");
        if (!last) source += "/";
      }
    });
    return new RegExp(`^${source}$`, "u");
  });
  return (file) => patterns.some((re) => re.test(file));
}

// A glob made only of wildcards and dots, such as "**", "**/?*" or "**/*.*", which leaves pre-push next to no added
// lines to check. A folder of only "?" takes in names of that length, and one that starts with a dot only dotfiles,
// so those are narrower.
export function isBlanketGlob(glob: string): boolean {
  return globSegments(glob).every((segment) => /^[*?][*?.]*$/.test(segment) && segment.includes("*"));
}

function globSegments(glob: string): string[] {
  const trimmed = glob.replace(/^(?:\.?\/)+/, "");
  return (trimmed === "" || trimmed.endsWith("/") ? trimmed + "**" : trimmed).split("/");
}

// The nearest .second-read.toml at or above `cwd`, up to the top of the git repository. Outside a repository
// there is none, so a stray file in a parent folder is never picked up.
export function findRepoConfig(cwd: string): string | undefined {
  const found: string[] = [];
  let dir = cwd;
  for (;;) {
    const candidate = join(dir, REPO_FILE);
    if (existsSync(candidate)) found.push(candidate);
    if (existsSync(join(dir, ".git"))) return found[0];
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export function mergeRules(user: UserConfig, repo: Allowlists | undefined): Rules {
  return {
    terms: user.terms,
    allowedWords: [...user.allowedWords, ...(repo?.allowedWords ?? [])],
    allowedEmails: [...user.allowedEmails, ...(repo?.allowedEmails ?? [])],
    allowedPaths: [...user.allowedPaths, ...(repo?.allowedPaths ?? [])],
    allowedNames: user.allowedNames,
    userAllowedEmails: user.allowedEmails,
  };
}

export const USER_FILE_TEMPLATE = `# second-read: your private terms and allowlists.
# This file stays on this machine. Never check it in, and never copy its terms into a repository.

# Private terms: project, folder, character or client names that must never be posted.
# Each is matched in any case, at word boundaries, with its words joined by spaces, hyphens or nothing:
# "Example Project" also catches "example-project" and "ExampleProject".
terms = [
]

# Money and account words that are fine to post everywhere, as a report names them (such as "billing").
allowed_words = []

# Your account or machine name, when it's an ordinary word that's fine to post, so it isn't flagged anywhere.
# Common default machine names, such as "MacBook-Pro", are never flagged. Paths with your account name still are.
allowed_names = []

# Email addresses that are fine to post. "*" matches any run of characters, as in "*@example.com".
# Your own address, git's user.email, is allowed only when it's written out here in full.
allowed_emails = []

# Paths that are fine to post, such as "~/.config/some-tool".
allowed_paths = []
`;

function allowLists(values: Record<string, TomlValue>, path: string, extra: string[]): Allowlists {
  for (const key of Object.keys(values)) {
    if (!Object.hasOwn(ALLOW_KEYS, key) && !extra.includes(key)) {
      throw new ConfigError(`${path}: unknown key "${key}"`);
    }
  }
  return {
    allowedWords: stringList(values, "allowed_words", path),
    allowedEmails: stringList(values, "allowed_emails", path),
    allowedPaths: stringList(values, "allowed_paths", path),
  };
}

function stringList(values: Record<string, TomlValue>, key: string, path: string): string[] {
  const value = values[key];
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new ConfigError(`${path}: "${key}" must be an array of strings`);
  return value;
}

function parseFile(path: string): Record<string, TomlValue> {
  return parseText(readText(path), path);
}

function parseText(source: string, path: string): Record<string, TomlValue> {
  try {
    return parseToml(source);
  } catch (e) {
    throw new ConfigError(`${path}: ${(e as Error).message}`);
  }
}

function readText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (e) {
    throw new ConfigError(`can't read ${path}: ${(e as Error).message}`);
  }
}
