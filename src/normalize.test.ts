import assert from "node:assert/strict";
import { test } from "node:test";
import { fold, originalSpan, termPattern } from "./normalize.ts";

function matches(term: string, text: string): string[] {
  const folded = fold(text);
  return [...folded.text.matchAll(termPattern(term)!)].map((m) => {
    const [start, end] = originalSpan(folded, m.index, m.index + m[0].length);
    return text.slice(start, end);
  });
}

test("a term matches in any case and with any separator between its words", () => {
  const term = "example-private-project";
  for (const text of [
    "Example-Private-Project",
    "EXAMPLE PRIVATE PROJECT",
    "ExamplePrivateProject",
    "example_private_project",
    "example.private.project",
    "example\nprivate project",
  ]) {
    assert.deepEqual(matches(term, `see ${text} now`), [text], text);
  }
});

test("a term matches through accents, compatibility forms and invisible characters", () => {
  for (const text of ["éxample", "ｅｘａｍｐｌｅ", "exa​mple", "exa­mple", "éxample", "ℯxample"]) {
    assert.deepEqual(matches("example", `a ${text} b`), [text], JSON.stringify(text));
  }
});

test("a term matches only at word boundaries", () => {
  assert.deepEqual(matches("example", "counterexample examples example_ (example)"), ["example", "example"]);
});

test("a term written with accents matches the plain form", () => {
  assert.deepEqual(matches("Exämple", "an example"), ["example"]);
});

test("a term with no letters or digits matches nothing", () => {
  assert.equal(termPattern(" - "), null);
});

test("folding maps every character back to the original", () => {
  const text = "ﬁ ｘ é";
  const folded = fold(text);
  assert.equal(folded.text, "fi x e");
  assert.deepEqual(originalSpan(folded, 0, 2), [0, 1]);
  assert.deepEqual(originalSpan(folded, 3, 4), [2, 3]);
});
