import assert from "node:assert/strict";
import { test } from "node:test";
import { parseShell, UNKNOWN, UNKNOWN_END } from "./shell.ts";

const words = (source: string) => parseShell(source).map((c) => c.words);

test("parseShell splits words the way bash quotes them", () => {
  assert.deepEqual(words(`gh pr create --title 'It''s "done"' --body "a \\"b\\" \\$c" x\\ y $'l1\\nl2'`), [
    ["gh", "pr", "create", "--title", `Its "done"`, "--body", `a "b" $c`, "x y", "l1\nl2"],
  ]);
  assert.deepEqual(words(`echo "one \\\n two"`), [["echo", "one  two"]]);
});

test("parseShell splits lists, pipes and subshells into commands, in order", () => {
  assert.deepEqual(words(`cd sub && gh issue list; (git status) | cat || true & echo done # a comment`), [
    ["cd", "sub"],
    ["gh", "issue", "list"],
    ["git", "status"],
    ["cat"],
    ["true"],
    ["echo", "done"],
  ]);
  assert.deepEqual(words(`if true; then git commit -m x; fi\nfor f in a; do echo $f; done`).slice(0, 3), [
    ["true"],
    ["git", "commit", "-m", "x"],
    ["for", "f", "in", "a"],
  ]);
});

test("parseShell reads a heredoc in a command substitution, as agents write bodies", () => {
  const [command] = parseShell(`gh pr create --title T --body "$(cat <<'EOF'\nFirst line.\n\nSecond, $NOT_A_VAR.\nEOF\n)"`);
  assert.deepEqual(command?.words, ["gh", "pr", "create", "--title", "T", "--body", "First line.\n\nSecond, $NOT_A_VAR."]);
});

test("parseShell gives a command its heredoc, here-string, file or piped input", () => {
  const [heredoc] = parseShell(`gh issue comment 4 --body-file - <<-EOF\n\tHello\n\tEOF\n`);
  assert.deepEqual(heredoc?.stdin, { text: "Hello\n" });
  assert.deepEqual(parseShell(`gh pr review 5 -F - <<< "Looks good"`)[0]?.stdin, { text: "Looks good\n" });
  assert.deepEqual(parseShell(`gh pr comment 5 -F - < notes.md 2>&1`)[0]?.stdin, { file: "notes.md" });
  const piped = parseShell(`cat <<'EOF' | gh pr comment 5 -F -\nPiped body\nEOF`);
  assert.deepEqual(piped[1]?.stdin, { text: "Piped body\n" });
  assert.deepEqual(parseShell(`echo -n "short" | gh pr comment 5 -F -`)[1]?.stdin, { text: "short" });
  assert.deepEqual(parseShell(`printf '%s\\n' "line" | gh pr comment 5 -F -`)[1]?.stdin, { text: "line\n" });
});

test("parseShell marks what the shell fills in only when it runs", () => {
  const marked = (source: string) => UNKNOWN + source + UNKNOWN_END;
  assert.deepEqual(words(`gh pr create --body "Fix for $USER in \${HOME}" --title "$(date)" -t \`whoami\``), [
    ["gh", "pr", "create", "--body", `Fix for ${marked("$USER")} in ${marked("${HOME}")}`, "--title",
      marked("$(date)"), "-t", marked("`whoami`")],
  ]);
  const [heredoc] = parseShell(`gh issue comment 4 -F - <<EOF\nCost: $AMOUNT, not \\$5\nEOF`);
  assert.deepEqual(heredoc?.stdin, { text: `Cost: ${marked("$AMOUNT")}, not $5\n` });
  const [piped] = parseShell(`git log -1 | gh pr comment 5 -F -`).slice(1);
  assert.deepEqual(piped?.stdin, { text: marked("the output of git log -1") });
  assert.deepEqual(words(`echo $((1 + 2)) <(ls)`), [["echo", marked("$((1 + 2))"), marked("<(ls)")]]);
});

test("parseShell keeps going past text it can't finish, so nothing is skipped", () => {
  assert.deepEqual(words(`gh pr comment 5 --body "never closed`), [["gh", "pr", "comment", "5", "--body", "never closed"]]);
  assert.deepEqual(parseShell(`git commit -F - <<EOF\nno end`)[0]?.stdin, { text: "no end\n" });
});
