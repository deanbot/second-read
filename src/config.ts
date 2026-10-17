import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Rules } from "./checks.ts";
import { fold, termPattern } from "./normalize.ts";
import { parseToml, type TomlValue } from "./toml.ts";

export const USER_FILE = "config.toml";
export const REPO_FILE = ".second-read.toml";

export class ConfigError extends Error {}

export interface UserConfig {
  terms: string[];
  allowedWords: string[];
  allowedEmails: string[];
  allowedPaths: string[];
}

export type RepoConfig = Omit<UserConfig, "terms">;

const ALLOW_KEYS = { allowed_words: "allowedWords", allowed_emails: "allowedEmails", allowed_paths: "allowedPaths" };

// The platform's config folder. SECOND_READ_CONFIG_DIR overrides it, which is how tests keep away from the real one.
export function configDir(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, home: string): string {
  if (env.SECOND_READ_CONFIG_DIR) return env.SECOND_READ_CONFIG_DIR;
  if (platform === "win32") return join(env.APPDATA || join(home, "AppData", "Roaming"), "second-read");
  return join(env.XDG_CONFIG_HOME || join(home, ".config"), "second-read");
}

// A missing user file means no private terms yet, not a failure: the other checks still run.
export function loadUserConfig(path: string): UserConfig {
  if (!existsSync(path)) return { terms: [], allowedWords: [], allowedEmails: [], allowedPaths: [] };
  const values = parseFile(path);
  return { terms: stringList(values, "terms", path), ...allowLists(values, path, ["terms"]) };
}

// A repository's file holds only an allowlist. It's checked in, so a private term in it would be posted.
export function loadRepoConfig(path: string, terms: string[]): RepoConfig {
  const source = readText(path);
  const values = parseText(source, path);
  if (Object.hasOwn(values, "terms")) {
    throw new ConfigError(`${path}: private terms belong in your own config file, never in a repository`);
  }
  const folded = fold(source).text;
  for (const term of terms) {
    const match = termPattern(term)?.exec(folded);
    if (match) {
      const line = folded.slice(0, match.index).split("\n").length;
      throw new ConfigError(`${path}: line ${line} names one of your private terms; take it out of the repository`);
    }
  }
  return allowLists(values, path, []);
}

// The nearest .second-read.toml at or above `cwd`, stopping at the top of the git repository.
export function findRepoConfig(cwd: string): string | undefined {
  let dir = cwd;
  for (;;) {
    const candidate = join(dir, REPO_FILE);
    if (existsSync(candidate)) return candidate;
    if (existsSync(join(dir, ".git"))) return undefined;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export function mergeRules(user: UserConfig, repo: RepoConfig | undefined): Rules {
  return {
    terms: user.terms,
    allowedWords: [...user.allowedWords, ...(repo?.allowedWords ?? [])],
    allowedEmails: [...user.allowedEmails, ...(repo?.allowedEmails ?? [])],
    allowedPaths: [...user.allowedPaths, ...(repo?.allowedPaths ?? [])],
  };
}

export const USER_FILE_TEMPLATE = `# second-read: your private terms and allowlists.
# This file stays on this machine. Never check it in, and never copy its terms into a repository.

# Private terms: project, folder, character or client names that must never be posted.
# Each is matched in any case, at word boundaries, with its words joined by spaces, hyphens or nothing:
# "Example Project" also catches "example-project" and "ExampleProject".
terms = [
]

# Money and account words that are fine to post everywhere, as a report names them (such as "billing"),
# and an account or machine name that is also an ordinary word.
allowed_words = []

# Email addresses that are fine to post. "*" matches any run of characters, as in "*@example.com".
allowed_emails = []

# Paths that are fine to post, such as "~/.config/some-tool".
allowed_paths = []
`;

function allowLists(values: Record<string, TomlValue>, path: string, extra: string[]): RepoConfig {
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
