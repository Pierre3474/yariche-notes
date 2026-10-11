// Migration d'un coffre v1 (éléments repérés par un nom unique + pointeur parent) vers
// l'identification par chemin (v2) : fichiers intacts, métadonnées, commentaires,
// versions, liens et corbeille repris.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { startServer, doc } from './helpers.js'

let server
const meta = (extra = {}) => ({
  owner: 'dev@local',
  type: 'doc',
  parent: null,
  visibility: 'private',
  linkRole: 'viewer',
  shares: {},
  appearance: { icon: null, cover: null },
  createdAt: 1,
  deletedAt: null,
  ...extra,
})

before(async () => {
  server = await startServer(
    { YARICHE_STORAGE: 'local' },
    {
      prepare: (dataDir) => {
        const v = path.join(dataDir, 'vaults', 'Notes')
        const internal = path.join(v, '.yariche')
        const write = (rel, content) => {
          fs.mkdirSync(path.dirname(path.join(v, rel)), { recursive: true })
          fs.writeFileSync(path.join(v, rel), content)
        }
        write('Projet.md', 'Voir [[Spec]]\n')
        write('Projet/Spec.md', 'spécification\n')
        write('Travail/Réunion.md', 'réunion\n')
        write('.trash/Vieux.md', 'supprimé\n')
        write('.trash/Vieux/Vieux enfant.md', 'enfant supprimé\n')
        write('.yariche/comments/Spec.json', JSON.stringify({ t1: { text: 'avant migration' } }))
        write('.yariche/versions/Spec/2026-01-01T00-00-00-000Z.md', 'ancienne version\n')
        write('.yariche/links.json', JSON.stringify({ Projet: ['Spec'] }))
        fs.writeFileSync(
          path.join(internal, 'meta.json'),
          JSON.stringify({
            Projet: meta({ appearance: { icon: '📁', cover: null } }),
            Spec: meta({ parent: 'Projet' }),
            Travail: meta({ type: 'folder' }),
            Réunion: meta({ parent: 'Travail' }),
            Vieux: meta({ parent: 'Travail', deletedAt: 5, trashRoot: true }),
            'Vieux enfant': meta({ parent: 'Vieux', deletedAt: 5, trashedWith: 'Vieux', trashRoot: false }),
          })
        )
      },
    }
  )
})

after(() => server?.stop())

test('ids par chemin, fichiers et données internes repris', async () => {
  const { api, dataDir } = server
  const docs = (await api('/api/docs')).json
  const byId = Object.fromEntries(docs.map((d) => [d.room, d]))
  assert.deepEqual(Object.keys(byId).sort(), ['Projet', 'Projet/Spec', 'Travail', 'Travail/Réunion'])
  assert.equal(byId['Projet'].icon, '📁')
  assert.equal(byId['Projet/Spec'].parent, 'Projet')
  assert.equal((await api(doc('Projet/Spec'))).json.content, 'spécification\n')
  assert.deepEqual((await api(doc('Projet/Spec', '/comments'))).json, { t1: { text: 'avant migration' } })
  assert.equal((await api(doc('Projet/Spec', '/versions'))).json.versions.length, 1)
  assert.deepEqual((await api(doc('Projet/Spec', '/backlinks'))).json.backlinks, ['Projet'])
  assert.ok(fs.existsSync(path.join(dataDir, 'vaults', 'Notes', '.yariche', 'meta.v1.json')))

  const trash = (await api('/api/trash')).json
  assert.equal(trash.length, 1)
  assert.equal(trash[0].room, '.trash/Vieux')
  assert.deepEqual(trash[0].path, ['Travail'])
  const restored = await api(doc('.trash/Vieux', '/restore'), { method: 'POST' })
  assert.equal(restored.json.room, 'Travail/Vieux')
  assert.equal((await api(doc('Travail/Vieux/Vieux enfant'))).json.content, 'enfant supprimé\n')
})
