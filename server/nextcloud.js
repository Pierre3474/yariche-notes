// Nextcloud : parcourir les dossiers (WebDAV) et synchroniser un coffre dans les deux
// sens avec le client officiel en ligne de commande (nextcloudcmd), comme le ferait
// l'application Nextcloud de bureau. Nextcloud voit donc chaque modification
// (versions, activité, notifications aux autres appareils) sans réglage côté serveur.
import fs from 'fs'
import path from 'path'
import { spawn } from 'child_process'

// --- Compte ------------------------------------------------------------------------
// Variables d'environnement prioritaires (déploiement sans interface), sinon réglages.
export function accountFrom(settings) {
  const env = process.env
  if (env.NEXTCLOUD_URL && env.NEXTCLOUD_USER && env.NEXTCLOUD_APP_PASSWORD)
    return { url: env.NEXTCLOUD_URL, user: env.NEXTCLOUD_USER, password: env.NEXTCLOUD_APP_PASSWORD, fromEnv: true }
  const nc = settings.nextcloud
  return nc?.url && nc?.user && nc?.password ? { ...nc, fromEnv: false } : null
}

export const normalizeUrl = (url) => {
  const u = new URL(String(url).trim())
  if (!/^https?:$/.test(u.protocol)) throw new Error('adresse invalide (http:// ou https://)')
  return `${u.origin}${u.pathname.replace(/\/+$/, '').replace(/\/index\.php$/, '')}`
}

// Chemin de dossier normalisé : « /Travail/Notes », « / » pour la racine
export function normalizeFolder(folder) {
  const parts = String(folder || '/')
    .split('/')
    .map((p) => p.trim())
    .filter(Boolean)
  if (parts.some((p) => p === '.' || p === '..')) throw new Error('chemin invalide')
  return `/${parts.join('/')}`
}

const encodePath = (folder) =>
  folder
    .split('/')
    .map((p) => encodeURIComponent(p))
    .join('/')

async function request(account, method, urlPath, { headers = {}, body, timeout = 15000 } = {}) {
  const auth = Buffer.from(`${account.user}:${account.password}`).toString('base64')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  try {
    return await fetch(`${account.url}${urlPath}`, {
      method,
      headers: { Authorization: `Basic ${auth}`, 'OCS-APIRequest': 'true', ...headers },
      body,
      signal: controller.signal,
    })
  } catch (err) {
    throw new Error(err.name === 'AbortError' ? 'Nextcloud ne répond pas' : `Nextcloud injoignable (${err.cause?.code || err.message})`)
  } finally {
    clearTimeout(timer)
  }
}

// Identifiant WebDAV du compte (différent de l'identifiant de connexion avec un SSO)
export async function whoami(account) {
  const r = await request(account, 'GET', '/ocs/v2.php/cloud/user?format=json')
  if (r.status === 401) throw new Error('identifiant ou mot de passe d’application refusé')
  if (!r.ok) throw new Error(`Nextcloud a répondu ${r.status}`)
  const data = (await r.json())?.ocs?.data
  if (!data?.id) throw new Error('réponse Nextcloud inattendue')
  return { id: data.id, name: data['display-name'] || data.displayname || data.id }
}

const decodeXml = (s) =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')

// Sous-dossiers directs d'un dossier Nextcloud
export async function listFolders(account, uid, folder) {
  const base = `/remote.php/dav/files/${encodeURIComponent(uid)}`
  const r = await request(account, 'PROPFIND', `${base}${encodePath(folder)}`, {
    headers: { Depth: '1', 'Content-Type': 'application/xml' },
    body:
      '<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">' +
      '<d:prop><d:resourcetype/><d:getlastmodified/><oc:size/></d:prop></d:propfind>',
  })
  if (r.status === 404) throw new Error('dossier introuvable')
  if (!r.ok) throw new Error(`Nextcloud a répondu ${r.status}`)
  const xml = await r.text()
  const folders = []
  let current = null
  for (const block of xml.split(/<(?:[\w-]+:)?response[\s>]/).slice(1)) {
    if (!/<(?:[\w-]+:)?collection\s*\/?>/.test(block)) continue
    const href = block.match(/<(?:[\w-]+:)?href>([^<]*)</)?.[1]
    if (!href) continue
    const rel = decodeURIComponent(decodeXml(href)).split(`/files/${uid}`)[1] || '/'
    const clean = normalizeFolder(rel)
    const size = Number(block.match(/<(?:[\w-]+:)?size>(\d+)</)?.[1] ?? NaN)
    if (clean === folder) {
      current = Number.isFinite(size) ? size : null
      continue
    }
    folders.push({ name: clean.split('/').pop(), path: clean, size: Number.isFinite(size) ? size : null })
  }
  folders.sort((a, b) => a.name.localeCompare(b.name, 'fr', { sensitivity: 'base' }))
  return { folders, size: current }
}

