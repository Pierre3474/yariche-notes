// Tests d'API : un vrai serveur Yariche sur un dossier temporaire (sans SSO).
// Lancer : npm test
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { startServer, eventually, sleep, doc } from './helpers.js'

let server
let BASE
let dataDir
let api

const vault = (...p) => path.join(dataDir, 'vaults', 'Notes', ...p)
const docs = async () => (await api('/api/docs')).json
const entry = async (room) => (await docs()).find((d) => d.room === room)

before(async () => {
  server = await startServer()
  ;({ base: BASE, dataDir, api } = server)
})

after(() => server?.stop())

test('une page est un vrai fichier .md, relu tel quel', async () => {
  assert.equal((await api(doc('Accueil', '/create'), { method: 'POST', body: { type: 'doc' } })).status, 200)
  const markdown = '# Titre\n\nDu **texte** et un lien [[Autre]].\n'
  assert.equal((await api(doc('Accueil'), { method: 'POST', body: { markdown } })).status, 200)
  assert.equal(fs.readFileSync(vault('Accueil.md'), 'utf8'), markdown)
  const { json } = await api(doc('Accueil'))
  assert.equal(json.content, markdown)
  assert.equal(json.path, 'Accueil.md')
})

test("l'en-tête YAML (propriétés Obsidian) est conservé", async () => {
  fs.writeFileSync(vault('Accueil.md'), '---\ntags: [a]\n---\nCorps\n')
  await sleep(700)
  const { json } = await api(doc('Accueil'))
  assert.equal(json.content, 'Corps\n')
  await api(doc('Accueil'), { method: 'POST', body: { markdown: 'Corps modifié\n' } })
  assert.equal(fs.readFileSync(vault('Accueil.md'), 'utf8'), '---\ntags: [a]\n---\nCorps modifié\n')
})

test("une note ouverte sans modification n'est pas réécrite (référence d'affichage)", async () => {
  const original = '* un\n* deux\n\n__gras__\n'
  fs.writeFileSync(vault('Obsidian.md'), original)
  await eventually(async () => entry('Obsidian'))
  // L'éditeur réécrit la note à sa façon : la référence dit que rien n'a changé
  const rendered = '- un\n- deux\n\n**gras**\n'
  await api(doc('Obsidian'), { method: 'POST', body: { markdown: rendered, baseline: true } })
  const save = await api(doc('Obsidian'), { method: 'POST', body: { markdown: rendered } })
  assert.equal(save.json.unchanged, true)
  assert.equal(fs.readFileSync(vault('Obsidian.md'), 'utf8'), original)
  // Une vraie modification, elle, est écrite
  await api(doc('Obsidian'), { method: 'POST', body: { markdown: `${rendered}\nAjout\n` } })
  assert.match(fs.readFileSync(vault('Obsidian.md'), 'utf8'), /Ajout/)
})

test('rangement façon Obsidian : l’identifiant est le chemin, le dossier se déduit', async () => {
  await api(doc('Travail', '/create'), { method: 'POST', body: { type: 'folder' } })
  await api(doc('Travail/Réunion', '/create'), { method: 'POST', body: { type: 'doc' } })
  assert.ok(fs.existsSync(vault('Travail', 'Réunion.md')))
  await api(doc('Travail/Réunion/Compte rendu', '/create'), { method: 'POST', body: { type: 'doc' } })
  assert.ok(fs.existsSync(vault('Travail', 'Réunion', 'Compte rendu.md')))
  const sub = await entry('Travail/Réunion/Compte rendu')
  assert.equal(sub.name, 'Compte rendu')
  assert.equal(sub.parent, 'Travail/Réunion')
  // Dossier parent inexistant : refusé
  assert.equal((await api(doc('Nulle/Part', '/create'), { method: 'POST', body: {} })).status, 400)

  const moved = await api(doc('Travail/Réunion', '/move'), { method: 'POST', body: { parent: null } })
  assert.equal(moved.json.newRoom, 'Réunion')
  assert.ok(fs.existsSync(vault('Réunion.md')))
  assert.ok(fs.existsSync(vault('Réunion', 'Compte rendu.md')))
  assert.ok(await entry('Réunion/Compte rendu'))
  const moveInside = await api(doc('Réunion', '/move'), { method: 'POST', body: { parent: 'Réunion/Compte rendu' } })
  assert.equal(moveInside.status, 400)
})

