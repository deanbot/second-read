import assert from "node:assert/strict";
import { test } from "node:test";
import { parseToml, TomlError } from "./toml.ts";

test("parses strings, booleans and arrays of strings with comments", () => {
  const source = [
    "# a comment",
    'name = "a \\"quoted\\" \\u00e9"  # trailing',
    "literal = 'C:\\path'",
    "on = true",
    "off = false",
    "terms = [",
    '  "one", # first',
    "",
    "  'two',",
    "]",
    "empty = []",
    '"quoted key" = "x"',
  ].join("\r\n");
  assert.deepEqual(
    { ...parseToml(source) },
    {
      name: 'a "quoted" é',
      literal: "C:\\path",
      on: true,
      off: false,
      terms: ["one", "two"],
      empty: [],
      "quoted key": "x",
    },
  );
});

test("an empty file is an empty table", () => {
  assert.deepEqual({ ...parseToml("\n# nothing\n") }, {});
});

test("rejects what it doesn't support, with the line", () => {
  const cases: [string, number, RegExp][] = [
    ["a = 1", 1, /expected a string/],
    ["\n[table]", 2, /tables aren't supported/],
    ['a = "x"\na = "y"', 2, /set more than once/],
    ['a = ["x", 1]', 1, /only strings/],
    ['a = "x', 1, /unterminated/],
    ['a = """x"""', 1, /multi-line/],
    ['a = "x" b', 1, /end of the line/],
    ['a = ["x" "y"]', 1, /expected "," or "\]"/],
    ['a = "\\q"', 1, /unknown escape/],
    ["= 'x'", 1, /expected a key/],
    ["a = truely", 1, /expected a string/],
  ];
  for (const [source, line, message] of cases) {
    assert.throws(
      () => parseToml(source),
      (e: unknown) => e instanceof TomlError && e.line === line && message.test(e.message),
      source,
    );
  }
});
