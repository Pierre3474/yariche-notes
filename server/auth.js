import session from 'express-session'
import FileStoreFactory from 'session-file-store'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import { createHash, randomBytes, timingSafeEqual } from 'crypto'
import express from 'express'
import { Issuer, generators } from 'openid-client'
import { registerLocalAuth } from './local-auth.js'

const FileStore = FileStoreFactory(session)
const env = process.env

// Connexion SSO par OpenID Connect : Authentik, Keycloak, Authelia, Zitadel, Google…
// (les anciennes variables AUTHENTIK_* restent acceptées)
const OIDC_ISSUER = env.OIDC_ISSUER || env.AUTHENTIK_ISSUER // ex. https://auth.exemple.fr/application/o/yariche/
const OIDC_CLIENT_ID = env.OIDC_CLIENT_ID || env.AUTHENTIK_CLIENT_ID
const OIDC_CLIENT_SECRET = env.OIDC_CLIENT_SECRET || env.AUTHENTIK_CLIENT_SECRET
const OIDC_REDIRECT_URI = env.OIDC_REDIRECT_URI || env.AUTHENTIK_REDIRECT_URI // ex. https://notes.exemple.fr/auth/callback
const OIDC_PROVIDER_NAME = env.OIDC_PROVIDER_NAME || (env.AUTHENTIK_ISSUER ? 'Authentik' : 'SSO')
const SESSION_SECRET = env.SESSION_SECRET
// Qui peut se connecter : emails ou identifiants SSO, séparés par des virgules ; vide =
// tout compte du SSO. Les autres travaillent par liens de partage (invités), sans compte.
const ALLOWED_EMAILS = (env.ALLOWED_EMAILS || '')
  .split(',')
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean)
// Plusieurs comptes SSO pour une même personne (ex. son compte d'administration) :
// « ACCOUNT_ALIASES=alice.admin=alice » → alice.admin est connecté comme
// alice (mêmes pages, mêmes droits). Paires séparées par des virgules.
const ACCOUNT_ALIASES = new Map(
  (env.ACCOUNT_ALIASES || '')
    .split(',')
    .map((pair) => pair.split('=').map((s) => s.trim().toLowerCase()))
    .filter(([from, to]) => from && to)
)
export const DEV_USER_EMAIL = env.DEV_USER_EMAIL || 'dev@local'

// Mode de connexion : AUTH_MODE=local (comptes de Yariche), oidc (SSO), both, ou none (aucune
// connexion : usage local sur sa propre machine). Sans AUTH_MODE : SSO si OIDC_* est renseigné
// (LOCAL_LOGIN=1 ajoute les comptes locaux), sinon aucune connexion, comme avant.
const AUTH_MODE = (env.AUTH_MODE || '').toLowerCase()
const OIDC_CONFIGURED = !!(OIDC_ISSUER && OIDC_CLIENT_ID && OIDC_CLIENT_SECRET)
const OIDC_ON = OIDC_CONFIGURED && AUTH_MODE !== 'local' && AUTH_MODE !== 'none'
export const LOCAL_LOGIN = AUTH_MODE !== 'none' && (AUTH_MODE === 'local' || AUTH_MODE === 'both' || /^(1|true|yes)$/i.test(env.LOCAL_LOGIN || ''))
const DEV_MODE = !OIDC_ON && !LOCAL_LOGIN
// Sans SSO, tout le monde est connecté sous cet utilisateur : réservé à un usage local
const DEV_USER = {
  sub: 'dev',
  email: DEV_USER_EMAIL,
  name: env.DEV_USER_NAME || 'Dev Local',
}

if (DEV_MODE) {
  console.warn(
    `[auth] aucune connexion configurée (AUTH_MODE=local pour des comptes, ou OIDC_*) : pas de connexion, tout le monde est ${DEV_USER.email}. ` +
      'À réserver à un usage local (voir README).'
  )
} else if (!SESSION_SECRET) {
  console.warn('[auth] SESSION_SECRET absent : les sessions ne sont pas protégées. Définis-le dans .env.')
}

