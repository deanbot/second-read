# second-read: plan

## 1. The problem

An agent working for one person posts far more prose than that person can read: every commit message, issue, PR
body and comment. The agent has also heard everything the person said while working, so a post can carry their
private conversation along with the work: a reason, a frustration, a decision about money. A rule in the agent's
instructions ("never post paths on my machine") holds most of the time. When it doesn't, the slip is public at
once, and it's hard to take back:

- an edited issue or comment keeps its old revisions, and each one has to be deleted by hand;
- a commit stays public until the history is rewritten and force-pushed.

So the check has to run **before** a post goes out, and it can't rely on the person reading every line.

## 2. Principles

- **Refuse, don't rewrite.** A post with a finding is stopped, with what was found and where. Nothing is silently
  changed, so what goes out is always what the author or agent wrote.
- **Private words stay private.** The list of private words lives on the user's machine, outside every repository.
  A repository may check in only an allowlist of words that are fine to post there.
- **Local only.** The check reads text on stdin and answers. It sends nothing anywhere. Only the sweep reads from
  GitHub, through the user's own `gh`.
- **Tool-neutral core, thin adapters.** One command does the checking. git, `gh` and each agent tool call it.
- **A safety net, not a boundary.** It catches slips by agents and people acting in good faith. It is not meant to
  stop someone set on getting text past it.

## 3. The core: `second-read check`

- Reads text on stdin. `--kind commit|issue|pr|comment|review` is recorded in the report, and lets a rule apply to one
  kind only.
- **Exit codes:** `0` clean, `1` findings, `2` the check itself failed. A guard treats `2` as a refusal, so a broken
  check never waves a post through.
- **The report** names each finding's category, the line, and the matched text. It is printed locally only.
- **Checks:**
  - paths under the home folder, written with the real account name or as `~/…` followed by something other than an
    allowed generic name;
  - temporary and scratch folders;
  - the account name, the machine name, and email addresses outside the allowlist;
  - money and accounts: words for plans, billing, payments, subscriptions, spending and usage limits, and amounts
    of money. These are the most likely to give false alarms in some repositories, so a repository's allowlist
    can switch off single words;
  - every term on the user's list, matched case-insensitively at word boundaries, after Unicode normalisation.
- **Configuration:**
  - the user's file in the platform's config folder (`~/.config/second-read/` where there is no other convention):
    private terms, allowed emails, allowed paths;
  - a repository's `.second-read.toml`: an allowlist only, never private terms. Anyone with write access can change
    it, so an entry that switches a whole check off is an error, and `pre-push` refuses a change to it until the
    new version's blob id, or the id of the commit that deletes it, is given;
  - `second-read init` writes the user's file with comments and no terms, and says how to add them.
- **Runtime:** TypeScript on Node 22, zero runtime dependencies, published as one npm package. It must start fast
  enough to run on every commit.

## 4. Guards anyone can use

- **git:** `commit-msg` checks the message. `pre-push` checks the messages and added lines of the commits being
  pushed, and the names the remote's branches and tags get; a deletion is never refused. `second-read hooks install`
  adds them to a repository, alongside any hooks already there.
- **`gh` shim:** a `gh` placed ahead of the real one on `PATH`. For `issue|pr create|edit|comment` and
  `pr review`, it checks `--title`, `--body`, `--body-file` and stdin bodies, then runs the real `gh` unchanged.
  Every other command passes straight through.

These catch every agent that posts through `git` and `gh`, and the user too.

## 5. Agent adapters

What the guards can't see: an agent that posts through its own GitHub tool, or text it shapes before calling `gh`.

- **Claude Code:** a plugin with a hook on tool calls. It runs the core on Bash commands that post, and on GitHub
  tool calls from MCP servers. It adds a model-judged check, using what Claude Code's hooks offer at the time it
  is built. The check's main target is **private dialog**: what the user told the agent in conversation,
  quoted or paraphrased. That covers their reasons, feelings, frustrations, preferences, money and life outside
  the work. A post says what changed, not why the user personally decided it, unless that reason is about the work.
  The check also looks for other paraphrased details: a description of the user's machine, home, accounts or
  private projects.
- **Others** (Gemini CLI, Codex, Kiro, …): one adapter each, written from that tool's current hook or extension docs
  when someone uses it. Where a tool has no hook, the git and `gh` guards still apply.

## 6. The sweep: `second-read sweep <owner/repo>`

- Reads a repository's issues, PRs, comments, reviews and commit messages through `gh`, and runs the core on each.
- **Edit histories too.** An edit's diff shows only what changed, so the sweep rebuilds each revision's full text
  before checking it. A detail that never changed is still inside every revision.
- Reports each finding with a link. For revisions, it says to delete every older revision, not just the ones that
  show the detail.
- Fixes nothing itself.

## 7. Milestones

- **M1 Core and guards:** `check`, the config files, `init`, the git hooks, the `gh` shim.
- **M2 Claude Code adapter:** the plugin, MCP GitHub tools, the paraphrase check.
- **M3 Sweep.**
- **Later:** an adapter for each other agent tool, when it's needed.

## 8. Out of scope

- Secrets and keys: use a secrets scanner beside it.
- Rewriting or redacting text.
- Checking code for private data. Added lines are checked for the same words and paths, but data files and fixtures
  are the repository's own business, allowed through `.second-read.toml`.
