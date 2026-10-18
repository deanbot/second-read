import assert from "node:assert/strict";
import { test } from "node:test";
import { parseGh, postNames, postTexts } from "./gh.ts";

test("parseGh reads the title, body and body files of a posting command", () => {
  assert.deepEqual(parseGh(["issue", "create", "--title", "T", "-b", "B", "--body-file=notes.md"]), {
    kind: "issue",
    noun: "this issue",
    titleName: "title",
    bodyName: "body",
    fileName: "body",
    nameName: "name",
    title: ["T"],
    body: ["B"],
    bodyFiles: ["notes.md"],
    names: [],
  });
  assert.deepEqual(parseGh(["pr", "review", "5", "--approve", "-F", "-", "-bAlso", "-t=x"]), {
    kind: "review",
    noun: "this review",
    titleName: "title",
    bodyName: "body",
    fileName: "body",
    nameName: "name",
    title: ["x"],
    body: ["Also"],
    bodyFiles: ["-"],
    names: [],
  });
});

test("parseGh reads grouped short flags as gh does: switches, then one flag that takes the rest or the next", () => {
  // Regression: -dt read as -d with the value "t" let the title through unchecked.
  assert.deepEqual(parseGh(["pr", "create", "-dt", "Title"])?.title, ["Title"]);
  assert.deepEqual(parseGh(["pr", "create", "-dwtTitle", "-fb=Body"])?.title, ["Title"]);
  assert.deepEqual(parseGh(["pr", "create", "-fb=Body"])?.body, ["Body"]);
  assert.deepEqual(parseGh(["label", "create", "bug", "-fd", "desc"])?.body, ["desc"]);
  assert.deepEqual(parseGh(["pr", "review", "5", "-cb", "Review"])?.body, ["Review"]);
  // A flag that takes a value ends the group, whatever letters follow.
  assert.deepEqual(parseGh(["pr", "create", "-Bt", "-t", "Title"])?.title, ["Title"]);
  assert.deepEqual(parseGh(["pr", "close", "5", "-dc", "Closing"])?.body, ["Closing"]);
  // A switch given "=" takes the rest as its own value.
  assert.deepEqual(parseGh(["pr", "create", "-d=t", "-t", "Title"])?.title, ["Title"]);
  // The same letter is a switch in one command and takes a value in another.
  assert.deepEqual(parseGh(["release", "create", "v1", "-dt", "Title"])?.title, ["Title"]);
  assert.deepEqual(parseGh(["repo", "create", "-cd", "desc", "example/repo"])?.body, ["desc"]);
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
    nameName: "name",
    title: ["Subject"],
    body: ["Body"],
    bodyFiles: ["msg.md"],
    names: [],
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

const names = (args: string[]) => postNames(parseGh(args)!);

test("parseGh reads a release's title, notes and tag, but not its assets", () => {
  for (const command of ["create", "new", "edit"]) {
    assert.deepEqual(texts(["release", command, "v1", "dist.tgz", "--draft", "-t", "T", "--notes", "N", "-F", "notes.md"]), [
      ["the title of this release", "T"],
      ["the notes of this release", "N"],
      ["the notes of this release, from notes.md", "From notes.md"],
    ]);
  }
  assert.deepEqual(texts(["release", "create", "v1", "--notes-file", "-"], () => "On stdin"), [
    ["the notes of this release", "On stdin"],
  ]);
  assert.deepEqual(names(["release", "create", "--target", "main", "--latest", "v1", "dist.tgz"]), [
    ["the tag of this release", "v1"],
  ]);
  assert.deepEqual(names(["release", "new", "--notes-start-tag=v0", "-pd", "v1"]), [["the tag of this release", "v1"]]);
  assert.deepEqual(names(["release", "create"]), []);
  // The tag it's given now is checked, not the one it had, so a leaked tag can be renamed.
  assert.deepEqual(names(["release", "edit", "old", "--target", "main", "--tag", "v1"]), [
    ["the tag of this release", "v1"],
  ]);
  assert.deepEqual(names(["release", "edit", "old", "--draft"]), []);
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

test("parseGh reads the name each gist file is uploaded under, not its path", () => {
  // --filename names only stdin.
  assert.deepEqual(names(["gist", "create", "notes/a.md", "-f", "named.md", "-", "../b.md"]), [
    ["the file name of this gist", "a.md"],
    ["the file name of this gist", "named.md"],
    ["the file name of this gist", "b.md"],
  ]);
  assert.deepEqual(names(["gist", "create", "-pfnamed.md"]), [["the file name of this gist", "named.md"]]);
  assert.deepEqual(names(["gist", "create", "-"]), []);
  assert.deepEqual(names(["gist", "edit", "abc123", "--add", "notes/new.md"]), [["the file name of this gist", "new.md"]]);
  assert.deepEqual(names(["gist", "edit", "abc123", "-a", "new.md", "-"]), [["the file name of this gist", "new.md"]]);
  // A file it replaces keeps its name.
  assert.deepEqual(names(["gist", "edit", "abc123", "-f", "a.md", "notes/local.md"]), []);
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

test("parseGh reads the name a repository is created or renamed to, past the flags that take a value", () => {
  for (const command of ["create", "new"]) {
    assert.deepEqual(names(["repo", command, "-h", "https://example.com", "-p", "example/template", "example/repo"]), [
      ["the name of this repository", "example/repo"],
    ]);
  }
  assert.deepEqual(names(["repo", "create", "--source=.", "-r", "upstream", "--push", "-cl", "mit", "repo"]), [
    ["the name of this repository", "repo"],
  ]);
  assert.deepEqual(names(["repo", "create"]), []);
  // The repository it renames isn't checked, so a leaked name can be renamed away.
  assert.deepEqual(names(["repo", "rename", "-R", "example/old", "-y", "new"]), [["the name of this repository", "new"]]);
  assert.deepEqual(names(["repo", "rename", "-yR", "example/old", "new"]), [["the name of this repository", "new"]]);
  assert.deepEqual(names(["repo", "edit", "example/repo", "--default-branch", "main"]), []);
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
