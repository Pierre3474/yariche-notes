<p align="center">
  <img src="branding/logo-mark.svg" width="88" alt="Yariche logo" />
</p>

<h1 align="center">Yariche</h1>

<p align="center">
  Self-hosted, real-time collaborative notes with a block editor, databases and whiteboards,<br />
  stored as plain Markdown files organised like an Obsidian vault, and synced with Nextcloud.
</p>

<p align="center">
  <a href="README.fr.md">Français</a> ·
  <a href="docs/architecture.md">Architecture</a> ·
  <a href="CONTRIBUTING.md">Contributing</a>
</p>

---

## Why

Hosted note apps keep your notes in their own database. Obsidian keeps
plain files, but real-time collaboration is not its thing. Yariche sits in between:

- **Your files stay yours.** Every page is a real `.md` file in a real folder tree
  (`Project.md`, `Project/Spec.md`, `.trash/`…). Open the same folder in Obsidian, grep it,
  back it up, version it with git.
- **Real-time collaboration.** Several people edit the same page at once (Yjs CRDT), with
  live cursors, comments, @mentions and an inbox.
- **Nextcloud as the vault.** Pick any Nextcloud folder as your working folder: Yariche syncs
  it both ways with the official Nextcloud sync client, so your notes are on every device.

## Features

- **Editor**: `/` command menu, `@` mentions, `[[wikilinks]]` with backlinks and graph view,
  `#tags`, callouts `> [!note]`, `==highlight==`, tables, task lists, syntax-highlighted code
  blocks, images (`![[photo.png]]` embeds included), version history, reading mode.
- **Obsidian-compatible vault**: folders, sub-pages in a same-name folder, `.trash/`,
  `attachments/`, YAML front matter shown as properties and never rewritten. Opening a note
  does not reformat it. Files added, moved or deleted outside Yariche are picked up live.
- **Databases**: 12 property types, table / board / list / gallery / calendar
  views, filters, sorts, calculations, a page per row.
- **Whiteboards**: notes, shapes, text, pen, connectors, images.
- **Collaboration**: anchored comments, mentions, inbox, sharing (private / link / invited
  people), **team spaces** (a shared folder shares everything inside it, including pages
  created later), guest links without an account (a page or a whole folder), SSO with any
  OpenID Connect provider.
- **Built-in AI** (any OpenAI-compatible API): assistant on the selection or cursor (`⌘J`, `/`, selection menu: improve, fix, shorten, translate, continue…) with a preview before anything is written, plus grey inline completion (Tab to accept).
- **Navigation**: file explorer, quick switcher (⌘O), command palette (⌘P), full-text
  search (⌘⇧F), daily note, trash, vault switcher.
- **Apps**: installable web app (PWA), a native macOS app (AppKit + WKWebView, with an
  optional *local mode* that runs Yariche inside the app on a folder of the Mac), and apps for
  Windows and Linux (Tauri: `.msi`/`.exe`, `.deb`, `.rpm`).
- **Optional AI assistant**: any OpenAI-compatible API (Ollama, LiteLLM, vLLM, OpenAI…).
- **AI agents (MCP)**: a built-in Model Context Protocol server: any MCP client
  can search, read, create and edit your notes with your permissions.

> The user interface is currently in French. Translations are very welcome, see
> [CONTRIBUTING.md](CONTRIBUTING.md).

## Quick start

```bash
git clone https://github.com/Pierre3474/yariche-notes.git
cd yariche-notes
./install.sh              # Docker; ./install.sh --local for Node.js without Docker
```

On Windows: `powershell -ExecutionPolicy Bypass -File install.ps1` (Docker Desktop).

