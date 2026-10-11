// Connexion par compte local : page de connexion, première installation (/setup),
// inscription facultative, changement de mot de passe et gestion des comptes (admin).
import express from 'express'
import { randomBytes, timingSafeEqual } from 'crypto'
import {
  accountCount,
  createAccount,
  findAccount,
  listAccounts,
  normalizeUsername,
  removeAccount,
  setPassword,
  verifyLogin,
  MIN_PASSWORD,
} from './accounts.js'
import { getSettings, isAdmin, updateSettings } from './settings.js'

const env = process.env
const ALLOW_SIGNUP = /^(1|true|yes)$/i.test(env.ALLOW_SIGNUP || '')
const SETUP_CODE = (env.SETUP_CODE || '').trim()

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a))
  const y = Buffer.from(String(b))
  return x.length === y.length && timingSafeEqual(x, y)
}

// Échecs de connexion : 5 essais par identifiant+adresse puis blocage de 15 minutes
const failures = new Map()
const WINDOW = 15 * 60_000
const MAX_FAILS = 5
// Par adresse : plus large (plusieurs personnes peuvent partager la même, derrière un proxy)
const MAX_FAILS_IP = 40
function blocked(key, max = MAX_FAILS) {
  const entry = failures.get(key)
  if (!entry) return false
  if (Date.now() - entry.since > WINDOW) {
    failures.delete(key)
    return false
  }
  return entry.count >= max
}
function fail(key) {
  const entry = failures.get(key)
  if (!entry || Date.now() - entry.since > WINDOW) failures.set(key, { count: 1, since: Date.now() })
  else entry.count++
}
setInterval(() => {
  for (const [key, entry] of failures) if (Date.now() - entry.since > WINDOW) failures.delete(key)
}, WINDOW).unref()

