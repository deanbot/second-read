import assert from "node:assert/strict";
import { test } from "node:test";
import { check, checkTerms, type Identity, type Rules } from "./checks.ts";

const identity: Identity = {
  user: "example",
  home: "/Users/example",
  host: "example-laptop.local",
  tempDirs: ["/var/folders/zz/example0000/T/"],
};

const noRules: Rules = { terms: [], allowedWords: [], allowedEmails: [], allowedPaths: [], allowedNames: [] };

function found(text: string, rules: Partial<Rules> = {}, who: Identity = identity): [string, string][] {
  return check(text, { identity: who, rules: { ...noRules, ...rules } }).map((f) => [
    f.word ? `${f.category} (${f.word})` : f.category,
    f.text,
  ]);
}

test("clean text has no findings", () => {
  assert.deepEqual(found("Add the commit-msg hook (#2)\n\nIt runs the check on every message."), []);
});

test("paths under the home folder", () => {
  assert.deepEqual(found("See /Users/example/notes/plan.md."), [["home path", "/Users/example/notes/plan.md"]]);
  assert.deepEqual(found("in /home/example/src"), [["home path", "/home/example/src"]]);
  assert.deepEqual(found("in C:\\Users\\example\\src"), [["home path", "C:\\Users\\example\\src"]]);
  assert.deepEqual(found("`/users/EXAMPLE/x`"), [["home path", "/users/EXAMPLE/x"]]);
  const elsewhere = { ...identity, home: "/srv/people/example" };
  assert.deepEqual(found("at /srv/people/example/a", {}, elsewhere), [["home path", "/srv/people/example/a"]]);
});

test("another account's home folder is not this account's", () => {
  assert.deepEqual(found("/Users/someone-else/x and /Users/examples/x"), []);
});

test("~ paths outside the allowed ones", () => {
  assert.deepEqual(found("Saved in ~/notes/today.md"), [["home path", "~/notes/today.md"]]);
  assert.deepEqual(found("Saved in $HOME/notes and ${HOME}/notes"), [
    ["home path", "$HOME/notes"],
    ["home path", "${HOME}/notes"],
  ]);
  assert.deepEqual(found("Writes ~/.config/second-read/config.toml and reads ~/.ssh/config, ~/ and ~"), []);
  assert.deepEqual(found("~/.configs/x"), [["home path", "~/.configs/x"]]);
  assert.deepEqual(found("~/src/tools/a and ~/src/other", { allowedPaths: ["~/src/tools/"] }), [
    ["home path", "~/src/other"],
  ]);
});

test("temporary and scratch folders", () => {
  assert.deepEqual(found("wrote /tmp/out.log and /private/var/folders/ab/T/x"), [
    ["temp folder", "/tmp/out.log"],
    ["temp folder", "/private/var/folders/ab/T/x"],
  ]);
  assert.deepEqual(found("in /var/folders/zz/example0000/T/run-1"), [
    ["temp folder", "/var/folders/zz/example0000/T/run-1"],
  ]);
  const scratch = { ...identity, tempDirs: ["/scratch/run-7"] };
  assert.deepEqual(found("at /scratch/run-7/a", {}, scratch), [["temp folder", "/scratch/run-7/a"]]);
  assert.deepEqual(found("build/tmp/x and src/tmp"), []);
  assert.deepEqual(found("/tmp/fixtures/a", { allowedPaths: ["/tmp/fixtures"] }), []);
});

test("the account name and the machine name", () => {
  assert.deepEqual(found("Thanks, Example!"), [["account name", "Example"]]);
  assert.deepEqual(found("Built on Example Laptop overnight"), [["machine name", "Example Laptop"]]);
  assert.deepEqual(found("Built on example-laptop.local"), [["machine name", "example-laptop"]]);
});

test("generic and very short account names are not flagged", () => {
  for (const user of ["runner", "root", "ab"]) {
    const who = { ...identity, user, home: `/home/${user}`, host: "ci" };
    assert.deepEqual(found(`the ${user} step`, {}, who), [], user);
  }
});

test("a common default machine name is not flagged, even numbered, but one with the owner's name in it is", () => {
  for (const host of ["MacBook-Pro.local", "macbookpro", "MacBook-Pro-2.local", "Mac-mini", "raspberrypi", "penguin"]) {
    const who = { ...identity, host };
    assert.deepEqual(found("Tested on a MacBook Pro, a Mac mini, a Raspberry Pi and a penguin", {}, who), [], host);
  }
  const owned = { ...identity, host: "Sam-MacBook-Pro.local" };
  assert.deepEqual(found("Tested on a MacBook Pro and on sam-macbook-pro", {}, owned), [
    ["machine name", "sam-macbook-pro"],
  ]);
  // A chosen name that's also a word is still flagged.
  const chosen = { ...identity, host: "maple.local" };
  assert.deepEqual(found("maple syrup", {}, chosen), [["machine name", "maple"]]);
});