The script writes `.env` (generated secrets), starts Yariche and prints the address
(<http://localhost:5174>) and the setup code. On the first visit you create the administrator
account on `/setup`. After that everyone signs in on `/login` with a username and password.

### Accounts

- Sign-in with Yariche accounts: passwords hashed with scrypt, five attempts per username then a
  15 minute lock, `HttpOnly` session cookie.
- The administrator adds, removes and resets accounts on `/admin/users`. Everyone changes their
  own password on `/account` (click the avatar).
- `ALLOW_SIGNUP=true` opens public sign-up on `/signup`. Closed by default.
- Command line: `docker exec -i yariche node server/cli.js user create <username>` (password read
  from standard input), `user passwd`, `user list`, `user delete`.
- There is no reset e-mail: an administrator sets a new password.
- OpenID Connect SSO (Authentik, Keycloak...) still works with the `OIDC_*` variables.
  `AUTH_MODE=both` or `LOCAL_LOGIN=1` shows the form and the SSO button together. With SSO,
  `/setup` is closed: create local accounts from `/admin/users` or the CLI.
- `AUTH_MODE=none` removes sign-in entirely (a single user, for your own machine only).

Behind an HTTPS reverse proxy, add `TRUST_PROXY=1` to `.env`.

Data lives in `./data` (mounted volume):

```
data/
  settings.json          server settings (active vault, Nextcloud account): private
  .sessions/             login sessions
  vaults/
    Notes/               a vault: plain Markdown files, like an Obsidian vault
      Home.md
      Project.md
      Project/Spec.md
      attachments/
      .trash/
      .yariche/          internal data (metadata, versions, comments): hidden
```

Back up `data/` and you have everything.

## Configuration

All settings are environment variables (see [`.env.example`](.env.example)).

| Variable | Purpose |
| --- | --- |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_REDIRECT_URI` | SSO (Authentik, Keycloak, Authelia, Zitadel, Google…). Redirect URI: `https://<your-host>/auth/callback`. |
| `OIDC_PROVIDER_NAME` | Label of the login button. |
| `ALLOWED_EMAILS` | Accounts allowed to log in (email or SSO username); others work through share links. Empty = any SSO account. |
| `ACCOUNT_ALIASES` | Other SSO accounts of the same person, e.g. `me.admin=me@example.com`: logged in as the main account (same pages). |
| `SESSION_SECRET` | Long random string, required with SSO. |
| `ADMIN_EMAILS` | Who may switch vaults and connect Nextcloud (default: first user to log in). |
| `DEFAULT_VAULT` | Name of the first vault (default `Notes`). |
| `YARICHE_DEFAULT_OWNER` | Owner of notes created outside Yariche. |
| `YARICHE_STORAGE` | `ask` (default), `nextcloud` (notes always in Nextcloud) or `local`. |
| `NEXTCLOUD_URL` | Nextcloud address suggested on first launch. |
| `NEXTCLOUD_USER`, `NEXTCLOUD_APP_PASSWORD` | Fixed Nextcloud account, without the browser login. |
| `NEXTCLOUD_SYNC_INTERVAL` | Seconds between two syncs (default 30). |
| `LLM_BASE_URL`, `LLM_MODEL`, `LLM_API_KEY` | AI assistant (OpenAI-compatible API). The macOS app in local mode reads the same variables from `~/Library/Application Support/Yariche/local/ai.env`. |

### Nextcloud

On first launch Yariche asks for your Nextcloud address and opens your browser, exactly like
the official Nextcloud apps (Login Flow v2): sign in (SSO and 2FA included), allow Yariche,
then pick the folder that will hold your notes (`Yariche` is suggested). No password is typed
into Yariche; the access can be revoked in Nextcloud (*Settings → Security*).

Set `YARICHE_STORAGE=nextcloud` to make Nextcloud mandatory (no notes stored only on the
server), or `local` to never ask.

Yariche keeps a local copy of the folder and runs `nextcloudcmd` (the official command-line
sync client) after each change and every 30 s. Nextcloud therefore sees normal uploads:
versions, activity and push notifications to your other devices all work. Changes made
elsewhere (Nextcloud web, desktop client, Obsidian on another machine) show up in Yariche; a
page that is open is refreshed in place when nobody is typing in it.

### Behind a reverse proxy

Forward everything to port 5174 and allow WebSocket upgrades on `/ws/`:

```nginx
location / {
    proxy_pass http://127.0.0.1:5174;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    client_max_body_size 20m;
}
location /ws/ {
    proxy_pass http://127.0.0.1:5174;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_read_timeout 1h;
}
```

## macOS app

```bash
cd macos-app
YARICHE_SERVER_URL=https://notes.example.com ./build-app.sh   # builds and installs to /Applications
```

Without `YARICHE_SERVER_URL`, the app asks for the server address on first launch. See
[macos-app/README.md](macos-app/README.md).

**Local mode** (menu *Yariche → Où travailler…*): the app embeds Node.js and the Yariche
server and works directly on a folder of the Mac, typically your Nextcloud folder, synced by
the Nextcloud client. It works offline; the server listens on 127.0.0.1 only and opens only
with a secret known by the app. Build without it (much smaller app): `YARICHE_LOCAL=0 ./build-app.sh`.

## Windows and Linux apps

Built by GitHub Actions (`.github/workflows/desktop.yml`): Windows installers (`.msi`, `.exe`),
Debian/Ubuntu `.deb` and Fedora `.rpm`, each installed and launched on a clean system during
the build. Same login flow as the macOS app (default browser, `yariche://` callback). See
[desktop/README.md](desktop/README.md).

## AI agents (MCP)

Yariche includes an MCP server at `https://<your-host>/mcp` (Streamable HTTP). An AI acts on
behalf of the person who created its token, with that person's permissions.

1. In Yariche: sidebar → **Accès IA (MCP)** → create a token (*read* or *read and edit*). It is
   shown once; only its SHA-256 hash is stored, and it can be revoked at any time.
2. Add the server to your client:

```bash
# Clients that speak MCP over stdio only: through mcp-remote
npx mcp-remote https://notes.example.com/mcp --header "Authorization: Bearer yar_…"
```

Tools: `list_pages`, `search_pages`, `read_page`, `get_backlinks`, and with an edit token
`create_page`, `update_page`, `move_page` (links are rewritten), `trash_page` (reversible).
An AI edit keeps the previous version in the page history, and people who have the page
open see it arrive live. Admins can also manage tokens in the container:
`docker exec -u node yariche node server/cli.js token create <account> <name> write`.

## Development

```bash
npm install
npm run dev        # Vite on http://localhost:5173 + server on 5174 (API and /ws proxied)
npm test           # API tests against a real server on a temporary folder
npm run build      # production client in dist/client, served by `npm start`
```

Requirements: Node.js 20+. Nextcloud sync additionally needs `nextcloudcmd`
(`apt install nextcloud-desktop-cmd`, already in the Docker image).

Start with [docs/architecture.md](docs/architecture.md) for a tour of the code.

## Known limitations

- A page is identified by its path, like in Obsidian: the same name can exist in several
  folders, and an ambiguous `[[Name]]` link resolves to the page in the same folder, then to
  the shortest path (write `[[Folder/Name]]` to be explicit).
- Editing the same database or whiteboard both in Yariche and in a text editor at the same
  time: the open version wins.
- The interface is French-only for now.

## License and legal notes

MIT, see [LICENSE](LICENSE). Dependency licenses are listed in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Yariche is an independent project, not
affiliated with Notion, Obsidian, AFFiNE or Nextcloud, whose names are trademarks of their
owners. If you host it for other people, read [LEGAL.md](LEGAL.md) (GDPR, cookies, user
rights) and adapt [PRIVACY.md](PRIVACY.md). Security policy: [SECURITY.md](SECURITY.md).
