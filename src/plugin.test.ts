// Feeds the Claude Code plugin's hook made-up tool calls, as Claude Code would, and reads what it decides.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

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

const env: NodeJS.ProcessEnv = {
  PATH: process.env.PATH ?? "",
  HOME: home,
  GIT_CONFIG_GLOBAL: join(scratch, "gitconfig"),
  GIT_CONFIG_NOSYSTEM: "1",
  SECOND_READ_CONFIG_DIR: config,
};
// The repository's allowlist is read only inside a git repository.
assert.equal(spawnSync("git", ["init", "-q", repo], { env }).status, 0);

function hook(call: string | object, command = [process.execPath, cli, "claude-hook"]) {
  const input = typeof call === "string" ? call : JSON.stringify({ hook_event_name: "PreToolUse", cwd: repo, ...call });
  const result = spawnSync(command[0]!, command.slice(1), { cwd: scratch, input, encoding: "utf8", env });
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
  assert.match(denied.reason, new RegExp(`private term\\s+"${TERM}"`));
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
