# second-read

_A privacy check on agent-written commits, issues, PRs and comments, for any coding agent._

Coding agents write a lot of prose on your behalf: commit messages, issue and PR bodies, review comments. Some of it
mentions things about you that you'd never post yourself, such as a path on your machine, the name of a private
project, or a detail about your accounts. Nobody can read every line an agent posts, and a rule in a prompt is
followed most of the time, not every time. Once a slip is posted, it's hard to take back: edit histories keep old
revisions, and a commit is public until the history is rewritten.

second-read reads what's about to go out and stops it when it finds something private. It doesn't rewrite your text.
It refuses, names what it found, and leaves the fix to you or your agent.

> **Status:** planned. Nothing here runs yet. [PLAN.md](./PLAN.md) is the design.

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

## License

[MIT](./LICENSE)
