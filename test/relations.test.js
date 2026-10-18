// Relations entre bases : lien inverse reporté par le serveur, réciblage après renommage.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startServer, doc } from './helpers.js'
import { validateOps, applyRelationOps } from '../server/db-relations.js'

let y
const base = (rows) => ({
  version: 2,
  schema: { title: { id: 'title', name: 'Nom', type: 'title' } },
  propOrder: ['title'],
  rows,
  rowOrder: Object.keys(rows),
  views: { v1: { id: 'v1', name: 'Tableau', type: 'table' } },
  viewOrder: ['v1'],
})
before(async () => {
  y = await startServer({ YARICHE_STORAGE: 'local' })
  for (const name of ['Projets', 'Tâches']) await y.api(doc(name, '/create'), { method: 'POST', body: { type: 'database' } })
  await y.api(doc('Projets', '/db'), { method: 'POST', body: base({ p1: { title: 'Site' } }) })
  await y.api(doc('Tâches', '/db'), { method: 'POST', body: base({ t1: { title: 'Maquette' }, t2: { title: 'Contenu' } }) })
})
after(() => y.stop())

test('relation dans les deux sens : propriété miroir puis lien reporté', async () => {
  const ensure = await y.api(doc('Projets', '/db/relation'), {
    method: 'POST',
    body: { ops: [{ op: 'ensureProp', prop: { id: 'revTasks', name: 'Tâches', type: 'relation', target: 'Tâches', twoWay: true, reverseProp: 'tasks' } }] },
  })
  assert.equal(ensure.status, 200)
  const link = await y.api(doc('Projets', '/db/relation'), {
    method: 'POST',
    body: { ops: [{ op: 'link', propId: 'revTasks', rowId: 'p1', add: ['t1', 't2'], remove: [] }] },
  })
  assert.deepEqual(link.json, { ok: true, changed: true })
  const db = (await y.api(doc('Projets', '/db'))).json
  assert.equal(db.schema.revTasks.type, 'relation')
  assert.ok(db.propOrder.includes('revTasks'))
  assert.deepEqual(db.rows.p1.revTasks, ['t1', 't2'])
  // Retrait d'un lien ; une deuxième fois : rien ne change
  await y.api(doc('Projets', '/db/relation'), { method: 'POST', body: { ops: [{ op: 'link', propId: 'revTasks', rowId: 'p1', add: [], remove: ['t1'] }] } })
  const again = await y.api(doc('Projets', '/db/relation'), { method: 'POST', body: { ops: [{ op: 'link', propId: 'revTasks', rowId: 'p1', add: [], remove: ['t1'] }] } })
  assert.equal(again.json.changed, false)
  assert.deepEqual((await y.api(doc('Projets', '/db'))).json.rows.p1.revTasks, ['t2'])
})

test('relation : seule une propriété relation peut être touchée', async () => {
  const res = await y.api(doc('Projets', '/db/relation'), { method: 'POST', body: { ops: [{ op: 'dropProp', propId: 'title' }] } })
  assert.equal(res.json.changed, false)
  assert.ok((await y.api(doc('Projets', '/db'))).json.schema.title)
  assert.equal((await y.api(doc('Projets', '/db/relation'), { method: 'POST', body: { ops: [{ op: 'rm -rf' }] } })).status, 400)
  assert.ok([403, 404].includes((await y.api(doc('Inexistante', '/db/relation'), { method: 'POST', body: { ops: [{ op: 'dropProp', propId: 'x' }] } })).status))
})

test('relation : la base liée renommée reste visée', async () => {
  await y.api(doc('Tâches', '/db'), {
    method: 'POST',
    body: { ...base({ t1: { title: 'Maquette' } }), schema: { title: { id: 'title', name: 'Nom', type: 'title' }, proj: { id: 'proj', name: 'Projet', type: 'relation', target: 'Projets', twoWay: true, reverseProp: 'revTasks' } }, propOrder: ['title', 'proj'] },
  })
  const r = await y.api(doc('Projets', '/rename'), { method: 'POST', body: { newName: 'Projets 2026' } })
  assert.equal(r.status, 200)
  const db = (await y.api(doc('Tâches', '/db'))).json
  assert.equal(db.schema.proj.target, 'Projets 2026')
})

test('relation : document Yjs vivant modifié en direct', async () => {
  const Y = await import('yjs')
  const ydoc = new Y.Doc()
  const root = ydoc.getMap('database')
  ydoc.transact(() => {
    const schema = new Y.Map()
    schema.set('rel', { id: 'rel', name: 'Lien', type: 'relation', target: 'X' })
    root.set('schema', schema)
    const order = new Y.Array()
    order.push(['rel'])
    root.set('propOrder', order)
    const rows = new Y.Map()
    const r = new Y.Map()
    rows.set('a', r)
    root.set('rows', rows)
  })
  let written = null
  const json = applyRelationOps({
    ops: validateOps([{ op: 'link', propId: 'rel', rowId: 'a', add: ['z'], remove: [] }]),
    liveDoc: ydoc,
    readJSON: () => null,
    writeJSON: (v) => (written = v),
  })
  assert.deepEqual(root.get('rows').get('a').get('rel'), ['z'])
  assert.deepEqual(written.rows.a.rel, ['z'])
  assert.equal(json.version, 2)
})
