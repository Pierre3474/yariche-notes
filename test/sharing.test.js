// Yariche privé (SSO, un seul compte autorisé) + liens de partage pour invités sans
// compte. Un faux fournisseur OpenID Connect signe de vrais jetons.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import WebSocket from 'ws'
import { startServer, browser, doc } from './helpers.js'
import { startIdp } from './oidc-idp.js'

const OWNER = 'pierre@example.com'
let idp
let yariche

async function login(email) {
  idp.setNextLogin(email)
  const b = browser(yariche.base)
  const r = await b.request('/login/start')
  return { b, r }
}

before(async () => {
  idp = await startIdp()
  yariche = await startServer(
    (base) => ({
      OIDC_ISSUER: idp.url,
      OIDC_CLIENT_ID: 'yariche',
      OIDC_CLIENT_SECRET: 'secret',
      OIDC_REDIRECT_URI: `${base}/auth/callback`,
      ALLOWED_EMAILS: `${OWNER},sansemail`,
      ADMIN_EMAILS: OWNER,
      SESSION_SECRET: 'test-secret',
      YARICHE_STORAGE: 'local',
    }),
    {
      // Une page créée avant le SSO (mode sans connexion)
      prepare: (dataDir) => {
        const vault = path.join(dataDir, 'vaults', 'Notes')
        fs.mkdirSync(path.join(vault, '.yariche'), { recursive: true })
        fs.writeFileSync(path.join(vault, 'Ancienne.md'), 'écrite sans connexion\n')
        fs.writeFileSync(
          path.join(vault, '.yariche', 'meta.json'),
          JSON.stringify({
            Ancienne: { owner: 'dev@local', type: 'doc', parent: null, visibility: 'private', linkRole: 'viewer', shares: {}, appearance: { icon: null, cover: null }, createdAt: 1, deletedAt: null },
          })
        )
      },
    }
  )
})

after(() => {
  yariche?.stop()
  idp?.close()
})

let owner
test('seul le compte autorisé entre ; il reprend les pages du mode sans connexion', async () => {
  const refused = await login('autre@example.com')
  assert.equal(refused.r.status, 403)
  assert.match(refused.r.text, /Accès réservé/)
  assert.equal((await refused.b.request('/api/me')).status, 401)

  const ok = await login(OWNER)
  owner = ok.b
  const me = (await owner.request('/api/me')).json
  assert.equal(me.email, OWNER)
  assert.equal(me.admin, true)
  const docs = (await owner.request('/api/docs')).json.map((d) => d.room)
  assert.ok(docs.includes('Ancienne'))
})

test('compte SSO sans email : accepté par son identifiant s’il est dans la liste', async () => {
  const { b } = await login('compte:sansemail')
  const me = (await b.request('/api/me')).json
  assert.equal(me.email, 'sansemail')
  const other = await login('compte:intrus')
  assert.equal(other.r.status, 403)
})

let link
let guest
test('lien d’invité : prénom, puis accès à la page partagée et ses sous-pages seulement', async () => {
  fs.mkdirSync(path.join(yariche.dataDir, 'vaults', 'Notes', 'attachments'), { recursive: true })
  fs.writeFileSync(path.join(yariche.dataDir, 'vaults', 'Notes', 'attachments', 'publique.png'), 'png')
  fs.writeFileSync(path.join(yariche.dataDir, 'vaults', 'Notes', 'attachments', 'secrete.png'), 'png')
  await owner.request(doc('Partagé', '/create'), { method: 'POST', body: { type: 'doc' } })
  await owner.request(doc('Partagé'), { method: 'POST', body: { markdown: 'Cours ![](attachments/publique.png)\n' } })
  await owner.request(doc('Partagé/Sous-page', '/create'), { method: 'POST', body: { type: 'doc' } })
  await owner.request(doc('Privé', '/create'), { method: 'POST', body: { type: 'doc' } })
  await owner.request(doc('Privé'), { method: 'POST', body: { markdown: 'Secret ![](attachments/secrete.png)\n' } })

  const created = await owner.request(doc('Partagé', '/share-link'), { method: 'POST', body: { role: 'editor' } })
  link = created.json.link
  assert.equal(link.role, 'editor')
  const token = link.url.split('/s/')[1]
  assert.ok(token.length >= 30)

  guest = browser(yariche.base)
  const form = await guest.request(`/s/${token}`)
  assert.equal(form.status, 200)
  assert.match(form.text, /Ton prénom/)
  const enter = await guest.request(`/s/${token}`, { method: 'POST', form: { name: 'Léa' }, follow: false })
  assert.equal(enter.status, 302)
  assert.equal(enter.location, `/?doc=${encodeURIComponent('Partagé')}`)

  const me = (await guest.request('/api/me')).json
  assert.equal(me.guest, true)
  assert.equal(me.name, 'Léa')
  assert.equal(me.shareRoot, 'Partagé')
  const docs = (await guest.request('/api/docs')).json
  assert.deepEqual(docs.map((d) => d.room).sort(), ['Partagé', 'Partagé/Sous-page'])
  assert.equal(docs.find((d) => d.room === 'Partagé/Sous-page').name, 'Sous-page')
  assert.equal(docs.find((d) => d.room === 'Partagé').parent, null)

  assert.equal((await guest.request(doc('Partagé'))).status, 200)
  assert.equal((await guest.request(doc('Partagé/Sous-page'))).status, 200)
  assert.equal((await guest.request(doc('Privé'))).status, 403)
  assert.equal((await guest.request(doc('Ancienne'))).status, 403)
  assert.equal((await guest.request(doc('Partagé'), { method: 'POST', body: { markdown: 'Modifié par Léa\n' } })).status, 200)
  assert.equal((await owner.request(doc('Partagé'))).json.content, 'Modifié par Léa\n')
})

