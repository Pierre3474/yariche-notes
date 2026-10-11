// IA (MCP) : jetons personnels, outils de lecture / écriture, droits de la personne.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { startServer, browser, doc } from './helpers.js'
import { startIdp } from './oidc-idp.js'

const OWNER = 'pierre@example.com'
const BOB = 'bob@example.com'
let idp
let yariche
let owner
let bob

before(async () => {
  idp = await startIdp()
  yariche = await startServer((base) => ({
    OIDC_ISSUER: idp.url,
    OIDC_CLIENT_ID: 'yariche',
    OIDC_CLIENT_SECRET: 'secret',
    OIDC_REDIRECT_URI: `${base}/auth/callback`,
    ALLOWED_EMAILS: `${OWNER},${BOB}`,
    ADMIN_EMAILS: OWNER,
    SESSION_SECRET: 'test-secret',
    YARICHE_STORAGE: 'local',
  }))
  owner = await login(OWNER)
  bob = await login(BOB)
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

async function connect(token) {
  const client = new Client({ name: 'test', version: '1.0.0' })
  const transport = new StreamableHTTPClientTransport(new URL(`${yariche.base}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  })
  await client.connect(transport)
  return client
}
const call = async (client, name, args) => {
  const r = await client.callTool({ name, arguments: args })
  const text = r.content?.[0]?.text || ''
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    json = null
  }
  return { error: !!r.isError, text, json }
}
const newToken = async (b, scope, name = 'test') => (await b.request('/api/tokens', { method: 'POST', body: { name, scope } })).json

test('sans jeton valide : refusé', async () => {
  for (const auth of [null, 'Bearer yar_faux', 'Basic abc']) {
    const res = await fetch(`${yariche.base}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(auth ? { Authorization: auth } : {}) },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })
    assert.equal(res.status, 401, String(auth))
  }
})

test('jeton en lecture : lister, chercher, lire ; aucun outil d’écriture', async () => {
  await owner.request(doc('Cours', '/create'), { method: 'POST', body: { type: 'folder' } })
  await owner.request(doc('Cours/MIMO', '/create'), { method: 'POST', body: { type: 'doc' } })
  await owner.request(doc('Cours/MIMO'), { method: 'POST', body: { markdown: 'Le MIMO multiplie les antennes.\n' } })
  const { token, scope } = await newToken(owner, 'read')
  assert.equal(scope, 'read')
  assert.match(token, /^yar_/)
  const ai = await connect(token)
  const names = (await ai.listTools()).tools.map((t) => t.name).sort()
  assert.deepEqual(names, ['get_backlinks', 'list_pages', 'read_page', 'search_pages'])
  assert.match((await call(ai, 'list_pages', {})).text, /doc\tCours\/MIMO/)
  assert.equal((await call(ai, 'search_pages', { query: 'antennes' })).json[0].id, 'Cours/MIMO')
  assert.equal((await call(ai, 'read_page', { id: 'Cours/MIMO' })).json.content, 'Le MIMO multiplie les antennes.\n')
  await ai.close()
})

test('jeton en écriture : créer (dossiers compris), modifier en gardant l’en-tête, historique', async () => {
  const { token } = await newToken(owner, 'write', 'Assistant')
  const ai = await connect(token)
  const made = await call(ai, 'create_page', { path: 'R521/TP/TP05 Compte rendu', content: '# TP05\n\nMesures.\n' })
  assert.equal(made.error, false, made.text)
  const tree = (await owner.request('/api/docs')).json.map((e) => e.room)
  assert.ok(tree.includes('R521') && tree.includes('R521/TP') && tree.includes('R521/TP/TP05 Compte rendu'))
  assert.equal((await owner.request(doc('R521/TP/TP05 Compte rendu'))).json.content, '# TP05\n\nMesures.\n')

  await owner.request(doc('Fiche', '/create'), { method: 'POST', body: { type: 'doc' } })
  await owner.request(doc('Fiche'), { method: 'POST', body: { markdown: 'avant\n' } })
  // En-tête YAML écrit par Obsidian : conservé
  const fs = await import('node:fs')
  const path = await import('node:path')
  const file = path.join(yariche.dataDir, 'vaults', 'Notes', 'Fiche.md')
  fs.writeFileSync(file, '---\ntags: [cours]\n---\navant\n')
  assert.equal((await call(ai, 'update_page', { id: 'Fiche', content: 'après\n' })).error, false)
  assert.equal(fs.readFileSync(file, 'utf8'), '---\ntags: [cours]\n---\naprès\n')
  await call(ai, 'update_page', { id: 'Fiche', content: 'ajout', mode: 'append' })
  assert.equal(fs.readFileSync(file, 'utf8'), '---\ntags: [cours]\n---\naprès\n\najout\n')
  const { versions } = (await owner.request(doc('Fiche', '/versions'))).json
  assert.ok(versions.length >= 2, 'versions précédentes gardées')
  await ai.close()
})

test('renommer met à jour les liens ; corbeille réversible', async () => {
  const { token } = await newToken(owner, 'write')
  const ai = await connect(token)
  await call(ai, 'create_page', { path: 'Sommaire', content: 'voir [[TP05 Compte rendu]]\n' })
  const moved = await call(ai, 'move_page', { id: 'R521/TP/TP05 Compte rendu', new_path: 'R521/TP/TP05 Final' })
  assert.equal(moved.error, false, moved.text)
  assert.equal((await call(ai, 'read_page', { id: 'Sommaire' })).json.content, 'voir [[TP05 Final]]\n')
  const trashed = await call(ai, 'trash_page', { id: 'Sommaire' })
  assert.equal(trashed.error, false)
  assert.ok(!(await owner.request('/api/docs')).json.some((e) => e.room === 'Sommaire'))
  assert.ok((await owner.request('/api/trash')).json.length >= 1)
  await ai.close()
})

test('droits de la personne : pas de page privée d’un autre, lecture seule respectée', async () => {
  const { token } = await newToken(bob, 'write')
  const ai = await connect(token)
  assert.equal((await call(ai, 'read_page', { id: 'Cours/MIMO' })).error, true)
  assert.doesNotMatch((await call(ai, 'list_pages', {})).text, /MIMO/)
  assert.equal((await call(ai, 'create_page', { path: 'Cours/Intrus' })).error, true)
  // Partagé en lecture : lisible, pas modifiable
  await owner.request(doc('Cours', '/share'), { method: 'POST', body: { visibility: 'shared', shares: { [BOB]: 'viewer' } } })
  assert.equal((await call(ai, 'read_page', { id: 'Cours/MIMO' })).error, false)
  assert.equal((await call(ai, 'update_page', { id: 'Cours/MIMO', content: 'x' })).error, true)
  await ai.close()
})

test('jetons : les siens seulement, révocation immédiate', async () => {
  const { token, id } = await newToken(owner, 'read', 'à révoquer')
  const ai = await connect(token)
  await call(ai, 'list_pages', {})
  const mine = (await owner.request('/api/tokens')).json
  assert.ok(mine.find((t) => t.id === id).lastUsedAt)
  assert.ok(mine.every((t) => !('hash' in t) && !('token' in t)))
  assert.ok(!(await bob.request('/api/tokens')).json.some((t) => t.id === id))
  assert.equal((await bob.request(`/api/tokens/${id}`, { method: 'DELETE' })).status, 404)
  assert.equal((await owner.request(`/api/tokens/${id}`, { method: 'DELETE' })).status, 200)
  await assert.rejects(connect(token))
})
