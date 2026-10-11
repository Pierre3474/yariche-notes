# Yariche pour Windows et Linux

App de bureau (Tauri 2) : ton serveur Yariche dans une fenêtre, avec le moteur web du système
(WebView2 sous Windows, WebKitGTK sous Linux). Même principe que l'app Mac (`macos-app/`).

- **Premier lancement** : adresse du serveur demandée (ou fixée à la compilation), vérification
  qu'il répond ; page « Serveur injoignable » avec « Réessayer » sinon.
- **Connexion SSO dans le navigateur par défaut** (clés de sécurité, passkeys) : le navigateur rend
  la main à l'app par un lien `yariche://auth?code=…` ; le code n'est utilisable qu'avec un secret
  gardé par l'app (principe PKCE). Le schéma `yariche://` est déclaré par l'installateur.
- Liens vers d'autres sites : ouverts dans le navigateur. Exports `.md` : dans Téléchargements.
- Menu Yariche : adresse du serveur, précédent / suivant, recharger.
- Les pages du serveur n'ont accès à aucune commande de l'app (seule la page de démarrage locale).

## Installer

Paquets produits par la CI (onglet *Actions* → « Apps de bureau », ou les *Releases* `desktop-v*`) :

| Système | Paquet | Installation |
|---------|--------|--------------|
| Windows 10/11 | `Yariche_x.y.z_x64-setup.exe` ou `.msi` | double-clic (WebView2 installé au besoin) |
| Debian 12+, Ubuntu 22.04+ | `yariche_x.y.z_amd64.deb` | `sudo apt install ./yariche_*.deb` |
| Fedora | `yariche-x.y.z-1.x86_64.rpm` | `sudo dnf install ./yariche-*.rpm` |

Les paquets ne sont pas signés : Windows SmartScreen demande « Informations complémentaires →
Exécuter quand même » au premier lancement.

## Compiler

Prérequis : Node.js 20+, Rust stable, et sous Linux les bibliothèques WebKitGTK
(`libwebkit2gtk-4.1-dev librsvg2-dev patchelf`, plus `rpm` pour le paquet Fedora).

```bash
cd desktop
npm ci
YARICHE_SERVER_URL=https://notes.exemple.fr npx tauri build --bundles deb,rpm   # Linux
YARICHE_SERVER_URL=https://notes.exemple.fr npx tauri build --bundles msi,nsis  # Windows
```

Sans `YARICHE_SERVER_URL`, l'adresse est demandée au premier lancement. La CI
(`.github/workflows/desktop.yml`) compile, puis installe et lance chaque paquet sur Debian 12,
Debian 13, Fedora et Windows.
