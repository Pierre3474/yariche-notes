// Rangement sur disque façon coffre Obsidian : l'identifiant d'un élément EST son chemin
// dans le coffre, sans extension.
//
//   <coffre>/
//     Accueil.md              page « Accueil »
//     Projet.md               page « Projet »…
//     Projet/                 …et ses sous-pages (« Projet/Spec »)
//       Spec.md
//       Tâches.db.json        base de données « Projet/Tâches » (whiteboard : .board.json)
//     R521/Concepts/          dossier « R521/Concepts » (pas de .md), comme dans Obsidian
//       MIMO.md               page « R521/Concepts/MIMO »
//     attachments/            images collées ou importées
//     .trash/                 corbeille (même convention qu'Obsidian)
//     .yariche/               données internes (méta, versions, commentaires)
//
// Le disque fait foi : un fichier ajouté, déplacé ou supprimé ailleurs (Nextcloud,
// Obsidian, Finder) est répercuté dans Yariche par reconcile().
import fs from 'fs'
import path from 'path'

export const SIDE_FILES = ['.md', '.board.json', '.db.json']
const EXT = { doc: '.md', board: '.board.json', database: '.db.json' }
const TRASH = '.trash'

let VAULT_DIR = null
// { get(id), all(): [id, meta][], create(id, props), remove(id), move(from, to), setInodes(map) }
let meta = null

export function initVault(vaultDir, metaApi) {
  VAULT_DIR = vaultDir
  meta = metaApi
}

export const sideFile = (id, ext) => path.join(VAULT_DIR, `${id}${ext}`)
export const filePath = (id) => sideFile(id, '.md')
export const mainFile = (id, type) => sideFile(id, EXT[type] || '.md')
// Dossier des enfants : un dossier, ou le dossier homonyme d'une page qui a des sous-pages
export const childDir = (id) => path.join(VAULT_DIR, id)
export const nodeDir = (id) => path.dirname(path.join(VAULT_DIR, id))
export const relPath = (abs) => path.relative(VAULT_DIR, abs)

// Identifiant valide : chemin relatif sans « .. », sans segment caché (hors .trash/ à la
// racine), sans double « / » ni caractère de contrôle
export function validId(id) {
  if (typeof id !== 'string' || !id || id.length > 500 || /[\\\0]/.test(id)) return false
  const parts = id.split('/')
  return parts.every((p, i) => p && p !== '.' && p !== '..' && p.trim() === p && (!p.startsWith('.') || (i === 0 && p === TRASH)))
}

const mkdirp = (dir) => fs.mkdirSync(dir, { recursive: true })

// Chemins déplacés par l'app elle-même : le watcher ne doit pas les prendre
// pour des modifications externes
const recentlyMoved = new Map()
function markMoved(p) {
  recentlyMoved.set(p, Date.now())
  setTimeout(() => recentlyMoved.delete(p), 5000)
}
export const movedByApp = (p) => recentlyMoved.has(p)

// Remonte en supprimant les dossiers devenus vides (jamais la racine du coffre ni .trash)
export function pruneEmpty(dir) {
  let current = dir
  while (current.startsWith(VAULT_DIR + path.sep) && path.basename(current) !== TRASH) {
    try {
      if (fs.readdirSync(current).length) return
      fs.rmdirSync(current)
      markMoved(current)
    } catch {
      return
    }
    current = path.dirname(current)
  }
}

function moveEntry(from, to) {
  if (from === to || !fs.existsSync(from)) return
  mkdirp(path.dirname(to))
  if (fs.existsSync(to)) {
    // Collision (reste d'une ancienne suppression) : on garde le plus récent de côté
    fs.renameSync(to, `${to}.${Date.now()}.bak`)
  }
  fs.renameSync(from, to)
  markMoved(from)
  markMoved(to)
}

// Déplace les fichiers d'un élément (et son dossier d'enfants) de fromId vers toId
export function moveNodeFiles(fromId, toId) {
  for (const ext of SIDE_FILES) moveEntry(sideFile(fromId, ext), sideFile(toId, ext))
  moveEntry(childDir(fromId), childDir(toId))
  pruneEmpty(nodeDir(fromId))
}

