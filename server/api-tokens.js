// Jetons d'accès personnels : une IA (serveur MCP) ou un script agit au nom de la personne
// qui a créé le jeton, avec ses droits. Seule l'empreinte SHA-256 est gardée : le jeton
// n'est montré qu'une fois, à sa création.
import fs from 'fs'
import path from 'path'
import { createHash, randomBytes } from 'crypto'

const SCOPES = new Set(['read', 'write'])
let file = null
let tokens = []
let loadedMtime = 0

const hash = (token) => createHash('sha256').update(String(token)).digest('hex')

export function initApiTokens(dataDir) {
  file = path.join(dataDir, 'api-tokens.json')
  load()
}

// Relu s'il a changé sur le disque (jeton créé ou révoqué par la ligne de commande)
function load() {
  try {
    const mtime = fs.statSync(file).mtimeMs
    if (mtime === loadedMtime) return
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    tokens = Array.isArray(parsed) ? parsed : []
    loadedMtime = mtime
  } catch {
    if (!fs.existsSync(file)) tokens = []
  }
}

function persist() {
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(tokens, null, 2), { mode: 0o600 })
  fs.renameSync(tmp, file)
  loadedMtime = fs.statSync(file).mtimeMs
}

const publicView = ({ id, name, owner, scope, createdAt, lastUsedAt }) => ({ id, name, owner, scope, createdAt, lastUsedAt: lastUsedAt || null })

export function createApiToken(owner, name, scope = 'read') {
  load()
  const cleanName = String(name || '').trim().slice(0, 80) || 'Jeton'
  if (!owner) throw new Error('propriétaire manquant')
  if (!SCOPES.has(scope)) throw new Error('portée invalide (read ou write)')
  if (tokens.filter((t) => t.owner === owner).length >= 20) throw new Error('20 jetons au plus : révoque ceux qui ne servent plus')
  const token = `yar_${randomBytes(32).toString('base64url')}`
  const entry = { id: randomBytes(6).toString('hex'), name: cleanName, owner, scope, hash: hash(token), createdAt: Date.now(), lastUsedAt: null }
  tokens.push(entry)
  persist()
  return { token, ...publicView(entry) }
}

export function listApiTokens(owner) {
  load()
  return tokens.filter((t) => !owner || t.owner === owner).map(publicView)
}

export function revokeApiToken(owner, id) {
  load()
  const before = tokens.length
  tokens = tokens.filter((t) => !(t.id === id && (!owner || t.owner === owner)))
  if (tokens.length === before) return false
  persist()
  return true
}

// Jeton présenté → entrée (sans l'empreinte), ou null
export function verifyApiToken(token) {
  if (typeof token !== 'string' || !token.startsWith('yar_') || token.length > 100) return null
  load()
  const h = hash(token)
  const entry = tokens.find((t) => t.hash === h)
  if (!entry) return null
  // Dernière utilisation : notée au plus une fois par minute (pas d'écriture à chaque appel)
  if (!entry.lastUsedAt || Date.now() - entry.lastUsedAt > 60_000) {
    entry.lastUsedAt = Date.now()
    persist()
  }
  return publicView(entry)
}
