# Legal notes

This file explains the legal position of the project and what a person running Yariche for
other people has to take care of. It is general information, not legal advice.

## Independence and trademarks

- Yariche is an independent project. It is not affiliated with, endorsed by or sponsored by
  Notion Labs, Inc., Obsidian (Dynalist Inc.), AFFiNE (TOEverything), Nextcloud GmbH or any
  other company named in this repository.
- Notion, Obsidian, AFFiNE, Nextcloud, Markdown and other names are trademarks of their
  owners. They appear only to describe compatibility or to compare features (nominative use).
- Yariche is not a fork of Notion, whose code is proprietary. It contains no code, text,
  icons, templates or other assets taken from Notion or from any other closed product.
  The interface is built from open-source components (Tiptap, Yjs, ProseMirror) and from
  interaction patterns that are common to many editors.
- The name "Yariche", the logo and the icons in `branding/` and `client/public/` were made for
  this project.

## License of the software

The source code is under the MIT license (`LICENSE`). Dependencies keep their own licenses,
all permissive (MIT, ISC, BSD, Apache-2.0, OFL-1.1 for the Inter typeface). The full list with
the required notices is in `THIRD_PARTY_NOTICES.md`. No dependency is under a copyleft license
(GPL, AGPL, LGPL). Keep the MIT notice and `THIRD_PARTY_NOTICES.md` when you redistribute.

The software is provided without warranty, as stated in the license.

## If you host Yariche for other people

You become the data controller for the personal data of your users, and possibly the host of
their content. Things to check, mainly under EU rules (GDPR, ePrivacy, and for France the LCEN
and the CNIL guidance):

1. **Privacy notice.** Publish one. `PRIVACY.md` is a template that lists what Yariche stores.
2. **Cookies.** Yariche sets one session cookie (`connect.sid`), strictly necessary to keep
   you signed in. No consent banner is required for it. Yariche has no analytics, no
   advertising, no tracking and loads no third-party resource (the typeface is served by your
   own server). If you add such tools to your reverse proxy or pages, the rule changes.
3. **Users' rights.** Access and portability: each local account has "Download my data" on
   `/account`. Erasure: "Delete my account" on `/account`, or an administrator on
   `/admin/users`. Notes are plain `.md` files that you can export or delete on disk.
4. **Security.** Use HTTPS, keep the system and the Docker image updated, back up `data/`.
   See `SECURITY.md`. Notify your users and, where required, your data protection authority
   (CNIL in France) within 72 hours of a personal data breach.
5. **Content.** You are responsible for what your users publish. Guest links make pages
   public, so provide a way to report abusive content and remove it (administrators can delete
   accounts, and the notes are plain files that you can delete on disk). A hosting provider
   has to remove manifestly illegal content when it is notified.
6. **Minors, terms of use, retention.** Decide who may register, publish terms of use if you
   open registration (`ALLOW_SIGNUP=true`), and set a retention period for deleted accounts
   and backups.
7. **AI features.** The optional assistant and the MCP server send page text to the model
   endpoint you configure (`LLM_BASE_URL`). If that is a third-party service, say so in your
   privacy notice and make sure you have a lawful basis for the transfer. Nothing is sent
   when `LLM_BASE_URL` is empty.
8. **Nextcloud synchronization.** Notes synchronized with a Nextcloud server are stored there
   too: that server is part of your processing.

## Reporting

Security problems: see `SECURITY.md`. Legal requests about this repository (copyright,
trademark): open a private security advisory on GitHub or contact the maintainer through the
profile linked from the repository, and the issue will be handled promptly.

---

## En français (résumé)

- Yariche est un projet indépendant : aucun lien avec Notion, Obsidian, AFFiNE ou Nextcloud,
  dont les noms sont des marques de leurs propriétaires, citées pour décrire la compatibilité.
- Ce n'est pas un fork de Notion (code propriétaire) : aucun code, texte, icône ou modèle de
  Notion n'est repris. Les composants viennent de projets libres (Tiptap, Yjs, ProseMirror).
- Le code est sous licence MIT. Les dépendances sont toutes sous licences permissives (liste et
  mentions dans `THIRD_PARTY_NOTICES.md`), sans licence copyleft.
- Si tu héberges Yariche pour d'autres personnes, tu es responsable de traitement au sens du
  RGPD : publie une politique de confidentialité (modèle dans `PRIVACY.md`), garde le cookie de
  session comme seul cookie (exempté de consentement car strictement nécessaire), prévois la
  suppression de compte et l'export des données (disponibles sur `/account`), sécurise le
  serveur, déclare une violation de données à la CNIL sous 72 heures, et retire les contenus
  manifestement illicites signalés (LCEN). Ce texte est une information générale, pas un avis
  juridique.
