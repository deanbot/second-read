#!/usr/bin/env node
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
  return { user, home: homedir(), host: hostname(), tempDirs };
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
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
});