// Sessions persistées sur disque (survivent aux redémarrages du conteneur),
// évite le MemoryStore et la déconnexion de tout le monde à chaque déploiement.
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.resolve(env.DATA_DIR || path.join(__dirname, '..', 'data'))
const sessionsDir = path.join(DATA_DIR, '.sessions')
fs.mkdirSync(sessionsDir, { recursive: true })

const baseSession = session({
  store: new FileStore({ path: sessionsDir, ttl: 60 * 60 * 24 * 30, logFn: () => {} }),
  secret: SESSION_SECRET || 'dev-secret-a-changer-en-prod',
  resave: false,
  saveUninitialized: false,
  // « auto » : cookie réservé à HTTPS quand la requête arrive en HTTPS (TRUST_PROXY
  // derrière un reverse proxy), utilisable en HTTP sur le réseau local
  cookie: { httpOnly: true, sameSite: 'lax', secure: 'auto', maxAge: 1000 * 60 * 60 * 24 * 30 },
})

// Déconnexion fiable : le magasin de sessions sur fichier peut réécrire une session que
// vient de supprimer une requête simultanée (le « touch » d'une autre requête relit puis
// réécrit le fichier). Les identifiants de session déconnectés sont donc refusés, même si
// leur fichier réapparaît.
const revokedSessions = new Map()
const REVOKED_TTL = 60 * 60_000
export function revokeSession(req) {
  const now = Date.now()
  for (const [sid, exp] of revokedSessions) if (exp <= now) revokedSessions.delete(sid)
  if (req.sessionID) revokedSessions.set(req.sessionID, now + REVOKED_TTL)
}
export const sessionMiddleware = (req, res, next) =>
  baseSession(req, res, (err) => {
    if (!err && req.sessionID && revokedSessions.has(req.sessionID)) {
      req.session.user = undefined
      req.session.guest = undefined
    }
    next(err)
  })

let oidcClient = null

export async function initAuth() {
  if (!OIDC_ON) return
  const issuer = await Issuer.discover(OIDC_ISSUER)
  oidcClient = new issuer.Client({
    client_id: OIDC_CLIENT_ID,
    client_secret: OIDC_CLIENT_SECRET,
    redirect_uris: [OIDC_REDIRECT_URI],
    response_types: ['code'],
  })
  console.log(`[auth] OIDC prêt (${OIDC_PROVIDER_NAME}) : ${OIDC_ISSUER}`)
}

