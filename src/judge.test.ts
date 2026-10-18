import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fakeClaude, transcript } from "./fake-claude.test.ts";
import {
  judgeInput,
  judgeRefusal,
  modelCheck,
  parseVerdict,
  recentTurns,
  RULE,
  runJudge,
  userTurns,
} from "./judge.ts";

const scratch = mkdtempSync(join(tmpdir(), "second-read-judge-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

const fake = fakeClaude(join(scratch, "bin"));
const env: NodeJS.ProcessEnv = { PATH: `${fake.dir}:${process.env.PATH ?? ""}`, CLAUDE_PLUGIN_DATA: join(scratch, "data") };
const options = { env, model: "haiku" };

const TURN = "Please move the cache. I want it gone before my sister visits, she says the laptop is slow.";
const texts = [{ where: "the body of this pull request", text: "Moves the cache to the config folder." }];
const path = join(scratch, "transcript.jsonl");
writeFileSync(path, transcript(["Hello.", TURN]));

test("only what the user typed is read from a transcript", () => {
  const lines = transcript(["Hello.", TURN]).split("\n");
  lines.push(JSON.stringify({ type: "user", isSidechain: true, message: { content: "A subagent's prompt" } }));
  lines.push(JSON.stringify({ type: "user", message: { content: [{ type: "text", text: "Pasted" }, { type: "image" }] } }));
  lines.push("{ not json");
  assert.deepEqual(userTurns(lines.join("\n")), ["Hello.", TURN, "Pasted"]);
});

test("the newest turns are kept first, up to the cap", () => {
  assert.deepEqual(recentTurns(["old", "middle", "new"], 9), ["new", "middle"]);
  assert.deepEqual(recentTurns(["old", "a newest turn past the cap"], 7), ["the cap"]);
  const input = JSON.parse(judgeInput(["new"], texts));
  assert.deepEqual(input, { user_turns: ["new"], post: texts });
});

test("a verdict is read only when it matches the schema", () => {
  const out = (v: unknown) => JSON.stringify({ is_error: false, structured_output: v });
  assert.deepEqual(parseVerdict(out({ private: false, findings: [] })), { flagged: false, findings: [] });
  const finding = { where: "w", post: "p", user: "u" };
  assert.deepEqual(parseVerdict(out({ private: true, findings: [finding] })), { flagged: true, findings: [finding] });
  assert.deepEqual(parseVerdict(out({ private: false, findings: [finding] })), { flagged: true, findings: [finding] });
  assert.deepEqual(parseVerdict(out({ private: true, findings: [] })), { flagged: true, findings: [] });
  assert.match(parseVerdict(out({ private: "no", findings: [] })) as string, /schema/);
  assert.match(parseVerdict(out({ private: false, findings: [{ where: "w" }] })) as string, /schema/);
  assert.match(parseVerdict(JSON.stringify({ is_error: true, result: "x" })) as string, /error/);
  assert.match(parseVerdict("not json") as string, /wasn't JSON/);
});

test("the options are read from the environment, and off only when the user says so", () => {
  assert.deepEqual(modelCheck({}), { on: true, model: "haiku" });
  assert.deepEqual(modelCheck({ CLAUDE_PLUGIN_OPTION_MODEL_CHECK: "false", CLAUDE_PLUGIN_OPTION_MODEL: "sonnet" }), {
    on: false,
    model: "sonnet",
  });
  assert.equal(modelCheck({ CLAUDE_PLUGIN_OPTION_MODEL_CHECK: "true" }).on, true);
});

test("the judge runs with no tools, MCP servers or hooks, from an empty folder, and is told not to judge itself", () => {
  fake.mode("clean");
  assert.deepEqual(runJudge("{}", options), { flagged: false, findings: [] });
  const [call] = fake.calls();
  const args = call!.args;
  const after = (flag: string) => args[args.indexOf(flag) + 1];
  assert.equal(after("--tools"), "");
  assert.equal(after("--model"), "haiku");
  assert.ok(args.includes("--strict-mcp-config") && args.includes("--no-session-persistence"));
  assert.deepEqual(JSON.parse(after("--settings")!), { disableAllHooks: true });
  assert.equal(after("--system-prompt"), RULE);
  assert.equal(call!.cwd.endsWith("second-read-judge"), true);
  assert.equal(call!.judging, "1");
  assert.equal(call!.input, "{}");
});

test("a quick failure is tried once more, and a second failure refuses", () => {
  fake.mode("fail,clean");
  assert.deepEqual(runJudge("{}", options), { flagged: false, findings: [] });
  assert.equal(fake.calls().length, 2);
  fake.mode("fail");
  assert.match(runJudge("{}", options) as string, /claude exited with 1: API Error: 529 overloaded/);
  assert.equal(fake.calls().length, 2);
});

test("a timeout, bad output or a missing claude refuses without trying again", () => {
  fake.mode("hang");
  assert.match(runJudge("{}", { ...options, timeoutMs: 2000 }) as string, /longer than 2 seconds/);
  assert.equal(fake.calls().length, 1);
  fake.mode("malformed,clean");
  assert.match(runJudge("{}", options) as string, /wasn't JSON/);
  assert.equal(fake.calls().length, 1);
  assert.match(runJudge("{}", { ...options, env: { PATH: join(scratch, "nothing") } }) as string, /isn't on PATH/);
});

test("a flagged post is refused with each finding, and a clean one goes on", () => {
  fake.mode("private");
  const reason = judgeRefusal(texts, path, options)!;
  assert.match(reason, /the model check found what the user said in private/);
  assert.match(reason, /the body of this pull request: "before a family visit"\n {4}carries what the user said: "before my sister visits"/);
  const input = JSON.parse(fake.calls()[0]!.input);
  assert.deepEqual(input.user_turns, [TURN, "Hello."]);
  assert.deepEqual(input.post, texts);
  fake.mode("flagged");
  assert.match(judgeRefusal(texts, path, options)!, /found what the user said[^]*the model quoted none of it/);
  fake.mode("clean");
  assert.equal(judgeRefusal(texts, path, options), undefined);
});

test("a call with no transcript, or none the check can read, is refused and says how to turn the check off", () => {
  fake.mode("clean");
  for (const [transcriptPath, why] of [
    [undefined, /no transcript/],
    [join(scratch, "missing.jsonl"), /ENOENT/],
  ] as const) {
    const reason = judgeRefusal(texts, transcriptPath, options)!;
    assert.match(reason, why);
    assert.match(reason, /model_check option in \/config/);
  }
  const empty = join(scratch, "empty.jsonl");
  writeFileSync(empty, transcript([]));
  assert.match(judgeRefusal(texts, empty, options)!, /no user turn in the transcript/);
  assert.equal(fake.calls().length, 0);
});
