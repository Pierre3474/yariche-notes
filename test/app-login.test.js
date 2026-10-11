// Connexion de l'app Mac : le navigateur par défaut (où WebAuthn marche) rend un code à
// usage unique par un lien yariche://, que l'app échange contre la session avec son secret.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { startServer, browser } from './helpers.js'
import { startIdp } from './oidc-idp.js'

const OWNER = 'pierre@example.com'
let idp
let yariche

before(async () => {
  idp = await startIdp()
  yariche = await startServer((base) => ({
    OIDC_ISSUER: idp.url,
    OIDC_CLIENT_ID: 'yariche',
    OIDC_CLIENT_SECRET: 'secret',
    OIDC_REDIRECT_URI: `${base}/auth/callback`,
    ALLOWED_EMAILS: OWNER,
    ACCOUNT_ALIASES: 'alice.admin=pierre@example.com',
    SESSION_SECRET: 'test-secret',
    YARICHE_STORAGE: 'local',
  }))
})

after(() => {
  yariche?.stop()
  idp?.close()
})

const pkce = () => {
  const verifier = crypto.randomBytes(32).toString('base64url')
  return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') }
}

// Parcours dans le navigateur : SSO puis page qui renvoie vers yariche://auth?code=…
async function sheetLogin(challenge, who = OWNER) {
  idp.setNextLogin(who)
  const sheet = browser(yariche.base)
  const r = await sheet.request(`/login/app?challenge=${challenge}`)
  const code = r.status === 200 ? r.text.match(/href="yariche:\/\/auth\?code=([\w-]+)"/)?.[1] || null : null
  return { sheet, r, code }
}

const exchange = (b, code, verifier) =>
  b.request('/login/app/exchange', { method: 'POST', form: { code, verifier }, follow: false })

test('le navigateur rend un code à l’app, pas une session', async () => {
  const { verifier, challenge } = pkce()
  const { sheet, r: page, code } = await sheetLogin(challenge)
  assert.ok(code, 'lien yariche://auth?code=…')
  assert.match(page.text, /http-equiv="refresh" content="0;url=yariche:\/\/auth\?code=/)
  assert.equal((await sheet.request('/api/me')).status, 401)

  const app = browser(yariche.base)
  const r = await exchange(app, code, verifier)
  assert.equal(r.status, 302)
  assert.equal(r.location, '/')
  assert.equal((await app.request('/api/me')).json.email, OWNER)
})

test('code intercepté : inutile sans le secret de l’app, et grillé après un essai', async () => {
  const { verifier, challenge } = pkce()
  const { code } = await sheetLogin(challenge)
  const thief = browser(yariche.base)
  assert.equal((await exchange(thief, code, pkce().verifier)).status, 401)
  assert.equal((await thief.request('/api/me')).status, 401)
  // Même l'app ne peut plus s'en servir : usage unique
  assert.equal((await exchange(browser(yariche.base), code, verifier)).status, 401)
})

test('code à usage unique, demandes invalides refusées', async () => {
  const { verifier, challenge } = pkce()
  const { code } = await sheetLogin(challenge)
  assert.equal((await exchange(browser(yariche.base), code, verifier)).status, 302)
  assert.equal((await exchange(browser(yariche.base), code, verifier)).status, 401)
  assert.equal((await exchange(browser(yariche.base), 'inconnu', verifier)).status, 401)
  assert.equal((await browser(yariche.base).request('/login/app?challenge=court', { follow: false })).status, 400)
})

test('compte non autorisé : pas de code', async () => {
  const { challenge } = pkce()
  const { r, code } = await sheetLogin(challenge, 'autre@example.com')
  assert.equal(r.status, 403)
  assert.equal(code, null)
})

test('second compte déclaré en alias : connecté comme le compte principal', async () => {
  idp.setNextLogin('compte:alice.admin')
  const b = browser(yariche.base)
  await b.request('/login/start')
  assert.equal((await b.request('/api/me')).json.email, OWNER)
  // par l'app aussi
  const { verifier, challenge } = pkce()
  const { code } = await sheetLogin(challenge, 'compte:alice.admin')
  const app = browser(yariche.base)
  assert.equal((await exchange(app, code, verifier)).status, 302)
  assert.equal((await app.request('/api/me')).json.email, OWNER)
  // un compte sans alias reste dehors
  idp.setNextLogin('compte:intrus')
  assert.equal((await browser(yariche.base).request('/login/start')).status, 403)
})

test('connexion web classique inchangée', async () => {
  idp.setNextLogin(OWNER)
  const b = browser(yariche.base)
  await b.request('/login/start')
  assert.equal((await b.request('/api/me')).json.email, OWNER)
})
