// Outils communs aux tests : un vrai serveur Yariche sur un dossier temporaire.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
export const doc = (room, suffix = '') => `/api/doc/${encodeURIComponent(room)}${suffix}`

// Attend qu'une condition devienne vraie (surveillance du disque, ~1 s)
export async function eventually(check, timeout = 10000) {
  const start = Date.now()
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() - start > timeout) throw new Error('délai dépassé')
    await sleep(150)
  }
}

// Démarre un serveur (sans SSO par défaut) ; env : variables en plus, ou fonction
// (base) => variables quand elles dépendent de l'adresse du serveur ; prepare(dataDir) :
// contenu à poser avant le démarrage
// Port libre donné par le système (un port tiré au hasard peut être déjà pris)
const freePort = () =>
  new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })

export async function startServer(env = {}, { prepare } = {}) {
  const port = await freePort()
  const base = `http://127.0.0.1:${port}`
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yariche-test-'))
  prepare?.(dataDir)
  const extra = typeof env === 'function' ? env(base) : env
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: { ...process.env, DATA_DIR: dataDir, PORT: String(port), OIDC_ISSUER: '', AUTHENTIK_ISSUER: '', ...extra },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let log = ''
  let exited = false
  child.stdout.on('data', (d) => (log += d))
  child.stderr.on('data', (d) => (log += d))
  child.on('exit', () => (exited = true))
  // Prêt quand CE serveur annonce son port (pas un autre qui l'occuperait) et répond
  await eventually(async () => {
    if (exited) throw new Error('arrêté')
    if (!log.includes(`localhost:${port}`)) return false
    try {
      return (await fetch(`${base}/favicon.svg`)).status > 0
    } catch {
      return false
    }
  }, 15000).catch(() => {
    // Sans ça, le processus du serveur resterait en vie et le test ne finirait jamais
    child.kill()
    fs.rmSync(dataDir, { recursive: true, force: true })
    throw new Error(`le serveur ne démarre pas :\n${log}`)
  })

  async function api(p, { method = 'GET', body, headers = {} } = {}) {
    const res = await fetch(`${base}${p}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await res.text()
    let json = null
    try {
      json = JSON.parse(text)
    } catch {
      json = null
    }
    return { status: res.status, json, text }
  }

  return {
    base,
    dataDir,
    api,
    log: () => log,
    stop() {
      child.kill()
      fs.rmSync(dataDir, { recursive: true, force: true })
    },
  }
}

// Navigateur minimal : cookies de session conservés, redirections suivies à la main
export function browser(base) {
  const jar = new Map()
  const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ')
  const store = (res) => {
    for (const c of res.headers.getSetCookie?.() || []) {
      const [pair] = c.split(';')
      const i = pair.indexOf('=')
      jar.set(pair.slice(0, i), pair.slice(i + 1))
    }
  }
  async function request(url, { method = 'GET', body, headers = {}, follow = true, form } = {}) {
    let target = url.startsWith('http') ? url : `${base}${url}`
    let init = {
      method,
      redirect: 'manual',
      headers: {
        ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      body: form ? new URLSearchParams(form).toString() : body === undefined ? undefined : JSON.stringify(body),
    }
    for (let hops = 0; hops < 10; hops++) {
      const sameHost = target.startsWith(base)
      const res = await fetch(target, { ...init, headers: { ...init.headers, ...(sameHost && jar.size ? { Cookie: cookieHeader() } : {}) } })
      if (sameHost) store(res)
      const location = res.headers.get('location')
      // Redirection vers une app (yariche://…) : c'est la fin du parcours dans le navigateur
      const leavesWeb = location && !/^https?:$/.test(new URL(location, target).protocol)
      if (!follow || !location || leavesWeb || res.status < 300 || res.status >= 400) {
        const text = await res.text()
        let json = null
        try {
          json = JSON.parse(text)
        } catch {
          json = null
        }
        return { status: res.status, json, text, url: target, location }
      }
      target = new URL(location, target).href
      init = { method: 'GET', redirect: 'manual', headers: {} }
    }
    throw new Error('trop de redirections')
  }
  return { request, cookies: () => cookieHeader() }
}
