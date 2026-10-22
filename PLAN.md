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
- **Local only.** The check reads text on stdin and answers. The check, the git hooks and the `gh` shim send
  nothing anywhere. Only the sweep reads from GitHub, through the user's own `gh`. Only the Claude Code adapter's model
  check sends text: the post and the user's turns, to the model provider the session already uses. The user can
  turn it off.
- **Tool-neutral core, thin adapters.** One command does the checking. git, `gh` and each agent tool call it.
- **A safety net, not a boundary.** It catches slips by agents and people acting in good faith. It is not meant to
  stop someone set on getting text past it.

## 3. The core: `second-read check`

- Reads text on stdin. `--kind commit|issue|pr|comment|review` is recorded in the report, and lets a rule apply to one
  kind only.
- **Exit codes:** `0` clean, `1` findings, `2` the check itself failed. A guard treats `2` as a refusal, so a broken
  check never waves a post through.
- **The report** names each finding's category, the line, and the matched text. It is printed locally only. The
  Claude Code plugin's report goes into the agent's session, so it never names a private term (section 5).
- **Checks:**
  - paths under the home folder, written with the real account name or as `~/` followed by something other than an
    allowed generic name;
  - temporary and scratch folders;
  - the account name, the machine name, and email addresses outside the allowlist. A machine name a system gives
    by default, or a word for the kind of computer, isn't flagged. Only the user's own file can allow any other
    name, since a repository that names it posts it. The user's own addresses, git's `user.email` unless it's a
    noreply address, are checked whatever a repository allows, even in exempt files; only the user's own file can
    allow one, by naming it exactly;
  - money and accounts: words for plans, billing, payments, subscriptions, spending and usage limits, and amounts
    of money. These are the most likely to give false alarms in some repositories, so a repository's allowlist
    can switch off single words;
  - every term on the user's list, matched case-insensitively at word boundaries, after Unicode normalisation.
- **Configuration:**
  - the user's file in the platform's config folder (`~/.config/second-read/` where there is no other convention),
    or in the folder `SECOND_READ_CONFIG_DIR` names: private terms, allowed emails, allowed paths, allowed account
    and machine names. A repository's own settings can set that variable, and the ones that choose the platform's
    folder (`XDG_CONFIG_HOME`, `APPDATA`, `HOME`), since Claude Code's checked-in project settings can set any but
    a few named variables. So whichever variable chose it, the folder must be absolute, outside every git
    repository (walking up from the folder itself, not from where the check runs), and hold a `config.toml`: a
    missing one there would mean no terms, and a folder every machine has, such as `/var/empty`, would switch the
    term check off. A folder meant to have no terms holds a file without any, which `init` writes. The one
    exception is the account's own default folder, built from the home folder the OS account names rather than
    `HOME`, which no repository can choose: there a missing file means no terms yet, and a home folder that's a
    git repository is fine;
  - a repository's `.second-read.toml`: an allowlist only, never private terms. Anyone with write access can change
    it, so an entry that switches a whole check off is an error, and `pre-push` refuses a change to it until the
    new version's blob id, or the id of the commit that deletes it, is given. Its `exempt_files` globs name files
    whose added lines `pre-push` checks for private terms only, such as the repository's tests; a glob that takes
    in nearly every file is an error. Messages, tags and posts are still checked in full;
  - `second-read init` writes the user's file with comments and no terms, and says how to add them.
- **Runtime:** TypeScript on Node 22, zero runtime dependencies, published as one npm package. It must start fast
  enough to run on every commit.

## 4. Guards anyone can use

- **git:** `commit-msg` checks the message. `pre-push` checks the messages and added lines of the commits being
  pushed, and the names the remote's branches and tags get; a deletion is never refused. A merge's added lines are
  the ones in none of its parents, as in a conflict resolution. `second-read hooks install` adds them to a
  repository, alongside any hooks already there.
