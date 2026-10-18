import test from 'node:test'
import assert from 'node:assert/strict'
import { isPublicAddress, checkUrl, parseMetadata, unfurl } from '../server/unfurl.js'

test('aperçu de lien : adresses privées refusées', () => {
  for (const a of ['127.0.0.1', '10.0.20.1', '192.168.1.10', '172.16.5.4', '169.254.169.254', '100.64.0.5', '0.0.0.0', '::1', 'fe80::1', 'fd00::1', '::ffff:10.0.0.1'])
    assert.equal(isPublicAddress(a), false, a)
  for (const a of ['8.8.8.8', '1.1.1.1', '2a01:4f8::1', '::ffff:8.8.8.8']) assert.equal(isPublicAddress(a), true, a)
})

test('aperçu de lien : schémas, ports et identifiants refusés', () => {
  for (const u of ['file:///etc/passwd', 'ftp://example.com/', 'https://example.com:22/', 'https://user:pw@example.com/', 'pas une url'])
    assert.throws(() => checkUrl(u), u)
  assert.equal(checkUrl('https://example.com/a?b=1').href, 'https://example.com/a?b=1')
})

test('aperçu de lien : connexion locale refusée avant toute requête', async () => {
  await assert.rejects(unfurl('http://127.0.0.1/'), /privée/)
  await assert.rejects(unfurl('http://localhost/'), /privée/)
})

test('aperçu de lien : lecture Open Graph', () => {
  const html = `<html><head><title>Titre &amp; HTML</title>
    <meta property="og:title" content="Titre OG">
    <meta name="description" content="Desc &#233;t&eacute;">
    <meta property="og:image" content="/img/cover.png">
    <link rel="icon" href="/fav.png"></head><body></body></html>`
  const d = parseMetadata(html, 'https://site.example/page')
  assert.equal(d.title, 'Titre OG')
  assert.equal(d.description, 'Desc été')
  assert.equal(d.image, 'https://site.example/img/cover.png')
  assert.equal(d.favicon, 'https://site.example/fav.png')
  assert.equal(parseMetadata('<title>Seul</title>', 'https://a.example/').title, 'Seul')
  // Pas de javascript: en image
  assert.equal(parseMetadata('<meta property="og:image" content="javascript:alert(1)">', 'https://a.example/').image, '')
})
