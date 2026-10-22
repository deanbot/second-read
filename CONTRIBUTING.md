# Contributing to second-read

## Setting up

You need Node 22.18 or newer, which runs the tests as TypeScript directly. The published package runs on any
Node 22.

```sh
git clone https://github.com/deanbot/second-read.git
cd second-read
npm ci
npm test
```

`npm test` builds `dist/` and runs every `*.test.ts` file under `src/`. The tests write their own config into a
scratch folder and never read yours.

[AGENTS.md](./AGENTS.md) has the rules and the workflow the maintainers follow, and [PLAN.md](./PLAN.md) is the
design.

## Issues and pull requests

- **Issues are welcome**, bugs and ideas alike. The task template has the sections a maintainer works from:
  Context, What "done" looks like, and Notes / Open questions. A blank issue is fine for a bug report.
- **Pull requests are read**, but code from outside contributors runs only in CI, after a maintainer approves the
  run. A change may be merged as it is, or redone on a maintainer's branch, with credit in that PR.
- **Security problems are reported privately**, through "Report a vulnerability" on this repository's
  [Security tab](https://github.com/deanbot/second-read/security/advisories/new). Please don't open a public issue
  for one.
