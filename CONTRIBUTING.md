# Contributing to Yariche

Thanks for your interest! Issues, ideas and pull requests are welcome, in English or French.

## Getting started

```bash
git clone https://github.com/Pierre3474/yariche-notes.git
cd yariche-notes
npm install
npm run dev      # http://localhost:5173 (client) + server on 5174
npm test
```

No account or configuration is needed: without OIDC variables the server runs in no-login
mode with a single local user, and stores everything in `./data`.

Read [docs/architecture.md](docs/architecture.md) first: it explains how pages map to files,
how saving works (and why opening a note must never rewrite it), and how external changes
are handled.

## Guidelines

- **Files are the source of truth.** Anything that changes what is written to disk must keep
  Obsidian compatibility: plain Markdown, front matter untouched, no reformatting on open.
  Add or update a test in `test/api.test.js` for it.
- **Match the surrounding code**: plain ES modules, no framework on the client, small
  functions, comments explaining *why*. The existing comments and the UI are in French;
  new code comments may be in English or French.
- **Keep dependencies light.** The Docker image must stay small and runnable on a homelab.
- **Security**: page names become file names, never build a path from user input without
  going through the existing helpers (`vault.js`) and checks (`app.param('room')`).
- Run `npm test` and `npm run build` before opening a pull request.

## Good first contributions

- Translations: the UI strings are in French, an i18n layer would open Yariche to everyone.
- JSON Canvas (`.canvas`) import/export for whiteboards, to open them in Obsidian.
- Tabs / split panes like Obsidian.
- Tests for the client (Playwright).

## Pull requests

1. Fork, create a branch (`feat/…`, `fix/…`).
2. Keep the change focused; describe the *why* in the PR.
3. Screenshots or a short recording for UI changes.

By contributing you agree that your contribution is licensed under the MIT license.