test("a default machine name is still flagged as an account name, which is often the person's own", () => {
  for (const user of ["kali", "mac", "penguin"]) {
    const who = { ...identity, user, home: `/home/${user}`, host: "MacBook-Pro.local" };
    assert.deepEqual(found(`Thanks, ${user}!`, {}, who), [["account name", user]], user);
  }
});

test("allowed names switch off an account or machine name that's an ordinary word, and allowed words don't", () => {
  const who = { ...identity, user: "maple", home: "/Users/maple", host: "juniper.local" };
  assert.deepEqual(found("maple syrup and juniper", {}, who), [
    ["account name", "maple"],
    ["machine name", "juniper"],
  ]);
  assert.deepEqual(found("maple syrup and juniper", { allowedWords: ["maple", "juniper"] }, who), [
    ["account name", "maple"],
    ["machine name", "juniper"],
  ]);
  assert.deepEqual(found("maple syrup and juniper", { allowedNames: ["Maple", "juniper"] }, who), []);
  assert.deepEqual(found("in /Users/maple/x", { allowedNames: ["maple"] }, who), [["home path", "/Users/maple/x"]]);
});

test("email addresses outside the allowlist", () => {
  assert.deepEqual(found("Mail someone@corp.co about it"), [["email", "someone@corp.co"]]);
  assert.deepEqual(
    found("1234+example@users.noreply.github.com, git@github.com:owner/repo, a@example.com, b@host.test"),
    [],
  );
  assert.deepEqual(found("Someone@Corp.co", { allowedEmails: ["*@corp.co"] }), []);
  assert.deepEqual(found("typescript@7.0.2 and @types/node@22 and node@v22"), []);
});

test("noreply addresses in commit trailers are allowed", () => {
  assert.deepEqual(
    found(
      "Co-Authored-By: Some Agent <noreply@example-ai.co>\nCo-Authored-By: Bot <no-reply@example-ci.co>\n" +
        "Signed-off-by: A <123-example@users.noreply.gitlab.com>",
    ),
    [],
  );
  assert.deepEqual(found("noreply.desk@corp.co"), [["email", "noreply.desk@corp.co"]]);
});

test("a name or word inside an allowed email or path isn't a finding, but a private term is", () => {
  assert.deepEqual(found("Example <1234+example@users.noreply.github.com>"), [["account name", "Example"]]);
  assert.deepEqual(found("billing@example.com and ~/.config/example-app"), []);
  assert.deepEqual(found("~/.config/example-private-project", { terms: ["example-private-project"] }), [
    ["private term", "example-private-project"],
  ]);
});

test("money and account words", () => {
  assert.deepEqual(found("The billing page"), [["money (billing)", "billing"]]);
  assert.deepEqual(found("I'm on the Max plan"), [["money (plan)", "Max plan"]]);
  assert.deepEqual(found("we upgraded our plan"), [["money (plan)", "upgraded our plan"]]);
  assert.deepEqual(found("hit the usage limits again"), [["money (usage limit)", "usage limits"]]);
  assert.deepEqual(found("cancel the subscription"), [["money (subscription)", "cancel the subscription"]]);
  assert.deepEqual(found("my monthly subscription"), [["money (subscription)", "monthly subscription"]]);
  assert.deepEqual(found("on a free subscription"), [["money (subscription)", "free subscription"]]);
  assert.deepEqual(found("check my subscription"), [["money (subscription)", "my subscription"]]);
  assert.deepEqual(found("two paid subscriptions"), [["money (subscription)", "paid subscriptions"]]);
  assert.deepEqual(found("the subscription fee went up"), [["money (subscription)", "subscription fee"]]);
  assert.deepEqual(found("its subscription renewal"), [["money (subscription)", "subscription renewal"]]);
  assert.deepEqual(found("upgrading our subscription"), [["money (subscription)", "upgrading our subscription"]]);
  assert.deepEqual(found("we cancelled the subscription"), [["money (subscription)", "cancelled the subscription"]]);
  assert.deepEqual(found("upgrading my plan"), [["money (plan)", "upgrading my plan"]]);
  assert.deepEqual(found("changing the plan"), [["money (plan)", "changing the plan"]]);
  assert.deepEqual(found("not paying for that"), [["money (payment)", "paying for"]]);
  assert.deepEqual(found("my credit card"), [["money (card)", "credit card"]]);
  assert.deepEqual(found("over our monthly budget"), [["money (budget)", "monthly budget"]]);
  assert.deepEqual(found("set a spend limit"), [["money (spending)", "spend limit"]]);
  assert.deepEqual(found("cut my spending"), [["money (spending)", "my spending"]]);
  assert.deepEqual(found("the overage charges"), [["money (usage limit)", "overage charges"]]);
  assert.deepEqual(found("out of plan quota"), [["money (usage limit)", "plan quota"]]);
});

