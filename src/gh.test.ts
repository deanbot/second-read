import assert from "node:assert/strict";
import { test } from "node:test";
import { parseGh, postTexts } from "./gh.ts";

test("parseGh reads the title, body and body files of a posting command", () => {
  assert.deepEqual(parseGh(["issue", "create", "--title", "T", "-b", "B", "--body-file=notes.md"]), {
    kind: "issue",
    noun: "this issue",
    titleName: "title",
    bodyName: "body",
    fileName: "body",
    title: ["T"],
    body: ["B"],
    bodyFiles: ["notes.md"],
  });
  assert.deepEqual(parseGh(["pr", "review", "5", "--approve", "-F", "-", "-bAlso", "-t=x"]), {
    kind: "review",
    noun: "this review",
    titleName: "title",
    bodyName: "body",
    fileName: "body",
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
    bodyName: "body",
    fileName: "body",
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

const texts = (args: string[], read = (file: string) => `From ${file}`) => postTexts(parseGh(args)!, read);

test("parseGh reads a release's title and notes, but not its tag or assets", () => {
  for (const command of ["create", "new", "edit"]) {
    assert.deepEqual(texts(["release", command, "v1", "dist.tgz", "-d", "-t", "T", "--notes", "N", "-F", "notes.md"]), [
      ["the title of this release", "T"],
      ["the notes of this release", "N"],
      ["the notes of this release, from notes.md", "From notes.md"],
    ]);
  }
  assert.deepEqual(texts(["release", "create", "v1", "--notes-file", "-"], () => "On stdin"), [
    ["the notes of this release", "On stdin"],
  ]);
});

test("parseGh reads the files a gist uploads, its description, and stdin", () => {
  assert.deepEqual(texts(["gist", "create", "--public", "a.md", "-d", "D", "-f", "named.md", "b.md", "-"]), [
    ["the description of this gist", "D"],
    ["the contents of this gist, from a.md", "From a.md"],
    ["the contents of this gist, from b.md", "From b.md"],
    ["the contents of this gist", "From -"],
  ]);
  assert.deepEqual(texts(["gist", "new", "--", "-a.md"]), [["the contents of this gist, from -a.md", "From -a.md"]]);
  // With no files it uploads stdin, but only when stdin is piped in.
  const piped = parseGh(["gist", "create", "--filename", "named.md", "--desc=D"]);
  assert.deepEqual([piped?.bodyFiles, piped?.stdinIfPiped], [["-"], true]);
  assert.equal(parseGh(["gist", "create", "a.md"])?.stdinIfPiped, undefined);
});

test("parseGh reads the file a gist edit uploads, not the gist or the file it names", () => {
  assert.deepEqual(texts(["gist", "edit", "abc123", "--filename", "a.md", "local.md", "--desc", "D"]), [
    ["the description of this gist", "D"],
    ["the contents of this gist, from local.md", "From local.md"],
  ]);
  assert.deepEqual(texts(["gist", "edit", "abc123", "-a", "new.md", "-r", "old.md"]), [
    ["the contents of this gist, from new.md", "From new.md"],
  ]);
  // Given a file, --add only names it in the gist.
  assert.deepEqual(texts(["gist", "edit", "abc123", "--add", "new.md", "-"]), [
    ["the contents of this gist", "From -"],
  ]);
  assert.deepEqual(texts(["gist", "edit", "abc123", "--filename", "a.md"]), []);
});

test("parseGh reads a label's name and description, past its color and switches", () => {
  assert.deepEqual(texts(["label", "create", "-c", "ff0000", "-f", "bug", "--description", "D"]), [
    ["the name of this label", "bug"],
    ["the description of this label", "D"],
  ]);
  assert.deepEqual(texts(["label", "create", "--color=ff0000", "bug", "-dD"]), [
    ["the name of this label", "bug"],
    ["the description of this label", "D"],
  ]);
  // The name a label has now isn't checked, so a leaked one can be renamed.
  assert.deepEqual(texts(["label", "edit", "old", "--color", "00ff00", "-n", "new", "-d", "D"]), [
    ["the name of this label", "new"],
    ["the description of this label", "D"],
  ]);
  assert.deepEqual(texts(["label", "edit", "old", "--color", "00ff00"]), []);
});

test("parseGh reads a repository's description", () => {
  for (const command of ["create", "new", "edit"]) {
    assert.deepEqual(texts(["repo", command, "example/repo", "--public", "-d", "D", "-c"]), [
      ["the description of this repository", "D"],
    ]);
  }
  assert.deepEqual(texts(["repo", "edit", "--description=D", "--homepage", "https://example.com"]), [
    ["the description of this repository", "D"],
  ]);
});

test("parseGh stops at --, and leaves every other command alone", () => {
  assert.deepEqual(parseGh(["pr", "comment", "5", "--", "--body", "B"])?.body, []);
  assert.equal(parseGh(["api", "repos/example/repo/issues", "-f", "body=B"]), undefined);
  assert.equal(parseGh(["issue", "list", "--search", "B"]), undefined);
  assert.equal(parseGh(["release", "list", "--limit", "5"]), undefined);
  assert.equal(parseGh(["gist", "view", "abc123"]), undefined);
  assert.equal(parseGh(["label", "delete", "bug"]), undefined);
  assert.equal(parseGh(["repo", "view", "example/repo"]), undefined);
  assert.equal(parseGh([]), undefined);
});
