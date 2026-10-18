// Envoi de fichiers : images, PDF et pièces jointes ; PDF lisible dans le navigateur, le reste
// téléchargé en bac à sable.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startServer } from './helpers.js'

let y
before(async () => {
  y = await startServer({ YARICHE_STORAGE: 'local' })
  await y.api('/api/doc/Page/create', { method: 'POST', body: { type: 'doc' } })
})
after(() => y.stop())

const send = async (name, type, bytes) => {
  const form = new FormData()
  form.append('file', new Blob([bytes], { type }), name)
  const res = await fetch(`${y.base}/api/doc/Page/upload`, { method: 'POST', body: form })
  return { status: res.status, body: await res.json().catch(() => ({})) }
}
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n')
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')

test('un PDF valide est accepté et servi avec le lecteur PDF du navigateur', async () => {
  const res = await send('Mon cours.pdf', 'application/pdf', PDF)
  assert.equal(res.status, 200)
  assert.match(res.body.url, /^attachments\/Mon-cours-\d+\.pdf$/)
  const file = await fetch(`${y.base}/${res.body.url}`)
  assert.equal(file.status, 200)
  assert.equal(file.headers.get('content-type'), 'application/pdf')
  assert.equal(file.headers.get('x-content-type-options'), 'nosniff')
  // Pas de bac à sable CSP : il empêcherait le lecteur PDF de s'ouvrir
  assert.ok(!file.headers.get('content-security-policy')?.includes('sandbox'))
})

test('un faux PDF (mauvais contenu) est refusé et supprimé', async () => {
  const res = await send('faux.pdf', 'application/pdf', Buffer.from('<script>alert(1)</script>'))
  assert.equal(res.status, 400)
})

test('une image reste acceptée et reste en bac à sable', async () => {
  const res = await send('photo.png', 'image/png', PNG)
  assert.equal(res.status, 200)
  const file = await fetch(`${y.base}/${res.body.url}`)
  assert.ok(file.headers.get('content-security-policy')?.includes('sandbox'))
})

test('les autres fichiers sont acceptés et servis en téléchargement, en bac à sable', async () => {
  for (const [name, type, bytes] of [['page.html', 'text/html', Buffer.from('<h1>x</h1>')], ['archive.zip', 'application/zip', Buffer.from('PK')]]) {
    const res = await send(name, type, bytes)
    assert.equal(res.status, 200)
    const file = await fetch(`${y.base}/${res.body.url}`)
    assert.match(file.headers.get('content-disposition') || '', /^attachment/)
    assert.ok(file.headers.get('content-security-policy')?.includes('sandbox'))
  }
})

test('un « .pdf » annoncé sous un autre type doit quand même être un PDF', async () => {
  const res = await send('piege.pdf', 'application/octet-stream', Buffer.from('<script>alert(1)</script>'))
  assert.equal(res.status, 400)
})