test("amounts of money", () => {
  for (const amount of ["$20", "$1.50", "$1,200", "$ 40", "€5", "£12.99", "¥300", "15 USD", "30 dollars", "$2k"]) {
    assert.deepEqual(found(`it costs ${amount} now`), [["money (amounts)", amount]], amount);
  }
  assert.deepEqual(found("$5/month or $5 a month"), [
    ["money (amounts)", "$5"],
    ["money (amounts)", "$5"],
  ]);
});

test("dev words near money words are not money", () => {
  assert.deepEqual(
    found("Read PLAN.md and the test plan. Plan the release; run it with $1 or $2. Rate limits, 5 ms, v1.2.3."),
    [],
  );
  assert.deepEqual(
    found(
      "Keep the size budget and the error budget. Raise the disk quota and the API quota. " +
        "Spending more time on tests. Overages in the token counter. Budgets for latency.",
    ),
    [],
  );
  assert.deepEqual(
    found(
      "The subscription closes when the stream ends. Log the subscription id. Subscriptions for each topic. " +
        "A GraphQL subscription, then unsubscribe. Subscribe to the paid event.",
    ),
    [],
  );
});

test("an allowed word switches off one money word only", () => {
  const text = "billing and payments for $20";
  assert.deepEqual(found(text, { allowedWords: ["billing"] }), [
    ["money (payment)", "payments"],
    ["money (amounts)", "$20"],
  ]);
  assert.deepEqual(found(text, { allowedWords: ["payments", "amounts", "Billing"] }), []);
});

test("private terms, matched however they're written", () => {
  const rules = { terms: ["example-private-project", "Mx Example"] };
  assert.deepEqual(found("Port it from ExamplePrivateProject, as mx  example asked.", rules), [
    ["private term", "ExamplePrivateProject"],
    ["private term", "mx  example"],
  ]);
  assert.deepEqual(found("ｅｘａｍｐｌｅ-ｐｒｉｖａｔｅ-ｐｒｏｊｅｃｔ", rules), [
    ["private term", "ｅｘａｍｐｌｅ-ｐｒｉｖａｔｅ-ｐｒｏｊｅｃｔ"],
  ]);
});

test("checkTerms finds only private terms, even inside a path or an email", () => {
  const text =
    "Paid plan, ~/notes, /tmp/x and someone@corp.co\nin /Users/example/ExamplePrivateProject/x\n" +
    "and example-private-project@corp.co\n";
  assert.deepEqual(
    checkTerms(text, ["example-private-project"]).map((f) => [f.category, f.line, f.column, f.text]),
    [
      ["private term", 2, 19, "ExamplePrivateProject"],
      ["private term", 3, 5, "example-private-project"],
    ],
  );
  assert.deepEqual(checkTerms(text, []), []);
});

test("findings report line, column and text from the original input", () => {
  const text = "first line\n  ｅｘａ\u200Bｍｐｌｅ-private-project and ~/notes\n";
  const findings = check(text, { identity, rules: { ...noRules, terms: ["example-private-project"] } });
  assert.deepEqual(
    findings.map((f) => [f.category, f.line, f.column, f.text]),
    [
      ["private term", 2, 3, "ｅｘａ\u200Bｍｐｌｅ-private-project"],
      ["home path", 2, 32, "~/notes"],
    ],
  );
  assert.equal(text.slice(findings[0]!.start, findings[0]!.end), findings[0]!.text);
});

test("columns count characters, not UTF-16 units", () => {
  const [finding] = check("😀😀 /tmp/x", { identity, rules: noRules });
  assert.equal(finding?.column, 4);
});

test("a finding inside another is reported once, as the outer one", () => {
  assert.deepEqual(found("/Users/example/example-private-project/x", { terms: ["example-private-project"] }), [
    ["home path", "/Users/example/example-private-project/x"],
  ]);
});

test("the text itself is never changed", () => {
  const text = "billing ~/notes";
  const before = text.slice();
  check(text, { identity, rules: noRules });
  assert.equal(text, before);
});

test("the check is fast enough for every commit", () => {
  const rules = { ...noRules, terms: Array.from({ length: 200 }, (_, i) => `example-term-${i}`) };
  const text = "Add the hook and its tests (#2). See ~/.config and the test plan.\n".repeat(2000);
  const started = performance.now();
  check(text, { identity, rules });
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 1000, `${text.length} characters and 200 terms took ${elapsed.toFixed(0)} ms`);
});

test("the check stays fast when every line has findings", () => {
  const text = "The billing page moved to ~/notes/a, says 1+example@users.noreply.github.com.\n".repeat(2000);
  const started = performance.now();
  const findings = check(text, { identity, rules: noRules });
  const elapsed = performance.now() - started;
  assert.equal(findings.length, 4000);
  assert.deepEqual([findings[3999]!.line, findings[3999]!.column], [2000, 27]);
  assert.ok(elapsed < 1000, `${findings.length} findings took ${elapsed.toFixed(0)} ms`);
});
