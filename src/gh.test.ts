import assert from "node:assert/strict";
import { test } from "node:test";
import { parseGh, postTexts } from "./gh.ts";

test("parseGh reads the title, body and body files of a posting command", () => {
  assert.deepEqual(parseGh(["issue", "create", "--title", "T", "-b", "B", "--body-file=notes.md"]), {
    kind: "issue",
    noun: "this issue",
    titleName: "title",
    title: ["T"],
    body: ["B"],
    bodyFiles: ["notes.md"],
  });
  assert.deepEqual(parseGh(["pr", "review", "5", "--approve", "-F", "-", "-bAlso", "-t=x"]), {
    kind: "review",
    noun: "this review",
    titleName: "title",
    title: ["x"],
    body: ["Also"],
    bodyFiles: ["-"],
  });
});

test("parseGh finds the command words around -R and its value", () => {
  assert.equal(parseGh(["issue", "-R", "example/repo", "comment", "4", "-b", "B"])?.kind, "comment");
  assert.equal(parseGh(["pr", "--repo=example/repo", "new", "-t", "T"])?.kind, "pr");
});

test("parseGh reads the comment a close or reopen leaves", () => {
  for (const command of [["issue", "close"], ["issue", "reopen"], ["pr", "close"], ["pr", "reopen"]]) {
    const post = parseGh([...command, "3", "-r", "not planned", "--comment", "Closing note", "-cAnother"]);
    assert.equal(post?.kind, "comment");
    assert.deepEqual(post?.body, ["Closing note", "Another"]);
  }
  assert.deepEqual(parseGh(["issue", "close", "3"])?.body, []);
});

test("parseGh reads a merge commit's subject and body", () => {
  const post = parseGh(["pr", "merge", "5", "--squash", "-t", "Subject", "--body", "Body", "-F", "msg.md"]);
  assert.deepEqual(post, {
    kind: "commit",
    noun: "this merge commit",
    titleName: "subject",
    title: ["Subject"],
    body: ["Body"],
    bodyFiles: ["msg.md"],
  });
  assert.deepEqual(
    postTexts(post!, () => "From the file"),
    [
      ["the subject of this merge commit", "Subject"],
      ["the body of this merge commit", "Body"],
      ["the body of this merge commit, from msg.md", "From the file"],
    ],
  );
});

test("parseGh stops at --, and leaves every other command alone", () => {
  assert.deepEqual(parseGh(["pr", "comment", "5", "--", "--body", "B"])?.body, []);
  assert.equal(parseGh(["api", "repos/example/repo/issues", "-f", "body=B"]), undefined);
  assert.equal(parseGh(["issue", "list", "--search", "B"]), undefined);
  assert.equal(parseGh(["release", "create", "v1", "--title", "T"]), undefined);
  assert.equal(parseGh([]), undefined);
});
