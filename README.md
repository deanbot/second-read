# second-read

_A privacy check on agent-written commits, issues, PRs and comments, for any coding agent._

Coding agents write a lot of prose on your behalf: commit messages, issue and PR bodies, review comments. Some of it
mentions things about you that you'd never post yourself, such as a path on your machine, the name of a private
project, or a detail about your accounts. Nobody can read every line an agent posts, and a rule in a prompt is
followed most of the time, not every time. Once a slip is posted, it's hard to take back: edit histories keep old
revisions, and a commit is public until the history is rewritten.

second-read reads what's about to go out and stops it when it finds something private. It doesn't rewrite your text.
It refuses, names what it found, and leaves the fix to you or your agent.

> **Status:** early. The check, the git and `gh` guards and the Claude Code plugin with its model check run; other
> agent adapters and the sweep are planned.
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
- **A `gh` shim:** the text of issues, pull requests, comments, releases, gists, labels and repositories, and the
  names they're given, before the real `gh` sends it.
- **Agent adapters**, for posts that don't go through `git` or `gh`, such as a GitHub tool an agent calls directly.
  Claude Code comes first. Other agents follow, each written from its tool's own hook docs.
- **A sweep** of what's already posted to a repository, edit histories included.

The check, the git hooks and the `gh` shim run on your machine, and the text they read goes nowhere else. Only the
Claude Code plugin's model check sends text: the post and your turns in the conversation, to the model provider your
session already uses. You can turn it off.

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

Your config file is `~/.config/second-read/config.toml` (`$XDG_CONFIG_HOME`, or `%APPDATA%` on Windows), or
`config.toml` in the folder `SECOND_READ_CONFIG_DIR` names:

```toml
terms = ["example-private-project"]       # never posted; see below
allowed_words = ["billing"]               # money words that are fine to post
allowed_emails = ["*@example.com"]
allowed_paths = ["~/.config/some-tool"]
allowed_names = ["juniper"]               # your account or machine name, when it's an ordinary word
```

A term matches in any case, with or without accents, in fullwidth forms, with invisible characters inside it, and
with its words joined by spaces, hyphens or nothing. It doesn't catch misspellings.

### `SECOND_READ_CONFIG_DIR`