export function registerAuthRoutes(app) {
  if (DEV_MODE) {
    // Sans SSO : utilisateur unique (usage local). Pas d'écran de connexion : les
    // adresses de connexion/déconnexion ramènent à l'app au lieu d'une page 404.
    app.get(['/login', '/login/start', '/login/app', '/logout', '/auth/callback'], (req, res) => res.redirect('/'))
    app.use((req, res, next) => {
      if (!req.session.user) req.session.user = { ...DEV_USER }
      next()
    })
    return
  }

  // Comptes locaux : /login (formulaire), /setup (premier compte), /account, /admin/users
  if (LOCAL_LOGIN) registerLocalAuth(app, { page: loginPageHtml, esc: escapeHtml, revoke: revokeSession, ssoName: OIDC_ON ? OIDC_PROVIDER_NAME : null })
  else app.get('/login', (req, res) => res.send(loginPageHtml()))
  if (!OIDC_ON) {
    app.get(['/login/start', '/login/app', '/auth/callback'], (req, res) => res.redirect('/login'))
    app.get('/logout', (req, res) => {
      revokeSession(req)
      req.session.destroy(() => res.redirect('/login'))
    })
    return
  }

  const startLogin = (req, res) => {
    const code_verifier = generators.codeVerifier()
    const code_challenge = generators.codeChallenge(code_verifier)
    const state = generators.state()
    req.session.oidc = { code_verifier, state }
    const url = oidcClient.authorizationUrl({
      scope: 'openid profile email',
      code_challenge,
      code_challenge_method: 'S256',
      state,
    })
    req.session.save(() => res.redirect(url))
  }
  app.get('/login/start', (req, res) => {
    delete req.session.appLogin
    startLogin(req, res)
  })

  // Connexion depuis l'app Mac. Sa vue web (WKWebView) n'a pas droit à WebAuthn (clés de
  // sécurité, passkeys : Apple le réserve aux navigateurs) : l'app ouvre donc la connexion
  // dans le navigateur par défaut, qui rend à l'app un code à usage unique par un lien
  // yariche://, échangé ensuite dans sa vue web contre la session.
  // Le code ne sert qu'avec le secret (« verifier ») gardé par l'app, dont elle a envoyé
  // l'empreinte au départ (même principe que PKCE) : intercepté seul (une autre app qui
  // revendiquerait yariche://), il est inutile.
  app.get('/login/app', (req, res) => {
    const challenge = String(req.query.challenge || '')
    if (!/^[A-Za-z0-9_-]{43}$/.test(challenge)) return res.status(400).send(messagePage('Connexion impossible', 'Demande de connexion invalide.'))
    req.session.appLogin = { challenge }
    startLogin(req, res)
  })

  app.post('/login/app/exchange', express.urlencoded({ extended: false, limit: '1kb' }), (req, res) => {
    const code = String(req.body?.code || '')
    const verifier = String(req.body?.verifier || '')
    const entry = appLoginCodes.get(code)
    appLoginCodes.delete(code) // usage unique, même en cas d'échec
    const valid =
      entry &&
      entry.exp > Date.now() &&
      /^[A-Za-z0-9_-]{43,128}$/.test(verifier) &&
      safeEqual(createHash('sha256').update(verifier).digest('base64url'), entry.challenge)
    if (!valid) {
      return res.status(401).send(messagePage('Connexion expirée', 'La connexion n’a pas abouti à temps. Réessaie depuis la page de connexion.', '<a class="sso-btn" href="/login">Réessayer</a>'))
    }
    // Nouvelle session (pas celle, éventuelle, d'avant la connexion)
    req.session.regenerate(() => {
      req.session.user = entry.user
      req.session.save(() => res.redirect('/'))
    })
  })

  app.get('/auth/callback', async (req, res) => {
    try {
      const params = oidcClient.callbackParams(req)
      const { code_verifier, state } = req.session.oidc || {}
      const tokenSet = await oidcClient.callback(OIDC_REDIRECT_URI, params, {
        code_verifier,
        state,
      })
      const userinfo = await oidcClient.userinfo(tokenSet.access_token)
      delete req.session.oidc
      const email = String(userinfo.email || '').trim().toLowerCase()
      const username = String(userinfo.preferred_username || '').trim().toLowerCase()
      // Identité stable : celle de la liste qui correspond (identifiant ou email, après
      // alias), sinon l'email, sinon l'identifiant (compte SSO sans email)
      const alias = (id) => (id && ACCOUNT_ALIASES.get(id)) || id
      const identity = ALLOWED_EMAILS.length
        ? [username, email].map(alias).find((id) => id && ALLOWED_EMAILS.includes(id))
        : ACCOUNT_ALIASES.get(username) || alias(email || username)
      if (identity && identity !== email && identity !== username) {
        console.log(`[auth] ${username || email} connecté comme ${identity} (ACCOUNT_ALIASES)`)
      }
      if (!identity) {
        const who = email || username || 'inconnu'
        console.warn(`[auth] connexion refusée (pas dans ALLOWED_EMAILS) : ${who}`)
        return res.status(403).send(messagePage('Accès réservé', `Ce Yariche est privé : le compte ${who} n’y a pas accès. Pour travailler sur un document, demande un lien de partage.`))
      }
      const user = {
        sub: userinfo.sub,
        email: identity,
        name: userinfo.name || userinfo.preferred_username || identity,
      }
      // Connexion demandée par l'app Mac : code à usage unique rendu à l'app (la session
      // se crée dans sa vue web, pas dans ce navigateur). Page plutôt que redirection : le
      // navigateur demande d'ouvrir Yariche, et le bouton reste là si on a refusé.
      const appLogin = req.session.appLogin
      if (appLogin) {
        const target = `yariche://auth?code=${issueAppLoginCode(user, appLogin.challenge)}`
        return req.session.destroy(() =>
          res.send(
            loginPageHtml({
              title: 'Connexion réussie',
              text: 'Retourne dans Yariche : ton navigateur propose de l’ouvrir. Tu pourras ensuite fermer cet onglet.',
              body: `<a class="sso-btn" href="${escapeHtml(target)}">Ouvrir Yariche</a>`,
              head: `<meta http-equiv="refresh" content="0;url=${escapeHtml(target)}" />`,
            })
          )
        )
      }
      // Nouvelle session à la connexion (pas celle d'avant, qu'un tiers aurait pu imposer),
      // écrite AVANT la redirection : sinon le navigateur, qui la suit aussitôt, arrive sans
      // session et retombe sur la page de connexion
      req.session.regenerate(() => {
        req.session.user = user
        req.session.save(() => res.redirect('/'))
      })
    } catch (err) {
      // Jeton sans les scopes demandés : le fournisseur n'expose pas openid/profile/email
      // (ex. application Authentik créée sans « scope mappings »)
      const hint = /insufficient_scope/.test(err.message)
        ? ' — le fournisseur SSO doit accorder les scopes openid, profile et email à cette application'
        : ''
      console.error('[auth] echec callback OIDC:', err.message + hint)
      res.status(401).send(messagePage('Connexion impossible', 'La connexion a échoué. Réessaie depuis la page d’accueil.'))
    }
  })

  app.get('/logout', (req, res) => {
    revokeSession(req)
    req.session.destroy(() => res.redirect('/'))
  })
}