test('noms en double dans des dossiers différents, comme Obsidian', async () => {
  for (const cours of ['R501', 'R521']) {
    fs.mkdirSync(vault(cours, 'Concepts'), { recursive: true })
    fs.writeFileSync(vault(cours, 'Concepts', 'MIMO.md'), `MIMO en ${cours}\n`)
  }
  fs.writeFileSync(vault('R521', 'Concepts', 'Antennes.md'), 'Voir [[MIMO]]\n')
  await eventually(async () => (await entry('R501/Concepts/MIMO')) && (await entry('R521/Concepts/Antennes')))
  const ids = (await docs()).map((d) => d.room)
  for (const id of ['R501/Concepts', 'R521/Concepts', 'R501/Concepts/MIMO', 'R521/Concepts/MIMO'])
    assert.ok(ids.includes(id), id)
  assert.equal((await api(doc('R501/Concepts/MIMO'))).json.content, 'MIMO en R501\n')

  // [[MIMO]] depuis R521/Concepts vise le MIMO du même dossier
  await api(doc('R521/Concepts/Antennes'), { method: 'POST', body: { markdown: 'Voir [[MIMO]]\n' } })
  assert.deepEqual((await api(doc('R521/Concepts/MIMO', '/backlinks'))).json.backlinks, ['R521/Concepts/Antennes'])
  assert.deepEqual((await api(doc('R501/Concepts/MIMO', '/backlinks'))).json.backlinks, [])

  // Renommer le MIMO de R521 met à jour ce lien-là, pas l'homonyme
  const r = await api(doc('R521/Concepts/MIMO', '/rename'), { method: 'POST', body: { newName: 'MIMO massif' } })
  assert.equal(r.json.newRoom, 'R521/Concepts/MIMO massif')
  assert.equal(fs.readFileSync(vault('R521', 'Concepts', 'Antennes.md'), 'utf8'), 'Voir [[MIMO massif]]\n')
  assert.ok(fs.existsSync(vault('R501', 'Concepts', 'MIMO.md')))
})

test('modifications faites ailleurs : ajout, déplacement (métadonnées suivies), suppression', async () => {
  fs.mkdirSync(vault('Externe'))
  fs.writeFileSync(vault('Externe', 'Note.md'), 'ajoutée ailleurs\n')
  const added = await eventually(async () => entry('Externe/Note'))
  assert.equal(added.parent, 'Externe')
  await api(doc('Externe/Note', '/appearance'), { method: 'POST', body: { icon: '🧭' } })
  await api(doc('Externe/Note', '/comments'), { method: 'POST', body: { t1: { text: 'suivi' } } })
  // Déplacé comme le ferait Obsidian ou le client Nextcloud : même fichier (même inode)
  fs.renameSync(vault('Externe', 'Note.md'), vault('Note déplacée.md'))
  const moved = await eventually(async () => entry('Note déplacée'))
  assert.equal(moved.parent, null)
  assert.equal(moved.icon, '🧭')
  assert.deepEqual((await api(doc('Note déplacée', '/comments'))).json, { t1: { text: 'suivi' } })
  assert.ok(!(await entry('Externe/Note')))
  fs.rmSync(vault('Note déplacée.md'))
  await eventually(async () => !(await entry('Note déplacée')))
})

test('corbeille : chemin gardé, nom libéré, restauration au bon endroit', async () => {
  await api(doc('Cours', '/create'), { method: 'POST', body: { type: 'folder' } })
  await api(doc('Cours/TP', '/create'), { method: 'POST', body: { type: 'doc' } })
  await api(doc('Cours/TP'), { method: 'POST', body: { markdown: 'première version\n' } })
  const del = await api(doc('Cours/TP', '/delete'), { method: 'POST' })
  assert.equal(del.json.trashId, '.trash/Cours/TP')
  assert.ok(fs.existsSync(vault('.trash', 'Cours', 'TP.md')))
  const item = (await api('/api/trash')).json.find((t) => t.room === '.trash/Cours/TP')
  assert.equal(item.name, 'TP')
  assert.deepEqual(item.path, ['Cours'])
  // Le nom est libre tout de suite, puis la restauration évite l'écrasement
  await api(doc('Cours/TP', '/create'), { method: 'POST', body: { type: 'doc' } })
  const restored = await api(doc('.trash/Cours/TP', '/restore'), { method: 'POST' })
  assert.equal(restored.json.room, 'Cours/TP (2)')
  assert.equal(fs.readFileSync(vault('Cours', 'TP (2).md'), 'utf8'), 'première version\n')
})

