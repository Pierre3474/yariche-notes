// Comptes locaux : installation, connexion, blocage, gestion des comptes, données personnelles.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startServer } from './helpers.js'

let y
let base
const PASS = 'un-mot-de-passe-long'

// Client minimal avec cookie, sans suivre les redirections
function client() {
  let cookie = ''
  const call = async (path, { method = 'GET', form, headers = {} } = {}) => {
    const res = await fetch(`${base}${path}`, {
      method,
      redirect: 'manual',
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
        ...headers,
      },
      body: form ? new URLSearchParams(form).toString() : undefined,
    })
    const set = res.headers.getSetCookie?.() || []
    if (set.length) cookie = set.map((c) => c.split(';')[0]).join('; ')
    return res
  }
  return call
}
const csrfOf = async (res) => (await res.text()).match(/name="csrf" value="([a-f0-9]+)"/)?.[1]

before(async () => {
  y = await startServer({ AUTH_MODE: 'local', SETUP_CODE: 'code-test', SESSION_SECRET: 'test', YARICHE_STORAGE: 'local' })
  base = y.base
})
after(() => y.stop())

test('sans connexion : redirection vers /setup puis /login', async () => {
  const c = client()
  assert.equal((await c('/')).headers.get('location'), '/login')
  assert.equal((await c('/login')).headers.get('location'), '/setup')
  assert.equal((await c('/api/me')).status, 401)
})

test('le premier compte demande le code, un mot de passe assez long, et devient administrateur', async () => {
  const c = client()
  const bad = await c('/setup', { method: 'POST', form: { code: 'faux', username: 'alice', password: PASS, password2: PASS } })
  assert.equal(bad.status, 403)
  const short = await c('/setup', { method: 'POST', form: { code: 'code-test', username: 'alice', password: 'court', password2: 'court' } })
  assert.equal(short.status, 400)
  const ok = await c('/setup', { method: 'POST', form: { code: 'code-test', username: 'Alice', name: 'Alice', password: PASS, password2: PASS } })
  assert.equal(ok.status, 302)
  const me = await (await c('/api/me')).json()
  assert.equal(me.email, 'alice')
  assert.equal(me.admin, true)
  assert.equal(me.auth, 'local')
  // /setup se referme une fois le premier compte créé
  assert.equal((await client()('/setup')).headers.get('location'), '/login')
})

test('connexion : mauvais mot de passe refusé, bon mot de passe accepté, requête d’une autre origine refusée', async () => {
  const wrong = await client()('/login', { method: 'POST', form: { username: 'alice', password: 'nope-nope-nope' } })
  assert.equal(wrong.status, 401)
  const foreign = await client()('/login', { method: 'POST', form: { username: 'alice', password: PASS }, headers: { origin: 'http://evil.example' } })
  assert.equal(foreign.status, 403)
  const c = client()
  assert.equal((await c('/login', { method: 'POST', form: { username: 'alice', password: PASS } })).status, 302)
  assert.equal((await c('/api/me')).status, 200)
  await c('/logout')
  assert.equal((await c('/api/me')).status, 401)
})

test('le mot de passe n’est jamais stocké en clair', async () => {
  const fs = await import('node:fs')
  const path = await import('node:path')
  const raw = fs.readFileSync(path.join(y.dataDir, 'accounts.json'), 'utf8')
  assert.ok(raw.includes('scrypt$'))
  assert.ok(!raw.includes(PASS))
})

test('un administrateur crée un compte ; sans jeton CSRF la demande est refusée ; un membre n’a pas accès à l’administration', async () => {
  const admin = client()
  await admin('/login', { method: 'POST', form: { username: 'alice', password: PASS } })
  const token = await csrfOf(await admin('/admin/users'))
  assert.ok(token)
  const noCsrf = await admin('/admin/users/create', { method: 'POST', form: { username: 'bob', password: PASS } })
  assert.equal(noCsrf.status, 403)
  const created = await admin('/admin/users/create', { method: 'POST', form: { csrf: token, username: 'bob', name: 'Bob', password: PASS } })
  assert.equal(created.status, 200)

  const bob = client()
  assert.equal((await bob('/login', { method: 'POST', form: { username: 'bob', password: PASS } })).status, 302)
  assert.equal((await bob('/admin/users')).status, 403)
  assert.equal((await (await bob('/api/me')).json()).admin, false)
})

test('l’inscription libre est fermée par défaut', async () => {
  const res = await client()('/signup')
  assert.equal(res.status, 302)
  assert.equal(res.headers.get('location'), '/login')
})

test('un membre exporte ses données puis supprime son compte avec son mot de passe', async () => {
  const bob = client()
  await bob('/login', { method: 'POST', form: { username: 'bob', password: PASS } })
  const exported = await (await bob('/account/export')).json()
  assert.equal(exported.account.username, 'bob')
  assert.ok(!JSON.stringify(exported).includes('hash'))

  const token = await csrfOf(await bob('/account'))
  const wrong = await bob('/account/delete', { method: 'POST', form: { csrf: token, confirm: 'pas-le-bon-mot-de-passe' } })
  assert.equal(wrong.status, 401)
  const done = await bob('/account/delete', { method: 'POST', form: { csrf: token, confirm: PASS } })
  assert.equal(done.status, 302)
  const again = await client()('/login', { method: 'POST', form: { username: 'bob', password: PASS } })
  assert.equal(again.status, 401)
})

test('après 5 échecs sur un identifiant, même le bon mot de passe est refusé un moment', async () => {
  for (let i = 0; i < 5; i++) await client()('/login', { method: 'POST', form: { username: 'alice', password: `mauvais-${i}-mauvais` } })
  const res = await client()('/login', { method: 'POST', form: { username: 'alice', password: PASS } })
  assert.equal(res.status, 429)
})
