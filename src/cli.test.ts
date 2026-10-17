// Runs the built CLI, as a guard would. `npm test` builds it first.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const cli = join(root, "dist", "cli.js");

const scratch = mkdtempSync(join(tmpdir(), "second-read-cli-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

// The home and config folders both point into the scratch folder, so the real config is never read.
const home = join(scratch, "home");
const config = join(scratch, "config");
const cwd = join(scratch, "repo");
mkdirSync(join(cwd, ".git"), { recursive: true });
mkdirSync(home, { recursive: true });
mkdirSync(config, { recursive: true });
writeFileSync(join(config, "config.toml"), 'terms = ["example-private-project"]\n');

function run(args: string[], input: string) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd,
    input,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "",
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: join(scratch, "xdg"),
      APPDATA: join(scratch, "appdata"),
      SECOND_READ_CONFIG_DIR: config,
    },
  });
}

test("the CLI is built", () => {
  assert.ok(existsSync(cli), `${cli} is missing; run npm run build`);
});

test("exit codes from the built CLI", () => {
  assert.equal(run(["check", "--kind", "commit"], "Add the hook (#2)\n").status, 0);
  const found = run(["check"], `Moved example-private-project to ${home}/projects\n`);
  assert.equal(found.status, 1);
  assert.match(found.stdout, /private term +"example-private-project"/);
  assert.match(found.stdout, /home path +".*\/projects"/);
  assert.equal(run(["check", "--kind", "nope"], "").status, 2);
});

test("the CLI starts fast enough to run on every commit", () => {
  const text = "Add the hook and its tests (#2).\n\nIt reads ~/.config and runs the check.\n".repeat(50);
  let best = Infinity;
  for (let i = 0; i < 5; i++) {
    const started = performance.now();
    const result = run(["check", "--kind", "commit"], text);
    best = Math.min(best, performance.now() - started);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  }
  assert.ok(best < 500, `the best of 5 runs took ${best.toFixed(0)} ms`);
});

test("the package has no runtime dependencies", () => {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.equal(pkg.dependencies, undefined);
  assert.equal(pkg.optionalDependencies, undefined);
  assert.equal(pkg.peerDependencies, undefined);
});