test('un invité ne voit rien d’autre : recherche, utilisateurs, coffre, création, fichiers', async () => {
  for (const [method, url] of [
    ['GET', '/api/search?q=Secret'],
    ['GET', '/api/users'],
    ['GET', '/api/vault'],
    ['GET', '/api/trash'],
    ['GET', '/api/graph'],
    ['GET', '/api/notifications'],
    ['POST', doc('Nouvelle', '/create')],
    ['POST', doc('Partagé', '/share-link')],
    ['POST', doc('Partagé', '/rename')],
    ['POST', doc('Partagé', '/delete')],
  ]) {
    const r = await guest.request(url, { method, body: method === 'POST' ? {} : undefined })
    assert.equal(r.status, 403, `${method} ${url}`)
  }
  // Image citée par une autre page : invisible ; image de la page partagée : servie
  await owner.request(doc('Partagé'), { method: 'POST', body: { markdown: 'Cours ![](attachments/publique.png)\n' } })
  assert.equal((await guest.request('/attachments/publique.png')).status, 200)
  assert.equal((await guest.request('/attachments/secrete.png')).status, 404)
  assert.equal((await guest.request('/api/vault-file?name=secrete.png')).status, 404)
  assert.equal((await guest.request('/api/vault-file?name=publique.png')).status, 200)
})

test('temps réel : l’invité rejoint la page partagée, pas les autres', async () => {
  const wsBase = yariche.base.replace('http', 'ws')
  const open = (room) =>
    new Promise((resolve) => {
      const ws = new WebSocket(`${wsBase}/ws/${encodeURIComponent(room)}`, { headers: { Cookie: guest.cookies() } })
      ws.on('open', () => {
        ws.close()
        resolve('ouvert')
      })
      ws.on('unexpected-response', (_, res) => resolve(res.statusCode))
      ws.on('error', () => resolve('erreur'))
    })
  assert.equal(await open('Partagé'), 'ouvert')
  assert.equal(await open('Privé'), 403)
})

test('le lien suit la page déplacée, lecture seule, puis lien désactivé', async () => {
  // Page partagée rangée ailleurs : le lien d'invité la suit
  await owner.request(doc('Classeur', '/create'), { method: 'POST', body: { type: 'folder' } })
  const moved = await owner.request(doc('Partagé', '/move'), { method: 'POST', body: { parent: 'Classeur' } })
  assert.equal(moved.json.newRoom, 'Classeur/Partagé')
  assert.equal((await guest.request('/api/me')).json.shareRoot, 'Classeur/Partagé')
  assert.equal((await guest.request(doc('Classeur/Partagé'))).status, 200)
  assert.equal((await guest.request(doc('Classeur/Partagé/Sous-page'))).status, 200)
  assert.equal((await guest.request(doc('Classeur'))).status, 403)

  await owner.request(doc('Classeur/Partagé', '/share-link'), { method: 'POST', body: { role: 'viewer' } })
  assert.equal((await guest.request(doc('Classeur/Partagé'), { method: 'POST', body: { markdown: 'non\n' } })).status, 403)
  assert.equal((await guest.request(doc('Classeur/Partagé'))).status, 200)

  await owner.request(doc('Classeur/Partagé', '/share-link'), { method: 'DELETE' })
  assert.equal((await guest.request(doc('Classeur/Partagé'))).status, 401)
  const token = link.url.split('/s/')[1]
  assert.equal((await browser(yariche.base).request(`/s/${token}`)).status, 404)
})