export function ensureNodeOnDisk(id, type) {
  mkdirp(nodeDir(id))
  if (type === 'folder') mkdirp(childDir(id))
}

/** Supprime définitivement les fichiers d'un élément et tout son dossier d'enfants. */
export function removeFromDisk(id) {
  for (const ext of SIDE_FILES) fs.rmSync(sideFile(id, ext), { force: true })
  fs.rmSync(childDir(id), { recursive: true, force: true })
  pruneEmpty(nodeDir(id))
}

// Dossiers de fichiers joints : pas des dossiers de notes dans l'explorateur
const IGNORED_DIRS = new Set(['uploads', 'attachments', 'node_modules'])
// Anciens fichiers internes restés à la racine d'un coffre (avant .yariche/). Les autres
// noms en « _ » sont des notes ou dossiers normaux (_templates, _prompts d'Obsidian…)
const LEGACY_FILES = new Set(['_meta.json', '_links.json', '_users.json', '_notifications.json'])
export const ignoredName = (name) => name.startsWith('.') || IGNORED_DIRS.has(name) || LEGACY_FILES.has(name)
// Copies de conflit ou fichiers temporaires des clients de synchro : jamais des pages
const TEMP_RE = /(^~\$)|(\.(tmp|part|swp|bak)$)|(\.~lock\.)/i
const FILE_TYPES = [
  ['.board.json', 'board'],
  ['.db.json', 'database'],
  ['.md', 'doc'],
]
const typeOfFile = (name) => FILE_TYPES.find(([ext]) => name.endsWith(ext) && name.length > ext.length)

// Noms en NFC : un fichier créé sur Mac peut arriver décomposé (é = e + ◌́), ce qui
// en ferait une page différente de celle tapée dans le navigateur
function normalizeEntry(dir, name) {
  const nfc = name.normalize('NFC')
  if (nfc === name) return name
  const from = path.join(dir, name)
  const to = path.join(dir, nfc)
  try {
    // macOS (APFS) ignore la forme de normalisation : c'est déjà le même fichier
    if (fs.existsSync(to)) return fs.statSync(to).ino === fs.statSync(from).ino ? nfc : name
    fs.renameSync(from, to)
    return nfc
  } catch {
    return name
  }
}

// Ce qui existe sur le disque : { id: { type, ino } }
function scanDisk() {
  const present = {}
  const walk = (dir, prefix) => {
    let entries = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true }).map((e) => ({
        name: ignoredName(e.name) ? e.name : normalizeEntry(dir, e.name),
        isDir: e.isDirectory(),
        isFile: e.isFile(),
      }))
    } catch {
      return
    }
    const pageNames = new Set()
    for (const e of entries) {
      if (!e.isFile || ignoredName(e.name) || TEMP_RE.test(e.name)) continue
      const match = typeOfFile(e.name)
      if (!match) continue
      const [ext, type] = match
      const name = e.name.slice(0, -ext.length)
      pageNames.add(name)
      let ino = null
      try {
        ino = fs.statSync(path.join(dir, e.name)).ino
      } catch {
        continue
      }
      present[prefix + name] = { type, ino }
    }
    for (const e of entries) {
      if (!e.isDir || ignoredName(e.name)) continue
      const full = path.join(dir, e.name)
      const id = prefix + e.name
      // « Projet.md » + « Projet/ » : les sous-pages de la page, pas un dossier à part
      if (!pageNames.has(e.name)) {
        let ino = null
        try {
          ino = fs.statSync(full).ino
        } catch {
          continue
        }
        present[id] = { type: 'folder', ino }
      }
      walk(full, `${id}/`)
    }
  }
  walk(VAULT_DIR, '')
  return present
}

const depth = (id) => id.split('/').length
const isTrash = (id) => id === TRASH || id.startsWith(`${TRASH}/`)

/**
 * Aligne Yariche sur le disque (le disque fait foi) :
 *  - fichier (.md, .db.json, .board.json) ou dossier inconnu → nouvel élément ;
 *  - élément déplacé ou renommé ailleurs (même inode) → suivi, métadonnées comprises ;
 *  - élément introuvable → retiré (supprimé ailleurs).
 * Idempotent : sans changement externe, ne fait rien.
 */
