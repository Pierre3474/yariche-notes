# Yariche.app, client macOS natif

App AppKit + WKWebView (pas d'Electron, pas de Node) qui affiche un serveur Yariche.

## Compiler et installer

```bash
./build-app.sh                                   # compile, installe dans /Applications, lance
YARICHE_SERVER_URL=https://notes.exemple.fr ./build-app.sh   # avec l'adresse du serveur intégrée
./build-app.sh --no-install                      # compile seulement (build.noindex/)
```

Une seule copie reste sur le Mac (celle de /Applications) : pas de doublon dans Spotlight
ou le Launchpad. Prérequis : Xcode ou les Command Line Tools (Swift 5.9+), macOS 12+.

Sans `YARICHE_SERVER_URL`, l'adresse est demandée au premier lancement ; elle se change
ensuite dans **Yariche → Adresse du serveur…** (⌘,).

## Ce que fait l'app (et que la page web seule ne peut pas faire)

- Barre de titre transparente : les boutons de fenêtre sont centrés dans la barre de 52 px
  de l'app, la fenêtre se déplace depuis les zones vides des barres (la page envoie leurs
  rectangles au natif, `window.webkit.messageHandlers.yariche`).
- **Afficher dans le Finder** sur les notes et dossiers : l'app retrouve le coffre
  synchronisé par le client Nextcloud (intégration Finder `~/Library/CloudStorage/Nextcloud-…`
  ou dossier de synchro classique), sinon le demande une fois
  (**Yariche → Dossier du coffre sur ce Mac…** pour le changer).
- Thème clair/sombre synchronisé avec l'app, sans flash blanc au chargement.
- Dialogues natifs pour `alert` / `confirm` / `prompt`, sélecteur de fichiers.
- Téléchargements (export `.md`) dans ~/Téléchargements.
- Connexion SSO dans le navigateur par défaut : clés de sécurité, passkeys et Touch ID y
  fonctionnent, contrairement à la vue web d'une app (Apple réserve WebAuthn aux
  navigateurs). Le navigateur rend la main à l'app par un lien `yariche://auth?code=…`
  (code à usage unique, 2 min) que l'app échange contre la session avec un secret qu'elle
  seule connaît (principe PKCE) : une autre app qui capterait le lien n'en ferait rien.
- Liens cliqués dans les notes ouverts dans le navigateur par défaut.
- **Mode local** (menu **Yariche → Où travailler (serveur ou ce Mac)…**) : Yariche tourne dans
  l'app (Node.js officiel et le serveur embarqués, `Contents/Resources`) et écrit directement
  dans un dossier du Mac: ton dossier Nextcloud, que le client Nextcloud synchronise. Marche
  hors connexion. Le serveur n'écoute que sur 127.0.0.1 (port 5178 si libre) et n'ouvre
  qu'avec le secret de ce lancement ; ses données internes (métadonnées, versions,
  commentaires) sont dans `~/Library/Application Support/Yariche/local`, pas dans le dossier
  synchronisé. Journal : `~/Library/Logs/Yariche/local-server.log`. Limite : commentaires,
  partages et historique sont propres à ce Mac (les notes, elles, sont les mêmes partout).
  Réglages du serveur local dans `~/Library/Application Support/Yariche/local/ai.env`
  (`CLÉ=valeur`) : assistant IA (`LLM_BASE_URL`, `LLM_MODEL`, `LLM_API_KEY`) et sites internes
  acceptés pour l'aperçu des signets (`UNFURL_ALLOW_HOSTS=*.exemple.fr`).
  `YARICHE_LOCAL=0 ./build-app.sh` : app sans mode local (5 Mo au lieu de ~200 Mo).
- Badge du Dock = notifications non lues.
- Page d'erreur avec « Réessayer » et « Changer d'adresse… » si le serveur est injoignable.
- Menus complets : Édition (⌘C/⌘V/⌘Z), Présentation (⌘R, ⌘[ / ⌘], zoom), Fenêtre, plein écran.

## Notes

- `NSAllowsArbitraryLoads` est activé : un serveur en `http://` sur le réseau local reste
  joignable. Préférer HTTPS dès que le serveur est exposé.
- Signature ad hoc (`codesign --sign -`) : suffisant pour un usage personnel, pas pour
  distribuer l'app (il faudrait un certificat Developer ID et la notarisation).
