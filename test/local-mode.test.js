// Mode local de l'app Mac : un seul coffre dans un dossier donné (celui de Nextcloud sur le
// Mac), données internes hors de ce dossier, serveur ouvert seulement avec le secret de l'app.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import WebSocket from 'ws'
import { startServer, browser, doc } from './helpers.js'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yariche-local-'))
const vaultDir = path.join(root, 'Nextcloud', 'Cours')
const internalDir = path.join(root, 'app-support', 'internal')
const SECRET = 'secret-de-lancement-0123456789abcdef'
let y

before(async () => {
  fs.mkdirSync(path.join(vaultDir, 'R521'), { recursive: true })
  fs.writeFileSync(path.join(vaultDir, 'R521', 'MIMO.md'), '# MIMO\n')
  y = await startServer({
    VAULT_DIR: vaultDir,
    YARICHE_INTERNAL_DIR: internalDir,
    YARICHE_LOCAL_TOKEN: SECRET,
    HOST: '127.0.0.1',
    YARICHE_STORAGE: 'local',
    // Comme l'app : utilisateur unique nommé, notes du dossier découvertes à son nom
    DEV_USER_EMAIL: 'moi@ce-mac',
  })
})

after(() => {
  y?.stop()
  fs.rmSync(root, { recursive: true, force: true })
})

const rawGet = (pathname, headers = {}) =>
  new Promise((resolve, reject) => {
    const { port } = new URL(y.base)
    http.get({ host: '127.0.0.1', port, path: pathname, headers }, (res) => resolve(res.statusCode)).on('error', reject)
  })

test('sans le secret de l’app : rien', async () => {
  assert.equal((await fetch(`${y.base}/api/me`)).status, 401)
  assert.equal((await fetch(`${y.base}/`)).status, 401)
  assert.equal((await fetch(`${y.base}/local-login?token=faux`, { redirect: 'manual' })).status, 401)
  // Autre nom d'hôte (rebinding DNS) : refusé même avec le cookie
  assert.equal(await rawGet('/api/me', { Host: 'evil.example:80', Cookie: `yariche_local=${SECRET}` }), 421)
  const ws = new WebSocket(`${y.base.replace('http', 'ws')}/ws/R521%2FMIMO`)
  const code = await new Promise((resolve) => ws.on('unexpected-response', (req, res) => resolve(res.statusCode)).on('open', () => resolve(101)))
  assert.equal(code, 401)
})

test('avec le secret : le dossier du Mac est le coffre, données internes à part', async () => {
  const app = browser(y.base)
  const login = await app.request(`/local-login?token=${SECRET}`, { follow: false })
  assert.equal(login.status, 302)
  const me = (await app.request('/api/me')).json
  assert.equal(me.local, true)
  assert.ok((await app.request('/api/docs')).json.some((e) => e.room === 'R521/MIMO'))
  await app.request(doc('R521/TP01', '/create'), { method: 'POST', body: { type: 'doc' } })
  await app.request(doc('R521/TP01'), { method: 'POST', body: { markdown: 'Compte rendu\n' } })
  assert.equal(fs.readFileSync(path.join(vaultDir, 'R521', 'TP01.md'), 'utf8'), 'Compte rendu\n')
  // Rien de Yariche dans le dossier synchronisé par Nextcloud
  assert.ok(!fs.existsSync(path.join(vaultDir, '.yariche')))
  assert.ok(fs.existsSync(path.join(internalDir, 'Cours', 'nodes.json')))
  // Un seul coffre, fixé par l'app
  assert.equal((await app.request('/api/vaults/create', { method: 'POST', body: { name: 'Autre' } })).status, 403)
  const vaults = (await app.request('/api/vaults')).json
  assert.deepEqual(vaults.map((v) => v.id), ['Cours'])
})
