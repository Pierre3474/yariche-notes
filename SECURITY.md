# Security

## Reporting a vulnerability

Please do not open a public issue. Use GitHub's private vulnerability reporting
(*Security → Report a vulnerability* on the repository). You will get an answer within a week.

## Exposing Yariche on the internet: checklist

Yariche is designed to be reachable from the internet (guest links), but only with every
layer below in place. This is how the reference deployment is hardened.

**Application**
- SSO with OpenID Connect (`OIDC_*`), and `ALLOWED_EMAILS` so that only your account(s) can
  sign in. Everyone else works through **guest links** (`/s/<token>`, 192-bit random token):
  a guest only reaches the shared page and its sub-pages (API, real time, attached files),
  and the token is checked on every request, so disabling a link cuts access immediately.
- Strict Content Security Policy (no inline or third-party scripts, `frame-ancestors 'none'`),
  `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: no-referrer` (share links never leak
  through the Referer header), `Permissions-Policy`, COOP/CORP, `Cache-Control: no-store` on
  the API.
- Uploaded files are served in a CSP sandbox (an SVG cannot run scripts).
- WebSocket: `Origin` must match the host, messages capped at 8 MB.
- Brute force: `/s`, `/login`, `/auth` limited to 30 requests per minute per IP.
- AI access (MCP, `/mcp`): personal tokens (`yar_` + 256 random bits), stored as SHA-256
  hashes, shown once, revocable, *read* or *read and edit*; the AI never gets more than the
  permissions of the token's owner. 120 requests per minute per IP.
- Guest links are public, so guests are bounded: per link and per 24 h, at most
  `GUEST_CREATES_PER_LINK` new pages (300) and `GUEST_UPLOAD_MB_PER_LINK` of uploads (300 MB);
  per guest session `GUEST_WRITES_PER_MINUTE` changes (120) and
  `GUEST_REALTIME_MB_PER_MINUTE` of real-time data (20 MB, then the socket is closed).
  Permissions are checked before an upload is written to disk. Nothing new is created or
  uploaded when free disk space drops below `MIN_FREE_DISK_MB` (1024).
- Login: a fresh session is issued at every sign-in (no session fixation). Desktop apps sign in
  in the default browser and get back a one-time code (2 min) usable only with a secret kept
  by the app (PKCE-like), so an intercepted `yariche://` link is worthless.
- Session cookie `HttpOnly`, `SameSite=Lax`, `Secure` over HTTPS (`TRUST_PROXY=1` behind a
  reverse proxy), sessions saved before every login redirect. Set a long `SESSION_SECRET`.

**Container** (`docker-compose.yml`)
- Read-only root filesystem, `/tmp` as `noexec` tmpfs, `no-new-privileges`.
- All Linux capabilities dropped; the few needed at start-up to give `data/` to the `node`
  user are dropped for good (bounding set emptied) before Yariche starts as `node`.
- PID and memory limits. Seccomp default profile.

**Desktop apps**
- macOS: the native bridge only answers the Yariche server shown in the window (and the app's
  own local pages); "Show in Finder" cannot leave the vault folder; plain HTTP only on the local
  network (ATS `NSAllowsLocalNetworking`). Local mode listens on 127.0.0.1 only and opens only
  with the secret of the current launch (cookie, `Host` checked against DNS rebinding,
  WebSocket included).
- Windows / Linux (Tauri): the server's pages have no access to the app's commands (explicit
  capability for the local start page only); links to other sites open in the default browser.
- CI: third-party GitHub Actions pinned to commit SHAs, read-only token except for publishing
  a release, SHA-256 checksums shipped with the packages.

**Host / network**
- Run the container inside an unprivileged LXC (Proxmox: AppArmor profile enforced, user
  namespace) or an equivalent VM.
- Only the reverse proxy should reach the Yariche port (host firewall rule on the published
  port, for example an iptables `DOCKER-USER` rule limited to the proxy's address).
- Reverse proxy with TLS, HSTS, rate limiting and an IPS (e.g. Traefik + CrowdSec).

**Identity provider**
- Restrict the Yariche application to your own account in the IdP as well (defense in
  depth), and register only the HTTPS redirect URI.

## Known advisories

- GHSA-cp6q-959q-f8rh (Tiptap `mergeAttributes`): reviewed; not exploitable in Yariche
  because ProseMirror only keeps attributes declared in the schema (untrusted `__proto__`
  keys never reach `mergeAttributes`). The fix lands with the planned Tiptap v3 migration.

## Operational notes

- `data/settings.json` may contain a Nextcloud app password: it is written with mode `0600`;
  keep `data/` out of public backups. Revoke the app password in Nextcloud if in doubt.