- **`gh` shim:** a `gh` placed ahead of the real one on `PATH`. For `issue|pr create|edit|comment` and
  `pr review`, it checks `--title`, `--body`, `--body-file` and stdin bodies, then runs the real `gh` unchanged.
  It checks the `--comment` of `issue|pr close|reopen` and the merge commit message and `--author-email` of
  `pr merge` too, and for `release`, `gist`, `label` and `repo` `create|edit`, the title, notes, description, label
  name and gist files. An author email is checked as an address in a commit is, so the user's own is refused
  whatever a repository allows, unless it's a noreply address. The label of each asset `release create|upload`
  sends (`<file>#<label>`) is checked as text. A gist's files are checked in full, since a gist is a new post, not
  lines added to the repository's files.
  The names these give are checked as branch names are: a repository's on `create` and `rename`, a release's tag,
  each gist file's name (its basename, or `--filename` for stdin), and each release asset's file name, labeled or
  not, since it's in the asset's download URL. gh expands an asset without a label as a glob, so the shim matches
  it at least as widely as Go's `filepath.Glob` does, and the Claude Code hook refuses it unread, since the files
  may not be there until the command runs. An edit checks only the new name, so a leaked one can be renamed away.
  Grouped short flags are read as gh reads them, from each command's flags that take a value.
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
  - **How it runs:** the plugin's command hook runs it only on a call whose posts the word check passes, so other
    calls never wait on a model. A prompt hook can't see the conversation, and an agent hook is experimental, with
    no documented behaviour on failure. The hook runs `claude -p` with no tools, MCP servers or hooks, from an
    empty folder, and asks for a verdict that fits a JSON schema.
  - **What it reads:** the text turns the user typed, from the session's transcript, newest first up to 60,000
    characters, and each text the call posts apart from file contents, which are code. Both are given as JSON, as
    data. A user-role entry marked as something else isn't a typed turn: a skill's text or a hook's output
    (`isMeta`, `turnCompanion`, `sourceToolUseID`), a tool's result, a subagent's prompt, and a message from another
    session (`origin.kind` or `turnOrigin` of `peer`). An entry also marked as typed (`human`, or a `promptSource`
    of `typed`) counts despite a skill's marker. Any other user entry counts as typed, so a marker the format renames
    leaves the check stricter, not off.
  - **No typed turn:** a session that only other sessions direct has nothing private to carry, so its posts go on
    without the model. The word check still runs. A message from another session that quotes the user is the
    sending session's to check.
  - **Fails closed:** a verdict that flags the post refuses it, with the post's words and the user's. So does a
    timeout (90 seconds), a crash, output that doesn't fit the schema, a missing transcript, or one where no line
    reads as an entry, since its format isn't documented. With no typed turn, a call whose own turn (the hook
    input's `prompt_id`) has no user entry in the transcript yet is refused too, since that turn may be typed. A
    quick crash is tried once more, since it's more likely the API than the post.
  - **Options:** `model_check` turns it off, and `model` picks the model, `haiku` by default. `config_dir` points
    the hooks at a config folder of their own, for a session whose commands read a `SECOND_READ_CONFIG_DIR` with
    no terms, so their output never shows the user's. Claude Code gives plugin options only to the plugin's hooks, and
    reads them only from user, `--settings` and managed settings, so neither the session's commands nor a
    repository can see or set it. A folder without a `config.toml`, or a path that isn't absolute, refuses every
    post.
  - **What it tells Claude:** a deny reason never names a private term. A term's finding gives its line, column and
    rule but not its text, and a term anywhere else in the reason, in a path, a file name, a quoted command or the
    model check's answer, is masked. A reason that can't be masked, since the terms can't be read, is replaced by
    why they couldn't.
  - **Its limits:** once the account reaches its usage limit, every post is refused until the limit resets or
    the check is turned off. A reason given before the cap, or before a compaction or `/clear`, isn't seen. The transcript
    is written asynchronously, so the newest turn, the likeliest to lead to a post, may be missing. It was there
    in each headless run tried on Claude Code 2.1.302: a new session, a resumed one, and a call from a subagent,
    whose hook is given the main session's transcript. Interactive sessions weren't tried. The hook input's
    `prompt_id` matched the newest turn's `promptId` in the transcript, so a missing turn can be detected. The check
    does so only when the transcript has no typed turn, where a missing one would otherwise mean no model check;
    with earlier typed turns, the newest may still be missing. A Claude Code that sends no `prompt_id` gets no such
    check. A format change that marked typed turns as one of the kinds skipped above would turn the model check off
    without a word. A paraphrase the model misses goes out. Text the user pasted from elsewhere can try to steer it,
    which fits a safety net, not a boundary.
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
  are the repository's own business, exempted through `.second-read.toml`. A private term is found in them anyway.
