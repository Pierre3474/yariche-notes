// Aperçu d'un lien pour les signets (titre, description, image, icône), récupéré par le
// serveur (le navigateur ne contacte pas le site). Le serveur tourne souvent dans un
// réseau privé : jamais de requête vers une adresse locale, privée ou réservée, y compris
// après une redirection ou une résolution DNS piégée (on se connecte à l'IP vérifiée).
import dns from 'node:dns/promises'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'

const TIMEOUT_MS = 5000
const MAX_HTML = 512 * 1024
const MAX_IMAGE = 4 * 1024 * 1024
const MAX_REDIRECTS = 3
const USER_AGENT = 'Mozilla/5.0 (compatible; YaricheBot/1.0; +link preview)'

const blockList = new net.BlockList()
for (const [addr, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
])
  blockList.addSubnet(addr, prefix, 'ipv4')
for (const [addr, prefix] of [
  ['::', 128], ['::1', 128], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64],
  ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
])
  blockList.addSubnet(addr, prefix, 'ipv6')

// (Une règle ::ffff:0:0/96 dans la BlockList bloquerait aussi toute l'IPv4 : les adresses
// IPv4 écrites en IPv6 sont ramenées à leur forme IPv4)
export function isPublicAddress(address) {
  const mapped = String(address).match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)
  if (mapped) return isPublicAddress(mapped[1])
  const family = net.isIP(address)
  if (!family) return false
  if (family === 6 && /^::ffff:/i.test(address)) return false
  return !blockList.check(address, family === 6 ? 'ipv6' : 'ipv4')
}

export class UnfurlError extends Error {}

// URL acceptée : http(s), ports web standard, pas d'identifiants dans l'adresse
export function checkUrl(raw) {
  let url
  try {
    url = new URL(String(raw).trim())
  } catch {
    throw new UnfurlError('adresse invalide')
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new UnfurlError('seules les adresses http(s) sont acceptées')
  if (url.username || url.password) throw new UnfurlError('adresse avec identifiants refusée')
  if (url.port && !['80', '443', '8080', '8443'].includes(url.port)) throw new UnfurlError('port refusé')
  return url
}

async function publicAddressOf(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '')
  const records = net.isIP(host) ? [{ address: host, family: net.isIP(host) }] : await dns.lookup(host, { all: true, verbatim: true })
  if (!records.length || !records.every((r) => isPublicAddress(r.address)))
    throw new UnfurlError('adresse privée ou réservée refusée')
  return records[0]
}

// Une requête GET vers une IP déjà vérifiée ; renvoie au plus `max` octets du corps
async function fetchOnce(url, { max, accept }) {
  const target = await publicAddressOf(url.hostname)
  const client = url.protocol === 'https:' ? https : http
  return new Promise((resolve, reject) => {
    const req = client.request(
      url,
      {
        method: 'GET',
        headers: { 'User-Agent': USER_AGENT, Accept: accept, 'Accept-Language': 'fr,en;q=0.8' },
        // Connexion à l'adresse contrôlée, pas à une seconde résolution DNS
        // (Node 20+ demande parfois toutes les adresses : option « all »)
        lookup: (_host, opts, cb) =>
          opts?.all ? cb(null, [{ address: target.address, family: target.family }]) : cb(null, target.address, target.family),
        timeout: TIMEOUT_MS,
      },
      (res) => {
        const chunks = []
        let size = 0
        res.on('data', (chunk) => {
          size += chunk.length
          if (size > max) {
            chunks.push(chunk.subarray(0, chunk.length - (size - max)))
            res.destroy()
            return
          }
          chunks.push(chunk)
        })
        const done = () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks), truncated: size > max })
        res.on('end', done)
        res.on('close', done)
        res.on('error', reject)
      }
    )
    req.on('timeout', () => req.destroy(new UnfurlError('délai dépassé')))
    req.on('error', reject)
    req.end()
  })
}

async function fetchFollowing(raw, options) {
  let url = checkUrl(raw)
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const res = await fetchOnce(url, options)
    if (res.status >= 300 && res.status < 400 && res.headers.location) {
      url = checkUrl(new URL(res.headers.location, url).href)
      continue
    }
    return { ...res, url }
  }
  throw new UnfurlError('trop de redirections')
}

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', eacute: 'é', egrave: 'è', ecirc: 'ê', agrave: 'à',
  acirc: 'â', ccedil: 'ç', ocirc: 'ô', icirc: 'î', ugrave: 'ù', ucirc: 'û', euml: 'ë', iuml: 'ï', rsquo: '’',
  lsquo: '‘', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»', hellip: '…', mdash: '—', ndash: '–', middot: '·',
}
const decode = (s) =>
  String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(Number.parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n] ?? ENTITIES[n.toLowerCase()] ?? m)
