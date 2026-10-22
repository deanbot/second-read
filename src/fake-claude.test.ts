// A made-up `claude` for the model check's tests, so no test calls a model. It records each call in calls.jsonl and
// answers as its mode file says: a comma-separated list, one mode per call, the last repeating.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SCRIPT = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const calls = path.join(__dirname, "calls.jsonl");
const n = fs.existsSync(calls) ? fs.readFileSync(calls, "utf8").split("\\n").filter(Boolean).length : 0;
const input = fs.readFileSync(0, "utf8");
fs.appendFileSync(calls, JSON.stringify({ args: process.argv.slice(2), input, cwd: process.cwd(),
  judging: process.env.SECOND_READ_JUDGING }) + "\\n");
const modes = fs.readFileSync(path.join(__dirname, "mode"), "utf8").trim().split(",");
const mode = modes[Math.min(n, modes.length - 1)];
const verdict = (v) => console.log(JSON.stringify({ type: "result", is_error: false, structured_output: v }));
if (mode === "clean") verdict({ private: false, findings: [] });
else if (mode === "private") verdict({ private: true, findings: [{ where: "the body of this pull request",
  post: "before a family visit", user: "before my sister visits" }] });
else if (mode === "quotes-term") verdict({ private: true, findings: [{ where: "the body of this pull request",
  post: "before the launch", user: "before the example-private-project launch" }] });
else if (mode === "flagged") verdict({ private: true, findings: [] });
else if (mode === "unshaped") verdict({ private: "no" });
else if (mode === "malformed") console.log("not json");
else if (mode === "fail") { console.error("API Error: 529 overloaded"); process.exit(1); }
else if (mode === "hang") setTimeout(() => {}, 600000);
`;

export interface Fake {
  dir: string;
  mode: (modes: string) => void;
  calls: () => { args: string[]; input: string; cwd: string; judging?: string }[];
}

export function fakeClaude(dir: string): Fake {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "claude"), SCRIPT, { mode: 0o755 });
  writeFileSync(join(dir, "mode"), "clean");
  const log = join(dir, "calls.jsonl");
  return {
    dir,
    mode: (modes) => {
      writeFileSync(join(dir, "mode"), modes);
      writeFileSync(log, "");
    },
    calls: () => {
      let text = "";
      try {
        text = readFileSync(log, "utf8");
      } catch {}
      return text.split("\n").filter(Boolean).map((l) => JSON.parse(l));
    },
  };
}

// A transcript as Claude Code writes it, with one entry of each kind the check must skip.
export function transcript(turns: string[]): string {
  const entries: object[] = [{ type: "system", content: "started" }];
  for (const turn of turns) {
    entries.push({ type: "user", message: { role: "user", content: turn } });
    entries.push({ type: "user", isMeta: true, message: { role: "user", content: "Caveat: added by Claude Code" } });
    entries.push({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "On it." }] } });
    entries.push({
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "a tool's output" }] },
    });
  }
  return entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
}
