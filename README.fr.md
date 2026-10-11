<p align="center">
  <img src="branding/logo-mark.svg" width="88" alt="Logo Yariche" />
</p>

<h1 align="center">Yariche</h1>

<p align="center">
  Notes collaboratives en temps réel, auto-hébergées, avec l'ergonomie de Notion / AFFiNE,<br />
  enregistrées en vrais fichiers Markdown rangés comme un coffre Obsidian, et synchronisées avec Nextcloud.
</p>

<p align="center"><a href="README.md">English</a> · <a href="docs/architecture.md">Architecture</a> · <a href="CONTRIBUTING.md">Contribuer</a></p>

---

## Pourquoi

- **Tes fichiers restent à toi** : chaque page est un vrai fichier `.md` dans une vraie
  arborescence (`Projet.md`, `Projet/Spec.md`, `.trash/`…). Le même dossier s'ouvre dans
  Obsidian, se sauvegarde, se versionne avec git.
- **Collaboration en temps réel** : plusieurs personnes sur la même page (Yjs), curseurs,
  commentaires, @mentions, boîte de réception.
- **Nextcloud comme coffre** : n'importe quel dossier de ton Nextcloud peut devenir le dossier
  de travail, synchronisé dans les deux sens avec le client officiel de Nextcloud.

## Démarrage rapide

```bash
git clone https://github.com/Pierre3474/yariche-notes.git
cd yariche-notes
./install.sh              # Docker ; ./install.sh --local pour Node.js sans Docker
```

Sous Windows : `powershell -ExecutionPolicy Bypass -File install.ps1` (Docker Desktop).

Le script crée le `.env` (secrets générés), démarre Yariche et affiche l'adresse
(<http://localhost:5174>) et le code d'installation. À la première visite, tu crées le compte
administrateur sur la page `/setup`. Ensuite chaque personne se connecte sur `/login` avec son
identifiant et son mot de passe.

### Comptes

- Connexion par comptes Yariche : mots de passe hachés (scrypt), cinq essais par identifiant puis
  blocage de 15 minutes, session en cookie `HttpOnly`.
- L'administrateur ajoute, supprime et réinitialise les comptes sur `/admin/users`. Chacun change
  son mot de passe sur `/account` (clic sur l'avatar).
- `ALLOW_SIGNUP=true` ouvre l'inscription libre sur `/signup`. Fermée par défaut.
- En ligne de commande : `docker exec -i yariche node server/cli.js user create <identifiant>`
  (mot de passe lu sur l'entrée standard), `user passwd`, `user list`, `user delete`.
- Pas d'e-mail de réinitialisation : un administrateur change le mot de passe.
- Un SSO OpenID Connect (Authentik, Keycloak…) reste possible avec les variables `OIDC_*`.
  `AUTH_MODE=both` ou `LOCAL_LOGIN=1` affiche alors le formulaire et le bouton SSO ensemble.
  Avec un SSO, `/setup` est fermé : les comptes locaux se créent par `/admin/users` ou la CLI.
- `AUTH_MODE=none` supprime toute connexion (un seul utilisateur, à réserver à ta machine).

Derrière un reverse proxy HTTPS, ajoute `TRUST_PROXY=1` dans le `.env`.

Tout est dans `./data` : `settings.json` (réglages du serveur), `.sessions/`, et
`vaults/<coffre>/` (les notes, comme un coffre Obsidian ; `.yariche/` y contient les
métadonnées, versions et commentaires). Sauvegarder `data/` suffit.

## Travailler dans un dossier Nextcloud

Au premier lancement, Yariche demande l'adresse de ton Nextcloud et ouvre ton navigateur,
comme les applications Nextcloud officielles : tu te connectes (SSO et double facteur
compris), tu autorises Yariche, puis tu choisis le dossier des notes (« Yariche » est
proposé). Aucun mot de passe n'est saisi dans Yariche ; l'accès se révoque dans Nextcloud
(*Paramètres → Sécurité*).

`YARICHE_STORAGE=nextcloud` rend Nextcloud obligatoire (aucune note seulement sur le
serveur), `local` ne le propose jamais.

Yariche garde une copie locale du dossier et lance `nextcloudcmd` (le client de
synchronisation officiel, en ligne de commande) après chaque modification et toutes les 30 s.
Nextcloud voit des envois normaux : versions, activité, notifications vers tes autres appareils.
Ce qui est modifié ailleurs (Nextcloud web, client de bureau, Obsidian) apparaît dans Yariche ;
une page ouverte se met à jour d'elle-même si personne n'est en train d'y écrire.

Sur Mac, avec le client Nextcloud, l'app Yariche propose « Afficher dans le Finder » sur chaque
note et chaque dossier.

## Configuration

Variables d'environnement, toutes décrites dans [`.env.example`](.env.example) : SSO OpenID
Connect (`OIDC_*`), comptes autorisés (`ALLOWED_EMAILS`, et `ACCOUNT_ALIASES` pour un
second compte de la même personne), administrateurs (`ADMIN_EMAILS`), compte Nextcloud sans interface
(`NEXTCLOUD_*`), assistant IA compatible OpenAI (`LLM_*`).

Derrière un reverse proxy : tout vers le port 5174, WebSocket autorisé sur `/ws/` (exemple
nginx dans le [README anglais](README.md#behind-a-reverse-proxy)).

## App macOS

```bash
cd macos-app
YARICHE_SERVER_URL=https://notes.exemple.fr ./build-app.sh   # compile et installe dans /Applications
```

## IA (MCP)

Yariche contient un serveur MCP (`https://<ton-hôte>/mcp`) : tout client MCP cherche, lit, crée et modifie tes notes avec tes droits. Barre latérale →
**Accès IA (MCP)** → créer un jeton (lecture seule, ou lecture et modification) ; la fenêtre
donne la commande `npx mcp-remote …` à coller. Chaque modification par l'IA garde la version
précédente dans l'historique de la page. Détails dans le [README anglais](README.md#ai-agents-mcp).

## Apps Mac, Windows et Linux

- **macOS** (`macos-app/`) : app native ; *mode local* au choix (menu *Yariche → Où
  travailler…*) : Yariche tourne dans l'app et écrit directement dans un dossier du Mac, par
  exemple ton dossier Nextcloud.
- **Windows et Linux** (`desktop/`, Tauri) : installateurs `.msi`/`.exe`, paquets `.deb`
  (Debian, Ubuntu) et `.rpm` (Fedora), produits et testés par la CI.

## Développement

```bash
npm install
npm run dev        # Vite (5173) + serveur (5174)
npm test           # tests d'API sur un vrai serveur et un dossier temporaire
```

Voir [CONTRIBUTING.md](CONTRIBUTING.md) et [docs/architecture.md](docs/architecture.md).

## Licence

[MIT](LICENSE)