export function reconcile(defaultOwner) {
  const present = scanDisk()
  const liveEntries = () => meta.all().filter(([id]) => !isTrash(id))
  // Bases et whiteboards jamais enregistrés n'ont pas encore de fichier : on ne les
  // considère disparus que s'ils ont déjà existé sur le disque, ou si leur dossier a disparu
  const isMissing = (id, m) => {
    if (present[id] && present[id].type === (m.type || 'doc')) return false
    if (!present[id] && (m.type === 'board' || m.type === 'database') && !m.ino) return !fs.existsSync(nodeDir(id))
    return true
  }
  const diff = () => {
    const live = new Map(liveEntries())
    return {
      live,
      created: Object.keys(present).filter((id) => !live.has(id)),
      missing: [...live].filter(([id, m]) => isMissing(id, m)).map(([id]) => id),
    }
  }
  let { live, created, missing } = diff()

  // Déplacements (même inode, même type) : le plus haut d'abord, ses descendants suivent
  const moved = []
  const byIno = new Map(created.map((id) => [`${present[id].type}:${present[id].ino}`, id]))
  for (const id of [...missing].sort((a, b) => depth(a) - depth(b))) {
    const m = meta.get(id)
    if (!m?.ino) continue
    const key = `${m.type || 'doc'}:${m.ino}`
    const target = byIno.get(key)
    if (!target || meta.get(target)) continue
    meta.move(id, target)
    moved.push([id, target])
    byIno.delete(key)
  }
  if (moved.length) ({ live, created, missing } = diff())

  // Garde-fou : coffre momentanément vide ou démonté → on ne retire rien
  const removed = []
  const alive = live.size
  if (missing.length && (missing.length < 5 || missing.length <= alive / 2)) {
    for (const id of missing.sort((a, b) => depth(a) - depth(b))) {
      if (meta.get(id)) removed.push(...meta.remove(id))
    }
    ;({ created } = diff())
  } else if (missing.length) {
    console.warn(`[coffre] ${missing.length} élément(s) introuvable(s) sur ${alive} : rien n'est retiré par prudence`)
  }

  // Nouveaux éléments : les parents avant les enfants
  for (const id of created.sort((a, b) => depth(a) - depth(b))) {
    const parent = id.includes('/') ? id.slice(0, id.lastIndexOf('/')) : null
    const owner = (parent && meta.get(parent)?.owner) || defaultOwner
    meta.create(id, { owner, type: present[id].type, ino: present[id].ino })
  }
  meta.setInodes(Object.fromEntries(Object.entries(present).map(([id, p]) => [id, p.ino])))
  return { created, moved, removed }
}

// Fichiers du coffre par nom (intégrations Obsidian ![[photo.png]]) ou par chemin relatif.
// Uniquement des médias : les notes .md ont leurs propres droits d'accès.
export const MEDIA_RE = /\.(png|jpe?g|gif|webp|svg|avif|bmp|pdf)$/i
export function findVaultFile({ name, rel }) {
  if (rel) {
    const abs = path.resolve(VAULT_DIR, rel)
    if (!abs.startsWith(VAULT_DIR + path.sep) || !MEDIA_RE.test(abs)) return null
    if (path.relative(VAULT_DIR, abs).split(path.sep).some((seg) => seg.startsWith('.'))) return null
    return fs.existsSync(abs) ? abs : null
  }
  if (!name || !MEDIA_RE.test(name) || /[/\\]/.test(name)) return null
  // attachments/ d'abord (emplacement par défaut), puis tout le coffre
  const preferred = path.join(VAULT_DIR, 'attachments', name)
  if (fs.existsSync(preferred)) return preferred
  const walk = (dir) => {
    let entries = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return null
    }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue
      if (e.isFile() && e.name === name) return path.join(dir, e.name)
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue
      const hit = walk(path.join(dir, e.name))
      if (hit) return hit
    }
    return null
  }
  return walk(VAULT_DIR)
}