// Codes de connexion de l'app Mac : 2 minutes, usage unique, en mémoire
const appLoginCodes = new Map()
function issueAppLoginCode(user, challenge) {
  const now = Date.now()
  for (const [code, entry] of appLoginCodes) if (entry.exp <= now) appLoginCodes.delete(code)
  const code = randomBytes(32).toString('base64url')
  appLoginCodes.set(code, { user, challenge, exp: now + 2 * 60_000 })
  return code
}
function safeEqual(a, b) {
  const x = Buffer.from(String(a))
  const y = Buffer.from(String(b))
  return x.length === y.length && timingSafeEqual(x, y)
}

export const escapeHtml = (v) =>
  String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

// Page simple au style de la page de connexion (logo, titre, texte, contenu libre)
export function messagePage(title, text, extraHtml = '') {
  return loginPageHtml({ title, text, body: extraHtml })
}

function loginPageHtml({ title = null, text = null, body = null, head = '', wide = false } = {}) {
  return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(title || 'Connexion')} · Yariche</title>
  <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
  <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
  ${head}
  <style>
    :root { --bg: #ffffff; --card: #ffffff; --text: #1f1f1f; --text-light: #7a7a7e; --border: #e6e6e8; --hover: #f4f4f5; }
    @media (prefers-color-scheme: dark) {
      :root { --bg: #191919; --card: #202020; --text: #ececec; --text-light: #9c9ca0; --border: #2e2e2e; --hover: #2a2a2a; }
    }
    * { box-sizing: border-box; }
    html, body {
      height: 100%; margin: 0; background: var(--bg); color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
      display: flex; align-items: center; justify-content: center;
    }
    .card {
      width: 360px; max-width: calc(100vw - 32px); text-align: center;
      padding: 40px 32px 32px; background: var(--card); border: 1px solid var(--border); border-radius: 16px;
      box-shadow: 0 12px 32px rgba(0,0,0,0.06);
    }
    .logo { width: 64px; height: 64px; margin: 0 auto 18px; display: block; border-radius: 15px; }
    h1 { font-size: 22px; margin: 0 0 6px; letter-spacing: -0.01em; }
    p { color: var(--text-light); font-size: 14px; margin: 0 0 28px; line-height: 1.5; }
    .sso-btn {
      display: flex; align-items: center; justify-content: center; gap: 10px;
      width: 100%; padding: 11px 16px; border-radius: 9px; border: 1px solid var(--border);
      background: var(--card); color: var(--text); font-size: 14px; font-weight: 600;
      cursor: pointer; text-decoration: none;
    }
    .sso-btn:hover { background: var(--hover); }
    form { display: flex; flex-direction: column; gap: 10px; text-align: left; }
    label { font-size: 12px; color: var(--text-light); }
    input { height: 40px; padding: 0 12px; font-size: 15px; border-radius: 9px; border: 1px solid var(--border);
      background: var(--bg); color: var(--text); }
    button.sso-btn { background: #1e96eb; border-color: #1e96eb; color: #fff; }
    .error { color: #e5484d; font-size: 13px; }
    .ok { color: #2f9e6a; font-size: 13px; }
    .sep { color: var(--text-light); font-size: 12px; margin: 14px 0; }
    .foot { margin: 18px 0 0; font-size: 13px; }
    a { color: #1e96eb; }
    .card.wide { width: 640px; }
    table { width: 100%; border-collapse: collapse; text-align: left; margin-bottom: 8px; }
    td { padding: 10px 0; border-bottom: 1px solid var(--border); font-size: 14px; vertical-align: middle; }
    td small { color: var(--text-light); }
    td.actions { text-align: right; }
    form.inline { display: inline-flex; gap: 6px; flex-direction: row; align-items: center; margin-left: 6px; }
    form.inline input { height: 32px; width: 150px; font-size: 13px; }
    .mini { height: 32px; padding: 0 10px; border-radius: 8px; border: 1px solid var(--border); background: var(--card); color: var(--text); cursor: pointer; font-size: 13px; }
    .mini.danger { color: #e5484d; }
    .wide-btn { width: 100%; height: 40px; }
    h2.sub { font-size: 15px; margin: 26px 0 6px; text-align: left; }
    .hint { font-size: 13px; text-align: left; margin: 0 0 12px; }
    form.add { margin-top: 20px; } form.add h2 { font-size: 15px; margin: 0 0 4px; }
  </style>
</head>
<body>
  <div class="card${wide ? ' wide' : ''}">
    <img class="logo" src="/logo.svg" alt="" />
    <h1>${escapeHtml(title || 'Yariche')}</h1>
    <p>${title ? escapeHtml(text || '') : 'Notes Markdown collaboratives,<br />rangées comme un coffre Obsidian.'}</p>
    ${body ?? (title ? '' : `<a class="sso-btn" href="/login/start">Continuer avec ${escapeHtml(OIDC_PROVIDER_NAME)}</a>`)}
  </div>
</body>
</html>`
}

export function requireAuth(req, res, next) {
  if (req.session.user) return next()
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'non authentifie' })
  return res.redirect('/login')
}

export const isDevMode = DEV_MODE
export const authKind = DEV_MODE ? 'none' : LOCAL_LOGIN && OIDC_ON ? 'both' : LOCAL_LOGIN ? 'local' : 'oidc'
// Connexion limitée à quelques comptes (les autres passent par des liens d'invité)
export const loginRestricted = ALLOWED_EMAILS.length > 0

// Utilise pour valider la session au moment de l'upgrade WebSocket
// (express-session n'est pas applique automatiquement sur les requetes 'upgrade').
// Session complète (utilisateur ou invité) au moment de l'upgrade WebSocket
export function runSessionMiddleware(req) {
  return new Promise((resolve) => {
    sessionMiddleware(req, {}, () => resolve(req.session?.user ? req.session : null))
  })
}
