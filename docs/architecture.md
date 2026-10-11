# Architecture

A tour of the code for contributors. Code comments are in French; names are explicit enough
to follow along.

```
Browser / macOS app ──HTTP /api/*──────────▶ Express (server/index.js)
        │                                         │
        └──WebSocket /ws/<page>───▶ y-websocket ──┤ live Yjs documents (memory)
                                                  │
                                    vault on disk ◀┘  data/vaults/<vault>/…  ◀──▶ nextcloudcmd ◀──▶ Nextcloud
```

## Server (`server/`)

| File | Role |
| --- | --- |
| `index.js` | Express routes, WebSocket upgrade, vault switching, file watcher, external-change handling. |
| `vault.js` | Where files live on disk (Obsidian-like layout), moves, and `reconcile()`: aligns Yariche's tree with the disk (files added / moved / deleted elsewhere). |
| `meta-store.js` | Per-page metadata (owner, sharing, icon, trash) in `<vault>/.yariche/nodes.json`, keyed by path, plus the wikilink index and Obsidian-style link resolution (backlinks, graph). |
| `migrate-v2.js` | One-time migration of a vault from name-keyed `meta.json` (v1) to path-keyed `nodes.json`. |
| `version-store.js` | Page history: snapshot of the previous content on each save. |
| `social-store.js` | Known users (mentions) and notifications (inbox). |
| `settings.js` | Server settings (`data/settings.json`): active vault, Nextcloud account, admins. |
| `nextcloud.js` | WebDAV folder browsing and the sync loop around `nextcloudcmd`. |
| `auth.js` | Sessions and OpenID Connect login (plus the macOS app's login through the default browser: one-time code returned via `yariche://`, bound to a PKCE-style secret); no-login mode when OIDC is not configured. |

### Pages, paths and files

A page's **identifier is its path in the vault**, without extension (`room`, e.g.
`R521/Concepts/MIMO`): it is the Yjs room, the key in `nodes.json` and the file location. As in
Obsidian, the same name can exist in different folders; the displayed name is the last segment
and the parent is the directory.

- a page: `Path/Name.md`;
- a page with sub-pages: `Name.md` + folder `Name/` holding the children;
- a folder: a directory (no `.md`);
- a database / whiteboard: `Name.db.json` / `Name.board.json`;
- trash: `.trash/<original path>` (Obsidian's convention), the root of a trashed subtree
  remembers where it came from (`originalId`) for restore.

Moving or renaming changes the identifier of the node and of its whole subtree: files move,
metadata, versions and comments follow (`moveSubtree`), open live documents are dropped and
clients reopen the page at its new address. Files moved outside Yariche are recognised by
their inode, so their metadata follows too.

`[[links]]` are stored as written and resolved like Obsidian: a link containing `/` matches a
path (or the end of one), otherwise a name; among homonyms, the one in the same folder wins,
then the shortest path. Renaming or moving rewrites the links that pointed to the old path.

Versions and comments are stored per node under `storageKey(id)` (the encoded path, or a hash
for very long paths).

### Saving and the "baseline"

The editor state is a Yjs document kept in memory by y-websocket (no Yjs persistence). The
client serialises it to Markdown and `POST /api/doc/:room` writes the file (atomically,
temp file + rename). The YAML front matter is never touched.

Opening a note must not reformat it (the Markdown serializer has its own style: `-` bullets,
`**bold**`…). When content comes from disk, the client posts a **baseline**: how the editor
renders that file. Later saves equal to the baseline are no-ops, so the file stays
byte-for-byte identical until someone actually edits it.

### External changes

A chokidar watcher on the vault:

- add / move / delete → `reconcile()` (debounced);
- a page file changed by someone else (content differs from what Yariche wrote):
  - page not open → the in-memory Yjs doc is dropped, the next open reads the disk;
  - page open → an "external conflict" is published; the first client with no unsaved edit
    claims it (`/conflict/claim`) and loads the new content for everyone; otherwise a banner
    asks.

### Vaults and Nextcloud

A vault is a folder of `data/vaults/`. Only one is open at a time (`openVault()` re-inits the
stores, the watcher and the sync). Clients send the vault they display (`X-Yariche-Vault`,
`?vault=` on WebSockets) so a tab left on another vault cannot write into the new one.

A vault can be linked to a Nextcloud folder: `nextcloud.js` runs `nextcloudcmd` (netrc
credentials, hidden files not synced, so `.yariche/` and `.trash/` stay local) after each
change (3 s debounce) and every `NEXTCLOUD_SYNC_INTERVAL` seconds.

## Client (`client/`)

| File | Role |
| --- | --- |
| `main.js` | App shell: explorer, navigation, page loading, saving, palette, shortcuts, native bridge. |
| `vault-ui.js` | Vault switcher and "working folder" dialog (Nextcloud browser). |
| `markdown-extras.js`, `link-decorations.js` | Obsidian syntax: wikilinks, tags, callouts, `==highlight==`, embeds. |
| `code-block.js` | Code blocks (highlight.js through lowlight). |
| `slash-command.js`, `mention.js`, `suggest-menu.js` | `/` menu, `@` and `[[` pickers. |
| `comments.js` | Anchored comment threads (W3C text-quote selectors in a Yjs map). |
| `database.js`, `board.js` | Databases and whiteboards (Yjs maps, JSON files on disk). |

## macOS app (`macos-app/`)

AppKit + WKWebView, no Electron. It adds what a web page cannot do: native title bar,
dialogs, downloads, Dock badge, "Show in Finder" (it finds the vault synced by the Nextcloud
client, or asks once). The page talks to it through `window.webkit.messageHandlers.yariche`.

## Tests

`npm test` starts a real server on a temporary `DATA_DIR` and exercises the API
(`test/api.test.js`): files on disk, front matter, baseline, tree moves, external changes,
trash names, renames, path safety, vault switching.