`SECOND_READ_CONFIG_DIR` names another config folder, for tests, or for an agent session whose own output should
never show your terms. The guards and the plugin can each be given your real one: see
[the guards' own folder](#a-config-folder-of-the-guards-own) and
[the plugin's](#a-config-folder-of-the-plugins-own). Agent tools can set variables from settings checked into a
repository: Claude Code's project `.claude/settings.json` applies to "everyone working in the project, checked into
source control", its `env` key can be set in any settings file, and only a few named variables are kept from
project settings. So a repository could point the variable at a config of its own choosing. The same goes for the
variables that choose the platform's folder: `XDG_CONFIG_HOME`, `APPDATA`, and `HOME` or `USERPROFILE`. Whichever
of them chose the folder, the check refuses the forms that would let a repository pick it:

- **A folder inside any git repository**, its work tree or `.git`, through symlinks too, wherever the check runs
  from. Point the variable at a folder outside every repository, or unset it.
- **A relative path**, which would be read from wherever the check runs. A leading `~` is your home folder, since
  settings files hand the value over with no shell to expand it.
- **A folder with no `config.toml`.** A missing file would mean no terms, so a folder every machine has, such as
  `/`, `/var/empty` or the system's temp folder, would switch the term check off. A folder that's meant to have no
  terms holds a file without any, which `init` writes, with the variable set as the check sees it:

  ```sh
  SECOND_READ_CONFIG_DIR=/path/to/folder second-read init
  ```

Each makes the check fail, so the guards refuse until it's fixed. Your account's own default folder is the one
exception: `~/.config/second-read` (`AppData\Roaming\second-read` on Windows), with `~` the home folder your
account has on the system rather than `HOME`, which no repository's settings can change. It's read even when your
home folder is itself a git repository, and a missing file there still means no terms yet.

**Upgrading:** run `init` once, with the same variables set, or every check fails, if your config folder has no
`config.toml` and any of these is true:

- `SECOND_READ_CONFIG_DIR` names it;
- `XDG_CONFIG_HOME` or `APPDATA` points somewhere other than your account's default;
- `HOME` isn't your account's home folder, as under `sudo` without `-H` or in some CI containers.

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
  `reopen` leave, and the `--subject`, body and `--author-email` of `gh pr merge`'s merge commit. It checks a
  release's title, notes and tag, and the file name and any label of each asset `gh release create` or
  `gh release upload` sends, a gist's description and the files it uploads, stdin included, with the name
  each is uploaded under, a label's name and description, and a repository's name and description, on
  `gh repo rename` too. A name is checked as a branch name is, and only the new one, so a leaked name can be renamed
  away. Then it runs the real `gh` with the same arguments and input. Every other command, `gh api` included, passes
  straight through.

Each guard refuses on a finding, and also when the check itself fails. A hook that was already in place is set aside
and still runs after the check; `second-read hooks uninstall` removes only second-read's hooks and puts it back. The
repository's `.second-read.toml` is read from the repository the hook runs in, or from the folder the shim runs in.

When `core.hooksPath` points at a checked-in folder, the hooks go into a folder inside `.git` instead, and this
clone's `core.hooksPath` points there. The repository's hooks still run, including ones added later: each hook
githooks(5) lists, except `push-to-checkout`. git runs `reference-transaction` and `post-index-change` very often, so
they run only if the repository had them when you installed; install again after adding one. `hooks uninstall` puts
`core.hooksPath` back. Running the repository's own setup step again, if it sets `core.hooksPath`, turns the guards
off until you install them again.

### A config folder of the guards' own

A session whose commands read a `SECOND_READ_CONFIG_DIR` with no terms runs its `git commit`, `git push` and `gh`
there too, so the guards would read that folder and check by patterns only. `SECOND_READ_GUARD_CONFIG_DIR` points
the git hooks and the gh shim at your real config, set beside the other variable, for example in the session's
settings:

```json
"env": {
  "SECOND_READ_CONFIG_DIR": "/path/to/folder-with-no-terms",
  "SECOND_READ_GUARD_CONFIG_DIR": "~/.config/second-read"
}
```

- **What reads it:** only `commit-msg`, `pre-push` and the shim. `second-read check` and the plugin's hooks keep
  reading `SECOND_READ_CONFIG_DIR`, and the plugin its `config_dir` option.
- **What a guard prints:** while it's set, the guard's report goes into the session, so it never names a private
  term, as the plugin's deny reasons don't. A term's finding gives its line, column and rule, with `(not shown)` in
  place of the text, and a term anywhere else, in a branch's name, a file's name, a path or an error, reads
  `[private term]`. Unset, a guard prints what it found, for you at your terminal.
- **The rules:** the same as `SECOND_READ_CONFIG_DIR`'s, since a repository's settings can set it too. The folder
  has to hold a `config.toml`, the path has to be absolute or start with `~`, and it can't be inside a git
  repository, unless it's your account's own default folder. If any is wrong, every guard refuses until it's fixed;
  a `gh` command that posts nothing still runs.
- **Set but blank refuses too.** A repository's settings can set a variable but not unset it, so a blank value
  there would otherwise turn yours off, and the guards would fall back to the folder with no terms.
- **Where to set the pair:** in `.claude/settings.local.json` or with `--settings`, never in settings checked into
  a repository. A project's shared `.claude/settings.json` overrides the same variable in your
  user settings; the local file and `--settings` sit above it.
- **What it doesn't hide:** the session's commands can see the variable, as they see every other. It names a folder,
  not your terms, and your default folder is as easy to find. An empty `SECOND_READ_CONFIG_DIR` keeps your terms out
  of what second-read prints into the session; it never kept the file from being read.

Unset, the guards find your config as everything else does.

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
  and `gh api` calls that send fields (`-f`, `-F`, including `@file`) or an `--input` body, unless they're `GET`. A
  GraphQL query is checked when it's a mutation.
- **`git commit` and `git tag` messages**, from `-m`, `-F` and `--trailer`. What a push sends is the `pre-push`
  hook's to check.
- **GitHub tools from MCP servers:** any tool with `github` in its name, in any case, apart from the ones that only
  read (`get_`, `list_`, `search_`, `_read`). Every string it's given is checked, except `owner` and `repo`. A
  file's contents are checked like the lines a push adds, so `exempt_files` applies to them.

A body can come from a heredoc (`--body "$(cat <<'EOF' … EOF)"`), a here-string, a file, or `cat`, `echo` or
`printf` piped in. A file the same command writes first, as in `cat > body.md <<'EOF'`, is read from the command,
since the hook runs before it does. Posts inside `$(…)` and backticks are checked too. A body the shell fills in
only when the command runs, such as `--body "$BODY"` or what `xargs` adds, can't be read beforehand, so the call is
denied. So is a release asset given as a glob, such as `dist/*.tgz`, whose files may not be there yet. Put the text
in the command, or in a file and pass its path, and name each asset.

### The model check

A post the word check passes then goes to a small model, which reads it beside what you typed in the conversation.
It refuses a post that carries what you told the agent in private, quoted or in other words: why you personally
decided something, rather than what changed, or a description of your machine, home, accounts or private projects.
A reason about the work, such as a bug, a release or a code style you prefer, is fine.

- **When it runs:** only on a call that posts, after the word check passes it, so other calls never wait on it. It
  adds a few seconds to each post. With no turn you typed in the session, such as one only other sessions direct,
  there's nothing private to carry, so the post goes on without it. The word check still runs.
- **What counts as your turn:** only what you typed, a slash command included. A skill's text, a hook's output, a
  tool's result, a subagent's prompt and a message from another session are recorded in the conversation too, but
  aren't yours, so the model check neither reads them nor counts them as a turn.
- **What it sends:** your typed turns, newest first, up to 60,000 characters, and the post's text apart from file
  contents. It runs `claude -p` with no tools, so they go only to the model provider your session already uses, and
  each check counts toward your usage limit or API billing.
- **When it fails:** a timeout (90 seconds), a crash, or an answer it can't read refuses the post, and the reason
  says why. So does a conversation it can't read, such as a turn you typed whose text it can't find. A crash within
  a few seconds, such as an overloaded API, is tried once more first. Once your account reaches its usage limit,
  every post is refused until the limit resets or you turn the model check off.
- **What it misses:** a reason you gave earlier than the 60,000 characters, or before a compaction or `/clear`. A
  paraphrase the model doesn't spot. Text you pasted from elsewhere can try to steer it. A message from another
  session that quotes you: what you typed there is the sending session's to check, with its own guards.

To turn it off, or pick another model than `haiku`, change second-read's **Model check** or **Model check's model**
in `/config`, or in `/plugin` under second-read. The word check keeps running either way.

### What the plugin tells Claude

A deny reason goes into the session, so it never names one of your private terms. A term's finding gives its line,
column and rule, with `(not shown)` in place of the text, and a term anywhere else in the reason, such as inside a
path, a file name or the model check's answer, reads `[private term]`. Claude can still find the spot and fix it.
The reason is all that's masked: the post itself is checked as it is, and never changed.

### A config folder of the plugin's own

A session that works on a repository where `second-read check` runs all day, such as second-read's own, can set
`SECOND_READ_CONFIG_DIR` to a folder with no terms, so its commands' output never shows yours. The plugin's hooks
run in that session and would read that folder too. Point them at your real config with the **Config folder**
option, `config_dir`, in `/config` or in `/plugin` under second-read:

```json
"pluginConfigs": {
  "second-read@second-read": { "options": { "config_dir": "~/.config/second-read" } }
}
```

That's the entry it writes to your user settings. Claude Code gives the option only to the plugin's hooks: commands
Claude runs never see it, and `second-read check` keeps reading `SECOND_READ_CONFIG_DIR`. It reads plugin options
only from your user settings, a `--settings` file and managed settings, so a repository can't set it. Set, it wins
over `SECOND_READ_CONFIG_DIR` for the hooks. Left empty, the hooks find your config as everything else does.

The folder has to hold a `config.toml`, and the path has to be absolute or start with `~`. If either is wrong,
every post is refused until it's fixed, since the hooks would otherwise go on without your terms. Calls that
don't post aren't affected.

The git hooks and the gh shim don't read the option: they run outside Claude Code, which gives it only to the
plugin. The plugin checks every commit and tag message and gh post a session makes, but what a push adds is the
`pre-push` hook's to check. Point the guards at your config with
[`SECOND_READ_GUARD_CONFIG_DIR`](#a-config-folder-of-the-guards-own), or in such a session they read the folder
with no terms.

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

If `claude` isn't on the hook's `PATH`, or can't reach the model, the model check refuses every post, but no other
call. Turn the model check off in `/config` until it can.

Before Claude Code 2.1.295, the hook's `onFailure` setting is ignored, so a hook that crashes lets the call through.

A setup script can tell whether the plugin is in place with `claude plugin list --json`, which lists it as
`"id": "second-read@second-read"` with `"enabled": true`.

## Contributing

Issues and pull requests are welcome. [CONTRIBUTING.md](./CONTRIBUTING.md) says how to run the tests, how an issue
or PR is handled, and how to report a security problem privately.

## License

[MIT](./LICENSE)
