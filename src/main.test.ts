import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { loadUserConfig } from "./config.ts";
import { type Io, main } from "./main.ts";

const scratch = mkdtempSync(join(tmpdir(), "second-read-main-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

let runs = 0;

// Every run gets its own config folder and working folder inside the scratch folder.
async function run(argv: string[], stdin = "", setup?: (config: string, cwd: string) => void) {
  const root = join(scratch, `run-${++runs}`);
  const config = join(root, "config");
  const cwd = join(root, "repo");
  mkdirSync(join(cwd, ".git"), { recursive: true });
  setup?.(config, cwd);
  let out = "";
  let err = "";
  const io: Io = {
    argv,
    env: { SECOND_READ_CONFIG_DIR: config },
    platform: "linux",
    cwd,
    identity: () => ({ user: "example", home: "/home/example", host: "example-box", tempDirs: [] }),
    command: ["node", "cli.js"],
    readStdin: async () => Buffer.from(stdin),
    out: (text) => (out += text),
    err: (text) => (err += text),
  };
  const code = await main(io);
  return { code, out, err, config };
}

function userFile(text: string) {
  return (config: string) => {
    mkdirSync(config, { recursive: true });
    writeFileSync(join(config, "config.toml"), text);
  };
}

test("clean text exits 0 and prints nothing", async () => {
  const { code, out, err } = await run(["check", "--kind", "commit"], "Add the hook (#2)\n");
  assert.deepEqual({ code, out, err }, { code: 0, out: "", err: "" });
});

test("findings exit 1 with a report naming each category, line and text", async () => {
  const { code, out, err } = await run(
    ["check", "--kind=pr"],
    "Ported from example-private-project.\nSee ~/notes and the billing page.\n",
    userFile('terms = ["Example Private Project"]\n'),
  );
  assert.equal(code, 1);
  assert.equal(err, "");
  assert.equal(
    out,
    "second-read: 3 findings in this pull request. Nothing was changed; fix the text and try again.\n" +
      '  1:13    private term           "example-private-project"\n' +
      '  2:5     home path              "~/notes"\n' +
      '  2:21    money (billing)        "billing"\n',
  );
});

test("the repository's allowlist applies", async () => {
  const { code } = await run(["check"], "the billing page", (_config, cwd) =>
    writeFileSync(join(cwd, ".second-read.toml"), 'allowed_words = ["billing"]\n'),
  );
  assert.equal(code, 0);
});

// A repository's allowed words used to switch off the machine name too, which publishes the name to allow it.
test("only the user's own file can stop the machine name being flagged", async () => {
  const repoWords = await run(["check"], "Built on example-box", (_config, cwd) =>
    writeFileSync(join(cwd, ".second-read.toml"), 'allowed_words = ["example-box"]\n'),
  );
  assert.equal(repoWords.code, 1);
  assert.match(repoWords.out, /machine name +"example-box"/);
  const repoNames = await run(["check"], "Built on example-box", (_config, cwd) =>
    writeFileSync(join(cwd, ".second-read.toml"), 'allowed_names = ["example-box"]\n'),
  );
  assert.equal(repoNames.code, 2);
  assert.match(repoNames.err, /allowed_names belongs in your own config file/);
  // The account name "example" is in the machine name, so it's allowed too.
  const user = await run(["check"], "Built on example-box", userFile('allowed_names = ["example", "example-box"]\n'));
  assert.equal(user.code, 0, user.out);
});

test("the check failing exits 2, so a guard refuses rather than waving the post through", async () => {
  const cases: [string[], ((config: string, cwd: string) => void) | undefined, RegExp][] = [
    [["check", "--kind", "tweet"], undefined, /--kind must be one of/],
    [["check", "--kind"], undefined, /--kind must be one of/],
    [["check", "--quiet"], undefined, /unknown option "--quiet"/],
    [[], undefined, /no command given/],
    [["chekc"], undefined, /unknown command "chekc"/],
    [["check"], userFile("terms = [\n"), /the check failed: .*config\.toml: line 2/],
    [
      ["check"],
      (_config, cwd) => writeFileSync(join(cwd, ".second-read.toml"), 'terms = ["x"]\n'),
      /never in a repository/,
    ],
  ];
  for (const [argv, setup, message] of cases) {
    const { code, out, err } = await run(argv, "billing", setup);
    assert.equal(code, 2, argv.join(" "));
    assert.equal(out, "");
    assert.match(err, message);
  }
});

test("a failure reading stdin exits 2", async () => {
  const io: Io = {
    argv: ["check"],
    env: { SECOND_READ_CONFIG_DIR: join(scratch, "no-config") },
    platform: "linux",
    cwd: scratch,
    identity: () => ({ user: "example", home: "/home/example", host: "example-box", tempDirs: [] }),
    command: ["node", "cli.js"],
    readStdin: async () => {
      throw new Error("stdin closed");
    },
    out: () => {},
    err: () => {},
  };
  assert.equal(await main(io), 2);
});

test("init writes the user file with comments and no terms, and says how to add one", async () => {
  const { code, out, config } = await run(["init"]);
  const path = join(config, "config.toml");
  assert.equal(code, 0);
  assert.match(out, /wrote .*config\.toml/);
  assert.match(out, /terms = \[\n {4}"example-private-project",\n {2}\]/);
  assert.match(readFileSync(path, "utf8"), /^# /);
  assert.deepEqual(loadUserConfig(path).terms, []);
  if (process.platform !== "win32") assert.equal(statSync(path).mode & 0o777, 0o600);
});

test("init leaves an existing file alone", async () => {
  const { code, out, config } = await run(["init"], "", userFile('terms = ["example-private-project"]\n'));
  assert.equal(code, 0);
  assert.match(out, /already exists/);
  assert.equal(readFileSync(join(config, "config.toml"), "utf8"), 'terms = ["example-private-project"]\n');
});

test("help exits 0", async () => {
  const { code, out } = await run(["--help"]);
  assert.equal(code, 0);
  assert.match(out, /second-read check/);
});
