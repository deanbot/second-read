// Feeds the Claude Code plugin's hook made-up tool calls, as Claude Code would, and reads what it decides.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { checkTerms } from "./checks.ts";
import { fakeClaude, transcript } from "./fake-claude.test.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const cli = join(root, "dist", "cli.js");

const scratch = mkdtempSync(join(tmpdir(), "second-read-plugin-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

const TERM = "example-private-project";
const home = join(scratch, "home");
const config = join(scratch, "config");
const repo = join(scratch, "repo");
for (const dir of [home, config, join(repo, "src")]) mkdirSync(dir, { recursive: true });
writeFileSync(join(config, "config.toml"), `terms = ["${TERM}"]\n`);
writeFileSync(join(repo, ".second-read.toml"), 'exempt_files = ["src/**/*.test.ts"]\n');
writeFileSync(join(scratch, "gitconfig"), "[user]\n\tname = Example\n\temail = example@example.com\n");

// The model check runs a made-up claude, which passes every post unless a test says otherwise.
const fake = fakeClaude(join(scratch, "bin"));
const USER_TURN = "Please move the cache. I want it gone before my sister visits, she says the laptop is slow.";
const transcriptPath = join(scratch, "transcript.jsonl");
writeFileSync(transcriptPath, transcript([USER_TURN]));

const env: NodeJS.ProcessEnv = {
  PATH: `${fake.dir}:${process.env.PATH ?? ""}`,
  HOME: home,
  GIT_CONFIG_GLOBAL: join(scratch, "gitconfig"),
  GIT_CONFIG_NOSYSTEM: "1",
  SECOND_READ_CONFIG_DIR: config,
  CLAUDE_PLUGIN_DATA: join(scratch, "data"),
};
// The repository's allowlist is read only inside a git repository.
assert.equal(spawnSync("git", ["init", "-q", repo], { env }).status, 0);

function hook(call: string | object, command = [process.execPath, cli, "claude-hook"], extra: NodeJS.ProcessEnv = {}) {
  const input =
    typeof call === "string"
      ? call
      : JSON.stringify({ hook_event_name: "PreToolUse", cwd: repo, transcript_path: transcriptPath, ...call });
  const result = spawnSync(command[0]!, command.slice(1), {
    cwd: scratch,
    input,
    encoding: "utf8",
    env: { ...env, ...extra },
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr);
  // Never "allow", which would skip the user's own permission prompt.
  assert.doesNotMatch(result.stdout, /"allow"/);
  if (result.stdout === "") return { denied: false, reason: "" };
  const output = JSON.parse(result.stdout).hookSpecificOutput;
  assert.equal(output.hookEventName, "PreToolUse");
  assert.equal(output.permissionDecision, "deny");
  return { denied: true, reason: output.permissionDecisionReason as string };
}

const bash = (command: string) => ({ tool_name: "Bash", tool_input: { command, description: "Post it" } });

// The same change, written once with the made-up user's private project in it and once without.
const LEAKY = `Moves the cache, so ${TERM} can share it.`;
const CLEAN = "Moves the cache to the config folder.";

test("the hook denies a gh post with a private term, and lets the same post without it through", () => {
  const command = (body: string) => `gh pr create --title "Move the cache" --body "$(cat <<'EOF'\n${body}\nEOF\n)"`;
  const denied = hook(bash(command(LEAKY)));
  assert.ok(denied.denied);
  assert.match(denied.reason, /1 finding in the body of this pull request/);
  // The reason goes into the session, so it says where the term is without naming it.
  assert.match(denied.reason, /1:21\s+private term\s+\(not shown\)/);
  assert.doesNotMatch(denied.reason, new RegExp(TERM));
  assert.deepEqual(hook(bash(command(CLEAN))), { denied: false, reason: "" });
});

test("the hook checks gh api posts, such as a reply to an inline review comment", () => {
  const reply = (body: string) => `gh api repos/example/repo/pulls/7/comments -X POST -f body="${body}" -F in_reply_to=1`;
  assert.match(hook(bash(reply("Saved to ~/notes/today.md"))).reason, /home path/);
  assert.equal(hook(bash(reply(CLEAN))).denied, false);
  assert.equal(hook(bash(`gh api repos/example/repo/pulls/7/comments --jq '.[].body'`)).denied, false);
});

test("the hook checks git commit messages, and leaves other commands alone", () => {
  assert.match(hook(bash(`git add -A && git commit -m "${LEAKY}"`)).reason, /this commit message/);
  assert.equal(hook(bash(`git commit -m "${CLEAN}"`)).denied, false);
  assert.equal(hook(bash(`grep -r ${TERM} src`)).denied, false);
  assert.equal(hook({ tool_name: "Read", tool_input: { file_path: join(repo, TERM) } }).denied, false);
});

test("the hook checks posts inside substitutions, and files the command writes first", () => {
  assert.match(hook(bash(`PR_URL=$(gh pr create -t "Move the cache" -b "${LEAKY}")`)).reason, /body of this pull request/);
  assert.match(hook(bash(`echo \`git commit -m "${LEAKY}"\``)).reason, /this commit message/);
  writeFileSync(join(repo, "body.md"), `${CLEAN}\n`);
  const rewrite = `cat > body.md <<'EOF'\n${LEAKY}\nEOF\ngh pr create -t "Move the cache" -F body.md`;
  assert.match(hook(bash(rewrite)).reason, /private term/);
});

test("the hook checks comments left by close and reopen, merge commit messages, and posts behind sudo", () => {
  assert.match(hook(bash(`gh issue close 3 --comment "${LEAKY}"`)).reason, /body of this comment/);
  assert.match(hook(bash(`gh pr reopen 5 -c "${LEAKY}"`)).reason, /body of this comment/);
  assert.match(hook(bash(`gh pr merge 5 --squash --subject "${LEAKY}"`)).reason, /subject of this merge commit/);
  assert.match(hook(bash(`gh pr merge 5 -t "Move the cache" --body "${LEAKY}"`)).reason, /body of this merge commit/);
  assert.equal(hook(bash(`gh pr merge 5 --squash --subject "Move the cache" --body "${CLEAN}"`)).denied, false);
  assert.match(hook(bash(`sudo gh pr comment 5 --body "${LEAKY}"`)).reason, /private term/);
});

test("the hook checks gh release, gist, label and repo posts", () => {
  assert.match(hook(bash(`gh release create v1 --title "${LEAKY}"`)).reason, /title of this release/);
  assert.match(hook(bash(`gh release edit v1 -n "${LEAKY}"`)).reason, /notes of this release/);
  assert.match(hook(bash(`gh gist create -d "${LEAKY}" --public`)).reason, /description of this gist/);
  assert.match(hook(bash(`echo "${LEAKY}" | gh gist create -f notes.md`)).reason, /contents of this gist/);
  assert.match(hook(bash(`gh label create ${TERM} --color ff0000`)).reason, /name of this label/);
  assert.match(hook(bash(`gh label edit bug --description "${LEAKY}"`)).reason, /description of this label/);
  assert.match(hook(bash(`gh repo create example/repo -d "${LEAKY}"`)).reason, /description of this repository/);
  assert.match(hook(bash(`gh repo edit --description "${LEAKY}"`)).reason, /description of this repository/);
  assert.equal(hook(bash(`gh release create v1 -t "Version 1" -n "${CLEAN}"`)).denied, false);
  assert.equal(hook(bash(`gh label create bug -c ff0000 -d "${CLEAN}"`)).denied, false);
  assert.match(hook(bash(`cat notes.md | gh gist create`)).reason, /can't check what this command posts/);
});

test("the hook reads grouped short flags as gh does", () => {
  assert.match(hook(bash(`gh pr create -dt "${LEAKY}"`)).reason, /title of this pull request/);
  assert.match(hook(bash(`gh label create bug -fd "${LEAKY}"`)).reason, /description of this label/);
  assert.equal(hook(bash(`gh pr create -dt "Move the cache" -b "${CLEAN}"`)).denied, false);
  // Regression: gh api read -if as the switch -i alone, so the field went unchecked.
  assert.match(hook(bash(`gh api repos/example/repo/issues -if body="${LEAKY}"`)).reason, /body field of gh api/);
  assert.match(hook(bash(`gh api repos/example/repo/issues -iXPOST -f body="${LEAKY}"`)).reason, /body field/);
  assert.equal(hook(bash(`gh api repos/example/repo/issues -if body="${CLEAN}"`)).denied, false);
});

test("the hook checks the names a post gives as branch names are read, and lets a leaked name be renamed", () => {
  assert.match(hook(bash(`gh repo create example/${TERM} --public`)).reason, /name of this repository/);
  assert.match(hook(bash(`gh repo create -h https://example.com example/paid-plan`)).reason, /money \(plan\)/);
  assert.match(hook(bash(`gh repo rename -R example/repo ${TERM}`)).reason, /name of this repository/);
  assert.match(hook(bash(`gh release create ${TERM}-v1 -t "Version 1"`)).reason, /tag of this release/);
  assert.match(hook(bash(`gh release edit v1 --tag paid-plan-v1`)).reason, /tag of this release/);
  assert.match(hook(bash(`echo "${CLEAN}" | gh gist create -f ${TERM}.md`)).reason, /file name of this gist/);
  mkdirSync(join(repo, TERM), { recursive: true });
  writeFileSync(join(repo, TERM, "notes.md"), `${CLEAN}\n`);
  writeFileSync(join(repo, `${TERM}.md`), `${CLEAN}\n`);
  assert.equal(hook(bash(`gh gist create ${TERM}/notes.md`)).denied, false);
  assert.match(hook(bash(`gh gist edit abc123 --add ${TERM}.md`)).reason, /file name of this gist/);
  assert.equal(hook(bash(`gh release edit ${TERM}-v1 --tag v1`)).denied, false);
  assert.equal(hook(bash(`gh repo rename -R example/${TERM} clean`)).denied, false);
});

// The scratch git config's user.email is example@example.com.
test("the hook checks a merge commit's author email as an address in a commit", () => {
  const allowing = join(scratch, "allowing");
  assert.equal(spawnSync("git", ["init", "-q", allowing], { env }).status, 0);
  writeFileSync(join(allowing, ".second-read.toml"), 'allowed_emails = ["*@example.com"]\n');
  const merge = (args: string) => hook({ ...bash(`gh pr merge 5 --squash ${args}`), cwd: allowing });
  assert.match(merge("-A example@example.com").reason, /author email of this merge commit[^]*your email/);
  assert.match(merge("--author-email=someone@mail-example.co").reason, /email +"someone@mail-example\.co"/);
  assert.equal(merge("-A 12345+example@users.noreply.github.com").denied, false);
  assert.equal(merge("-A someone@example.com").denied, false);
  assert.match(merge(`-A "$EMAIL"`).reason, /can't check what this command posts/);
});

test("the hook checks each release asset's file name and label", () => {
  assert.match(hook(bash(`gh release create v1 "dist/app.tgz#${LEAKY}"`)).reason, /label of an asset of this release/);
  assert.match(hook(bash(`gh release upload v1 dist/app.tgz#${TERM}`)).reason, /label of an asset of this release/);
  assert.match(hook(bash(`gh release upload v1 dist/${TERM}.tgz`)).reason, /file name of an asset of this release/);
  assert.match(hook(bash(`gh release create v1 "dist/${TERM}.tgz#Build"`)).reason, /file name of an asset of this release/);
  assert.equal(hook(bash(`gh release upload v1 dist/${TERM}/app.tgz "dist/app.tgz#App for Linux"`)).denied, false);
  // A glob is expanded only when the command runs, past files it may make first.
  const glob = hook(bash(`npm pack --pack-destination dist && gh release upload v1 dist/*.tgz`)).reason;
  assert.match(glob, /can't check what this command posts[^]*file name of an asset of this release: dist\/\*\.tgz/);
  assert.equal(hook(bash(`gh release upload v1 "dist/*.tgz#All builds"`)).denied, false);
});

test("the hook checks the files a gist uploads in full, even exempt ones", () => {
  const fixture = 'const saved = "~/notes/today.md";\n';
  writeFileSync(join(repo, "src", "cache.test.ts"), fixture);
  assert.match(hook(bash(`gh gist create src/cache.test.ts`)).reason, /home path/);
  assert.match(hook(bash(`gh gist edit abc123 --add src/cache.test.ts`)).reason, /home path/);
});

test("the hook refuses a post it can't read, or whose check fails", () => {
  assert.match(hook(bash(`gh pr comment 5 --body "$BODY"`)).reason, /can't check what this command posts[^]*\$BODY/);
  assert.match(hook(bash(`xargs gh pr comment 5 --body < notes.txt`)).reason, /the arguments xargs adds/);
  assert.match(hook(bash(`gh pr comment 5 --body-file missing.md`)).reason, /the check failed/);
  assert.match(hook("not json").reason, /the check failed/);
});

test("the hook checks GitHub tools from MCP servers, whatever the server is called", () => {
  const comment = (body: string) => ({
    tool_name: "mcp__plugin_example_github__add_issue_comment",
    tool_input: { owner: "example", repo: "repo", issue_number: 3, body },
  });
  assert.match(hook(comment(LEAKY)).reason, /body of add_issue_comment/);
  assert.equal(hook(comment(CLEAN)).denied, false);
  assert.equal(hook({ tool_name: "mcp__memory__create_entities", tool_input: { name: TERM } }).denied, false);
});

test("the hook checks a file a GitHub tool writes as the lines it adds, exempt files included", () => {
  const push = (path: string, content: string) => ({
    tool_name: "mcp__github__push_files",
    tool_input: { owner: "example", repo: "repo", branch: "topic", message: "Add a test", files: [{ path, content }] },
  });
  const fixture = 'const saved = "~/notes/today.md";\n';
  assert.equal(hook(push("src/cache.test.ts", fixture)).denied, false);
  assert.match(hook(push("src/cache.ts", fixture)).reason, /home path/);
  assert.match(hook(push("src/cache.test.ts", `// ${TERM}\n`)).reason, /private term/);
});

const prBody = (body: string) => bash(`gh pr create --title "Move the cache" --body "${body}"`);

test("the model check runs once for a post the word check passes, and never for other calls", () => {
  fake.mode("clean");
  assert.equal(hook(bash(`ls -la && npm test`)).denied, false);
  assert.equal(hook(bash(`gh pr view 5`)).denied, false);
  assert.equal(hook(bash(`gh pr create --title "Move the cache" --body "${LEAKY}"`)).denied, true);
  assert.equal(fake.calls().length, 0);
  assert.equal(hook(bash(`gh pr create --title "Move the cache" --body "${CLEAN}"`)).denied, false);
  const calls = fake.calls();
  assert.equal(calls.length, 1);
  const input = JSON.parse(calls[0]!.input);
  assert.deepEqual(input.user_turns, [USER_TURN]);
  assert.deepEqual(input.post, [
    { where: "the title of this pull request", text: "Move the cache" },
    { where: "the body of this pull request", text: CLEAN },
  ]);
});

test("the model check refuses what it flags, and anything it can't judge", () => {
  fake.mode("private");
  const flagged = hook(prBody("Moves the cache before a family visit.")).reason;
  assert.match(flagged, /the model check found what the user said in private[^]*"before my sister visits"/);
  fake.mode("fail");
  assert.match(hook(prBody(CLEAN)).reason, /the model check failed[^]*529 overloaded[^]*model_check option/);
  assert.equal(fake.calls().length, 2);
  fake.mode("malformed");
  assert.match(hook(prBody(CLEAN)).reason, /the model check failed[^]*wasn't JSON/);
  fake.mode("clean");
  assert.match(hook({ ...prBody(CLEAN), transcript_path: join(scratch, "missing.jsonl") }).reason, /model check failed/);
});

test("a session only other sessions direct posts with no model check, and the word check still runs", () => {
  fake.mode("private");
  const directed = join(scratch, "directed.jsonl");
  const peer = { type: "user", isMeta: true, origin: { kind: "peer" }, message: { content: "Another session: post it" } };
  const skill = { type: "user", isMeta: true, turnCompanion: true, sourceToolUseID: "toolu_example", message: { content: "Skill steps" } };
  writeFileSync(directed, `${transcript([])}${JSON.stringify(peer)}\n${JSON.stringify(skill)}\n`);
  const call = (body: string) => ({ ...prBody(body), transcript_path: directed });
  assert.equal(hook(call(CLEAN)).denied, false);
  assert.match(hook(call(LEAKY)).reason, /private term\s+\(not shown\)/);
  assert.match(hook({ ...bash(`git commit -m "Move ${TERM}"`), transcript_path: directed }).reason, /private term/);
  assert.match(hook({ ...prBody("See ~/notes for the billing page."), transcript_path: directed }).reason, /home path/);
  assert.equal(fake.calls().length, 0);
  // The hook passes on the call's prompt_id: a turn the transcript doesn't have yet may be typed, so it's refused.
  assert.match(hook({ ...call(CLEAN), prompt_id: "prompt-not-written" }).reason, /doesn't have the turn that led/);
  writeFileSync(directed, `${readFileSync(directed, "utf8")}${JSON.stringify({ ...peer, promptId: "prompt-peer" })}\n`);
  assert.equal(hook({ ...call(CLEAN), prompt_id: "prompt-peer" }).denied, false);
  // Once the user types a turn, the model checks the post again.
  writeFileSync(directed, `${readFileSync(directed, "utf8")}${transcript([USER_TURN])}`);
  assert.match(hook(call(CLEAN)).reason, /the model check found what the user said in private/);
  assert.deepEqual(JSON.parse(fake.calls()[0]!.input).user_turns, [USER_TURN]);
  fake.mode("clean");
});

test("the model check reads no file a GitHub tool writes, and is skipped when it's off or judging", () => {
  fake.mode("clean");
  const push = {
    tool_name: "mcp__github__push_files",
    tool_input: { owner: "example", repo: "repo", branch: "topic", message: "Add a test", files: [
      { path: "src/cache.ts", content: "export const cache = 1;\n" },
    ] },
  };
  assert.equal(hook(push).denied, false);
  assert.deepEqual(JSON.parse(fake.calls()[0]!.input).post.map((p: { text: string }) => p.text), ["topic", "Add a test", "src/cache.ts"]);
  fake.mode("private");
  assert.equal(hook(prBody(CLEAN), undefined, { CLAUDE_PLUGIN_OPTION_MODEL_CHECK: "false" }).denied, false);
  assert.equal(hook(prBody(CLEAN), undefined, { SECOND_READ_JUDGING: "1" }).denied, false);
  assert.equal(fake.calls().length, 0);
  assert.equal(hook(prBody(CLEAN), undefined, { CLAUDE_PLUGIN_OPTION_MODEL: "sonnet" }).denied, true);
  const args = fake.calls()[0]!.args;
  assert.equal(args[args.indexOf("--model") + 1], "sonnet");
  fake.mode("clean");
});

test("the plugin's options and the hook's timeout leave the model check room to answer", () => {
  const plugin = JSON.parse(readFileSync(join(root, ".claude-plugin", "plugin.json"), "utf8"));
  assert.equal(plugin.userConfig.model_check.type, "boolean");
  assert.equal(plugin.userConfig.model_check.default, true);
  assert.equal(plugin.userConfig.model.default, "haiku");
  // A string, which every Claude Code the plugin supports takes: an option type it doesn't know keeps the plugin, and
  // so every check, from loading. No default, so unset finds the config as everything else does.
  assert.equal(plugin.userConfig.config_dir.type, "string");
  assert.equal(Object.hasOwn(plugin.userConfig.config_dir, "default"), false);
  const hooks = JSON.parse(readFileSync(join(root, "adapters", "claude-code", "hooks.json"), "utf8"));
  // The judge is killed at 90 seconds, so its own reason is given before the hook times out.
  assert.ok(hooks.hooks.PreToolUse[0].hooks[0].timeout > 90);
});

test("the command the plugin's hooks.json names runs the hook from the source", () => {
  const hooks = JSON.parse(readFileSync(join(root, "adapters", "claude-code", "hooks.json"), "utf8"));
  const [entry] = hooks.hooks.PreToolUse;
  assert.match("Bash", new RegExp(entry.matcher));
  assert.match("mcp__claude_ai_GitHub__create_issue", new RegExp(entry.matcher));
  assert.doesNotMatch("BashOutput", new RegExp(entry.matcher));
  const [handler] = entry.hooks;
  assert.equal(handler.onFailure, "block");
  const args = (handler.args as string[]).map((a) => a.replace("${CLAUDE_PLUGIN_ROOT}", root));
  const plugin = JSON.parse(readFileSync(join(root, ".claude-plugin", "plugin.json"), "utf8"));
  assert.equal(plugin.hooks, "./adapters/claude-code/hooks.json");
  assert.match(hook(bash(`gh issue create -t "${LEAKY}" -b "${CLEAN}"`), [handler.command, ...args]).reason, /title/);
});

// A session that works on second-read reads a config folder with no terms, so its own output never shows the user's
// terms. The plugin's config_dir option points its hooks at the real one.
const empty = join(scratch, "empty");
const own = join(scratch, "own");
mkdirSync(empty, { recursive: true });
mkdirSync(own, { recursive: true });
writeFileSync(join(empty, "config.toml"), "terms = []\n");
writeFileSync(join(own, "config.toml"), `terms = ["${TERM}"]\n`);
const session = { SECOND_READ_CONFIG_DIR: empty };

test("with config_dir set, the hook reads that folder, while check run by the session reads SECOND_READ_CONFIG_DIR", () => {
  fake.mode("clean");
  assert.equal(hook(prBody(LEAKY), undefined, session).denied, false);
  const withOption = { ...session, CLAUDE_PLUGIN_OPTION_CONFIG_DIR: own };
  assert.match(hook(prBody(LEAKY), undefined, withOption).reason, /1 finding in the body[^]*private term\s+\(not shown\)/);
  const checked = spawnSync(process.execPath, [cli, "check"], {
    cwd: scratch,
    input: LEAKY,
    encoding: "utf8",
    env: { ...env, ...withOption },
  });
  assert.equal(checked.status, 0, checked.stdout);
});

test("config_dir takes ~ for the home folder, and a blank one is unset", () => {
  fake.mode("clean");
  mkdirSync(join(home, "own"), { recursive: true });
  writeFileSync(join(home, "own", "config.toml"), `terms = ["${TERM}"]\n`);
  assert.equal(hook(prBody(LEAKY), undefined, { ...session, CLAUDE_PLUGIN_OPTION_CONFIG_DIR: "~/own" }).denied, true);
  assert.equal(hook(prBody(LEAKY), undefined, { ...session, CLAUDE_PLUGIN_OPTION_CONFIG_DIR: " " }).denied, false);
  assert.equal(hook(prBody(LEAKY), undefined, { CLAUDE_PLUGIN_OPTION_CONFIG_DIR: "" }).denied, true);
});

test("a config_dir with no config.toml, or that isn't absolute, refuses every post and no other call", () => {
  fake.mode("clean");
  const missing = { ...session, CLAUDE_PLUGIN_OPTION_CONFIG_DIR: join(scratch, "nowhere") };
  assert.match(hook(prBody(CLEAN), undefined, missing).reason, /config_dir option is .*nowhere, which has no config\.toml/);
  assert.equal(hook(bash(`ls -la`), undefined, missing).denied, false);
  const relative = { ...session, CLAUDE_PLUGIN_OPTION_CONFIG_DIR: "own" };
  assert.match(hook(prBody(CLEAN), undefined, relative).reason, /config_dir option is "own", which isn't an absolute path/);
  assert.equal(hook(bash(`ls -la`), undefined, relative).denied, false);
});

// Whether a text names the made-up term in any form the check would catch.
const namesTerm = (text: string) =>
  checkTerms(text, {
    identity: { user: "", home: "/nonexistent", host: "", tempDirs: [], emails: [] },
    rules: { terms: [TERM], allowedWords: [], allowedEmails: [], allowedPaths: [], allowedNames: [], userAllowedEmails: [] },
  }).length > 0;

test("no reason the hook gives names a private term, wherever the term turns up", () => {
  fake.mode("clean");
  mkdirSync(join(repo, TERM), { recursive: true });
  writeFileSync(join(repo, TERM, "leaky.md"), "Saved to ~/notes/today.md\n");
  const calls = [
    bash(`gh pr comment 5 --body "Saved to ~/${TERM}/notes"`),
    bash(`gh pr comment 5 --body "Write to ops@${TERM}.dev"`),
    bash(`gh pr comment 5 --body "Moves ExamplePrivateProject and ｅｘａｍｐｌｅ-private-project"`),
    bash(`gh pr comment 5 --body-file ${TERM}/leaky.md`),
    bash(`gh pr comment 5 --body-file ${TERM}/missing.md`),
    bash(`gh pr comment 5 --body "$(./${TERM}/notes)"`),
    { tool_name: "mcp__github__push_files", tool_input: { files: [{ path: `${TERM}/a.ts`, content: "~/notes\n" }] } },
  ];
  for (const call of calls) {
    const { denied, reason } = hook(call);
    assert.ok(denied, JSON.stringify(call));
    assert.ok(!namesTerm(reason), reason);
    assert.match(reason, /\[private term\]|\(not shown\)/, reason);
  }
  fake.mode("quotes-term");
  const judged = hook(prBody(CLEAN)).reason;
  assert.match(judged, /the model check found[^]*before the \[private term\] launch/);
  fake.mode("clean");
});

test("a term is masked before a value is quoted, so an escaped newline or backslash can't hide it", () => {
  fake.mode("clean");
  const comment = (body: string) => ({
    tool_name: "mcp__github__add_issue_comment",
    tool_input: { owner: "example", repo: "repo", issue_number: 3, body },
  });
  // Quoted, each joins as an escape whose letters and backslashes break the term's words apart.
  for (const join of ["\\\\", "\u0001", "\ud800"]) {
    const words = TERM.split("-").join(join);
    const { denied, reason } = hook(comment(`See ~/notes/${words}/a.md`));
    assert.ok(denied, JSON.stringify(join));
    assert.match(reason, /home path\s+"~\/notes\/\[private term\]\/a\.md"/, reason);
    assert.doesNotMatch(reason, /example/i, reason);
  }
  fake.mode("quotes-term-across-lines");
  const judged = hook(prBody(CLEAN)).reason;
  assert.match(judged, /carries what the user said: "the \[private term\] launch"/, judged);
  assert.doesNotMatch(judged, /example/i, judged);
  fake.mode("clean");
});

test("the hook refuses a SECOND_READ_CONFIG_DIR inside a repository, wherever a post goes, and no other call", () => {
  fake.mode("clean");
  mkdirSync(join(repo, "config-folder"), { recursive: true });
  writeFileSync(join(repo, "config-folder", "config.toml"), "terms = []\n");
  const inRepo = { SECOND_READ_CONFIG_DIR: join(repo, "config-folder") };
  assert.match(hook(prBody(LEAKY), undefined, inRepo).reason, /SECOND_READ_CONFIG_DIR is .*config-folder, inside the repository/);
  // A post that goes to a folder in no repository, or in another, is refused just the same.
  for (const cwd of [home, join(scratch, "other-repo")]) {
    if (cwd !== home) assert.equal(spawnSync("git", ["init", "-q", cwd], { env }).status, 0);
    const reason = hook({ ...prBody(LEAKY), cwd }, undefined, inRepo).reason;
    assert.match(reason, /SECOND_READ_CONFIG_DIR is .*config-folder, inside the repository/, cwd);
  }
  assert.equal(hook(bash(`ls -la`), undefined, inRepo).denied, false);
  // config_dir, which no repository can set, takes the hook past it.
  assert.equal(hook(prBody(LEAKY), undefined, { ...inRepo, CLAUDE_PLUGIN_OPTION_CONFIG_DIR: own }).denied, true);
  assert.match(hook(prBody(LEAKY), undefined, { ...inRepo, CLAUDE_PLUGIN_OPTION_CONFIG_DIR: own }).reason, /\(not shown\)/);
});

test("a reason the hook can't mask, since the terms can't be read, gives only why", () => {
  const broken = join(scratch, "broken");
  mkdirSync(broken, { recursive: true });
  writeFileSync(join(broken, "config.toml"), `terms = ["${TERM}", 1]\n`);
  const { denied, reason } = hook(bash(`gh pr comment 5 --body "$(./${TERM}/notes)"`), undefined, {
    CLAUDE_PLUGIN_OPTION_CONFIG_DIR: broken,
  });
  assert.ok(denied);
  assert.match(reason, /the check failed[^]*arrays may hold only strings/);
  assert.doesNotMatch(reason, new RegExp(TERM));
});
