#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { homedir, hostname, tmpdir, userInfo } from "node:os";
import { fileURLToPath } from "node:url";
import type { Identity } from "./checks.ts";
import { main } from "./main.ts";

function systemIdentity(): Identity {
  let user: string;
  try {
    user = userInfo().username;
  } catch {
    user = process.env.USER ?? process.env.USERNAME ?? "";
  }
  const tempDirs = [tmpdir()];
  try {
    tempDirs.push(realpathSync(tempDirs[0]!));
  } catch {}
  return { user, home: homedir(), host: hostname(), tempDirs, emails: gitEmails() };
}

// Every user.email git uses here, from each config file it reads: one set in a repository doesn't hide the global
// one. An address an includeIf sets for another folder isn't read.
// No git, or no address, means none to check.
function gitEmails(): string[] {
  const result = spawnSync("git", ["config", "--get-all", "user.email"], { encoding: "utf8" });
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT" || result.status === 1) return [];
  if (result.error) throw new Error(`can't run git: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`git config failed: ${result.stderr.trim()}`);
  return result.stdout.split("\n").filter((e) => e.trim() !== "");
}

async function readStdin(): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

process.exitCode = await main({
  argv: process.argv.slice(2),
  env: process.env,
  platform: process.platform,
  cwd: process.cwd(),
  identity: systemIdentity,
  command: [process.execPath, fileURLToPath(import.meta.url)],
  readStdin,
  stdinIsTTY: process.stdin.isTTY === true,
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
});