export function registerLocalAuth(app, { page, esc, ssoName }) {
  const form = express.urlencoded({ extended: false, limit: '4kb' })

  // Une requête POST doit venir de la même origine (en plus du cookie SameSite=Lax)
  const sameOrigin = (req) => {
    const origin = req.get('origin')
    if (!origin) return true
    try {
      return new URL(origin).host === req.get('host')
    } catch {
      return false
    }
  }
  const csrf = (req) => (req.session.csrf ||= randomBytes(16).toString('hex'))
  const csrfOk = (req) => sameOrigin(req) && req.session.csrf && safeEqual(req.body?.csrf || '', req.session.csrf)
  const field = (id, label, type = 'text', extra = '') =>
    `<label for="${id}">${esc(label)}</label><input id="${id}" name="${id}" type="${type}" ${extra} />`
  const err = (msg) => (msg ? `<div class="error">${esc(msg)}</div>` : '')

  const loginPage = (error = '', username = '') =>
    page({
      title: 'Connexion',
      text: 'Connecte-toi pour retrouver tes notes.',
      body: `<form method="post" action="/login">
        ${field('username', 'Identifiant', 'text', `value="${esc(username)}" autocomplete="username" autocapitalize="none" required autofocus`)}
        ${field('password', 'Mot de passe', 'password', 'autocomplete="current-password" required')}
        ${err(error)}
        <button class="sso-btn" type="submit">Se connecter</button>
      </form>
      ${ssoName ? `<div class="sep">ou</div><a class="sso-btn" href="/login/start">Continuer avec ${esc(ssoName)}</a>` : ''}
      ${ALLOW_SIGNUP ? '<p class="foot">Pas de compte ? <a href="/signup">Créer un compte</a></p>' : ''}`,
    })

  const startSession = (req, res, account) =>
    req.session.regenerate(() => {
      req.session.user = { sub: `local-${account.id}`, email: account.username, name: account.name }
      req.session.save(() => res.redirect('/'))
    })

  const setupForm = (error = '', v = {}) =>
    page({
      title: 'Bienvenue',
      text: 'Crée le premier compte : il sera administrateur et pourra ajouter les autres.',
      body: `<form method="post" action="/setup">
        ${SETUP_CODE ? field('code', 'Code d’installation (dans le fichier .env)', 'password', 'autocomplete="off" required') : ''}
        ${field('username', 'Identifiant', 'text', `value="${esc(v.username || '')}" autocomplete="username" autocapitalize="none" required`)}
        ${field('name', 'Nom affiché', 'text', `value="${esc(v.name || '')}" autocomplete="name"`)}
        ${field('password', `Mot de passe (${MIN_PASSWORD} caractères minimum)`, 'password', `autocomplete="new-password" minlength="${MIN_PASSWORD}" required`)}
        ${field('password2', 'Confirmer le mot de passe', 'password', 'autocomplete="new-password" required')}
        ${err(error)}
        <button class="sso-btn" type="submit">Créer le compte administrateur</button>
      </form>`,
    })

  app.get('/login', (req, res) => {
    if (accountCount() === 0 && !ssoName) return res.redirect('/setup')
    if (req.session.user && !req.session.user.guest) return res.redirect('/')
    res.send(loginPage())
  })

  app.post('/login', form, async (req, res) => {
    if (!sameOrigin(req)) return res.status(403).send(page({ title: 'Requête refusée', text: 'Origine inattendue.' }))
    const username = normalizeUsername(req.body?.username)
    const key = `${req.ip}|${username}`
    if (blocked(key) || blocked(`ip|${req.ip}`, MAX_FAILS_IP))
      return res.status(429).send(loginPage('Trop d’échecs. Réessaie dans quelques minutes.', username))
    const account = await verifyLogin(username, req.body?.password)
    if (!account) {
      fail(key)
      fail(`ip|${req.ip}`)
      console.warn(`[auth] échec de connexion locale : ${username || '?'} (${req.ip})`)
      return res.status(401).send(loginPage('Identifiant ou mot de passe incorrect.', username))
    }
    failures.delete(key)
    startSession(req, res, account)
  })

  // Avec un SSO, le serveur a déjà ses comptes : /setup resterait ouvert à n'importe qui
  // tant qu'aucun compte local n'existe. Les comptes locaux se créent alors depuis
  // /admin/users (administrateur connecté) ou en ligne de commande.
  app.get('/setup', (req, res) => {
    if (ssoName || accountCount() > 0) return res.redirect('/login')
    res.send(setupForm())
  })
  app.post('/setup', form, async (req, res) => {
    if (ssoName || accountCount() > 0) return res.redirect('/login')
    if (!sameOrigin(req)) return res.status(403).send(page({ title: 'Requête refusée', text: 'Origine inattendue.' }))
    const v = { username: normalizeUsername(req.body?.username), name: String(req.body?.name || '') }
    if (SETUP_CODE && !safeEqual(String(req.body?.code || '').trim(), SETUP_CODE))
      return res.status(403).send(setupForm('Code d’installation incorrect.', v))
    if (req.body?.password !== req.body?.password2)
      return res.status(400).send(setupForm('Les deux mots de passe sont différents.', v))
    try {
      const account = await createAccount({ ...v, password: String(req.body?.password || '') })
      if (!getSettings().firstUser) updateSettings({ firstUser: account.username })
      console.log(`[auth] premier compte créé : ${account.username} (administrateur)`)
      startSession(req, res, account)
    } catch (e) {
      res.status(400).send(setupForm(e.message, v))
    }
  })

  if (ALLOW_SIGNUP) {
    const signupForm = (error = '', v = {}) =>
      page({
        title: 'Créer un compte',
        text: 'Choisis un identifiant et un mot de passe.',
        body: `<form method="post" action="/signup">
          ${field('username', 'Identifiant', 'text', `value="${esc(v.username || '')}" autocomplete="username" autocapitalize="none" required`)}
          ${field('name', 'Nom affiché', 'text', `value="${esc(v.name || '')}" autocomplete="name"`)}
          ${field('password', `Mot de passe (${MIN_PASSWORD} caractères minimum)`, 'password', `autocomplete="new-password" minlength="${MIN_PASSWORD}" required`)}
          ${field('password2', 'Confirmer le mot de passe', 'password', 'autocomplete="new-password" required')}
          ${err(error)}
          <button class="sso-btn" type="submit">Créer mon compte</button>
        </form><p class="foot"><a href="/login">Retour à la connexion</a></p>`,
      })
    app.get('/signup', (req, res) => (accountCount() === 0 && !ssoName ? res.redirect('/setup') : res.send(signupForm())))
    app.post('/signup', form, async (req, res) => {
      if (accountCount() === 0 && !ssoName) return res.redirect('/setup')
      if (!sameOrigin(req)) return res.status(403).send(page({ title: 'Requête refusée', text: 'Origine inattendue.' }))
      const v = { username: normalizeUsername(req.body?.username), name: String(req.body?.name || '') }
      if (req.body?.password !== req.body?.password2)
        return res.status(400).send(signupForm('Les deux mots de passe sont différents.', v))
      try {
        startSession(req, res, await createAccount({ ...v, password: String(req.body?.password || '') }))
      } catch (e) {
        res.status(400).send(signupForm(e.message, v))
      }
    })
  }

  // --- Pages réservées aux comptes connectés -----------------------------------------
  const needUser = (req, res, next) =>
    req.session.user && !req.session.user.guest ? next() : res.redirect('/login')
  const needAdmin = (req, res, next) =>
    isAdmin(req.session.user?.email, false) ? next() : res.status(403).send(page({ title: 'Accès refusé', text: 'Réservé aux administrateurs.', body: '<a class="sso-btn" href="/">Retour</a>' }))

  const accountPage = (req, msg = '', error = '') =>
    page({
      title: 'Mon compte',
      text: `Connecté en tant que ${req.session.user.name} (${req.session.user.email}).`,
      body: `<form method="post" action="/account/password">
        <input type="hidden" name="csrf" value="${csrf(req)}" />
        ${field('current', 'Mot de passe actuel', 'password', 'autocomplete="current-password" required')}
        ${field('password', `Nouveau mot de passe (${MIN_PASSWORD} caractères minimum)`, 'password', `autocomplete="new-password" minlength="${MIN_PASSWORD}" required`)}
        ${field('password2', 'Confirmer le nouveau mot de passe', 'password', 'autocomplete="new-password" required')}
        ${err(error)}${msg ? `<div class="ok">${esc(msg)}</div>` : ''}
        <button class="sso-btn" type="submit">Changer le mot de passe</button>
      </form>
      <p class="foot"><a href="/">Retour aux notes</a>${isAdmin(req.session.user.email, false) ? ' · <a href="/admin/users">Gérer les comptes</a>' : ''}</p>`,
    })
  app.get('/account', needUser, (req, res) => res.send(accountPage(req)))
  app.post('/account/password', needUser, form, async (req, res) => {
    if (!csrfOk(req)) return res.status(403).send(accountPage(req, '', 'Session expirée, réessaie.'))
    const account = findAccount(req.session.user.email)
    if (!account) return res.status(400).send(accountPage(req, '', 'Ce compte n’utilise pas de mot de passe local.'))
    if (req.body.password !== req.body.password2) return res.status(400).send(accountPage(req, '', 'Les deux mots de passe sont différents.'))
    if (!(await verifyLogin(account.username, String(req.body.current || ''))))
      return res.status(401).send(accountPage(req, '', 'Mot de passe actuel incorrect.'))
    try {
      await setPassword(account.username, String(req.body.password))
      res.send(accountPage(req, 'Mot de passe changé.'))
    } catch (e) {
      res.status(400).send(accountPage(req, '', e.message))
    }
  })

  const usersPage = (req, msg = '', error = '') => {
    const me = req.session.user.email
    const rows = listAccounts()
      .map(
        (u) => `<tr><td>${esc(u.username)}${u.username === me ? ' (toi)' : ''}<br /><small>${esc(u.name)}</small></td>
        <td class="actions">
          <form method="post" action="/admin/users/password" class="inline">
            <input type="hidden" name="csrf" value="${csrf(req)}" /><input type="hidden" name="username" value="${esc(u.username)}" />
            <input name="password" type="password" placeholder="Nouveau mot de passe" minlength="${MIN_PASSWORD}" autocomplete="new-password" required />
            <button type="submit" class="mini">Changer</button>
          </form>
          ${u.username === me ? '' : `<form method="post" action="/admin/users/delete" class="inline" onsubmit="return confirm('Supprimer ce compte ? Ses notes restent dans le coffre.')">
            <input type="hidden" name="csrf" value="${csrf(req)}" /><input type="hidden" name="username" value="${esc(u.username)}" />
            <button type="submit" class="mini danger">Supprimer</button></form>`}
        </td></tr>`
      )
      .join('')
    return page({
      title: 'Comptes',
      text: 'Ajoute, supprime ou réinitialise le mot de passe des comptes locaux.',
      wide: true,
      body: `${err(error)}${msg ? `<div class="ok">${esc(msg)}</div>` : ''}
      <table>${rows}</table>
      <form method="post" action="/admin/users/create" class="add">
        <input type="hidden" name="csrf" value="${csrf(req)}" />
        <h2>Nouveau compte</h2>
        ${field('username', 'Identifiant', 'text', 'autocomplete="off" autocapitalize="none" required')}
        ${field('name', 'Nom affiché', 'text', 'autocomplete="off"')}
        ${field('password', `Mot de passe provisoire (${MIN_PASSWORD} caractères minimum)`, 'password', `autocomplete="new-password" minlength="${MIN_PASSWORD}" required`)}
        <button class="sso-btn" type="submit">Créer le compte</button>
      </form>
      <p class="foot"><a href="/">Retour aux notes</a> · <a href="/account">Mon compte</a></p>`,
    })
  }
  app.get('/admin/users', needUser, needAdmin, (req, res) => res.send(usersPage(req)))
  app.post('/admin/users/create', needUser, needAdmin, form, async (req, res) => {
    if (!csrfOk(req)) return res.status(403).send(usersPage(req, '', 'Session expirée, réessaie.'))
    try {
      const u = await createAccount({ username: req.body.username, name: req.body.name, password: String(req.body.password || '') })
      res.send(usersPage(req, `Compte « ${u.username} » créé.`))
    } catch (e) {
      res.status(400).send(usersPage(req, '', e.message))
    }
  })
  app.post('/admin/users/password', needUser, needAdmin, form, async (req, res) => {
    if (!csrfOk(req)) return res.status(403).send(usersPage(req, '', 'Session expirée, réessaie.'))
    try {
      await setPassword(req.body.username, String(req.body.password || ''))
      res.send(usersPage(req, 'Mot de passe changé.'))
    } catch (e) {
      res.status(400).send(usersPage(req, '', e.message))
    }
  })
  app.post('/admin/users/delete', needUser, needAdmin, form, (req, res) => {
    if (!csrfOk(req)) return res.status(403).send(usersPage(req, '', 'Session expirée, réessaie.'))
    const target = normalizeUsername(req.body.username)
    if (target === req.session.user.email) return res.status(400).send(usersPage(req, '', 'Tu ne peux pas supprimer ton propre compte.'))
    const removed = removeAccount(target)
    res.send(usersPage(req, removed ? 'Compte supprimé.' : '', removed ? '' : 'Compte introuvable.'))
  })
}
