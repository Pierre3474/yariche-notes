// Espaces d'équipe : un dossier partagé l'est avec tout son contenu, y compris ce qui y
// est créé ensuite (comptes invités, ou invités sans compte par lien).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startServer, browser, doc } from './helpers.js'
import { startIdp } from './oidc-idp.js'

const OWNER = 'pierre@example.com'
const BOB = 'bob@example.com'
let idp
let yariche

before(async () => {
  idp = await startIdp()
  yariche = await startServer((base) => ({
    OIDC_ISSUER: idp.url,
    OIDC_CLIENT_ID: 'yariche',
    OIDC_CLIENT_SECRET: 'secret',
    OIDC_REDIRECT_URI: `${base}/auth/callback`,
    ALLOWED_EMAILS: `${OWNER},${BOB},sansemail`,
    ADMIN_EMAILS: OWNER,
    SESSION_SECRET: 'test-secret',
    YARICHE_STORAGE: 'local',
  }))
})

after(() => {
  yariche?.stop()
  idp?.close()
})

async function login(who) {
  idp.setNextLogin(who)
  const b = browser(yariche.base)
  await b.request('/login/start')
  return b
}
const rooms = async (b) => (await b.request('/api/docs')).json.map((e) => e.room)
const create = (b, room, type = 'doc') => b.request(doc(room, '/create'), { method: 'POST', body: { type } })

let owner
let bob
test('dossier partagé avec un compte : tout son contenu, même créé après', async () => {
  owner = await login(OWNER)
  bob = await login(BOB)
  await create(owner, 'Privé')
  await create(owner, 'Cours', 'folder')
  await create(owner, 'Cours/Équipe', 'folder')
  await create(owner, 'Cours/Équipe/Planning')
  const shared = await owner.request(doc('Cours/Équipe', '/share'), { method: 'POST', body: { visibility: 'shared', shares: { [BOB]: 'editor' } } })
  assert.equal(shared.status, 200)
  // Créée APRÈS le partage : visible quand même
  await create(owner, 'Cours/Équipe/Compte rendu')

  const seen = await rooms(bob)
  assert.deepEqual(seen.sort(), ['Cours/Équipe', 'Cours/Équipe/Compte rendu', 'Cours/Équipe/Planning'].sort())
  // Dossier parent privé : l'espace apparaît à la racine chez Bob
  const entry = (await bob.request('/api/docs')).json.find((e) => e.room === 'Cours/Équipe')
  assert.equal(entry.parent, null)
  assert.equal(entry.shared, true)
  assert.equal((await bob.request(doc('Privé'))).status, 403)

  // Bob modifie et crée dans l'espace ; il possède ce qu'il crée
  assert.equal((await bob.request(doc('Cours/Équipe/Planning'), { method: 'POST', body: { markdown: 'lundi\n' } })).status, 200)
  assert.equal((await create(bob, 'Cours/Équipe/Idées')).status, 200)
  assert.equal((await bob.request(doc('Cours/Équipe/Idées'))).json.role, 'owner')
  // … mais pas ailleurs
  assert.equal((await create(bob, 'Cours/Intrus')).status, 403)
})

test('le propriétaire de l’espace gère ce que les membres y créent', async () => {
  assert.equal((await owner.request(doc('Cours/Équipe/Idées'))).json.role, 'owner')
  const renamed = await owner.request(doc('Cours/Équipe/Idées', '/rename'), { method: 'POST', body: { newName: 'Idées retenues' } })
  assert.equal(renamed.status, 200)
  // Un simple membre ne gère pas les pages des autres
  assert.equal((await bob.request(doc('Cours/Équipe/Planning', '/rename'), { method: 'POST', body: { newName: 'X' } })).status, 403)
  assert.equal((await bob.request(doc('Cours/Équipe/Planning', '/delete'), { method: 'POST' })).status, 403)
  // Sortie de l'espace : plus d'accès
  await owner.request(doc('Cours/Équipe/Planning', '/move'), { method: 'POST', body: { parent: 'Cours' } })
  assert.equal((await bob.request(doc('Cours/Planning'))).status, 403)
})

test('partage avec un identifiant SSO (compte sans email)', async () => {
  const r = await owner.request(doc('Cours/Équipe', '/share'), { method: 'POST', body: { visibility: 'shared', shares: { [BOB]: 'editor', sansemail: 'viewer' } } })
  assert.deepEqual(r.json.shares, { [BOB]: 'editor', sansemail: 'viewer' })
  const sans = await login('compte:sansemail')
  assert.ok((await rooms(sans)).includes('Cours/Équipe/Compte rendu'))
  assert.equal((await sans.request(doc('Cours/Équipe/Compte rendu'), { method: 'POST', body: { markdown: 'x\n' } })).status, 403)
})

async function joinAsGuest(folder, role) {
  const { link } = (await owner.request(doc(folder, '/share-link'), { method: 'POST', body: { role } })).json
  const token = link.url.split('/s/')[1]
  const g = browser(yariche.base)
  await g.request(`/s/${token}`, { method: 'POST', form: { name: 'Léa' }, follow: false })
  return g
}

test('dossier partagé par lien d’invité : l’invité y crée et renomme ses pages', async () => {
  await create(owner, 'Projet', 'folder')
  await create(owner, 'Projet/Consignes')
  const guest = await joinAsGuest('Projet', 'editor')
  assert.equal((await guest.request('/api/me')).json.shareRoot, 'Projet')

  const made = await create(guest, 'Projet/Sans titre')
  assert.equal(made.status, 200)
  assert.equal(made.json.meta.owner, OWNER)
  assert.equal((await guest.request(doc('Projet/Sans titre'))).json.canRename, true)
  const renamed = await guest.request(doc('Projet/Sans titre', '/rename'), { method: 'POST', body: { newName: 'Notes de Léa' } })
  assert.equal(renamed.status, 200)
  assert.ok((await rooms(guest)).includes('Projet/Notes de Léa'))
  assert.ok((await rooms(owner)).includes('Projet/Notes de Léa'))
  // Toujours à lui après le renommage ; pas ce qui appartient au propriétaire
  assert.equal((await guest.request(doc('Projet/Notes de Léa'))).json.canRename, true)
  assert.equal((await guest.request(doc('Projet/Consignes'))).json.canRename, false)
  assert.equal((await guest.request(doc('Projet/Consignes', '/rename'), { method: 'POST', body: { newName: 'X' } })).status, 403)
  // Hors de l'espace : rien
  assert.equal((await create(guest, 'Ailleurs')).status, 403)
  assert.equal((await create(guest, 'Cours/Intrus')).status, 403)
  assert.equal((await guest.request(doc('Projet/Notes de Léa', '/delete'), { method: 'POST' })).status, 403)
})

test('lien d’invité en lecture : pas de création', async () => {
  await create(owner, 'Lecture', 'folder')
  const reader = await joinAsGuest('Lecture', 'viewer')
  assert.equal((await create(reader, 'Lecture/Page')).status, 403)
})
