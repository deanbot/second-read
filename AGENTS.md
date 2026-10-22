# second-read — Agent Instructions

## What this repo is

`second-read` checks what agents post (commit messages, issues, PRs, comments) for private details before it goes
out. [PLAN.md](./PLAN.md) is the design source of truth. Read the section an issue names before starting it.

## Rules

- **This repository is public, and its own text is checked like any other.** Issues, PRs, commits, tests and
  fixtures never carry a real private detail. A test uses made-up terms (`example-private-project`) and made-up
  paths (`/Users/example/…`).
- **Never read the user's private-terms file.** Tests write their own config into a scratch folder.
- **The core sends nothing anywhere.** Only the sweep calls GitHub, and only through `gh`.
- **Refuse, don't rewrite.** No code path changes the text it checks.
- **Zero runtime dependencies** in the published package.

## Conventions

- TypeScript strict on Node 22. Tests sit next to the code (`*.test.ts`) and run as `.ts` directly, which needs Node
  22.18 or newer; the published package runs on any Node 22.
- Every bug fix includes a regression test.
- Commits are terse, one line where possible, tagged with the issue (`#12`). No AI or tool attribution trailers.
- PR descriptions are terse and durable: what changed and why, `Closes #N`. No attribution.
- Toolchain majors may be newer than you remember. Read the installed docs in `node_modules` before writing
  config from memory.

## CI

- CI (`.github/workflows/ci.yml`) runs `npm ci` and `npm test` on every pull request and every push to `main`, on
  Node 22 and Node 24. It tests a pull request's head commit, not GitHub's merge with the base. A change to
  Markdown files only skips the tests. `npm run eval:judge` calls a model and stays out of CI.
- The check to require before merge is `tests`. It passes when the tests passed on both Node versions, or when they
  were skipped for a Markdown-only change.
- PRs must be up to date with `main` before merge, so the head CI tested is what merges. Bring one up to date by
  merging `main` into it, never by rebasing.
- To switch CI off, set the repository variable `CI_ENABLED` to `false`, in any case (Settings → Secrets and
  variables → Actions → Variables). To switch it back on, delete the variable or set it to anything else; unset
  means on.
- While it's off, no tests run and the `tests` check fails, so nothing merges untested. A skipped job would count
  as passing, which is why it fails instead. To merge then, either switch CI back on and push a new commit (or close
  and reopen the PR) so CI runs again, or run `npm test` on the PR's head yourself and merge through the ruleset's
  bypass.

## Workflow

- One branch per issue. Don't push to `main` or merge; the maintainer merges.
- **No automation that acts on issue or PR text.** Anyone can write that text on a public repository.
