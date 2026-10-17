import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { check, type Finding, type Identity, KINDS, type Kind } from "./checks.ts";
import {
  configDir,
  findRepoConfig,
  loadRepoConfig,
  loadUserConfig,
  mergeRules,
  USER_FILE,
  USER_FILE_TEMPLATE,
} from "./config.ts";

export interface Io {
  argv: string[];
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  cwd: string;
  identity: () => Identity;
  readStdin: () => Promise<string>;
  out: (text: string) => void;
  err: (text: string) => void;
}

export const EXIT = { clean: 0, findings: 1, failed: 2 } as const;

const USAGE = `Usage:
  second-read check [--kind commit|issue|pr|comment|review]   check the text on stdin
  second-read init                                           write your config file

check exits 0 when the text is clean, 1 with findings, and 2 when the check itself fails.
`;

const KIND_NAMES: Record<Kind, string> = {
  commit: "this commit message",
  issue: "this issue",
  pr: "this pull request",
  comment: "this comment",
  review: "this review",
};

class UsageError extends Error {}

export async function main(io: Io): Promise<number> {
  try {
    return await run(io);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (e instanceof UsageError) io.err(`second-read: ${message}\n\n${USAGE}`);
    else io.err(`second-read: the check failed: ${message}\n`);
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

async function runCheck(io: Io, { kind }: { kind?: Kind }): Promise<number> {
  const identity = io.identity();
  const user = loadUserConfig(join(configDir(io.env, io.platform, identity.home), USER_FILE));
  const repoPath = findRepoConfig(io.cwd);
  const repo = repoPath === undefined ? undefined : loadRepoConfig(repoPath, user.terms);
  const text = await io.readStdin();
  const findings = check(text, { identity, rules: mergeRules(user, repo), ...(kind ? { kind } : {}) });
  if (findings.length === 0) return EXIT.clean;
  io.out(report(findings, kind));
  return EXIT.findings;
}

export function report(findings: Finding[], kind?: Kind): string {
  const where = kind ? KIND_NAMES[kind] : "this text";
  const count = findings.length === 1 ? "1 finding" : `${findings.length} findings`;
  const rows = findings.map((f) => {
    const position = `${f.line}:${f.column}`;
    const category = f.word ? `${f.category} (${f.word})` : f.category;
    return `  ${position.padEnd(7)} ${category.padEnd(22)} ${JSON.stringify(f.text)}`;
  });
  return `second-read: ${count} in ${where}. Nothing was changed; fix the text and try again.\n${rows.join("\n")}\n`;
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
