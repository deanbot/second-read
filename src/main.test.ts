import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { loadUserConfig } from "./config.ts";
import { type Io, main } from "./main.ts";

const scratch = mkdtempSync(join(tmpdir(), "second-read-main-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

let runs = 0;

// Every run gets its own config folder and working folder inside the scratch folder. The config folder holds a file
// with no terms, as SECOND_READ_CONFIG_DIR needs, unless the run is init, which writes it.
// A setup can return variables to set on top, such as another SECOND_READ_CONFIG_DIR.
async function run(argv: string[], stdin = "", setup?: (config: string, cwd: string) => NodeJS.ProcessEnv | void) {
  const root = join(scratch, `run-${++runs}`);
  const config = join(root, "config");
  const cwd = join(root, "repo");
  mkdirSync(join(cwd, ".git"), { recursive: true });
  if (argv[0] !== "init") userFile("terms = []\n")(config);
  const env = setup?.(config, cwd) ?? {};
  let out = "";
  let err = "";
  const io: Io = {
    argv,
    env: { SECOND_READ_CONFIG_DIR: config, ...env },
    platform: "linux",
    cwd,
    identity: () => ({ user: "example", home: "/home/example", host: "example-box", tempDirs: [], emails: [] }),
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
    identity: () => ({ user: "example", home: "/home/example", host: "example-box", tempDirs: [], emails: [] }),
    command: ["node", "cli.js"],
    readStdin: async () => {
      throw new Error("stdin closed");
    },
    out: () => {},
    err: () => {},
  };
  assert.equal(await main(io), 2);
});

test("the gh shim reads no stdin from a terminal for a gist with no files, as gh doesn't", async () => {
  const config = join(scratch, "no-terms");
  userFile("terms = []\n")(config);
  const io = (stdinIsTTY: boolean): Io => ({
    argv: ["gh-shim", join(scratch, "shim", "gh"), "gist", "create", "--desc", "Clean"],
    env: { SECOND_READ_CONFIG_DIR: config, PATH: "" },
    platform: "linux",
    cwd: scratch,
    identity: () => ({ user: "example", home: "/home/example", host: "example-box", tempDirs: [], emails: [] }),
    command: ["node", "cli.js"],
    readStdin: async () => {
      throw new Error("stdin read");
    },
    stdinIsTTY,
    out: () => {},
    err: () => {},
  });
  // With no real gh on PATH, a shim that got past the check exits 127.
  assert.equal(await main(io(true)), 127);
  assert.equal(await main(io(false)), 2);
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

// A repository's own settings can set SECOND_READ_CONFIG_DIR, as Claude Code's checked-in project settings can,
// and point it at a config of the repository's choosing.
// Clean text, so a run exits 0 when its config is accepted and 2 when it's refused.
const TEXT = "Add the hook (#2)\n";

function configAt(folder: (cwd: string) => string) {
  return (_config: string, cwd: string) => {
    const dir = folder(cwd);
    userFile("terms = []\n")(dir);
    return { SECOND_READ_CONFIG_DIR: dir };
  };
}

test("a SECOND_READ_CONFIG_DIR inside the repository being checked is refused, through a symlink too", async () => {
  const inside = [
    (cwd: string) => join(cwd, "config"),
    (cwd: string) => join(cwd, ".git", "config-folder"),
    (cwd: string) => join(cwd, "a", "b", "config"),
    (cwd: string) => {
      userFile("terms = []\n")(join(cwd, "config"));
      symlinkSync(join(cwd, "config"), join(cwd, "..", "link"));
      return join(cwd, "..", "link");
    },
  ];
  for (const folder of inside) {
    const { code, err } = await run(["check"], TEXT, configAt(folder));
    assert.equal(code, 2, err);
    assert.match(err, /SECOND_READ_CONFIG_DIR is .*, inside the repository at .*repo\. A repository's own settings/);
  }
  const outside = await run(["check"], TEXT, configAt((cwd) => join(cwd, "..", "elsewhere")));
  assert.equal(outside.code, 0, outside.err);
});

test("on a file system that ignores case, the repository named in another case is the same folder", async () => {
  let ignoresCase = false;
  const { code, err } = await run(["check"], TEXT, (_config, cwd) => {
    userFile("terms = []\n")(join(cwd, "config"));
    ignoresCase = existsSync(join(cwd, "..", "REPO"));
    return { SECOND_READ_CONFIG_DIR: join(cwd, "..", "REPO", "config") };
  });
  assert.equal(code, 2, err);
  // Where case counts, the folder isn't there at all, and has no config.toml.
  assert.match(err, ignoresCase ? /inside the repository/ : /which has no config\.toml/);
});

test("a relative SECOND_READ_CONFIG_DIR is refused, since it's read from wherever the check runs", async () => {
  for (const value of ["config", "./config", "../config", "~config"]) {
    const { code, err } = await run(["check"], TEXT, () => ({ SECOND_READ_CONFIG_DIR: value }));
    assert.equal(code, 2, value);
    assert.match(err, new RegExp(`SECOND_READ_CONFIG_DIR is "${value.replaceAll(".", "\\.")}", which isn't an absolute path`));
  }
});

test("a SECOND_READ_CONFIG_DIR with no config.toml is refused, with the init line that fixes it", async () => {
  for (const folder of ["/", join(scratch, "nowhere"), tmpdir()]) {
    const { code, err } = await run(["check"], TEXT, () => ({ SECOND_READ_CONFIG_DIR: folder }));
    assert.equal(code, 2, folder);
    assert.match(err, /which has no config\.toml[^]*SECOND_READ_CONFIG_DIR=\S+ second-read init\n$/);
  }
  // Written by init, a folder with no terms in it is fine.
  const root = join(scratch, "meant-empty");
  const init = await run(["init"], "", () => ({ SECOND_READ_CONFIG_DIR: root }));
  assert.equal(init.code, 0, init.err);
  assert.equal((await run(["check"], TEXT, () => ({ SECOND_READ_CONFIG_DIR: root }))).code, 0);
});

test("init and shim install refuse a SECOND_READ_CONFIG_DIR inside the repository", async () => {
  const init = await run(["init"], "", (_config, cwd) => ({ SECOND_READ_CONFIG_DIR: join(cwd, "config") }));
  assert.equal(init.code, 2);
  assert.match(init.err, /inside the repository/);
  const shim = await run(["shim", "install"], "", configAt((cwd) => join(cwd, "config")));
  assert.equal(shim.code, 2);
  assert.match(shim.err, /inside the repository/);
});
