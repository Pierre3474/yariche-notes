// Nextcloud comme stockage : premier lancement (connexion par le navigateur, Login
// Flow v2), choix du dossier. Un faux Nextcloud répond comme le vrai.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { startServer, doc } from './helpers.js'

const APP_PASSWORD = 'mot-de-passe-application'
let nc
let ncUrl
let yariche
let polls = 0
const folders = new Set(['/Documents', '/Photos'])

function fakeNextcloud(req, res) {
  const url = new URL(req.url, ncUrl)
  const json = (value, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(value))
  }
  if (req.method === 'POST' && url.pathname === '/index.php/login/v2')
    return json({
      poll: { token: 'jeton', endpoint: `${ncUrl}/index.php/login/v2/poll` },
      login: `${ncUrl}/index.php/login/v2/flow/jeton`,
    })
  if (req.method === 'POST' && url.pathname === '/index.php/login/v2/poll') {
    // Accès pas encore autorisé au premier passage, puis accordé
    if (++polls < 2) return json({}, 404)
    return json({ server: ncUrl, loginName: 'alice', appPassword: APP_PASSWORD })
  }
  if (req.headers.authorization !== `Basic ${Buffer.from(`alice:${APP_PASSWORD}`).toString('base64')}`) return json({}, 401)
  if (url.pathname === '/ocs/v2.php/cloud/user') return json({ ocs: { data: { id: 'alice', 'display-name': 'Alice' } } })
  const prefix = '/remote.php/dav/files/alice'
  if (url.pathname.startsWith(prefix)) {
    const p = decodeURIComponent(url.pathname.slice(prefix.length)).replace(/\/$/, '')
    if (req.method === 'MKCOL') {
      folders.add(p)
      res.writeHead(201)
      return res.end()
    }
    if (req.method === 'PROPFIND') {
      const children = [...folders].filter((f) => f.startsWith(`${p}/`) && !f.slice(p.length + 1).includes('/'))
      const entry = (f) =>
        `<d:response><d:href>${prefix}${encodeURI(f)}/</d:href><d:propstat><d:prop>` +
        `<d:resourcetype><d:collection/></d:resourcetype><oc:size>2048</oc:size></d:prop></d:propstat></d:response>`
      res.writeHead(207, { 'Content-Type': 'application/xml' })
      return res.end(
        `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">${entry(p)}${children.map(entry).join('')}</d:multistatus>`
      )
    }
  }
  json({}, 404)
}

before(async () => {
  nc = http.createServer(fakeNextcloud)
  await new Promise((r) => nc.listen(0, '127.0.0.1', r))
  ncUrl = `http://127.0.0.1:${nc.address().port}`
  yariche = await startServer({ YARICHE_STORAGE: 'nextcloud', DEFAULT_VAULT: 'Yariche', NEXTCLOUD_URL: ncUrl })
})

after(() => {
  yariche?.stop()
  nc?.close()
})

test('premier lancement : Nextcloud obligatoire, rien ne s’enregistre ailleurs', async () => {
  const { json } = await yariche.api('/api/vault')
  assert.equal(json.setup.mode, 'nextcloud')
  assert.equal(json.setup.step, 'connect')
  assert.equal(json.setup.allowLocal, false)
  assert.equal(json.setup.defaultUrl, ncUrl)
  assert.equal((await yariche.api(doc('Note', '/create'), { method: 'POST', body: {} })).status, 409)
  assert.equal((await yariche.api('/api/vaults/create', { method: 'POST', body: { name: 'Local' } })).status, 403)
})

test('connexion par le navigateur (Login Flow v2) puis choix du dossier', async () => {
  const start = await yariche.api('/api/nextcloud/login/start', { method: 'POST', body: { url: ncUrl } })
  assert.equal(start.status, 200)
  // Connexion d'abord, puis la page d'autorisation (évite l'erreur de jeton de Nextcloud)
  assert.equal(
    start.json.login,
    `${ncUrl}/index.php/login?redirect_url=${encodeURIComponent('/index.php/login/v2/flow/jeton')}`
  )
  // Tant que l'accès n'est pas autorisé dans le navigateur
  const waiting = await yariche.api('/api/nextcloud/login/poll', { method: 'POST', body: { id: start.json.id } })
  assert.equal(waiting.json.done, false)
  const done = await yariche.api('/api/nextcloud/login/poll', { method: 'POST', body: { id: start.json.id } })
  assert.equal(done.json.done, true)
  assert.equal(done.json.setup.step, 'folder')
  assert.equal(done.json.vault.nextcloud.user, 'Alice')

  // Le mot de passe d'application reste sur le serveur (fichier privé), jamais renvoyé
  const settings = path.join(yariche.dataDir, 'settings.json')
  assert.equal(fs.statSync(settings).mode & 0o777, 0o600)
  assert.ok(!(await yariche.api('/api/vault')).text.includes(APP_PASSWORD))

  const list = await yariche.api('/api/nextcloud/folders?path=%2F')
  assert.deepEqual(
    list.json.folders.map((f) => f.path),
    ['/Documents', '/Photos']
  )
  assert.equal((await yariche.api('/api/nextcloud/folders', { method: 'POST', body: { path: '/Yariche' } })).status, 200)
  assert.ok(folders.has('/Yariche'))
  const link = await yariche.api('/api/vault/link', { method: 'POST', body: { folder: '/Yariche' } })
  assert.equal(link.status, 200)

  const { json } = await yariche.api('/api/vault')
  assert.equal(json.setup.step, null)
  assert.equal(json.name, 'Yariche')
  assert.equal(json.remote.folder, '/Yariche')
  // Les notes s'enregistrent maintenant (dans la copie synchronisée avec Nextcloud)
  assert.equal((await yariche.api(doc('Note', '/create'), { method: 'POST', body: {} })).status, 200)
})
