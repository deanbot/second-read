import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { bashPosts, isGithubTool, mcpPosts } from "./claude.ts";
import { UNKNOWN } from "./shell.ts";

const scratch = mkdtempSync(join(tmpdir(), "second-read-claude-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
const home = join(scratch, "home");
const repo = join(scratch, "repo");
mkdirSync(join(repo, "sub"), { recursive: true });
writeFileSync(join(repo, "sub", "body.md"), "From a file.\n");

const texts = (command: string) => bashPosts(command, repo, home).map((p) => [p.where, p.text]);

test("bashPosts reads gh issue and pr posts as the shim does", () => {
  assert.deepEqual(texts(`gh pr create --title "Add a flag" --body "$(cat <<'EOF'\nBody text.\nEOF\n)"`), [
    ["the title of this pull request", "Add a flag"],
    ["the body of this pull request", "Body text."],
  ]);
  assert.deepEqual(texts(`gh issue comment 4 --body-file - <<'EOF'\nOn stdin.\nEOF`), [
    ["the body of this comment", "On stdin.\n"],
  ]);
  assert.deepEqual(texts(`gh pr review 5 --approve`), []);
  assert.deepEqual(texts(`gh issue list --search "anything"`), []);
});

test("bashPosts reads gh release, gist, label and repo posts as the shim does", () => {
  assert.deepEqual(texts(`gh release create v1 -t "Version 1" --notes-file - <<'EOF'\nNotes.\nEOF`), [
    ["the tag of this release", "v1"],
    ["the title of this release", "Version 1"],
    ["the notes of this release", "Notes.\n"],
  ]);
  assert.deepEqual(texts(`gh gist create sub/body.md --desc "A gist"`), [
    ["the file name of this gist", "body.md"],
    ["the description of this gist", "A gist"],
    ["the contents of this gist, from sub/body.md", "From a file.\n"],
  ]);
  assert.deepEqual(texts(`echo "Piped." | gh gist create`), [["the contents of this gist", "Piped.\n"]]);
  assert.deepEqual(texts(`gh gist create`), [["the contents of this gist", ""]]);
  assert.ok(texts(`cat notes.md | gh gist create`)[0]?.[1]?.includes(UNKNOWN));
  assert.deepEqual(texts(`gh gist edit abc123 -f body.md sub/body.md`), [
    ["the contents of this gist, from sub/body.md", "From a file.\n"],
  ]);
  assert.deepEqual(texts(`gh label create bug --color ff0000 -d "Something's broken"`), [
    ["the name of this label", "bug"],
    ["the description of this label", "Something's broken"],
  ]);
  assert.deepEqual(texts(`gh repo edit --description "A tool"`), [["the description of this repository", "A tool"]]);
});

test("bashPosts reads the names a gh post gives, marked to be checked as names", () => {
  const names = (command: string) =>
    bashPosts(command, repo, home).map((p) => [p.where, p.text, p.name ?? false]);
  assert.deepEqual(names(`gh repo create -d "A tool" example/repo`), [
    ["the name of this repository", "example/repo", true],
    ["the description of this repository", "A tool", false],
  ]);
  assert.deepEqual(names(`gh release create v1 -dt "Version 1"`), [
    ["the tag of this release", "v1", true],
    ["the title of this release", "Version 1", false],
  ]);
  assert.deepEqual(names(`gh gist create sub/body.md`), [
    ["the file name of this gist", "body.md", true],
    ["the contents of this gist, from sub/body.md", "From a file.\n", false],
  ]);
  // A "#" inside a word starts a label, not a comment.
  assert.deepEqual(names(`gh release upload v1 dist/app.tgz#App dist/notes.txt 'dist/a.zip#For Linux'`), [
    ["the file name of an asset of this release", "app.tgz", true],
    ["the file name of an asset of this release", "notes.txt", true],
    ["the file name of an asset of this release", "a.zip", true],
    ["the label of an asset of this release", "App", false],
    ["the label of an asset of this release", "For Linux", false],
  ]);
});

test("bashPosts reads a merge commit's author email", () => {
  assert.deepEqual(texts(`gh pr merge 5 --squash -A someone@example.com`), [
    ["the author email of this merge commit", "someone@example.com"],
  ]);
  assert.deepEqual(texts(`gh pr merge 5 -sA someone@example.com --subject "Subject"`), [
    ["the subject of this merge commit", "Subject"],
    ["the author email of this merge commit", "someone@example.com"],
  ]);
});

test("bashPosts marks an asset gh or the shell expands as a glob, and one the shell fills in, as unknown", () => {
  for (const command of [
    `gh release create v1 dist/*.tgz`,
    `gh release upload v1 'dist/*.tgz'`,
    `gh release upload v1 "$DIR"/app.tgz`,
    `gh release upload v1 "dist/app.tgz#$LABEL"`,
    `gh release upload v1 $(ls dist/x)`,
  ]) {
    const [asset] = texts(command).filter(([where]) => where?.includes("asset"));
    assert.ok(asset?.[1]?.includes(UNKNOWN), command);
  }
  // gh never expands a labeled asset.
  assert.deepEqual(texts(`gh release upload v1 'dist/*.tgz#All of them'`), [
    ["the file name of an asset of this release", "*.tgz"],
    ["the label of an asset of this release", "All of them"],
  ]);
});

test("bashPosts reads a body file from the folder the command runs in", () => {
  const [post] = bashPosts(`cd sub && gh pr comment 5 -F body.md`, repo, home);
  assert.equal(post?.text, "From a file.\n");
  assert.equal(post?.cwd, join(repo, "sub"));
  assert.equal(bashPosts(`git -C sub commit -F body.md`, repo, home)[0]?.text, "From a file.\n");
  assert.throws(() => bashPosts(`gh pr comment 5 -F missing.md`, repo, home), /ENOENT/);
});

test("bashPosts reads gh api fields and bodies that post, and leaves reads alone", () => {
  assert.deepEqual(texts(`gh api repos/example/repo/pulls/7/comments -X POST -f body="Inline reply" -F in_reply_to=12`), [
    ["the body field of gh api repos/example/repo/pulls/7/comments", "Inline reply"],
    ["the in_reply_to field of gh api repos/example/repo/pulls/7/comments", "12"],
  ]);
  assert.equal(bashPosts(`gh api repos/{owner}/{repo}/issues/3/comments -f body=x`, repo, home)[0]?.kind, "comment");
  assert.deepEqual(texts(`gh api repos/example/repo/issues -F title=T -F body=@sub/body.md -f owner=example`), [
    ["the title field of gh api repos/example/repo/issues", "T"],
    ["the body field of gh api repos/example/repo/issues", "From a file.\n"],
  ]);
  assert.deepEqual(texts(`gh api repos/example/repo/issues/3/comments --input - <<'EOF'\n{"body": "JSON body", "n": [1, "two"]}\nEOF`), [
    ["body in the body of gh api repos/example/repo/issues/3/comments", "JSON body"],
    ["n[1] in the body of gh api repos/example/repo/issues/3/comments", "two"],
  ]);
  assert.deepEqual(texts(`gh api repos/example/repo/pulls/7/comments`), []);
  // Grouped short flags: -i is a switch, and the flag after it takes the rest or the next argument.
  assert.deepEqual(texts(`gh api repos/example/repo/issues -if body="Grouped"`), [
    ["the body field of gh api repos/example/repo/issues", "Grouped"],
  ]);
  assert.deepEqual(texts(`gh api repos/example/repo/issues -ifbody="Joined" -iX GET`), []);
  assert.deepEqual(texts(`gh api repos/example/repo/issues -iq .body`), []);
  assert.deepEqual(texts(`gh api search/issues -X GET -f q="anything"`), []);
  assert.deepEqual(texts(`gh api graphql -f query='query { viewer { login } }'`), []);
  assert.equal(texts(`gh api graphql -f query='mutation { addComment(input: {body: "x"}) { clientMutationId } }'`).length, 1);
});

test("bashPosts reads git commit and tag messages", () => {
  assert.deepEqual(texts(`git commit -am "Subject" -m "Body paragraph." --trailer "Refs: #3"`), [
    ["this commit message", "Subject\n\nBody paragraph."],
    ["a trailer of this commit message", "Refs: #3"],
  ]);
  assert.deepEqual(texts(`git -c core.editor=true commit --message="Joined"`), [["this commit message", "Joined"]]);
  assert.deepEqual(texts(`git commit -S -m "Signed"`), [["this commit message", "Signed"]]);
  assert.deepEqual(texts(`git tag -a v1 -m "Release notes"`), [["this tag message", "Release notes"]]);
  assert.deepEqual(texts(`git commit --amend --no-edit && git push origin HEAD`), []);
});

test("bashPosts finds posts behind wrappers, assignments and sh -c", () => {
  assert.equal(texts(`GH_PAGER= env -u X command gh pr comment 1 -b "Wrapped"`)[0]?.[1], "Wrapped");
  assert.equal(texts(`bash -c 'gh pr comment 1 -b "Inner"'`)[0]?.[1], "Inner");
  assert.equal(texts(`/opt/example/bin/gh pr comment 1 -b "By path"`)[0]?.[1], "By path");
  assert.equal(texts(`sudo gh pr comment 1 -b "Sudo"`)[0]?.[1], "Sudo");
  assert.equal(texts(`sudo -E -u someone -- env X=1 gh pr comment 1 -b "Past options"`)[0]?.[1], "Past options");
});

test("bashPosts reads text xargs adds as text the shell fills in", () => {
  assert.ok(texts(`xargs gh pr comment 5 --body < body.md`)[0]?.[1]?.includes(UNKNOWN));
  assert.ok(texts(`echo note | xargs -I{} gh pr comment 5 --body "Note: {}"`)[0]?.[1]?.includes(UNKNOWN));
  assert.deepEqual(texts(`echo 5 | xargs -n 1 gh pr comment --body "Known text"`), [
    ["the body of this comment", "Known text"],
  ]);
  assert.deepEqual(texts(`gh pr list -q '.[].number' | xargs -n1 gh pr view`), []);
});

test("bashPosts reads the comments close and reopen leave, and a merge commit's message", () => {
  assert.deepEqual(texts(`gh issue close 3 --comment "Done" && gh pr merge 5 --squash -t "Subject" -b "Body"`), [
    ["the body of this comment", "Done"],
    ["the subject of this merge commit", "Subject"],
    ["the body of this merge commit", "Body"],
  ]);
});

test("bashPosts reads the posts inside command substitutions", () => {
  assert.deepEqual(texts(`PR_URL=$(gh pr create -t T -b "Captured") && echo "$PR_URL"`), [
    ["the title of this pull request", "T"],
    ["the body of this pull request", "Captured"],
  ]);
  assert.deepEqual(texts("echo `git commit -m 'In backticks'`"), [["this commit message", "In backticks"]]);
});

test("bashPosts reads a file the command writes before it posts, not what's on disk", () => {
  writeFileSync(join(repo, "stale.md"), "An older text.\n");
  assert.deepEqual(texts(`cat > stale.md <<'EOF'\nThe new text.\nEOF\ngh pr comment 5 --body-file stale.md`), [
    ["the body of this comment, from stale.md", "The new text.\n"],
  ]);
  assert.deepEqual(texts(`echo "Not yet on disk" > new.md && git commit -F new.md`), [
    ["this commit message, from new.md", "Not yet on disk\n"],
  ]);
  assert.deepEqual(texts(`printf '%s' "Teed" | tee out.json > /dev/null; gh api repos/example/repo/issues --input out.json`), [
    ["the body of gh api repos/example/repo/issues, from out.json", "Teed"],
  ]);
  assert.ok(texts(`./generate > stale.md && gh pr comment 5 -F stale.md`)[0]?.[1]?.includes(UNKNOWN));
  assert.ok(texts(`echo more >> stale.md && gh pr comment 5 -F stale.md`)[0]?.[1]?.includes(UNKNOWN));
});

test("bashPosts marks text and files the shell fills in", () => {
  assert.ok(texts(`gh pr comment 1 --body "$BODY"`)[0]?.[1]?.includes(UNKNOWN));
  assert.ok(texts(`gh pr comment 1 --body-file "$FILE"`)[0]?.[1]?.includes(UNKNOWN));
  assert.ok(texts(`git log -1 | gh pr comment 1 -F -`)[0]?.[1]?.includes(UNKNOWN));
});

test("isGithubTool takes in GitHub tools from any server name", () => {
  assert.ok(isGithubTool("mcp__github__create_issue"));
  assert.ok(isGithubTool("mcp__plugin_example_GitHub__add_issue_comment"));
  assert.ok(!isGithubTool("mcp__memory__create_entities"));
  assert.ok(!isGithubTool("Bash"));
});

test("mcpPosts reads every string a GitHub tool sends, but for where it goes", () => {
  const posts = mcpPosts(
    "mcp__github__create_pull_request",
    { owner: "example", repo: "repo", title: "T", body: "B", head: "topic", draft: false },
    repo,
  );
  assert.deepEqual(
    posts.map((p) => [p.where, p.text, p.kind]),
    [
      ["title of create_pull_request", "T", "pr"],
      ["body of create_pull_request", "B", "pr"],
      ["head of create_pull_request", "topic", "pr"],
    ],
  );
  assert.deepEqual(mcpPosts("mcp__github__get_issue", { owner: "o", repo: "r", issue_number: 1 }, repo), []);
  assert.deepEqual(mcpPosts("mcp__github__issue_read", { method: "get" }, repo), []);
  assert.deepEqual(mcpPosts("mcp__github__search_code", { query: "anything" }, repo), []);
});

test("mcpPosts reads a file's contents as the lines it adds, under its path", () => {
  const posts = mcpPosts(
    "mcp__github__push_files",
    { owner: "o", repo: "r", branch: "main", message: "Add", files: [{ path: "src/a.test.ts", content: "x\n" }] },
    repo,
  );
  assert.deepEqual(
    posts.map((p) => [p.where, p.text, p.file]),
    [
      ["branch of push_files", "main", undefined],
      ["message of push_files", "Add", undefined],
      ["src/a.test.ts, as push_files writes it", "x\n", "src/a.test.ts"],
      ["files[0].path of push_files", "src/a.test.ts", undefined],
    ],
  );
});
