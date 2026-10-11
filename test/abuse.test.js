// Garde-fous contre l'abus d'un lien d'invité (public) et contre le disque plein.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import WebSocket from 'ws'
import { startServer, browser, doc } from './helpers.js'
import { startIdp } from './oidc-idp.js'

const OWNER = 'pierre@example.com'
let idp
let y
let owner

const env = (base, extra = {}) => ({
  OIDC_ISSUER: idp.url,
  OIDC_CLIENT_ID: 'yariche',
  OIDC_CLIENT_SECRET: 'secret',
  OIDC_REDIRECT_URI: `${base}/auth/callback`,
  ALLOWED_EMAILS: OWNER,
  SESSION_SECRET: 'test-secret',
  YARICHE_STORAGE: 'local',
  ...extra,
})

before(async () => {
  idp = await startIdp()
  idp.setNextLogin(OWNER)
  y = await startServer((base) =>
    env(base, { GUEST_WRITES_PER_MINUTE: '6', GUEST_CREATES_PER_LINK: '2', GUEST_UPLOAD_MB_PER_LINK: '1', GUEST_REALTIME_MB_PER_MINUTE: '1' })
  )
  owner = browser(y.base)
  await owner.request('/login/start')
})

after(() => {
  y?.stop()
  idp?.close()
})

async function guestOf(server, ownerBrowser, room, role) {
  const { link } = (await ownerBrowser.request(doc(room, '/share-link'), { method: 'POST', body: { role } })).json
  const g = browser(server.base)
  await g.request(`/s/${link.url.split('/s/')[1]}`, { method: 'POST', form: { name: 'Léa' }, follow: false })
  return g
}

const png = (bytes) => new Blob([Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(bytes)])], { type: 'image/png' })
async function upload(b, room, blob) {
  const form = new FormData()
  form.append('file', blob, 'photo.png')
  const res = await fetch(`${y.base}${doc(room, '/upload')}`, { method: 'POST', body: form, headers: { Cookie: b.cookies() } })
  return res.status
}
const attachments = () => {
  const dir = path.join(y.dataDir, 'vaults', 'Notes', 'attachments')
  return fs.existsSync(dir) ? fs.readdirSync(dir) : []
}

test('envoi de fichier : refusé AVANT d’écrire quoi que ce soit sans droit de modification', async () => {
  await owner.request(doc('Lecture', '/create'), { method: 'POST', body: { type: 'doc' } })
  const reader = await guestOf(y, owner, 'Lecture', 'viewer')
  const before = attachments().length
  assert.equal(await upload(reader, 'Lecture', png(1000)), 403)
  assert.equal(attachments().length, before, 'aucun fichier écrit')
})

test('invité : volume de fichiers plafonné par lien', async () => {
  await owner.request(doc('Atelier', '/create'), { method: 'POST', body: { type: 'folder' } })
  const guest = await guestOf(y, owner, 'Atelier', 'editor')
  assert.equal(await upload(guest, 'Atelier', png(300_000)), 200)
  // 1 Mo par lien dans ce test : le deuxième gros fichier dépasse
  assert.equal(await upload(guest, 'Atelier', png(900_000)), 429)
})

test('invité : créations plafonnées par lien, modifications par minute', async () => {
  await owner.request(doc('Projet', '/create'), { method: 'POST', body: { type: 'folder' } })
  const guest = await guestOf(y, owner, 'Projet', 'editor')
  const create = (name) => guest.request(doc(`Projet/${name}`, '/create'), { method: 'POST', body: { type: 'doc' } })
  assert.equal((await create('Un')).status, 200)
  assert.equal((await create('Deux')).status, 200)
  assert.equal((await create('Trois')).status, 429)
  // 6 modifications par minute dans ce test (déjà 3 ci-dessus)
  const statuses = []
  for (let i = 0; i < 5; i++) statuses.push((await guest.request(doc('Projet/Un'), { method: 'POST', body: { markdown: `v${i}\n` } })).status)
  assert.deepEqual(statuses, [200, 200, 200, 429, 429])
  // Le propriétaire n'est pas limité
  for (let i = 0; i < 8; i++) assert.equal((await owner.request(doc('Projet/Un'), { method: 'POST', body: { markdown: `p${i}\n` } })).status, 200)
})

test('invité : temps réel coupé au-delà du débit permis', async () => {
  await owner.request(doc('Direct', '/create'), { method: 'POST', body: { type: 'doc' } })
  const guest = await guestOf(y, owner, 'Direct', 'editor')
  const ws = new WebSocket(`${y.base.replace('http', 'ws')}/ws/Direct`, { headers: { Cookie: guest.cookies(), Origin: y.base } })
  await new Promise((resolve, reject) => ws.on('open', resolve).on('error', reject))
  const closed = new Promise((resolve) => ws.on('close', (code) => resolve(code)))
  ws.send(Buffer.alloc(1_200_000)) // 1 Mo/min dans ce test
  assert.equal(await closed, 1008)
})

test('disque presque plein : pas de nouvelle page ni de fichier', async () => {
  const idp2Login = OWNER
  idp.setNextLogin(idp2Login)
  const full = await startServer((base) => env(base, { MIN_FREE_DISK_MB: '999999999' }))
  try {
    const b = browser(full.base)
    await b.request('/login/start')
    assert.equal((await b.request(doc('Nouvelle', '/create'), { method: 'POST', body: { type: 'doc' } })).status, 507)
  } finally {
    full.stop()
  }
})
