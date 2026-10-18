# second-read

_A privacy check on agent-written commits, issues, PRs and comments, for any coding agent._

Coding agents write a lot of prose on your behalf: commit messages, issue and PR bodies, review comments. Some of it
mentions things about you that you'd never post yourself, such as a path on your machine, the name of a private
project, or a detail about your accounts. Nobody can read every line an agent posts, and a rule in a prompt is
followed most of the time, not every time. Once a slip is posted, it's hard to take back: edit histories keep old
revisions, and a commit is public until the history is rewritten.

second-read reads what's about to go out and stops it when it finds something private. It doesn't rewrite your text.
It refuses, names what it found, and leaves the fix to you or your agent.

> **Status:** early. The check, the git and `gh` guards and the Claude Code plugin run; the model check, other agent
> adapters and the sweep are planned.
> [PLAN.md](./PLAN.md) is the design.

## What it checks

- **Paths on your machine:** anything under your home folder, temporary and scratch folders.
- **Who you are on this machine:** your account name, your machine's name and email addresses, apart from the
  ones you allow (such as GitHub's `noreply` address). Your own address, git's `user.email`, is checked whatever a
  repository allows.
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
- **A `gh` shim:** the text of issues, pull requests, comments, releases, gists, labels and repository
  descriptions, before the real `gh` sends it.
- **Agent adapters**, for posts that don't go through `git` or `gh`, such as a GitHub tool an agent calls directly.
  Claude Code comes first. Other agents follow, each written from its tool's own hook docs.
- **A sweep** of what's already posted to a repository, edit histories included.

The check runs on your machine, and the text it reads goes nowhere else.

## Install

second-read needs Node 22 or newer.

```sh
npm install -g second-read
second-read init
```

`init` writes your config file and says how to add your private terms. To update later, run
`npm install -g second-read` again.

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
allowed_names = ["juniper"]               # your account or machine name, when it's an ordinary word
```

A term matches in any case, with or without accents, in fullwidth forms, with invisible characters inside it, and
with its words joined by spaces, hyphens or nothing. It doesn't catch misspellings.

The machine name isn't flagged when it's one a system gives by default, such as `MacBook-Pro`, `raspberrypi` or
`penguin`, or a word for the kind of computer, such as `laptop`. Any other name is, even an ordinary word, since a
name someone chose can say who they are. If yours is a word that's fine to post, put it in `allowed_names`, and
the same goes for an account name. Paths with your account name in them are still flagged.

A repository can check in a `.second-read.toml` with the same `allowed_*` keys, but for `allowed_names`: naming
your machine there would post it. It can't hold `terms`, and it's an error if it names one of your private terms.
Since anyone who can change the repository can change it, it also can't switch a whole check off: `allowed_paths`
can't take in all of `~` or a temp folder, and each `allowed_emails` pattern needs a fixed domain (`*@example.com`
or `*@*.example.com`, not `*@*` or `*@*.com`). Your own file has none of these limits.

A pattern with a fixed domain can still take in a lot, such as `*@*.co.uk`, or `*@gmail.com` and everyone there. So
your own addresses, each `user.email` git uses where the check runs, are checked whatever a repository allows,
unless one is a noreply address. Your own file allows one only by naming it exactly, as `git commit -s` needs: a
pattern such as `*@gmail.com` is for other people's addresses, and doesn't take in yours.

A repository whose code or tests hold paths, emails or money words on purpose can list those files in its
`.second-read.toml`:

```toml
exempt_files = ["src/**/*.test.ts", "fixtures/"]
```

`pre-push` checks the lines a push adds to them for your private terms only. Each glob is a path from the top of the
repository: `*` and `?` stay within one folder, `**` takes in any number of them, and a trailing `/` takes in a
whole folder. A glob made only of wildcards and dots, such as `**` or `**/*.*`, is an error, since it takes in nearly
every file; one for dotfiles, such as `**/.*`, is fine. Commit and tag messages, branch and tag names, and everything
the `gh` shim sends are still checked in full, a gist's files included: a gist is a post of its own.

## The guards

```sh
second-read hooks install    # in a repository: adds the commit-msg and pre-push hooks
second-read shim install     # writes a gh shim, and says which folder to put ahead of gh on PATH
```

- **`commit-msg`** checks the message git is about to commit.
- **`pre-push`** checks the message and the added lines of every commit the remote doesn't have yet (for a merge, the
  lines in none of its parents, such as a conflict resolution's), and the name each branch and tag gets on the remote,
  with the same checks as a message: a branch called `fix-billing-page` or `paid-plan` is refused for the money words
  unless the allowlist lets them through. An annotated tag's own name is checked too, since it goes with the tag
  whatever the remote calls it. Deleting a branch or tag is never refused, since that's how a leaked name is taken
  back. It also refuses a push that changes a `.second-read.toml`, and prints an id for each change: the new version's
  blob, or the commit that deletes the file. Once you've read the change, push again with
  `SECOND_READ_ALLOWLIST_REVIEWED="<id>"`. An id covers only that change, so a later one is refused again.
- **The `gh` shim** checks `--title`, `--body`, `--body-file` and a body read from stdin, for `gh issue` and
  `gh pr` `create`, `edit` and `comment`, and `gh pr review`. It also checks the `--comment` that `close` and
  `reopen` leave, and the `--subject` and body of `gh pr merge`'s merge commit. It checks a release's title and
  notes, a gist's description and the files it uploads, stdin included, a label's name and description, and a
  repository's description. Then it runs the real `gh` with the same arguments and input. Every other command,
  `gh api` included, passes straight through.

Each guard refuses on a finding, and also when the check itself fails. A hook that was already in place is set aside
and still runs after the check; `second-read hooks uninstall` removes only second-read's hooks and puts it back. The
repository's `.second-read.toml` is read from the repository the hook runs in, or from the folder the shim runs in.

When `core.hooksPath` points at a checked-in folder, the hooks go into a folder inside `.git` instead, and this
clone's `core.hooksPath` points there. The repository's hooks still run, including ones added later: each hook
githooks(5) lists, except `push-to-checkout`. git runs `reference-transaction` and `post-index-change` very often, so
they run only if the repository had them when you installed; install again after adding one. `hooks uninstall` puts
`core.hooksPath` back. Running the repository's own setup step again, if it sets `core.hooksPath`, turns the guards
off until you install them again.

## The Claude Code plugin

The plugin checks what Claude Code is about to post, before the tool call runs. When it finds something, it denies
the call and gives Claude the report as the reason, so Claude can fix the text and try again. It needs Claude Code
2.1.295 or newer and Node 22.18 or newer on `PATH`, and it reads the same config files as the guards.

1. Add this repository as a plugin marketplace:

   ```sh
   claude plugin marketplace add deanbot/second-read
   ```

2. Install the plugin:

   ```sh
   claude plugin install second-read@second-read
   ```

3. Check that it's installed and enabled:

   ```sh
   claude plugin list
   ```

It checks:

- **Bash commands that post through `gh`:** the same `gh` commands as the shim, behind `env`, `sudo` and the like,
  and `gh api` calls that send fields (`-f`, `-F`, including `@file`) or an `--input` body, unless they're `GET`. A GraphQL query
  is checked when it's a mutation.
- **`git commit` and `git tag` messages**, from `-m`, `-F` and `--trailer`. What a push sends is the `pre-push`
  hook's to check.
- **GitHub tools from MCP servers:** any tool with `github` in its name, in any case, apart from the ones that only
  read (`get_`, `list_`, `search_`, `_read`). Every string it's given is checked, except `owner` and `repo`. A
  file's contents are checked like the lines a push adds, so `exempt_files` applies to them.

A body can come from a heredoc (`--body "$(cat <<'EOF' … EOF)"`), a here-string, a file, or `cat`, `echo` or
`printf` piped in. A file the same command writes first, as in `cat > body.md <<'EOF'`, is read from the command,
since the hook runs before it does. Posts inside `$(…)` and backticks are checked too. A body the shell fills in
only when the command runs, such as `--body "$BODY"` or what `xargs` adds, can't be read beforehand, so the call is
denied. Put the text in the command, or in a file and pass its path.

The plugin never approves a call. A clean post goes on to Claude Code's usual permission check. Its deny holds in
`bypassPermissions` mode too: a session run with `--permission-mode bypassPermissions` on Claude Code 2.1.302 had
its leaking post refused.

If the hook itself fails or times out, the call is denied. A hook that can't run at all, because `node` isn't on
`PATH` or is older than 22.18, denies every Bash call, not only posts. To get out of that:

1. Turn the plugin off, from a terminal:

   ```sh
   claude plugin disable second-read@second-read
   ```

2. Install Node 22.18 or newer.

3. Turn the plugin back on:

   ```sh
   claude plugin enable second-read@second-read
   ```

Before Claude Code 2.1.295, the hook's `onFailure` setting is ignored, so a hook that crashes lets the call through.

A setup script can tell whether the plugin is in place with `claude plugin list --json`, which lists it as
`"id": "second-read@second-read"` with `"enabled": true`.

## License

[MIT](./LICENSE)
