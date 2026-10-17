import { accessSync, closeSync, constants, openSync, readSync, realpathSync, statSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import type { Kind } from "./checks.ts";
import { shQuote } from "./git.ts";

export const SHIM_MARKER = "# Added by second-read: the gh shim.";

const POSTS: Record<string, Record<string, Kind>> = {
  issue: { create: "issue", new: "issue", edit: "issue", comment: "comment" },
  pr: { create: "pr", new: "pr", edit: "pr", comment: "comment", review: "review" },
};

const TEXT_FLAGS: Record<string, "title" | "body" | "bodyFile"> = {
  "--title": "title",
  "-t": "title",
  "--body": "body",
  "-b": "body",
  "--body-file": "bodyFile",
  "-F": "bodyFile",
};

export interface GhPost {
  kind: Kind;
  title: string[];
  body: string[];
  bodyFiles: string[];
}

// The text a posting gh command sends, or undefined for any other command, which passes straight through.
export function parseGh(args: string[]): GhPost | undefined {
  const words: string[] = [];
  const post: Omit<GhPost, "kind"> = { title: [], body: [], bodyFiles: [] };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") break;
    if (arg === "-R" || arg === "--repo") {
      i++;
      continue;
    }
    let name: string | undefined;
    let value: string | undefined;
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      name = eq < 0 ? arg : arg.slice(0, eq);
      if (eq >= 0) value = arg.slice(eq + 1);
    } else if (arg.startsWith("-") && arg.length > 1) {
      // A short flag takes its value from the next argument, or joined: "-tTitle" or "-t=Title".
      name = arg.slice(0, 2);
      if (arg.length > 2) value = arg.slice(arg[2] === "=" ? 3 : 2);
    } else {
      words.push(arg);
      continue;
    }
    const field = TEXT_FLAGS[name];
    if (field === undefined) continue;
    if (value === undefined) value = args[++i];
    if (value === undefined) continue;
    if (field === "bodyFile") post.bodyFiles.push(value);
    else post[field].push(value);
  }
  const kind = POSTS[words[0] ?? ""]?.[words[1] ?? ""];
  return kind === undefined ? undefined : { kind, ...post };
}

export function shimScript(command: string[]): string {
  return `#!/bin/sh
${SHIM_MARKER} It checks what gh is about to post, then runs the real gh.
exec ${command.map(shQuote).join(" ")} gh-shim "$0" "$@"
`;
}

// The first gh on PATH that isn't this shim: its own folder is skipped, and so is any other copy of the shim,
// so it can never call itself.
export function findRealGh(
  pathEnv: string,
  cwd: string,
  platform: NodeJS.Platform,
  skipDirs: string[],
): string | undefined {
  const skip = new Set(skipDirs.map(real));
  const names = platform === "win32" ? ["gh.exe", "gh.cmd", "gh.bat", "gh"] : ["gh"];
  for (const entry of pathEnv.split(delimiter)) {
    const dir = resolve(cwd, entry);
    if (skip.has(real(dir))) continue;
    for (const name of names) {
      const path = join(dir, name);
      if (isExecutableFile(path) && !isShim(path)) return path;
    }
  }
  return undefined;
}

export function isShim(path: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const head = Buffer.alloc(512);
    const read = readSync(fd, head, 0, head.length, 0);
    return head.subarray(0, read).toString("utf8").includes(SHIM_MARKER);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}
