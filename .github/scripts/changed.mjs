// Says whether CI runs the tests for the change from one commit to another: `tests=false` when every changed file
// is Markdown, `tests=true` otherwise. Anything it can't tell (a missing commit, a failed diff, no changed files)
// runs the tests. Usage: node changed.mjs <base> <head>, run from the repository.
import { spawnSync } from "node:child_process";

const [base = "", head = ""] = process.argv.slice(2);

function needsTests() {
  if (!base || !head || /^0+$/.test(base)) return true;
  // --no-renames lists a renamed file under both names, so renaming code to .md still counts as code.
  const args = ["diff", "--no-renames", "--name-only", "-z", "--end-of-options", base, head, "--"];
  const diff = spawnSync("git", args, { encoding: "utf8" });
  if (diff.status !== 0) return true;
  const names = diff.stdout.split("\0").filter(Boolean);
  return names.length === 0 || names.some((name) => !name.endsWith(".md"));
}

console.log(`tests=${needsTests()}`);
