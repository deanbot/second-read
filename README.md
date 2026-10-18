# second-read

_A privacy check on agent-written commits, issues, PRs and comments, for any coding agent._

Coding agents write a lot of prose on your behalf: commit messages, issue and PR bodies, review comments. Some of it
mentions things about you that you'd never post yourself, such as a path on your machine, the name of a private
project, or a detail about your accounts. Nobody can read every line an agent posts, and a rule in a prompt is
followed most of the time, not every time. Once a slip is posted, it's hard to take back: edit histories keep old
revisions, and a commit is public until the history is rewritten.

second-read reads what's about to go out and stops it when it finds something private. It doesn't rewrite your text.
It refuses, names what it found, and leaves the fix to you or your agent.

> **Status:** early. The check and the git and `gh` guards run; the agent adapters and sweep are planned.
> [PLAN.md](./PLAN.md) is the design.

## What it checks

- **Paths on your machine:** anything under your home folder, temporary and scratch folders.
- **Who you are on this machine:** your account name, your machine's name and email addresses, apart from the
  ones you allow (such as GitHub's `noreply` address).
- **Money and accounts:** plans, billing, payments, spending, usage limits, what you will or won't pay for, and
  credentials.
- **Your own list of private words:** project, folder, character or client names, in a file on your machine that is
  never checked in anywhere.
- **What you told the agent in private**, where an agent tool can run a model check. That means your reasons,
  feelings, frustrations and preferences, and your life outside the work, quoted or paraphrased. A post should say
  what changed, not why you personally decided it, unless that reason is about the work.
- **Other paraphrases**, by the same model check: "your disk is nearly full", a description of your accounts or
  your setup.

It isn't a secrets scanner. Tools like gitleaks find keys and tokens, and second-read is meant to run beside one.

## Where it runs

- **git hooks:** commit messages, and the lines a push adds.
- **A `gh` shim:** the title and body of `gh issue`, `gh pr` and comment commands, before the real `gh` sends them.
- **Agent adapters**, for posts that don't go through `git` or `gh`, such as a GitHub tool an agent calls directly.
  Claude Code comes first. Other agents follow, each written from its tool's own hook docs.
- **A sweep** of what's already posted to a repository, edit histories included.

The check runs on your machine, and the text it reads goes nowhere else.

## Using the check

```sh
second-read init                                  # writes your config file, with no terms in it
echo "$MESSAGE" | second-read check --kind commit
```

`check` exits `0` when the text is clean, `1` with findings and `2` when the check itself fails, so a guard can
refuse on anything but `0`. The report names each finding's category, line and text, and is printed only on your
machine.

Your config file is `~/.config/second-read/config.toml` (`$XDG_CONFIG_HOME`, or `%APPDATA%` on Windows):

```toml
terms = ["example-private-project"]       # never posted; see below
allowed_words = ["billing"]               # money words that are fine to post
allowed_emails = ["*@example.com"]
allowed_paths = ["~/.config/some-tool"]
```

A term matches in any case, with or without accents, in fullwidth forms, with invisible characters inside it, and
with its words joined by spaces, hyphens or nothing. It doesn't catch misspellings.

A repository can check in a `.second-read.toml` with the same `allowed_*` keys. It can't hold `terms`, and it's an
error if it names one of your private terms. Since anyone who can change the repository can change it, it also can't
switch a whole check off: `allowed_paths` can't take in all of `~` or a temp folder, and each `allowed_emails`
pattern needs a fixed domain (`*@example.com` or `*@*.example.com`, not `*@*` or `*@*.com`). Your own file can allow
anything.

## The guards

```sh
second-read hooks install    # in a repository: adds the commit-msg and pre-push hooks
second-read shim install     # writes a gh shim, and says which folder to put ahead of gh on PATH
```

- **`commit-msg`** checks the message git is about to commit.
- **`pre-push`** checks the message and the added lines of every commit the remote doesn't have yet, and the name each
  branch and tag gets on the remote, with the same checks as a message: a branch called `fix-billing-page` or
  `paid-plan` is refused for the money words unless the allowlist lets them through. An annotated tag's own name is checked too, since
  it goes with the tag whatever the remote calls it. Deleting a branch or tag is never refused, since that's how a
  leaked name is taken back. It also refuses a push that changes a `.second-read.toml`, and prints an id for each
  change: the new version's blob, or the commit that deletes the file. Once you've read the change, push again with
  `SECOND_READ_ALLOWLIST_REVIEWED="<id>"`. An id covers only that change, so a later one is refused again.
- **The `gh` shim** checks `--title`, `--body`, `--body-file` and a body read from stdin, for `gh issue` and
  `gh pr` `create`, `edit` and `comment`, and `gh pr review`. Then it runs the real `gh` with the same arguments and
  input. Every other command, `gh api` included, passes straight through.

Each guard refuses on a finding, and also when the check itself fails. A hook that was already in place is set aside
and still runs after the check; `second-read hooks uninstall` removes only second-read's hooks and puts it back. The
repository's `.second-read.toml` is read from the repository the hook runs in, or from the folder the shim runs in.

When `core.hooksPath` points at a checked-in folder, the hooks go into a folder inside `.git` instead, and this
clone's `core.hooksPath` points there. The repository's hooks still run, including ones added later: each hook
githooks(5) lists, except `push-to-checkout`. git runs `reference-transaction` and `post-index-change` very often, so
they run only if the repository had them when you installed; install again after adding one. `hooks uninstall` puts
`core.hooksPath` back. Running the repository's own setup step again, if it sets `core.hooksPath`, turns the guards
off until you install them again.

## License

[MIT](./LICENSE)