// Taille d'un dossier Nextcloud (octets), null si inconnue
export async function folderSize(account, uid, folder) {
  const parent = folder.split('/').slice(0, -1).join('/') || '/'
  const { folders } = await listFolders(account, uid, parent)
  return folders.find((f) => f.path === folder)?.size ?? null
}

// Garde-fou : un coffre est copié sur le serveur, un dossier de photos le remplirait
export const MAX_VAULT_BYTES = (Number(process.env.NEXTCLOUD_MAX_VAULT_MB) || 2048) * 1024 * 1024

export async function createFolder(account, uid, folder) {
  const r = await request(account, 'MKCOL', `/remote.php/dav/files/${encodeURIComponent(uid)}${encodePath(folder)}`)
  if (r.status === 405) return // existe déjà
  if (!r.ok) throw new Error(`création impossible (${r.status})`)
}

// --- Connexion par le navigateur (Login Flow v2, comme les applis Nextcloud) ------------
// La personne se connecte sur la page de Nextcloud (SSO, double facteur compris) et
// autorise Yariche : Nextcloud crée alors un mot de passe d'application pour Yariche,
// révocable dans Paramètres → Sécurité. Aucun mot de passe ne transite par Yariche.
const USER_AGENT = 'Yariche'

async function post(url, init = {}) {
  try {
    return await fetch(url, { method: 'POST', ...init, signal: AbortSignal.timeout(15000) })
  } catch (err) {
    throw new Error(`Nextcloud injoignable (${err.cause?.code || err.message})`)
  }
}

export async function startLoginFlow(url) {
  const base = normalizeUrl(url)
  const r = await post(`${base}/index.php/login/v2`, { headers: { 'User-Agent': USER_AGENT } })
  if (r.status === 404) throw new Error('aucun Nextcloud à cette adresse')
  if (!r.ok) throw new Error(`Nextcloud a répondu ${r.status}`)
  const data = await r.json().catch(() => null)
  if (!data?.login || !data?.poll?.token || !data?.poll?.endpoint) throw new Error('réponse Nextcloud inattendue')
  // La page de connexion et le point de suivi doivent être sur ce même Nextcloud
  const host = new URL(base).host
  const flowPage = new URL(data.login)
  if (flowPage.host !== host || new URL(data.poll.endpoint).host !== host)
    throw new Error('réponse Nextcloud inattendue')
  // On passe d'abord par la page de connexion de Nextcloud, qui renvoie ensuite vers
  // l'autorisation : la connexion (SSO compris) a lieu AVANT que Nextcloud ne pose son jeton
  // de sécurité. Sinon, une session périmée dans le navigateur force une connexion au milieu
  // de l'autorisation et Nextcloud répond « Les jetons de statut ne correspondent pas ».
  const login = `${base}/index.php/login?redirect_url=${encodeURIComponent(flowPage.pathname + flowPage.search)}`
  return { base, login, token: data.poll.token, endpoint: data.poll.endpoint }
}

// null tant que l'accès n'a pas été autorisé dans le navigateur
export async function pollLoginFlow(flow) {
  const r = await post(flow.endpoint, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': USER_AGENT },
    body: `token=${encodeURIComponent(flow.token)}`,
  })
  if (r.status === 404) return null
  if (!r.ok) throw new Error(`Nextcloud a répondu ${r.status}`)
  const data = await r.json().catch(() => null)
  if (!data?.loginName || !data?.appPassword) throw new Error('réponse Nextcloud inattendue')
  // L'adresse saisie (joignable depuis le serveur) plutôt que celle annoncée par Nextcloud
  return { url: flow.base, user: data.loginName, password: data.appPassword }
}

// --- Synchronisation ------------------------------------------------------------------
const INTERVAL = Math.max(10, Number(process.env.NEXTCLOUD_SYNC_INTERVAL) || 30) * 1000
const DEBOUNCE = 3000
let job = null

// Jamais envoyé vers Nextcloud (ni rapatrié) : données internes de Yariche, corbeille,
// fichiers temporaires, réglages d'Obsidian. nextcloudcmd synchronise les fichiers cachés
// par défaut, d'où cette liste. Le nom « sync-exclude.lst » compte : sous un autre nom, les
// motifs s'appliqueraient au dossier du fichier et non au dossier synchronisé.
const EXCLUDES = ['.yariche/', '.trash/', '.*.yariche-tmp', '.obsidian/', '.DS_Store', '.~lock.*', '~$*']