test('un nom mis à la corbeille redevient libre, et revient à la restauration', async () => {
  for (let i = 0; i < 3; i++) {
    await api(doc('Nouveau dossier', '/create'), { method: 'POST', body: { type: 'folder' } })
    assert.ok(await entry('Nouveau dossier'))
    await api(doc('Nouveau dossier', '/delete'), { method: 'POST' })
  }
  const trash = (await api('/api/trash')).json.filter((t) => t.name === 'Nouveau dossier')
  assert.equal(trash.length, 3)
  const one = trash.find((t) => t.room !== 'Nouveau dossier')
  const restored = await api(doc(one.room, '/restore'), { method: 'POST' })
  assert.equal(restored.json.room, 'Nouveau dossier')
  assert.ok(await entry('Nouveau dossier'))
})

test('renommer suit les fichiers, les commentaires et les liens', async () => {
  await api(doc('Source', '/create'), { method: 'POST', body: { type: 'doc' } })
  await api(doc('Source'), { method: 'POST', body: { markdown: 'Voir [[Cible]]\n' } })
  await api(doc('Cible', '/create'), { method: 'POST', body: { type: 'doc' } })
  await api(doc('Cible', '/comments'), { method: 'POST', body: { t1: { text: 'coucou' } } })
  const r = await api(doc('Cible', '/rename'), { method: 'POST', body: { newName: 'Destination' } })
  assert.equal(r.status, 200)
  assert.ok(fs.existsSync(vault('Destination.md')))
  assert.deepEqual((await api(doc('Destination', '/comments'))).json, { t1: { text: 'coucou' } })
  assert.equal(fs.readFileSync(vault('Source.md'), 'utf8'), 'Voir [[Destination]]\n')
})

test('les noms de page ne peuvent pas sortir du coffre', async () => {
  for (const bad of ['../evil', '.cache', 'a\\b']) {
    const { status } = await api(`/api/doc/${encodeURIComponent(bad)}/create`, { method: 'POST', body: {} })
    assert.equal(status, 400, bad)
  }
  const file = await fetch(`${BASE}/api/vault-file?path=${encodeURIComponent('../settings.json')}`)
  assert.equal(file.status, 404)
})

test('coffres : création, changement, onglet resté sur l’ancien coffre refusé', async () => {
  const created = await api('/api/vaults/create', { method: 'POST', body: { name: 'Perso' } })
  assert.equal(created.json.vault.id, 'Perso')
  assert.deepEqual(await docs(), [])
  const stale = await api('/api/docs', { headers: { 'X-Yariche-Vault': 'Notes' } })
  assert.equal(stale.status, 409)
  // Nom avec espace et accent : l'en-tête arrive encodé, c'est bien le même coffre
  // (sinon l'app se rechargeait en boucle)
  await api('/api/vaults/create', { method: 'POST', body: { name: 'Études 2026-2027' } })
  const same = await api('/api/docs', { headers: { 'X-Yariche-Vault': encodeURIComponent('Études 2026-2027') } })
  assert.equal(same.status, 200)
  await api('/api/vaults/open', { method: 'POST', body: { id: 'Notes' } })
  assert.ok(await entry('Accueil'))
})

test('fichiers envoyés servis en bac à sable (pas de script via un SVG)', async () => {
  fs.mkdirSync(vault('attachments'), { recursive: true })
  fs.writeFileSync(vault('attachments', 'x.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')
  for (const url of ['/attachments/x.svg', '/api/vault-file?name=x.svg']) {
    const res = await fetch(`${BASE}${url}`)
    assert.equal(res.status, 200, url)
    assert.match(res.headers.get('content-security-policy') || '', /sandbox/, url)
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
  }
})

test('un tag piégé ne bloque pas le serveur', async () => {
  // Texte qui ferait exploser l'expression (a+)+$ si le tag n'était pas échappé
  await api(doc('Piège', '/create'), { method: 'POST', body: { type: 'doc' } })
  await api(doc('Piège'), { method: 'POST', body: { markdown: `#${'a'.repeat(40)}!\n` } })
  const start = Date.now()
  const { status } = await api(`/api/tag/${encodeURIComponent('(a+)+$')}`)
  assert.equal(status, 200)
  assert.ok(Date.now() - start < 3000)
})
