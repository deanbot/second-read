import assert from "node:assert/strict";
import { test } from "node:test";
import { parseGh } from "./gh.ts";

test("parseGh reads the title, body and body files of a posting command", () => {
  assert.deepEqual(parseGh(["issue", "create", "--title", "T", "-b", "B", "--body-file=notes.md"]), {
    kind: "issue",
    title: ["T"],
    body: ["B"],
    bodyFiles: ["notes.md"],
  });
  assert.deepEqual(parseGh(["pr", "review", "5", "--approve", "-F", "-", "-bAlso", "-t=x"]), {
    kind: "review",
    title: ["x"],
    body: ["Also"],
    bodyFiles: ["-"],
  });
});

test("parseGh finds the command words around -R and its value", () => {
  assert.equal(parseGh(["issue", "-R", "example/repo", "comment", "4", "-b", "B"])?.kind, "comment");
  assert.equal(parseGh(["pr", "--repo=example/repo", "new", "-t", "T"])?.kind, "pr");
});

test("parseGh stops at --, and leaves every other command alone", () => {
  assert.deepEqual(parseGh(["pr", "comment", "5", "--", "--body", "B"])?.body, []);
  assert.equal(parseGh(["api", "repos/example/repo/issues", "-f", "body=B"]), undefined);
  assert.equal(parseGh(["issue", "list", "--search", "B"]), undefined);
  assert.equal(parseGh(["release", "create", "v1", "--title", "T"]), undefined);
  assert.equal(parseGh([]), undefined);
});