const clean = (s, max) => {
  const v = decode(s || '').replace(/\s+/g, ' ').trim()
  return v.length > max ? `${v.slice(0, max - 1)}…` : v
}

function attrsOf(tag) {
  const attrs = {}
  for (const m of tag.matchAll(/([a-zA-Z:-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/g)) attrs[m[1].toLowerCase()] = m[3] ?? m[4] ?? m[5] ?? ''
  return attrs
}

// Métadonnées Open Graph / Twitter / HTML d'une page (lecture par expressions : pas de
// DOM côté serveur, et seul l'en-tête nous intéresse)
export function parseMetadata(html, baseUrl) {
  const head = html.slice(0, MAX_HTML)
  const meta = {}
  for (const m of head.matchAll(/<meta\b[^>]*>/gi)) {
    const a = attrsOf(m[0])
    const key = (a.property || a.name || '').toLowerCase()
    if (key && a.content !== undefined && !(key in meta)) meta[key] = a.content
  }
  let icon = null
  for (const m of head.matchAll(/<link\b[^>]*>/gi)) {
    const a = attrsOf(m[0])
    const rel = (a.rel || '').toLowerCase().split(/\s+/)
    if (a.href && (rel.includes('icon') || rel.includes('apple-touch-icon'))) {
      icon = a.href
      if (rel.includes('apple-touch-icon')) break
    }
  }
  const titleTag = head.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]
  const abs = (u) => {
    if (!u) return ''
    try {
      const v = new URL(decode(u).trim(), baseUrl)
      return ['http:', 'https:'].includes(v.protocol) ? v.href : ''
    } catch {
      return ''
    }
  }
  return {
    url: baseUrl,
    title: clean(meta['og:title'] || meta['twitter:title'] || titleTag || '', 200),
    description: clean(meta['og:description'] || meta['twitter:description'] || meta.description || '', 300),
    image: abs(meta['og:image'] || meta['og:image:url'] || meta['twitter:image'] || meta['twitter:image:src']),
    favicon: abs(icon || '/favicon.ico'),
  }
}

export async function unfurl(raw) {
  const res = await fetchFollowing(raw, { max: MAX_HTML, accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5' })
  const url = res.url.href
  const type = String(res.headers['content-type'] || '')
  if (res.status >= 400 || !/html|xml/i.test(type)) {
    const host = res.url.hostname.replace(/^www\./, '')
    return { url, title: host, description: '', image: '', favicon: new URL('/favicon.ico', res.url).href }
  }
  const charset = type.match(/charset=([\w-]+)/i)?.[1]?.toLowerCase()
  let html
  try {
    html = new TextDecoder(charset || 'utf-8').decode(res.body)
  } catch {
    html = res.body.toString('utf8')
  }
  const data = parseMetadata(html, url)
  if (!data.title) data.title = res.url.hostname.replace(/^www\./, '')
  return data
}

// Images d'aperçu passées par le serveur : la CSP de l'app n'autorise que ses propres
// images, et le navigateur n'envoie ainsi aucune requête à un site tiers. Pas de SVG.
const IMAGE_TYPES = /^image\/(png|jpe?g|gif|webp|avif|x-icon|vnd\.microsoft\.icon|bmp)$/i
const imageCache = new Map() // url -> { type, body, at }
export async function fetchPreviewImage(raw) {
  const key = checkUrl(raw).href
  const hit = imageCache.get(key)
  if (hit && Date.now() - hit.at < 6 * 3600 * 1000) return hit
  const res = await fetchFollowing(key, { max: MAX_IMAGE, accept: 'image/avif,image/webp,image/png,image/*;q=0.8' })
  const type = String(res.headers['content-type'] || '').split(';')[0].trim()
  if (res.status >= 400 || res.truncated || !IMAGE_TYPES.test(type)) throw new UnfurlError('image indisponible')
  const entry = { type, body: res.body, at: Date.now() }
  imageCache.set(key, entry)
  // Cache borné : les plus anciennes sortent
  while (imageCache.size > 200) imageCache.delete(imageCache.keys().next().value)
  return entry
}