export function syncStatus() {
  if (!job) return { enabled: false }
  return {
    enabled: true,
    folder: job.folder,
    server: job.account.url,
    running: !!job.child,
    lastSync: job.lastSync,
  }
}

/**
 * Démarre la synchronisation du coffre `dir` avec le dossier Nextcloud `folder`.
 * `homeDir` : dossier privé où écrire le .netrc (identifiants hors ligne de commande).
 */
export function startSync({ dir, folder, account, uid, homeDir, log = console }) {
  stopSync()
  fs.mkdirSync(homeDir, { recursive: true, mode: 0o700 })
  const host = new URL(account.url).hostname
  fs.writeFileSync(path.join(homeDir, '.netrc'), `machine ${host}\nlogin ${uid}\npassword ${account.password}\n`, {
    mode: 0o600,
  })
  const excludeFile = path.join(homeDir, 'sync-exclude.lst')
  fs.writeFileSync(excludeFile, `${EXCLUDES.join('\n')}\n`)
  job = { dir, folder, account, uid, homeDir, excludeFile, log, child: null, pending: false, timer: null, lastSync: null }
  job.interval = setInterval(() => requestSync(0), INTERVAL)
  requestSync(0)
}

export function stopSync() {
  if (!job) return
  clearInterval(job.interval)
  clearTimeout(job.timer)
  job.child?.kill('SIGTERM')
  job = null
}

// Demande une synchronisation (après une modification locale : petit délai pour grouper)
export function requestSync(delay = DEBOUNCE) {
  if (!job) return
  if (job.child) {
    job.pending = true
    return
  }
  clearTimeout(job.timer)
  job.timer = setTimeout(runSync, delay)
}

function runSync() {
  const current = job
  if (!current || current.child) return
  const started = Date.now()
  const args = ['--non-interactive', '-n', '--exclude', current.excludeFile, '--max-sync-retries', '3', '--path', current.folder]
  if (process.env.NEXTCLOUD_TRUST_SELF_SIGNED === '1') args.push('--trust')
  args.push(current.dir, current.account.url)
  let output = ''
  let child
  try {
    child = spawn('nextcloudcmd', args, {
      env: { ...process.env, HOME: current.homeDir, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (err) {
    current.lastSync = { at: Date.now(), ok: false, error: `nextcloudcmd introuvable (${err.message})` }
    return
  }
  current.child = child
  // Sortie détaillée de nextcloudcmd : on garde la fin, où figurent les erreurs par fichier
  const keep = (chunk) => {
    output = (output + chunk.toString()).slice(-60000)
  }
  child.stdout.on('data', keep)
  child.stderr.on('data', keep)
  const killer = setTimeout(() => child.kill('SIGKILL'), 10 * 60 * 1000)
  const finish = (code, error) => {
    clearTimeout(killer)
    if (job !== current) return // coffre changé entre-temps
    current.child = null
    const ok = code === 0 && !error
    const reason = error || lastMeaningfulLine(output) || `code ${code}`
    if (!ok && current.lastSync?.ok !== false) current.log.warn(`[nextcloud] échec de synchronisation : ${reason}`)
    current.lastSync = { at: Date.now(), ok, error: ok ? null : reason, duration: Date.now() - started }
    if (current.pending) {
      current.pending = false
      requestSync(1000)
    }
  }
  child.on('error', (err) =>
    finish(-1, err.code === 'ENOENT' ? 'nextcloudcmd n’est pas installé sur le serveur' : err.message)
  )
  child.on('close', (code) => finish(code))
}

// Message utile dans la sortie de nextcloudcmd : l'erreur d'un fichier (« … and error:
// "Network error: 99" ») plutôt qu'une ligne de journal quelconque
function lastMeaningfulLine(output) {
  const lines = output
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  for (const line of [...lines].reverse()) {
    const item = line.match(/propagation of "([^"]+)".*error: "([^"]+)"/)
    if (item) return `${item[1]} : ${item[2]}`.slice(0, 300)
  }
  const err = [...lines].reverse().find((l) => /\b(error|erreur|fail|denied|unauthori|refus)/i.test(l) && !/\binfo\b/.test(l))
  return (err || lines.pop() || '').replace(/^\S+ \S+ \[[^\]]+\]:\s*/, '').slice(0, 300)
}
