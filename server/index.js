import express from 'express'
import http from 'http'
import { WebSocketServer } from 'ws'
import { setupWSConnection, docs as liveDocs } from 'y-websocket/bin/utils'
import * as decoding from 'lib0/decoding'
import chokidar from 'chokidar'
import fs from 'fs'
import path from 'path'
import { randomUUID, randomBytes, timingSafeEqual } from 'crypto'
import multer from 'multer'
import { fileURLToPath } from 'url'
import {
  sessionMiddleware,
  initAuth,
  registerAuthRoutes,
  requireAuth,
  runSessionMiddleware,
  isDevMode,
  authKind,
  loginRestricted,
  messagePage,
  escapeHtml,
  DEV_USER_EMAIL,
} from './auth.js'
import {
  initMetaStore,
  initLinksIndex,
  ensureDocMeta,
  getDocMeta,
  updateShareSettings,
  updateAppearance,
  listRoomsForUser,
  getRole,
  canEdit,
  setLinks,
  setLinksMany,
  hasLinks,
  getBacklinks,
  getGraphData,
  duplicateDoc,
  listTrashForUser,
  setFavorite,
  allKnownEmails,
  createMeta,
  removeMeta,
  setShareLink,
  reassignOwner,
  reassignInMeta,
  allMetaEntries,
  descendantsOf,
  moveSubtree,
  markTrashed,
  clearTrashed,
  setInodes,
  resolveLink,
  linkTextsTo,
  isTrashId,
  parentIdOf,
  baseName,
  TRASH,
} from './meta-store.js'
import {
  initVault,
  nodeDir,
  filePath,
  sideFile,
  mainFile,
  moveNodeFiles,
  ensureNodeOnDisk,
  removeFromDisk,
  childDir,
  relPath,
  findVaultFile,
  reconcile,
  movedByApp,
  validId,
  SIDE_FILES,
} from './vault.js'
import { migrateVaultToV2 } from './migrate-v2.js'
import { initApiTokens, createApiToken, listApiTokens, revokeApiToken, verifyApiToken } from './api-tokens.js'
import { registerMcp } from './mcp.js'
import { storageKey } from './storage-key.js'
import { initVersionStore, snapshotVersion, listVersions, readVersion } from './version-store.js'
import {
  initSocialStore,
  touchUser,
  listUsers,
  addNotification,
  listNotifications,
  markNotificationsRead,
  renameRoomInNotifications,
  dropRoomNotifications,
} from './social-store.js'
import { initSettings, getSettings, updateSettings, isAdmin } from './settings.js'
import { initAccounts } from './accounts.js'
import {
  accountFrom,
  normalizeUrl,
  normalizeFolder,
  whoami,
  listFolders,
  folderSize,
  MAX_VAULT_BYTES,
  createFolder,
  startLoginFlow,
  pollLoginFlow,
  startSync,
  stopSync,
  requestSync,
  syncStatus,
} from './nextcloud.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// DATA_DIR : état du serveur (sessions, utilisateurs, réglages) ; les coffres sont dans VAULTS_DIR
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'))
// VAULT_DIR : un seul coffre, dans ce dossier (mode local de l'app Mac : le dossier Nextcloud
// du Mac) ; sinon les coffres sont les dossiers de VAULTS_DIR
const VAULT_DIR = process.env.VAULT_DIR ? path.resolve(process.env.VAULT_DIR) : null
const VAULTS_DIR = VAULT_DIR ? path.dirname(VAULT_DIR) : path.resolve(process.env.VAULTS_DIR || path.join(DATA_DIR, 'vaults'))
const DEFAULT_VAULT = VAULT_DIR ? path.basename(VAULT_DIR) : process.env.DEFAULT_VAULT || 'Notes'
// Données internes (métadonnées, versions, commentaires) hors du coffre : rien de plus n'est
// synchronisé par le client Nextcloud du Mac. Par défaut : <coffre>/.yariche
const INTERNAL_BASE = process.env.YARICHE_INTERNAL_DIR ? path.resolve(process.env.YARICHE_INTERNAL_DIR) : null
// Mode local de l'app Mac : serveur sur 127.0.0.1, ouvert seulement avec le secret de l'app
const HOST = process.env.HOST || undefined
const LOCAL_TOKEN = process.env.YARICHE_LOCAL_TOKEN || null
// Où vivent les notes : « nextcloud » (toujours dans un dossier Nextcloud, le serveur n'en
// garde qu'une copie de travail synchronisée), « local » (sur ce serveur), « ask »
// (choix au premier lancement, Nextcloud proposé d'abord)
const STORAGE = ['nextcloud', 'local', 'ask'].includes(process.env.YARICHE_STORAGE) ? process.env.YARICHE_STORAGE : 'ask'
const nextcloudOnly = STORAGE === 'nextcloud'
const PORT = process.env.PORT || 5174
// Assistant IA : n'importe quelle API compatible OpenAI (LiteLLM, Ollama, vLLM, OpenAI…)
const LLM_BASE_URL = (process.env.LLM_BASE_URL || process.env.LLM_GATEWAY_URL || '').replace(/\/+$/, '')
const LLM_MODEL = process.env.LLM_MODEL || ''
const LLM_API_KEY = process.env.LLM_API_KEY || ''

fs.mkdirSync(DATA_DIR, { recursive: true })
initSettings(DATA_DIR)
initAccounts(DATA_DIR)
initSocialStore(DATA_DIR)
initApiTokens(DATA_DIR)

// Propriétaire des fichiers ajoutés hors de Yariche (Nextcloud, Obsidian, Finder)
function defaultOwner() {
  if (process.env.YARICHE_DEFAULT_OWNER) return process.env.YARICHE_DEFAULT_OWNER
  const oldest = allMetaEntries()
    .filter(([, m]) => m.owner)
    .sort((a, b) => (a[1].createdAt || 0) - (b[1].createdAt || 0))[0]
  // Sans connexion (usage local, mode local de l'app Mac) : l'utilisateur unique
  return oldest ? oldest[1].owner : getSettings().firstUser || (isDevMode ? DEV_USER_EMAIL : 'dev@local')
}

// Tolère la forme échappée \[\[Page\]\] écrite par les versions précédentes
function extractWikilinks(markdown) {
  const matches = [...markdown.matchAll(/\\?\[\\?\[([^\]|#\\]+)/g)]
  return matches.map((m) => m[1].trim()).filter(Boolean)
}

// --- Coffres ------------------------------------------------------------------------
// Un coffre = un dossier de VAULTS_DIR (comme un coffre Obsidian), éventuellement
// synchronisé avec un dossier Nextcloud. Un seul est ouvert à la fois.
let VAULT = null // { id, dir, internal }
const sameSecret = (a, b) => {
  const x = Buffer.from(String(a))
  const y = Buffer.from(String(b))
  return x.length === y.length && timingSafeEqual(x, y)
}
const localHostOk = (req) => [`127.0.0.1:${PORT}`, `localhost:${PORT}`].includes(req.headers.host)
const hasLocalCookie = (req) =>
  (req.headers.cookie || '').split(';').some((c) => sameSecret(c.trim(), `yariche_local=${LOCAL_TOKEN}`))
const validVaultName = (name) =>
  typeof name === 'string' && name.trim() && name.length <= 100 && !/[/\\\0]/.test(name) && !name.startsWith('.')

function listVaults() {
  const all = listAllVaults()
  // Mode Nextcloud : seuls les dossiers Nextcloud comptent (et le coffre ouvert)
  return nextcloudOnly ? all.filter((v) => v.remote || v.active) : all
}
function listAllVaults() {
  if (VAULT_DIR) return [{ id: DEFAULT_VAULT, remote: null, active: true }]
  const links = getSettings().vaults || {}
  let names = []
  try {
    names = fs
      .readdirSync(VAULTS_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)
  } catch {
    names = []
  }
  return names
    .sort((a, b) => a.localeCompare(b, 'fr', { sensitivity: 'base' }))
    .map((id) => ({ id, remote: links[id]?.remote || null, active: VAULT?.id === id }))
}

// Déplacement tolérant (VAULTS_DIR peut être sur un autre disque que DATA_DIR)
function moveAcross(from, to) {
  try {
    fs.renameSync(from, to)
  } catch (err) {
    if (err.code !== 'EXDEV') throw err
    fs.cpSync(from, to, { recursive: true })
    fs.rmSync(from, { recursive: true, force: true })
  }
}

// Ancienne version : les notes étaient directement dans DATA_DIR → coffre DEFAULT_VAULT
function migrateLegacyData() {
  if (!fs.existsSync(path.join(DATA_DIR, '_meta.json')) || fs.existsSync(VAULTS_DIR)) return
  const target = path.join(VAULTS_DIR, DEFAULT_VAULT)
  fs.mkdirSync(target, { recursive: true })
  const serverFiles = new Set(['.sessions', '.nextcloud', '_users.json', '_notifications.json', 'settings.json'])
  for (const entry of fs.readdirSync(DATA_DIR)) {
    const from = path.join(DATA_DIR, entry)
    if (serverFiles.has(entry) || from === VAULTS_DIR) continue
    moveAcross(from, path.join(target, entry))
  }
  updateSettings({ activeVault: DEFAULT_VAULT })
  console.log(`[coffre] données déplacées dans ${target}`)
}

// Données internes du coffre dans .yariche/ (caché : ni Nextcloud ni Obsidian ne le montrent)
function migrateVaultInternals(dir, internal) {
  const moves = [
    ['_meta.json', 'meta.json'],
    ['_links.json', 'links.json'],
    ['.versions', 'versions'],
  ]
  for (const [from, to] of moves) {
    const src = path.join(dir, from)
    const dst = path.join(internal, to)
    if (fs.existsSync(src) && !fs.existsSync(dst)) fs.renameSync(src, dst)
  }
  // Commentaires : <page>.comments.json à côté des notes → .yariche/comments/<page>.json
  const commentsDir = path.join(internal, 'comments')
  const walk = (d) => {
    let entries = []
    try {
      entries = fs.readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const full = path.join(d, e.name)
      if (e.isDirectory() && e.name !== '.yariche' && e.name !== 'node_modules') walk(full)
      else if (e.isFile() && e.name.endsWith('.comments.json')) {
        fs.mkdirSync(commentsDir, { recursive: true })
        const dst = path.join(commentsDir, `${e.name.slice(0, -'.comments.json'.length)}.json`)
        if (!fs.existsSync(dst)) fs.renameSync(full, dst)
      }
    }
  }
  walk(dir)
}

function openVault(id) {
  stopWatcher()
  stopSync()
  for (const room of [...liveDocs.keys()]) dropLiveDoc(room)
  lastWritten.clear()
  renderBaselines.clear()
  externalConflicts.clear()
  const dir = path.join(VAULTS_DIR, id)
  const internal = INTERNAL_BASE ? path.join(INTERNAL_BASE, id) : path.join(dir, '.yariche')
  fs.mkdirSync(internal, { recursive: true })
  migrateVaultInternals(dir, internal)
  // Éléments repérés par leur chemin (v2) plutôt que par un nom unique (v1)
  migrateVaultToV2(internal, { renameNotification: renameRoomInNotifications })
  initMetaStore(internal)
  initLinksIndex(internal)
  initVersionStore(path.join(internal, 'versions'))
  initVault(dir, {
    get: getDocMeta,
    all: allMetaEntries,
    create: createMeta,
    remove: forgetNode,
    move: moveNodeMeta,
    setInodes,
  })
  VAULT = { id, dir, internal }
  if (getSettings().activeVault !== id) updateSettings({ activeVault: id })
  const { created, moved, removed } = reconcile(defaultOwner())
  // Liens [[…]] des notes jamais indexées (coffre Obsidian importé, notes arrivées pendant
  // que le serveur était arrêté) : rétroliens et graphe complets dès l'ouverture
  indexLinks(allMetaEntries().filter(([nid, m]) => (m.type || 'doc') === 'doc' && !hasLinks(nid)).map(([nid]) => nid))
  console.log(
    `[coffre] « ${id} » ouvert (${dir}) : ${allMetaEntries().length} élément(s)` +
      (created.length ? `, ${created.length} découvert(s)` : '') +
      (moved.length ? `, ${moved.length} déplacé(s)` : '') +
      (removed.length ? `, ${removed.length} disparu(s)` : '')
  )
  startWatcher()
  startVaultSync()
}

// --- Déplacer, renommer, corbeille ------------------------------------------------------
// L'identifiant d'un élément est son chemin : le déplacer ou le renommer change le chemin
// de tout son sous-arbre. Versions, commentaires, notifications et documents en mémoire
// suivent (paires [ancien, nouveau] renvoyées par moveSubtree).
function followMoves(pairs) {
  for (const [from, to] of pairs) {
    for (const [a, b] of [
      [versionsDir(from), versionsDir(to)],
      [commentsPath(from), commentsPath(to)],
    ]) {
      if (fs.existsSync(a) && !fs.existsSync(b)) fs.renameSync(a, b)
    }
    renameRoomInNotifications(from, to)
    dropLiveDoc(from)
    externalConflicts.delete(from)
  }
}
// Fichiers déjà déplacés (hors de Yariche) : seulement les métadonnées
function moveNodeMeta(from, to) {
  const pairs = moveSubtree(from, to)
  followMoves(pairs)
  return pairs
}
// Déplacement demandé dans Yariche : fichiers puis métadonnées
function moveNode(from, to) {
  moveNodeFiles(from, to)
  return moveNodeMeta(from, to)
}

// Chemin libre : ni élément connu ni fichier/dossier sur le disque
const idTaken = (id) =>
  !!getDocMeta(id) || SIDE_FILES.some((ext) => fs.existsSync(sideFile(id, ext))) || fs.existsSync(childDir(id))
function freeId(id) {
  if (!idTaken(id)) return id
  let n = 2
  while (idTaken(`${id} (${n})`)) n++
  return `${id} (${n})`
}

// Corbeille : l'élément et son contenu vont dans .trash/, en gardant leur chemin
function trashNode(id) {
  const target = freeId(`${TRASH}/${id}`)
  moveNode(id, target)
  markTrashed(target, id)
  return target
}
// Restauration à l'emplacement d'origine (dossier disparu : à la racine ; nom pris : « (2) »)
function restoreNode(trashId) {
  const original = getDocMeta(trashId)?.originalId || trashId.slice(TRASH.length + 1)
  let parent = parentIdOf(original)
  if (parent && (!getDocMeta(parent) || isTrashId(parent))) parent = null
  const target = freeId(parent ? `${parent}/${baseName(original)}` : baseName(original))
  moveNode(trashId, target)
  clearTrashed(target)
  return target
}
// Suppression définitive (depuis la corbeille) : fichiers, versions, commentaires
function purgeNode(id) {
  const keys = [id, ...descendantsOf(id)]
  removeFromDisk(id)
  for (const key of keys) {
    fs.rmSync(versionsDir(key), { recursive: true, force: true })
    fs.rmSync(commentsPath(key), { force: true })
    dropRoomNotifications(key)
    dropLiveDoc(key)
  }
  removeMeta(id)
}

// Index des liens de pages lues sur le disque (une seule écriture de l'index)
function indexLinks(ids) {
  const map = {}
  for (const id of ids) {
    if (isTrashId(id) || (getDocMeta(id)?.type || 'doc') !== 'doc') continue
    try {
      map[id] = extractWikilinks(fs.readFileSync(filePath(id), 'utf8'))
    } catch {
      /* fichier disparu entre-temps */
    }
  }
  if (Object.keys(map).length) setLinksMany(map)
}

// Élément supprimé hors de Yariche : on l'oublie (versions et commentaires restent :
// si le fichier revient au même endroit, ils s'y rattachent)
function forgetNode(id) {
  const keys = removeMeta(id)
  for (const key of keys) {
    dropLiveDoc(key)
    dropRoomNotifications(key)
    externalConflicts.delete(key)
  }
  return keys
}

// --- Synchronisation Nextcloud du coffre ouvert ---------------------------------------
let syncError = null
let syncRetry = null
async function startVaultSync() {
  clearTimeout(syncRetry)
  syncError = null
  const remote = getSettings().vaults?.[VAULT.id]?.remote
  const account = accountFrom(getSettings())
  if (!remote || !account) return stopSync()
  const opened = VAULT.id
  try {
    const { id: uid } = await whoami(account)
    if (VAULT.id !== opened) return
    startSync({ dir: VAULT.dir, folder: remote.folder, account, uid, homeDir: path.join(DATA_DIR, '.nextcloud') })
  } catch (err) {
    syncError = err.message
    console.warn(`[nextcloud] synchronisation impossible : ${err.message} (nouvel essai dans 1 min)`)
    syncRetry = setTimeout(() => VAULT.id === opened && startVaultSync(), 60_000)
  }
}

// --- Écritures ------------------------------------------------------------------------
// Emplacements (filePath, sideFile…) : voir vault.js, ils suivent l'arborescence
const versionsDir = (id) => path.join(VAULT.internal, 'versions', storageKey(id))
const commentsPath = (id) => path.join(VAULT.internal, 'comments', `${storageKey(id)}.json`)
// Ce que Yariche a écrit lui-même, par chemin : tout autre contenu vient d'ailleurs
const lastWritten = new Map()
// Écriture atomique (fichier temporaire caché puis renommage) : Nextcloud, Obsidian ou
// le watcher ne voient jamais un fichier à moitié écrit
function writeFileEnsured(p, content) {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  const tmp = path.join(path.dirname(p), `.${path.basename(p)}.yariche-tmp`)
  fs.writeFileSync(tmp, content, 'utf8')
  fs.renameSync(tmp, p)
  lastWritten.set(p, content)
}
const readIfExists = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '')
// Par fichier : { disk, rendered } (voir POST /api/doc/:room)
const renderBaselines = new Map()

// Documents Yjs vivants (en mémoire, y-websocket sans persistance) : un nom de page
// qui disparaît (renommage, suppression) doit libérer le sien, sinon une future
// page du même nom hériterait de l'ancien contenu.
function dropLiveDoc(room) {
  const doc = liveDocs.get(room)
  if (!doc) return
  liveDocs.delete(room)
  for (const conn of [...doc.conns.keys()]) {
    try {
      conn.close()
    } catch {
      /* déjà fermée */
    }
  }
  doc.destroy()
}

// En-tête YAML (« propriétés » Obsidian) : l'éditeur ne le connaît pas, on le met de côté
// à la lecture et on le recolle à l'écriture pour ne jamais l'abîmer.
const FRONTMATTER_RE = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(\r?\n|$)/
function splitFrontmatter(text) {
  const m = text.match(FRONTMATTER_RE)
  return m ? { frontmatter: m[0], body: text.slice(m[0].length) } : { frontmatter: '', body: text }
}

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// Après un déplacement ou un renommage : les liens [[…]] qui visaient les éléments
// déplacés sont réécrits (comme Obsidian), dans le fichier et dans le document Yjs
// vivant (les éditeurs ouverts voient le lien changer en direct). Types Yjs testés par
// « duck typing » : y-websocket charge la build CommonJS de yjs, pas la même instance.
// linkTexts : { source (ancien id) : [textes de liens] } relevé AVANT le déplacement.
function rewriteLinksAfterMove(pairs, linkTextsBefore, session) {
  const newIdOf = new Map(pairs)
  const updated = []
  for (const [sourceBefore, changes] of Object.entries(linkTextsBefore)) {
    const source = newIdOf.get(sourceBefore) || sourceBefore
    if (!canEdit(sessionRole(session, source))) continue
    // Nouveau texte : même forme que l'ancien (nom seul, ou fin de chemin de même longueur)
    const replacements = changes
      .map(({ text, to }) => {
        const segments = text.split('/').filter(Boolean).length
        const next = segments > 1 ? to.split('/').slice(-segments).join('/') : baseName(to)
        return [text, next]
      })
      .filter(([a, b]) => a !== b)
    if (!replacements.length) continue
    let touched = false
    const p = filePath(source)
    if (fs.existsSync(p)) {
      const content = fs.readFileSync(p, 'utf8')
      let next = content
      for (const [from, to] of replacements) {
        const re = new RegExp(`(\\\\?\\[\\\\?\\[)${escapeRegExp(from)}(?=\\\\?\\]|\\||#)`, 'g')
        next = next.replace(re, `$1${to}`)
      }
      if (next !== content) {
        writeFileEnsured(p, next)
        setLinks(source, extractWikilinks(next))
        touched = true
      }
    }
    const doc = liveDocs.get(source)
    if (doc) {
      doc.transact(() => {
        const visit = (node) => {
          if (typeof node.toDelta === 'function') {
            for (const [from, to] of replacements) {
              const delta = node.toDelta()
              const plain = delta.map((op) => (typeof op.insert === 'string' ? op.insert : '\ufffc')).join('')
              const re = new RegExp(`\\[\\[${escapeRegExp(from)}(?=\\]\\]|\\||#)`, 'g')
              for (const m of [...plain.matchAll(re)].reverse()) {
                const at = m.index + 2
                let offset = 0
                let attributes
                for (const op of delta) {
                  const len = typeof op.insert === 'string' ? op.insert.length : 1
                  if (at < offset + len) {
                    attributes = op.attributes
                    break
                  }
                  offset += len
                }
                node.delete(at, from.length)
                node.insert(at, to, attributes)
                touched = true
              }
            }
          } else if (typeof node.toArray === 'function') {
            node.toArray().forEach(visit)
          }
        }
        visit(doc.getXmlFragment('default'))
      })
    }
    if (touched) updated.push(source)
  }
  return updated
}
// Relevé avant déplacement : pour chaque élément du sous-arbre, les liens qui le visent
function linkTextsForSubtree(id) {
  const out = {}
  for (const from of [id, ...descendantsOf(id)]) {
    for (const [source, texts] of Object.entries(linkTextsTo(from))) {
      for (const text of texts) (out[source] ||= []).push({ text, from })
    }
  }
  return out
}
// Associe chaque texte relevé à la nouvelle position de sa cible
function withTargets(linkTexts, pairs) {
  const newIdOf = new Map(pairs)
  return Object.fromEntries(
    Object.entries(linkTexts).map(([source, list]) => [
      source,
      list.map(({ text, from }) => ({ text, to: newIdOf.get(from) || from })),
    ])
  )
}
// Modifications arrivées de l'extérieur (Nextcloud, Obsidian…) sur une page ouverte
const externalConflicts = new Map()

// --- Invités (liens de partage, sans compte) -------------------------------------------
// Un lien donne accès à UNE page et à ses sous-pages, en lecture ou en modification. Le
// jeton est revérifié à chaque requête : désactiver le lien coupe l'accès aussitôt.
function findShare(token) {
  if (typeof token !== 'string' || token.length < 20) return null
  for (const [room, m] of allMetaEntries()) {
    if (m.shareLink?.token === token && !isTrashId(room)) return { room, role: m.shareLink.role }
  }
  return null
}
const shareScope = (share) => (share ? [share.room, ...descendantsOf(share.room)] : [])
function guestRole(session, room) {
  const share = findShare(session?.guest?.token)
  if (!share || !shareScope(share).includes(room) || isTrashId(room)) return null
  return share.role
}
// Rôle de la personne (ou de l'invité) sur une page
function sessionRole(session, room) {
  const user = session?.user
  if (!user) return null
  return user.guest ? guestRole(session, room) : getRole(room, user.email)
}
const roleOf = (req, room) => sessionRole(req.session, room)
// Propriétaire : de l'élément, ou d'un dossier qui le contient (espace d'équipe). À la
// corbeille, aussi le propriétaire du dossier d'où il vient.
function isOwner(req, room) {
  const email = req.session.user?.guest ? null : req.session.user?.email
  if (!email) return false
  if (getRole(room, email) === 'owner') return true
  const meta = getDocMeta(room)
  const from = meta?.trashRoot && meta.originalId ? parentIdOf(meta.originalId) : null
  return !!from && getRole(from, email) === 'owner'
}

// Fichier (image, PDF) visible par un invité : cité par une page de son périmètre, ou
// envoyé par lui dans cette session
function guestCanSeeFile(session, name) {
  if (!name) return false
  if (session.guestUploads?.includes(name)) return true
  return shareScope(findShare(session.guest?.token)).some((room) => {
    const p = mainFile(room, getDocMeta(room)?.type || 'doc')
    try {
      return fs.readFileSync(p, 'utf8').includes(name)
    } catch {
      return false
    }
  })
}

// Pages créées sans connexion (mode dev) : reprises par le premier administrateur qui se
// connecte avec un vrai compte, dans tous les coffres
function adoptDevPages(email) {
  if (!email || email === DEV_USER_EMAIL || getSettings().devPagesAdoptedBy) return
  let count = reassignOwner(DEV_USER_EMAIL, email)
  for (const v of listAllVaults()) {
    if (v.id === VAULT.id) continue
    const file = path.join(VAULTS_DIR, v.id, '.yariche', 'meta.json')
    try {
      const all = JSON.parse(fs.readFileSync(file, 'utf8'))
      let changed = 0
      for (const m of Object.values(all)) if (reassignInMeta(m, DEV_USER_EMAIL, email)) changed++
      if (changed) {
        fs.writeFileSync(`${file}.tmp`, JSON.stringify(all, null, 2))
        fs.renameSync(`${file}.tmp`, file)
        count += changed
      }
    } catch {
      /* coffre sans métadonnées */
    }
  }
  updateSettings({ devPagesAdoptedBy: email })
  if (count) console.log(`[auth] ${count} page(s) du mode sans connexion reprises par ${email}`)
}

// --- Surveillance du coffre -----------------------------------------------------------
let watcher = null
let reconcileTimer = null
function stopWatcher() {
  clearTimeout(reconcileTimer)
  watcher?.close().catch(() => {})
  watcher = null
}

function scheduleReconcile() {
  clearTimeout(reconcileTimer)
  reconcileTimer = setTimeout(() => {
    const { created, moved, removed } = reconcile(defaultOwner())
    indexLinks(created)
    if (created.length) console.log(`[coffre] ajouté ailleurs : ${created.join(', ')}`)
    if (moved.length) console.log(`[coffre] déplacé ailleurs : ${moved.join(', ')}`)
    if (removed.length) console.log(`[coffre] supprimé ailleurs : ${removed.join(', ')}`)
  }, 800)
}

const PAGE_FILES = [
  ['.board.json', 'board'],
  ['.db.json', 'database'],
  ['.md', 'doc'],
]
// Fichier d'une page modifié hors de Yariche
function onExternalContent(p) {
  const rel = relPath(p).split(path.sep).join('/')
  const match = PAGE_FILES.find(([ext]) => rel.endsWith(ext))
  if (!match) return
  const room = rel.slice(0, -match[0].length)
  const base = path.basename(p)
  const meta = getDocMeta(room)
  if (!meta || (meta.type || 'doc') !== match[1] || mainFile(room, match[1]) !== p) return
  let content
  try {
    content = fs.readFileSync(p, 'utf8')
  } catch {
    return
  }
  if (lastWritten.get(p) === content) return // notre propre écriture
  if (match[1] === 'doc') setLinks(room, extractWikilinks(content))
  const live = liveDocs.get(room)
  if (!live) return // personne ne l'a ouverte : elle sera relue depuis le disque
  if (live.conns.size === 0) {
    // Document gardé en mémoire mais plus ouvert : on l'oublie, le disque fait foi
    dropLiveDoc(room)
    return
  }
  if (match[1] !== 'doc') {
    console.warn(`[coffre] ${base} modifié ailleurs pendant qu'il est ouvert : la version ouverte l'emportera`)
    return
  }
  console.log(`[coffre] ${base} modifié ailleurs pendant qu'il est ouvert`)
  externalConflicts.set(room, {
    id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    detectedAt: Date.now(),
    content: splitFrontmatter(content).body,
  })
}

function startWatcher() {
  const root = VAULT.dir
  const ignored = (p) => {
    const rel = path.relative(root, p)
    return rel.split(path.sep).some((seg) => seg.startsWith('.')) || /(^|[\\/])_[^\\/]*\.json$/.test(rel)
  }
  watcher = chokidar.watch(root, {
    ignoreInitial: true,
    ignored,
    awaitWriteFinish: { stabilityThreshold: 400, pollInterval: 100 },
  })
  watcher.on('all', (event, p) => {
    requestSync() // toute modification du coffre part vers Nextcloud (si lié)
    if (event === 'add' || event === 'change') onExternalContent(p)
    if (event !== 'change' && !movedByApp(p)) scheduleReconcile()
  })
  watcher.on('error', (err) => console.warn(`[coffre] surveillance : ${err.message}`))
}

async function main() {
  await initAuth()
  migrateLegacyData()
  fs.mkdirSync(VAULTS_DIR, { recursive: true })
  const vaults = listAllVaults()
  const wanted = getSettings().activeVault
  const initial = vaults.find((v) => v.id === wanted)?.id || vaults[0]?.id || DEFAULT_VAULT
  openVault(initial)

  const app = express()
  // Derrière un reverse proxy HTTPS : cookies « secure » et IP réelle (TRUST_PROXY=1)
  if (process.env.TRUST_PROXY) app.set('trust proxy', /^\d+$/.test(process.env.TRUST_PROXY) ? Number(process.env.TRUST_PROXY) : process.env.TRUST_PROXY)
  app.disable('x-powered-by')

  // Mode local de l'app Mac : seule l'app, qui connaît le secret de ce lancement, ouvre
  // Yariche (cookie posé par /local-login) ; un autre site ouvert dans un navigateur ou un
  // autre programme du Mac est refusé. Hôte vérifié (pas de rebinding DNS). /mcp garde son
  // authentification par jeton.
  if (LOCAL_TOKEN) {
    app.use((req, res, next) => {
      if (!localHostOk(req)) return res.status(421).end()
      if (req.path === '/local-login') {
        if (!sameSecret(String(req.query.token || ''), LOCAL_TOKEN)) return res.status(401).end()
        res.setHeader('Set-Cookie', `yariche_local=${LOCAL_TOKEN}; Path=/; HttpOnly; SameSite=Strict`)
        return res.redirect('/')
      }
      if (req.path === '/mcp' || hasLocalCookie(req)) return next()
      res.status(401).type('text/plain').send('Yariche (mode local) : ouvre-le depuis l’app Yariche.')
    })
  }

  // En-têtes de sécurité sur toutes les réponses. CSP : aucun script extérieur ni en ligne,
  // pas d'intégration dans une autre page, connexions seulement vers ce serveur.
  // Referrer-Policy no-referrer : un lien de partage ne fuit jamais vers un site cliqué.
  const hostRe = /^[a-z0-9.-]+(:\d+)?$/i
  app.use((req, res, next) => {
    const host = hostRe.test(req.headers.host || '') ? req.headers.host : null
    const sockets = host ? ` wss://${host} ws://${host}` : ''
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
        "font-src 'self' data: https://fonts.gstatic.com; img-src 'self' data: blob:; media-src 'self' blob:; " +
        `connect-src 'self'${sockets}; worker-src 'self' blob:; manifest-src 'self'; object-src 'none'; ` +
        "base-uri 'self'; form-action 'self'; frame-ancestors 'none'"
    )
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('X-Frame-Options', 'DENY')
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()')
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
    if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store')
    next()
  })

  // Anti-force brute : connexion et liens d'invité limités par adresse (derrière un
  // reverse proxy, TRUST_PROXY donne la vraie adresse du visiteur)
  const limiter = (max, windowMs = 60_000) => {
    const hits = new Map()
    setInterval(() => hits.clear(), windowMs).unref()
    return (req, res, next) => {
      const n = (hits.get(req.ip) || 0) + 1
      hits.set(req.ip, n)
      if (n <= max) return next()
      res.setHeader('Retry-After', String(Math.ceil(windowMs / 1000)))
      res.status(429).send('Trop de tentatives. Réessaie dans une minute.')
    }
  }
  app.use(['/s', '/login', '/auth', '/setup', '/signup', '/account', '/admin'], limiter(30))
  app.use('/mcp', limiter(120))
  app.use(express.json({ limit: '10mb' }))
  app.use(sessionMiddleware)
  // Logo, favicon, manifeste : visibles avant connexion (page de login, écran d'accueil)
  const clientDir = path.join(__dirname, '..', 'dist', 'client')
  const PUBLIC_ASSETS = new Set([
    '/logo.svg',
    '/favicon.svg',
    '/favicon-32.png',
    '/apple-touch-icon.png',
    '/icon-192.png',
    '/icon-512.png',
    '/manifest.webmanifest',
  ])
  const publicStatic = express.static(clientDir, { index: false })
  app.use((req, res, next) => (PUBLIC_ASSETS.has(req.path) ? publicStatic(req, res, next) : next()))

  // Lien de partage : /s/<jeton> → prénom de l'invité → la page partagée
  const guestNameForm = (share, error = '') =>
    messagePage(
      getDocMeta(share.room)?.appearance?.icon
        ? `${getDocMeta(share.room).appearance.icon} ${baseName(share.room)}`
        : baseName(share.room),
      share.role === 'editor' ? 'Tu es invité à modifier ce document.' : 'Tu es invité à lire ce document.',
      `<form method="post">
        <label for="name">Ton prénom (visible par les autres personnes sur le document)</label>
        <input id="name" name="name" maxlength="40" required autofocus autocomplete="given-name" />
        ${error ? `<div class="error">${escapeHtml(error)}</div>` : ''}
        <button class="sso-btn" type="submit">Ouvrir le document</button>
      </form>`
    )
  const invalidLink = () =>
    messagePage('Lien invalide', 'Ce lien de partage n’existe pas ou a été désactivé par son propriétaire.')
  app.get('/s/:token', (req, res) => {
    const share = findShare(req.params.token)
    if (!share) return res.status(404).send(invalidLink())
    const docUrl = `/?doc=${encodeURIComponent(share.room)}`
    const user = req.session.user
    // Le propriétaire (ou tout le monde sans SSO) ouvre simplement la page
    if (isDevMode || (user && !user.guest)) return res.redirect(docUrl)
    if (user?.guest && req.session.guest?.token === req.params.token) return res.redirect(docUrl)
    res.send(guestNameForm(share))
  })
  app.post('/s/:token', express.urlencoded({ extended: false, limit: '2kb' }), (req, res) => {
    const share = findShare(req.params.token)
    if (!share) return res.status(404).send(invalidLink())
    if (isDevMode || (req.session.user && !req.session.user.guest))
      return res.redirect(`/?doc=${encodeURIComponent(share.room)}`)
    const name = String(req.body?.name || '').replace(/\s+/g, ' ').trim().slice(0, 40)
    if (!name) return res.status(400).send(guestNameForm(share, 'Indique ton prénom.'))
    const id = randomBytes(6).toString('hex')
    req.session.regenerate(() => {
      req.session.user = { sub: `invite-${id}`, email: `invite-${id}@yariche.invalid`, name, guest: true }
      req.session.guest = { token: req.params.token }
      req.session.save(() => res.redirect(`/?doc=${encodeURIComponent(share.room)}`))
    })
  })

  // IA (MCP) : authentifiée par jeton personnel, pas par session
  registerMcp(app, mcpContext())

  registerAuthRoutes(app)
  app.use(requireAuth)

  // Invités : seulement la page partagée (et ses sous-pages), rien d'autre de l'app
  const GUEST_API = [
    ['GET', /^\/api\/me$/],
    ['GET', /^\/api\/docs$/],
    ['GET', /^\/api\/vault-file$/],
    ['GET', /^\/api\/doc\/[^/]+$/],
    ['POST', /^\/api\/doc\/[^/]+$/],
    ['GET', /^\/api\/doc\/[^/]+\/(board|db|comments|conflict)$/],
    ['POST', /^\/api\/doc\/[^/]+\/(board|db|comments|upload|ack|conflict\/claim|create|rename)$/],
  ]
  app.use((req, res, next) => {
    if (!req.session.user?.guest) return next()
    if (!findShare(req.session.guest?.token)) {
      return req.session.destroy(() =>
        req.path.startsWith('/api/')
          ? res.status(401).json({ error: 'lien de partage désactivé' })
          : res.status(410).send(invalidLink())
      )
    }
    if (req.path.startsWith('/api/') && !GUEST_API.some(([m, re]) => m === req.method && re.test(req.path)))
      return res.status(403).json({ error: 'accès invité limité au document partagé' })
    // Fichiers joints : seulement ceux du document partagé
    if ((req.path.startsWith('/attachments/') || req.path.startsWith('/uploads/')) &&
        !guestCanSeeFile(req.session, decodeURIComponent(path.basename(req.path))))
      return res.status(404).end()
    next()
  })
  app.use(express.static(clientDir))

  // --- Garde-fous : un lien d'invité est public, le disque est petit ---------------------
  // Par lien (24 h glissantes) : créations et volume de fichiers envoyés ; par session
  // invitée : nombre de modifications par minute. Pour tous : rien de nouveau quand le
  // disque est presque plein (la synchro Nextcloud et les sauvegardes en ont besoin).
  const envNumber = (name, fallback) => (Number(process.env[name]) > 0 ? Number(process.env[name]) : fallback)
  const GUEST_LIMITS = {
    writesPerMinute: envNumber('GUEST_WRITES_PER_MINUTE', 120),
    createsPerLink: envNumber('GUEST_CREATES_PER_LINK', 300),
    uploadBytesPerLink: envNumber('GUEST_UPLOAD_MB_PER_LINK', 300) * 1024 * 1024,
    realtimeBytesPerMinute: envNumber('GUEST_REALTIME_MB_PER_MINUTE', 20) * 1024 * 1024,
  }
  const MIN_FREE_BYTES = envNumber('MIN_FREE_DISK_MB', 1024) * 1024 * 1024
  const linkUsage = new Map()
  const usageOf = (token) => {
    let usage = linkUsage.get(token)
    if (!usage || Date.now() - usage.since > 86_400_000) linkUsage.set(token, (usage = { since: Date.now(), creates: 0, uploadBytes: 0 }))
    return usage
  }
  const diskFree = () => {
    try {
      const st = fs.statfsSync(VAULT.dir)
      return st.bavail * st.bsize
    } catch {
      return Infinity
    }
  }
  const guestWrites = new Map()
  setInterval(() => guestWrites.clear(), 60_000).unref()
  app.use('/api', (req, res, next) => {
    if (req.method === 'GET' || !req.session.user?.guest) return next()
    const n = (guestWrites.get(req.sessionID) || 0) + 1
    guestWrites.set(req.sessionID, n)
    if (n > GUEST_LIMITS.writesPerMinute) return res.status(429).json({ error: 'trop de modifications d’un coup, réessaie dans une minute' })
    next()
  })

  // Onglet resté sur un autre coffre (changé entre-temps) : ses écritures iraient dans
  // le mauvais coffre. Le client envoie le coffre qu'il affiche, le serveur refuse.
  // L'en-tête arrive encodé (un en-tête HTTP ne porte que de l'ASCII : « Cours%202026-2027 »)
  const shownVault = (req) => {
    const header = req.get('x-yariche-vault')
    if (!header) return req.query.vault
    try {
      return decodeURIComponent(header)
    } catch {
      return header
    }
  }
  app.use('/api', (req, res, next) => {
    const shown = shownVault(req)
    if (shown && shown !== VAULT.id) return res.status(409).json({ error: 'vault-changed', vault: VAULT.id })
    next()
  })

  // Le nom de page devient un nom de fichier : on refuse tout ce qui sortirait du coffre
  app.param('room', (req, res, next, room) => {
    if (!validId(room)) return res.status(400).json({ error: 'nom de page invalide' })
    next()
  })

  const admin = (req) => isAdmin(req.session.user?.email, isDevMode)
  const requireAdmin = (req, res, next) =>
    admin(req) ? next() : res.status(403).json({ error: 'réservé aux administrateurs' })

  app.get('/api/me', (req, res) => {
    const user = req.session.user
    if (user.guest) {
      const share = findShare(req.session.guest?.token)
      return res.json({ ...user, admin: false, vault: VAULT.id, ai: false, auth: 'guest', shareRoot: share?.room, role: share?.role })
    }
    touchUser(user)
    if (!isDevMode && admin(req)) adoptDevPages(user.email)
    res.json({
      ...user,
      admin: admin(req),
      vault: VAULT.id,
      ai: !!(LLM_BASE_URL && LLM_MODEL),
      auth: authKind,
      local: !!LOCAL_TOKEN,
      // Serveur privé : le partage passe par des liens d'invité, pas par des comptes
      privateServer: loginRestricted,
    })
  })

  app.get('/api/users', (req, res) => res.json(listUsers(allKnownEmails())))

  // Jetons d'accès personnels (IA via MCP, scripts) : on ne voit et ne gère que les siens
  app.get('/api/tokens', (req, res) => res.json(listApiTokens(req.session.user.email)))
  app.post('/api/tokens', (req, res) => {
    try {
      res.json(createApiToken(req.session.user.email, req.body?.name, req.body?.scope === 'write' ? 'write' : 'read'))
    } catch (err) {
      res.status(400).json({ error: err.message })
    }
  })
  app.delete('/api/tokens/:id', (req, res) => {
    if (!revokeApiToken(req.session.user.email, req.params.id)) return res.status(404).json({ error: 'jeton introuvable' })
    res.json({ ok: true })
  })

  // Chemin réel dans le coffre (comme Obsidian) : dossier/…/Nom.md, ou dossier/ pour un dossier
  const storagePath = (room, type) =>
    type === 'folder' ? `${relPath(childDir(room))}/` : relPath(mainFile(room, type))
  const mtime = (room, type) => {
    try {
      return fs.statSync(type === 'folder' ? childDir(room) : mainFile(room, type)).mtimeMs
    } catch {
      return null
    }
  }

  app.get('/api/docs', (req, res) => {
    if (req.session.user.guest) {
      const share = findShare(req.session.guest?.token)
      return res.json(
        shareScope(share)
          .filter((room) => getDocMeta(room) && !isTrashId(room))
          .map((room) => {
            const m = getDocMeta(room)
            return {
              room,
              name: baseName(room),
              icon: m.appearance?.icon || null,
              // La page partagée apparaît à la racine de l'explorateur de l'invité
              parent: room === share.room ? null : parentIdOf(room),
              type: m.type || 'doc',
              favorite: false,
              path: storagePath(room, m.type || 'doc'),
            }
          })
      )
    }
    res.json(
      listRoomsForUser(req.session.user.email).map((e) => ({
        ...e,
        path: storagePath(e.room, e.type),
        createdAt: getDocMeta(e.room)?.createdAt || null,
        updatedAt: mtime(e.room, e.type),
      }))
    )
  })

  app.get('/api/doc/:room', (req, res) => {
    // Page inexistante : dit comme tel au propriétaire (un invité voit « accès refusé »,
    // pour ne rien apprendre de ce qui existe hors de son partage)
    if (!getDocMeta(req.params.room) && !req.session.user.guest) return res.status(404).json({ error: 'page introuvable' })
    const role = roleOf(req, req.params.room)
    if (!role) return res.status(403).json({ error: 'acces refuse' })
    const p = filePath(req.params.room)
    const raw = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : ''
    const { frontmatter, body: content } = splitFrontmatter(raw)
    const meta = getDocMeta(req.params.room)
    // À la corbeille : la racine de ce qui a été supprimé (c'est elle qu'on restaure)
    let trashRoot = null
    if (isTrashId(req.params.room)) {
      let cur = req.params.room
      while (cur && !getDocMeta(cur)?.trashRoot) cur = parentIdOf(cur)
      trashRoot = cur || req.params.room
    }
    res.json({
      content,
      raw,
      frontmatter,
      role,
      name: baseName(req.params.room),
      type: meta?.type || 'doc',
      appearance: meta?.appearance || { icon: null, cover: null },
      deletedAt: trashRoot ? getDocMeta(trashRoot)?.deletedAt || Date.now() : null,
      trashRoot,
      path: storagePath(req.params.room, meta?.type || 'doc'),
      canRename: !trashRoot && canRename(req, req.params.room),
    })
  })

  const boardPath = (room) => sideFile(room, '.board.json')
  app.get('/api/doc/:room/board', (req, res) => {
    if (!roleOf(req, req.params.room))
      return res.status(403).json({ error: 'acces refuse' })
    const p = boardPath(req.params.room)
    res.json(fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : { notes: {}, strokes: [] })
  })
  app.post('/api/doc/:room/board', (req, res) => {
    const role = roleOf(req, req.params.room)
    if (!canEdit(role)) return res.status(403).json({ error: 'acces refuse' })
    writeFileEnsured(boardPath(req.params.room), JSON.stringify(req.body))
    res.json({ ok: true })
  })

  const dbPath = (room) => sideFile(room, '.db.json')
  app.get('/api/doc/:room/db', (req, res) => {
    if (!roleOf(req, req.params.room))
      return res.status(403).json({ error: 'acces refuse' })
    const p = dbPath(req.params.room)
    // Pas encore de fichier : objet vide, le client crée la base par défaut (Nom, Statut, Date…)
    res.json(fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {})
  })
  app.post('/api/doc/:room/db', (req, res) => {
    const role = roleOf(req, req.params.room)
    if (!canEdit(role)) return res.status(403).json({ error: 'acces refuse' })
    writeFileEnsured(dbPath(req.params.room), JSON.stringify(req.body))
    res.json({ ok: true })
  })

  app.post('/api/doc/:room/appearance', (req, res) => {
    const room = req.params.room
    const role = roleOf(req, room)
    if (!canEdit(role)) return res.status(403).json({ error: 'acces refuse' })
    const appearance = updateAppearance(room, req.body)
    res.json(appearance)
  })

  app.post('/api/doc/:room', (req, res) => {
    const room = req.params.room
    const role = roleOf(req, room)
    if (!canEdit(role)) return res.status(403).json({ error: 'acces refuse' })
    const p = filePath(room)
    const previous = readIfExists(p)
    const markdown = req.body.markdown ?? ''
    // Référence : le fichier tel que l'éditeur vient de l'afficher (ouverture, version
    // arrivée de Nextcloud). Tant que l'éditeur renvoie exactement ça, rien n'a été
    // modifié : on n'écrit pas, même si sa mise en forme diffère de celle du fichier
    // (listes « * » au lieu de « - », etc.).
    if (req.body.baseline) {
      renderBaselines.set(p, { disk: previous, rendered: markdown })
      return res.json({ ok: true, baseline: true })
    }
    const baseline = renderBaselines.get(p)
    if (baseline && baseline.disk === previous && baseline.rendered === markdown)
      return res.json({ ok: true, unchanged: true })
    // En-tête YAML conservé, saut de ligne final conservé : une note Obsidian ouverte
    // puis enregistrée sans modification reste identique octet pour octet.
    let content = splitFrontmatter(previous).frontmatter + markdown
    if (previous.endsWith('\n') && !content.endsWith('\n')) content += '\n'
    if (content === previous) return res.json({ ok: true, unchanged: true })
    snapshotVersion(room, previous)
    writeFileEnsured(filePath(room), content)
    setLinks(room, extractWikilinks(content))
    res.json({ ok: true })
  })

  app.get('/api/doc/:room/versions', (req, res) => {
    const room = req.params.room
    if (!roleOf(req, room)) return res.status(403).json({ error: 'acces refuse' })
    res.json({ versions: listVersions(room) })
  })

  app.get('/api/doc/:room/versions/:ts', (req, res) => {
    const room = req.params.room
    if (!roleOf(req, room)) return res.status(403).json({ error: 'acces refuse' })
    const content = readVersion(room, req.params.ts)
    if (content === null) return res.status(404).json({ error: 'version introuvable' })
    res.json({ content })
  })

  app.post('/api/doc/:room/versions/:ts/restore', (req, res) => {
    const room = req.params.room
    const role = roleOf(req, room)
    if (!canEdit(role)) return res.status(403).json({ error: 'acces refuse' })
    const content = readVersion(room, req.params.ts)
    if (content === null) return res.status(404).json({ error: 'version introuvable' })
    const current = fs.existsSync(filePath(room)) ? fs.readFileSync(filePath(room), 'utf8') : ''
    snapshotVersion(room, current)
    writeFileEnsured(filePath(room), content)
    setLinks(room, extractWikilinks(content))
    res.json({ ok: true, content: splitFrontmatter(content).body })
  })

  // Nom valide pour un élément : un seul segment (pas de « / »), pas caché
  const cleanName = (value) => {
    const name = String(value || '').normalize('NFC').trim()
    return name && name.length <= 200 && !/[\/\\\0]/.test(name) && !name.startsWith('.') ? name : null
  }
  // Déplace ou renomme, puis met à jour les liens [[…]] qui visaient le sous-arbre
  function moveWithLinks(from, to, session) {
    const before = linkTextsForSubtree(from)
    const pairs = moveNode(from, to)
    // Invité : ce qu'il a créé suit son nouveau nom (il peut toujours le renommer)
    if (session.guestCreated) session.guestCreated = session.guestCreated.map((id) => pairs.find(([a]) => a === id)?.[1] || id)
    return rewriteLinksAfterMove(pairs, withTargets(before, pairs), session)
  }
  // --- IA (MCP) : ce que les outils peuvent faire, au nom du propriétaire du jeton --------
  function mcpContext() {
    // Dossiers manquants d'un chemin, créés s'ils peuvent l'être
    const ensureFolders = (folder, email) => {
      if (!folder) return
      const parts = folder.split('/')
      for (let i = 1; i <= parts.length; i++) {
        const dir = parts.slice(0, i).join('/')
        if (getDocMeta(dir)) continue
        const above = parentIdOf(dir)
        if (above && !canEdit(getRole(above, email))) throw new Error(`dossier « ${above} » non modifiable`)
        if (idTaken(dir)) throw new Error(`« ${dir} » existe déjà sur le disque`)
        ensureDocMeta(dir, email, 'folder')
        ensureNodeOnDisk(dir, 'folder')
      }
      if (!canEdit(getRole(folder, email))) throw new Error(`dossier « ${folder} » non modifiable`)
    }
    const checkPath = (id) => {
      if (!validId(id) || isTrashId(id)) throw new Error(`chemin invalide : ${id}`)
    }
    return {
      log: (msg) => console.log(msg),
      verifyToken: verifyApiToken,
      validId,
      isTrashId,
      canEdit,
      role: (id, email) => getRole(id, email),
      listPages: (email) => listRoomsForUser(email).map((e) => ({ id: e.room, type: e.type, parent: e.parent })),
      search: (email, query, limit) =>
        searchFor(email, query, limit).map((r) => ({ id: r.room, type: r.type, ...(r.rowId ? { row: r.label } : {}), snippet: r.snippet })),
      backlinks: (id, email) => getBacklinks(id).filter((r) => getRole(r, email)),
      readPage(id, email) {
        const meta = getDocMeta(id)
        const type = meta?.type || 'doc'
        const readJSON = (p) => {
          try {
            return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null
          } catch {
            return null
          }
        }
        if (type === 'folder') return { type, children: listRoomsForUser(email).filter((e) => e.parent === id).map((e) => e.room) }
        if (type === 'database') return { type, rows: databaseRows(readJSON(sideFile(id, '.db.json'))).map(({ title, text }) => ({ title, text })) }
        if (type === 'board') {
          const notes = Object.values(readJSON(sideFile(id, '.board.json'))?.notes || {})
          return { type, notes: notes.map((n) => n.text).filter(Boolean) }
        }
        const { frontmatter, body } = splitFrontmatter(readIfExists(filePath(id)))
        return { type, path: storagePath(id, type), frontmatter, content: body }
      },
      // Écrit comme un éditeur extérieur : version précédente gardée, éditeurs ouverts prévenus
      writeBody(id, body) {
        const p = filePath(id)
        const previous = readIfExists(p)
        let content = splitFrontmatter(previous).frontmatter + String(body)
        if (!content.endsWith('\n')) content += '\n'
        if (content === previous) return false
        snapshotVersion(id, previous)
        fs.mkdirSync(path.dirname(p), { recursive: true })
        const tmp = path.join(path.dirname(p), `.${path.basename(p)}.yariche-tmp`)
        fs.writeFileSync(tmp, content, 'utf8')
        fs.renameSync(tmp, p)
        lastWritten.delete(p)
        onExternalContent(p) // liens, et page ouverte → rechargement proposé aux éditeurs
        lastWritten.set(p, content) // le watcher ne la signalera pas une seconde fois
        return true
      },
      createNode(id, type, email) {
        if (nextcloudOnly && !getSettings().vaults?.[VAULT.id]?.remote) throw new Error('Yariche n’est pas encore relié à Nextcloud')
        checkPath(id)
        if (getDocMeta(id)) throw new Error(`existe déjà : ${id}`)
        ensureFolders(parentIdOf(id), email)
        if (idTaken(id)) throw new Error(`existe déjà sur le disque : ${id}`)
        ensureDocMeta(id, email, type)
        ensureNodeOnDisk(id, type)
        if (type === 'doc' && !fs.existsSync(mainFile(id, type))) writeFileEnsured(mainFile(id, type), '')
        return id
      },
      movePage(from, to, email) {
        checkPath(to)
        if (getRole(from, email) !== 'owner') throw new Error('réservé au propriétaire')
        if (to === from) return { id: to, updatedLinks: [] }
        if (to.startsWith(`${from}/`)) throw new Error('impossible de déplacer un élément dans lui-même')
        ensureFolders(parentIdOf(to), email)
        if (idTaken(to) && to.toLowerCase() !== from.toLowerCase()) throw new Error(`existe déjà : ${to}`)
        return { id: to, updatedLinks: moveWithLinks(from, to, { user: { email } }) }
      },
      trashPage(id, email) {
        if (getRole(id, email) !== 'owner') throw new Error('réservé au propriétaire')
        return trashNode(id)
      },
    }
  }

  // Renommer : le propriétaire, ou l'invité qui vient de créer l'élément (dans cette session)
  const canRename = (req, room) =>
    req.session.user.guest ? !!req.session.guestCreated?.includes(room) && !!guestRole(req.session, room) : isOwner(req, room)

  app.post('/api/doc/:room/rename', (req, res) => {
    const room = req.params.room
    const meta = getDocMeta(room)
    if (!meta || isTrashId(room) || !canRename(req, room))
      return res.status(403).json({ error: 'reserve au proprietaire' })
    const name = cleanName(req.body?.newName)
    if (!name) return res.status(400).json({ error: 'nom invalide' })
    const parent = parentIdOf(room)
    const newRoom = parent ? `${parent}/${name}` : name
    if (newRoom === room) return res.json({ ok: true, newRoom, updatedLinks: [] })
    // Même nom, casse différente : permis (renommage en deux temps sur le disque)
    if (idTaken(newRoom) && newRoom.toLowerCase() !== room.toLowerCase())
      return res.status(409).json({ error: 'ce nom existe déjà dans ce dossier' })
    const updatedLinks = moveWithLinks(room, newRoom, req.session)
    res.json({ ok: true, newRoom, updatedLinks })
  })

  // "delete" = corbeille (réversible) : l'élément et son contenu vont dans .trash/
  app.post('/api/doc/:room/delete', (req, res) => {
    const room = req.params.room
    const meta = getDocMeta(room)
    if (!meta || isTrashId(room) || !isOwner(req, room))
      return res.status(403).json({ error: 'reserve au proprietaire' })
    const trashed = [room, ...descendantsOf(room)]
    const trashId = trashNode(room)
    res.json({ ok: true, trashed, trashId })
  })

  app.get('/api/trash', (req, res) => {
    res.json(listTrashForUser(req.session.user.email))
  })

  app.post('/api/doc/:room/restore', (req, res) => {
    const room = req.params.room
    const meta = getDocMeta(room)
    if (!meta || !meta.trashRoot || !isOwner(req, room))
      return res.status(403).json({ error: 'reserve au proprietaire' })
    res.json({ ok: true, room: restoreNode(room) })
  })

  app.post('/api/doc/:room/delete-permanent', (req, res) => {
    const room = req.params.room
    const meta = getDocMeta(room)
    if (!meta || !isOwner(req, room))
      return res.status(403).json({ error: 'reserve au proprietaire' })
    if (!meta.trashRoot) return res.status(400).json({ error: "mets d'abord la page à la corbeille" })
    purgeNode(room)
    res.json({ ok: true })
  })

  app.post('/api/trash/empty', (req, res) => {
    const rooms = listTrashForUser(req.session.user.email).map((t) => t.room)
    rooms.forEach(purgeNode)
    res.json({ ok: true, deleted: rooms.length })
  })

  app.post('/api/doc/:room/duplicate', (req, res) => {
    const room = req.params.room
    const email = req.session.user.email
    if (!getRole(room, email) || isTrashId(room)) return res.status(403).json({ error: 'acces refuse' })
    if (getDocMeta(room)?.type === 'folder') return res.status(400).json({ error: 'un dossier ne se duplique pas' })
    const newRoom = freeId(`${room} (copie)`)
    duplicateDoc(room, newRoom, email)
    // Les commentaires restent sur l'original (comme Notion)
    for (const ext of SIDE_FILES) {
      if (fs.existsSync(sideFile(room, ext))) writeFileEnsured(sideFile(newRoom, ext), readIfExists(sideFile(room, ext)))
    }
    res.json({ ok: true, newRoom })
  })

  // Fichiers envoyés par les utilisateurs : jamais exécutés comme une page de l'app (un
  // SVG ouvert directement pourrait sinon lancer du script avec la session de celui qui
  // l'ouvre). Bac à sable CSP + pas de devinette du type.
  const sandboxFile = (res) => {
    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox")
    res.setHeader('X-Content-Type-Options', 'nosniff')
  }
  // Fichiers du coffre ouvert servis tels quels : pièces jointes (attachments/, liées en
  // chemin relatif : « ![](attachments/photo.png) » s'affiche aussi dans Obsidian) et
  // anciennes images (uploads/, avant le rangement façon Obsidian)
  const vaultStatic = (sub) => {
    const cache = new Map()
    return (req, res, next) => {
      const dir = path.join(VAULT.dir, sub)
      if (!cache.has(dir))
        cache.set(dir, express.static(dir, { fallthrough: true, dotfiles: 'ignore', setHeaders: sandboxFile }))
      cache.get(dir)(req, res, next)
    }
  }
  app.use('/uploads', vaultStatic('uploads'))
  app.use('/attachments', vaultStatic('attachments'))
  const attachmentsDir = () => path.join(VAULT.dir, 'attachments')
  // Intégrations Obsidian ![[photo.png]] : fichier cherché par son nom dans le coffre
  // Chemins essayés dans l'ordre (relatif à la note, puis au coffre), puis par nom
  app.get('/api/vault-file', (req, res) => {
    const rels = [].concat(req.query.path || []).map(String).slice(0, 4)
    let found = null
    for (const rel of rels) if (!found) found = findVaultFile({ rel })
    if (!found && req.query.name) found = findVaultFile({ name: String(req.query.name) })
    if (!found) return res.status(404).json({ error: 'fichier introuvable' })
    if (req.session.user.guest && !guestCanSeeFile(req.session, path.basename(found)))
      return res.status(404).json({ error: 'fichier introuvable' })
    // (les PDF gardent la visionneuse du navigateur, qui refuse de s'ouvrir en bac à sable)
    if (!/\.pdf$/i.test(found)) sandboxFile(res)
    else res.removeHeader('Content-Security-Policy')
    res.sendFile(found)
  })
  const upload = multer({
    storage: multer.diskStorage({
      destination: (req, file, cb) => {
        fs.mkdirSync(attachmentsDir(), { recursive: true })
        cb(null, attachmentsDir())
      },
      filename: (req, file, cb) => {
        // Nom lisible comme Obsidian (« image-20260926-153012.png »), sans espace ni caractère spécial
        const ext = (path.extname(file.originalname) || '.png').toLowerCase().replace(/[^.a-z0-9]/g, '')
        const base = path
          .basename(file.originalname, path.extname(file.originalname))
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '')
          .replace(/[^a-zA-Z0-9_-]+/g, '-')
          .replace(/^-+|-+$/g, '')
          .slice(0, 60) || 'image'
        const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
        let name = `${base}-${stamp}${ext}`
        let n = 2
        while (fs.existsSync(path.join(attachmentsDir(), name))) name = `${base}-${stamp}-${n++}${ext}`
        cb(null, name)
      },
    }),
    limits: { fileSize: 15 * 1024 * 1024 },
    fileFilter: (req, file, cb) => cb(null, /^image\//.test(file.mimetype)),
  })
  // Vérifié AVANT l'envoi : multer écrit le fichier sur le disque pendant la réception
  const mayUpload = (req, res, next) => {
    if (!canEdit(roleOf(req, req.params.room))) return res.status(403).json({ error: 'acces refuse' })
    const size = Number(req.get('content-length')) || 0
    if (diskFree() - size < MIN_FREE_BYTES) return res.status(507).json({ error: 'disque du serveur presque plein' })
    if (req.session.user.guest) {
      const usage = usageOf(req.session.guest.token)
      if (usage.uploadBytes + size > GUEST_LIMITS.uploadBytesPerLink)
        return res.status(429).json({ error: 'limite d’envoi de fichiers atteinte pour ce lien' })
      usage.uploadBytes += size
    }
    next()
  }
  app.post('/api/doc/:room/upload', mayUpload, upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'image invalide ou trop grosse (max 15 Mo)' })
    // Un invité revoit tout de suite l'image qu'il vient d'envoyer (avant l'enregistrement)
    if (req.session.user.guest)
      req.session.guestUploads = [...(req.session.guestUploads || []), req.file.filename].slice(-50)
    res.json({ url: `attachments/${req.file.filename}` })
  })

  app.get('/api/doc/:room/backlinks', (req, res) => {
    const room = req.params.room
    const email = req.session.user.email
    if (!getRole(room, email)) return res.status(403).json({ error: 'acces refuse' })
    const backlinks = getBacklinks(room).filter((r) => getRole(r, email))
    res.json({ backlinks })
  })

  // Fils de commentaires : l'état vivant est dans le Y.Doc (map "comments"),
  // ce JSON sert de persistance entre deux redémarrages du serveur.
  app.get('/api/doc/:room/comments', (req, res) => {
    if (!roleOf(req, req.params.room)) return res.status(403).json({ error: 'acces refuse' })
    const p = commentsPath(req.params.room)
    res.json(fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {})
  })
  app.post('/api/doc/:room/comments', (req, res) => {
    if (!canEdit(roleOf(req, req.params.room)))
      return res.status(403).json({ error: 'acces refuse' })
    writeFileEnsured(commentsPath(req.params.room), JSON.stringify(req.body || {}))
    res.json({ ok: true })
  })

  // Mentions / réponses -> boîte de réception des personnes concernées.
  // On ne notifie que les personnes qui ont accès à la page (pas de fuite d'extrait).
  app.post('/api/doc/:room/notify', (req, res) => {
    const room = req.params.room
    const me = req.session.user
    if (!canEdit(getRole(room, me.email))) return res.status(403).json({ error: 'acces refuse' })
    const { mentions = [], participants = [], kind = 'comment', threadId = null, rowId = null, excerpt = '' } =
      req.body || {}
    const clean = (list) =>
      [...new Set((Array.isArray(list) ? list : []).filter((e) => typeof e === 'string' && e && e !== me.email))].slice(0, 50)
    const mentioned = clean(mentions)
    const base = {
      kind: ['comment', 'doc', 'row'].includes(kind) ? kind : 'comment',
      room,
      threadId: typeof threadId === 'string' ? threadId : null,
      rowId: typeof rowId === 'string' ? rowId : null,
      from: { email: me.email, name: me.name },
      excerpt: String(excerpt).slice(0, 240),
    }
    const noAccess = []
    for (const email of mentioned) {
      if (!getRole(room, email)) noAccess.push(email)
      else addNotification(email, { ...base, type: 'mention' })
    }
    for (const email of clean(participants)) {
      if (!mentioned.includes(email) && getRole(room, email)) addNotification(email, { ...base, type: 'reply' })
    }
    res.json({ ok: true, noAccess })
  })

  app.get('/api/notifications', (req, res) => {
    const email = req.session.user.email
    // On masque les notifications de pages devenues inaccessibles ou supprimées
    const list = listNotifications(email).filter((n) => getRole(n.room, email))
    res.json({ items: list.slice(0, 100), unread: list.filter((n) => !n.read).length })
  })
  app.post('/api/notifications/read', (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : null
    markNotificationsRead(req.session.user.email, ids)
    res.json({ ok: true })
  })

  app.post('/api/doc/:room/favorite', (req, res) => {
    const room = req.params.room
    if (!roleOf(req, room)) return res.status(403).json({ error: 'acces refuse' })
    setFavorite(room, req.session.user.email, !!req.body?.on)
    res.json({ ok: true })
  })

  // Recherche plein texte (contenu .md + lignes de bases), comme la recherche Cmd+K d'AFFiNE/Notion
  const stripMarkdown = (md) =>
    md
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/^\s*(#{1,6}|>|[-*+]( \[[ xX]\])?|\d+\.)\s+/gm, '')
      .replace(/^\s*\|?\s*:?-{3,}.*$/gm, '')
      .replace(/[|*_`~]/g, ' ')
      .replace(/\[\[|\]\]|==/g, '')
      .replace(/\s+/g, ' ')
  const snippetAround = (text, idx, qlen) => {
    const start = Math.max(0, idx - 40)
    return (start > 0 ? '…' : '') + text.slice(start, idx + qlen + 60)
  }
  // Lignes d'une base (format v2 Yjs ou v1 historique) -> [{ rowId, title, text }]
  function databaseRows(json) {
    if (!json) return []
    if (json.version === 2) {
      const titleProp = Object.values(json.schema || {}).find((p) => p.type === 'title')
      return Object.entries(json.rows || {}).map(([rowId, cells]) => {
        const texts = Object.entries(cells)
          .filter(([k, v]) => !k.startsWith('_') && typeof v === 'string')
          .map(([, v]) => v)
        return {
          rowId,
          title: (titleProp && cells[titleProp.id]) || 'Sans titre',
          text: stripMarkdown([...texts, cells._body || ''].join(' ')),
        }
      })
    }
    const titleProp = (json.properties || []).find((p) => p.type === 'text') || (json.properties || [])[0]
    return (json.rows || []).map((r) => ({
      rowId: r.id,
      title: (titleProp && r.cells?.[titleProp.id]) || 'Sans titre',
      text: Object.values(r.cells || {}).filter((v) => typeof v === 'string').join(' '),
    }))
  }

  app.get('/api/search', (req, res) => res.json(searchFor(req.session.user.email, req.query.q)))
  function searchFor(email, query, max = 30) {
    const q = String(query || '').trim().toLowerCase()
    if (!q) return []
    const results = []
    for (const { room, icon, type } of listRoomsForUser(email)) {
      if (type === 'database') {
        const p = sideFile(room, '.db.json')
        let json = null
        try {
          json = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null
        } catch {
          json = null
        }
        for (const row of databaseRows(json)) {
          const hay = `${row.title} ${row.text}`
          const idx = hay.toLowerCase().indexOf(q)
          if (idx === -1) continue
          results.push({ room, icon, type, rowId: row.rowId, label: row.title, snippet: snippetAround(hay, idx, q.length) })
          if (results.length >= max) break
        }
      } else {
        const p = filePath(room)
        const content = stripMarkdown(fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '')
        const idx = content.toLowerCase().indexOf(q)
        if (idx === -1) continue
        results.push({ room, icon, type, snippet: snippetAround(content, idx, q.length) })
      }
      if (results.length >= max) break
    }
    return results
  }

  app.get('/api/graph', (req, res) => {
    res.json(getGraphData(req.session.user.email))
  })

  app.get('/api/tag/:tag', (req, res) => {
    const email = req.session.user.email
    // Le tag vient de l'URL : échappé, sinon c'est une expression régulière arbitraire
    const tag = escapeRegExp(String(req.params.tag).slice(0, 100))
    const re = new RegExp(`(^|\\s)#${tag}(?![\\wÀ-ÿ-])`)
    const rooms = listRoomsForUser(email)
      .map((e) => e.room)
      .filter((r) => fs.existsSync(filePath(r)) && re.test(fs.readFileSync(filePath(r), 'utf8')))
    res.json({ rooms })
  })

  // Création : l'identifiant donné est le chemin voulu (« Projet/Spec ») ; le dossier
  // parent doit exister et être modifiable
  app.post('/api/doc/:room/create', (req, res) => {
    // Mode Nextcloud : pas de note hors de Nextcloud (premier lancement pas terminé)
    if (nextcloudOnly && !getSettings().vaults?.[VAULT.id]?.remote)
      return res.status(409).json({ error: 'connecte d’abord Yariche à ton Nextcloud' })
    const room = req.params.room.normalize('NFC')
    if (isTrashId(room) || !validId(room)) return res.status(400).json({ error: 'nom de page invalide' })
    const type = ['doc', 'board', 'database', 'folder'].includes(req.body?.type) ? req.body.type : 'doc'
    const parent = parentIdOf(room)
    if (!getDocMeta(room) && diskFree() < MIN_FREE_BYTES) return res.status(507).json({ error: 'disque du serveur presque plein' })
    // Invité d'un espace partagé en modification : il crée dans ce qu'on lui a partagé ;
    // l'élément appartient au propriétaire de l'espace
    if (req.session.user.guest) {
      const existing = getDocMeta(room)
      if (existing) return guestRole(req.session, room) ? res.json({ ok: true, meta: existing }) : res.status(403).json({ error: 'acces refuse' })
      if (!parent || !getDocMeta(parent) || guestRole(req.session, parent) !== 'editor')
        return res.status(403).json({ error: 'accès invité limité au document partagé' })
      if (idTaken(room)) return res.status(409).json({ error: 'ce nom existe déjà dans ce dossier' })
      const usage = usageOf(req.session.guest.token)
      if (usage.creates >= GUEST_LIMITS.createsPerLink) return res.status(429).json({ error: 'limite de créations atteinte pour ce lien' })
      usage.creates++
      const owner = getDocMeta(findShare(req.session.guest.token).room)?.owner || defaultOwner()
      const meta = ensureDocMeta(room, owner, type)
      ensureNodeOnDisk(room, type)
      if (meta.type === 'doc' && !fs.existsSync(mainFile(room, type))) writeFileEnsured(mainFile(room, type), '')
      req.session.guestCreated = [...(req.session.guestCreated || []), room].slice(-200)
      return res.json({ ok: true, meta })
    }
    const email = req.session.user.email
    if (parent) {
      if (!getDocMeta(parent)) return res.status(400).json({ error: 'dossier introuvable' })
      if (!canEdit(getRole(parent, email))) return res.status(403).json({ error: 'dossier non modifiable' })
    }
    const existed = getDocMeta(room)
    if (existed) {
      if (!getRole(room, email)) return res.status(403).json({ error: 'acces refuse' })
      return res.json({ ok: true, meta: existed })
    }
    // Un fichier existe déjà là (pas encore découvert) : on le reprend tel quel
    const meta = ensureDocMeta(room, email, type)
    ensureNodeOnDisk(room, type)
    const p = mainFile(room, type)
    // Contenu vide au départ : le titre est déjà affiché dans l'en-tête de page
    if (meta.type === 'doc' && !fs.existsSync(p)) writeFileEnsured(p, '')
    res.json({ ok: true, meta })
  })

  // Déplacer une page ou un dossier dans l'arborescence (glisser-déposer, « Déplacer vers… »)
  app.post('/api/doc/:room/move', (req, res) => {
    const room = req.params.room
    const email = req.session.user.email
    const meta = getDocMeta(room)
    if (!meta || isTrashId(room) || !isOwner(req, room)) return res.status(403).json({ error: 'reserve au proprietaire' })
    const parent = req.body?.parent || null
    if (parent) {
      const target = getDocMeta(parent)
      if (!target || isTrashId(parent)) return res.status(400).json({ error: 'destination introuvable' })
      if (!canEdit(getRole(parent, email))) return res.status(403).json({ error: 'destination non modifiable' })
      if (parent === room || parent.startsWith(`${room}/`))
        return res.status(400).json({ error: 'impossible de déplacer un élément dans lui-même' })
    }
    const newRoom = parent ? `${parent}/${baseName(room)}` : baseName(room)
    if (newRoom === room) return res.json({ ok: true, newRoom })
    if (idTaken(newRoom)) return res.status(409).json({ error: 'un élément porte déjà ce nom à cet endroit' })
    const updatedLinks = moveWithLinks(room, newRoom, req.session)
    res.json({ ok: true, newRoom, updatedLinks })
  })

  // Lien de partage pour des invités sans compte (propriétaire seulement)
  const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, '')
  const shareLinkInfo = (req, link) =>
    link ? { role: link.role, createdAt: link.createdAt, url: `${PUBLIC_URL || `${req.protocol}://${req.get('host')}`}/s/${link.token}` } : null
  const ownerOnly = (req, res) => {
    const meta = getDocMeta(req.params.room)
    if (!meta || !isOwner(req, req.params.room)) {
      res.status(403).json({ error: 'reserve au proprietaire' })
      return null
    }
    return meta
  }
  app.get('/api/doc/:room/share-link', (req, res) => {
    const meta = ownerOnly(req, res)
    if (meta) res.json({ link: shareLinkInfo(req, meta.shareLink) })
  })
  app.post('/api/doc/:room/share-link', (req, res) => {
    const meta = ownerOnly(req, res)
    if (!meta) return
    const role = req.body?.role === 'editor' ? 'editor' : 'viewer'
    const keep = meta.shareLink && !req.body?.regenerate
    const link = setShareLink(req.params.room, {
      token: keep ? meta.shareLink.token : randomBytes(24).toString('base64url'),
      role,
      createdAt: keep ? meta.shareLink.createdAt : Date.now(),
    })
    res.json({ link: shareLinkInfo(req, link) })
  })
  app.delete('/api/doc/:room/share-link', (req, res) => {
    if (!ownerOnly(req, res)) return
    setShareLink(req.params.room, null)
    res.json({ link: null })
  })

  // Partage: uniquement le proprietaire peut lire/modifier les reglages
  app.get('/api/doc/:room/share', (req, res) => {
    const meta = getDocMeta(req.params.room)
    if (!meta || !isOwner(req, req.params.room))
      return res.status(403).json({ error: 'reserve au proprietaire' })
    res.json(meta)
  })

  app.post('/api/doc/:room/share', (req, res) => {
    const room = req.params.room
    const meta = getDocMeta(room)
    if (!meta || !isOwner(req, room))
      return res.status(403).json({ error: 'reserve au proprietaire' })
    const updated = updateShareSettings(room, req.body)
    res.json(updated)
  })

  app.get('/api/doc/:room/conflict', (req, res) => {
    if (!roleOf(req, req.params.room))
      return res.status(403).json({ error: 'acces refuse' })
    res.json({ conflict: externalConflicts.get(req.params.room) || null })
  })

  app.post('/api/doc/:room/ack', (req, res) => {
    if (!roleOf(req, req.params.room)) return res.status(403).json({ error: 'acces refuse' })
    externalConflicts.delete(req.params.room)
    res.json({ ok: true })
  })

  // Un seul onglet applique la version arrivée de l'extérieur (les autres la reçoivent
  // par Yjs) : le premier qui la réclame l'obtient
  app.post('/api/doc/:room/conflict/claim', (req, res) => {
    const room = req.params.room
    if (!canEdit(roleOf(req, room))) return res.status(403).json({ error: 'acces refuse' })
    const conflict = externalConflicts.get(room)
    if (!conflict || conflict.id !== req.body?.id) return res.json({ ok: false })
    externalConflicts.delete(room)
    res.json({ ok: true, content: conflict.content })
  })

  // --- Coffres et Nextcloud (administrateurs) -------------------------------------------
  const ncAccount = () => accountFrom(getSettings())
  const vaultInfo = () => {
    const account = ncAccount()
    const remote = getSettings().vaults?.[VAULT.id]?.remote || null
    return {
      id: VAULT.id,
      // Nom affiché : celui du dossier Nextcloud quand le coffre y est enregistré
      name: remote ? remote.folder.split('/').pop() : VAULT.id,
      remote,
      sync: remote ? { ...syncStatus(), error: syncStatus().lastSync?.error || syncError } : null,
      nextcloud: account
        ? { connected: true, server: account.url, user: getSettings().nextcloud?.name || account.user, fromEnv: account.fromEnv }
        : { connected: false },
    }
  }
  // Premier lancement : ce qu'il reste à faire pour travailler dans Nextcloud
  // (step : 'connect' → se connecter, 'folder' → choisir le dossier, null → prêt)
  const setupInfo = () => {
    const settings = getSettings()
    const remote = settings.vaults?.[VAULT.id]?.remote
    const choseLocal = STORAGE === 'ask' && settings.storage === 'local'
    let step = null
    if (STORAGE !== 'local' && !choseLocal) {
      if (!ncAccount()) step = 'connect'
      else if (!remote) step = 'folder'
    }
    return {
      mode: STORAGE,
      step,
      allowLocal: !nextcloudOnly,
      defaultUrl: settings.nextcloud?.url || process.env.NEXTCLOUD_URL || '',
      suggestedFolder: `/${VAULT.id}`,
    }
  }
  // dir : chemin du coffre sur le serveur (l'app Mac s'en sert quand le serveur tourne sur le Mac)
  app.get('/api/vault', (req, res) =>
    res.json({
      ...vaultInfo(),
      admin: admin(req),
      setup: setupInfo(),
      ...(admin(req) ? { dir: VAULT.dir } : {}),
    })
  )
  // Mode « ask » : la personne préfère garder ses notes sur ce serveur
  app.post('/api/setup/local', requireAdmin, (req, res) => {
    if (nextcloudOnly) return res.status(403).json({ error: 'ce serveur enregistre les notes dans Nextcloud' })
    updateSettings({ storage: 'local' })
    res.json({ ok: true, setup: setupInfo() })
  })
  app.get('/api/vaults', requireAdmin, (req, res) => res.json(listVaults()))

  const switchTo = (res, id) => {
    openVault(id)
    res.json({ ok: true, vault: vaultInfo() })
  }
  app.post('/api/vaults/open', requireAdmin, (req, res) => {
    if (VAULT_DIR) return res.status(403).json({ error: 'coffre fixé par l’app' })
    const id = req.body?.id
    if (!listVaults().some((v) => v.id === id)) return res.status(404).json({ error: 'coffre introuvable' })
    if (id === VAULT.id) return res.json({ ok: true, vault: vaultInfo() })
    switchTo(res, id)
  })
  app.post('/api/vaults/create', requireAdmin, (req, res) => {
    if (VAULT_DIR) return res.status(403).json({ error: 'coffre fixé par l’app' })
    if (nextcloudOnly) return res.status(403).json({ error: 'les notes sont enregistrées dans Nextcloud : choisis un dossier Nextcloud' })
    const id = String(req.body?.name || '').normalize('NFC').trim()
    if (!validVaultName(id)) return res.status(400).json({ error: 'nom de coffre invalide' })
    if (listVaults().some((v) => v.id.toLowerCase() === id.toLowerCase()))
      return res.status(409).json({ error: 'ce coffre existe déjà' })
    fs.mkdirSync(path.join(VAULTS_DIR, id), { recursive: true })
    switchTo(res, id)
  })

  const setRemote = (id, remote) => {
    const vaults = { ...(getSettings().vaults || {}) }
    vaults[id] = { ...(vaults[id] || {}), remote }
    if (!remote) delete vaults[id].remote
    updateSettings({ vaults })
  }

  app.post('/api/nextcloud/connect', requireAdmin, async (req, res) => {
    try {
      const url = normalizeUrl(req.body?.url || '')
      const user = String(req.body?.user || '').trim()
      const password = String(req.body?.password || '').trim()
      if (!user || !password) return res.status(400).json({ error: 'identifiant et mot de passe d’application requis' })
      const who = await whoami({ url, user, password })
      updateSettings({ nextcloud: { url, user, password, name: who.name } })
      startVaultSync()
      res.json({ ok: true, vault: vaultInfo() })
    } catch (err) {
      res.status(400).json({ error: err.message })
    }
  })
  // Connexion par le navigateur : Yariche demande une connexion à Nextcloud, la personne
  // l'autorise sur la page qui s'ouvre, le client interroge /poll jusqu'à la fin
  const loginFlows = new Map()
  app.post('/api/nextcloud/login/start', requireAdmin, async (req, res) => {
    try {
      const flow = await startLoginFlow(req.body?.url || setupInfo().defaultUrl)
      const id = randomUUID()
      loginFlows.set(id, flow)
      setTimeout(() => loginFlows.delete(id), 20 * 60 * 1000) // durée de vie côté Nextcloud
      res.json({ id, login: flow.login })
    } catch (err) {
      res.status(400).json({ error: err.message })
    }
  })
  app.post('/api/nextcloud/login/poll', requireAdmin, async (req, res) => {
    const flow = loginFlows.get(req.body?.id)
    if (!flow) return res.status(410).json({ error: 'connexion expirée : recommence' })
    try {
      const account = await pollLoginFlow(flow)
      if (!account) return res.json({ done: false })
      loginFlows.delete(req.body.id)
      const who = await whoami(account)
      updateSettings({ nextcloud: { ...account, name: who.name } })
      startVaultSync()
      res.json({ done: true, vault: vaultInfo(), setup: setupInfo() })
    } catch (err) {
      res.status(400).json({ error: err.message })
    }
  })

  app.post('/api/nextcloud/disconnect', requireAdmin, (req, res) => {
    if (ncAccount()?.fromEnv) return res.status(400).json({ error: 'compte défini par les variables NEXTCLOUD_* du serveur' })
    updateSettings({ nextcloud: null })
    stopSync()
    res.json({ ok: true, vault: vaultInfo() })
  })

  const withAccount = (handler) => async (req, res) => {
    const account = ncAccount()
    if (!account) return res.status(400).json({ error: 'Nextcloud n’est pas connecté' })
    try {
      const { id: uid } = await whoami(account)
      await handler(req, res, account, uid)
    } catch (err) {
      res.status(400).json({ error: err.message })
    }
  }
  app.get(
    '/api/nextcloud/folders',
    requireAdmin,
    withAccount(async (req, res, account, uid) => {
      const folder = normalizeFolder(req.query.path || '/')
      const { folders, size } = await listFolders(account, uid, folder)
      res.json({ path: folder, size, folders, maxBytes: MAX_VAULT_BYTES })
    })
  )
  app.post(
    '/api/nextcloud/folders',
    requireAdmin,
    withAccount(async (req, res, account, uid) => {
      const folder = normalizeFolder(req.body?.path || '')
      if (folder === '/') return res.status(400).json({ error: 'nom de dossier requis' })
      await createFolder(account, uid, folder)
      res.json({ ok: true, path: folder })
    })
  )

  const tooBig = async (account, uid, folder) => {
    const size = await folderSize(account, uid, folder)
    if (size === null || size <= MAX_VAULT_BYTES) return null
    const gb = (n) => `${(n / 1024 ** 3).toFixed(1).replace('.', ',')} Go`
    return `ce dossier pèse ${gb(size)} : il serait copié en entier sur le serveur (limite ${gb(MAX_VAULT_BYTES)}, variable NEXTCLOUD_MAX_VAULT_MB). Choisis un dossier de notes.`
  }

  // « Travailler dans ce dossier » : le coffre local lié à ce dossier Nextcloud (créé au
  // besoin, du même nom), puis synchronisation dans les deux sens
  app.post(
    '/api/vault/open-remote',
    requireAdmin,
    withAccount(async (req, res, account, uid) => {
      const folder = normalizeFolder(req.body?.folder || '')
      if (folder === '/') return res.status(400).json({ error: 'choisis un dossier plutôt que la racine de Nextcloud' })
      const big = await tooBig(account, uid, folder)
      if (big) return res.status(400).json({ error: big })
      const vaults = listAllVaults()
      const linked = vaults.find((v) => v.remote?.folder === folder)
      if (linked) return switchTo(res, linked.id)
      const base = folder.split('/').pop()
      let id = base
      let n = 2
      // Coffre local du même nom pas encore lié : on le lie (ses notes partent vers Nextcloud)
      while (vaults.some((v) => v.id === id && v.remote)) id = `${base} ${n++}`
      fs.mkdirSync(path.join(VAULTS_DIR, id), { recursive: true })
      setRemote(id, { folder })
      switchTo(res, id)
    })
  )
  app.post(
    '/api/vault/link',
    requireAdmin,
    withAccount(async (req, res, account, uid) => {
      const folder = normalizeFolder(req.body?.folder || '')
      if (folder === '/') return res.status(400).json({ error: 'choisis un dossier plutôt que la racine de Nextcloud' })
      const big = await tooBig(account, uid, folder)
      if (big) return res.status(400).json({ error: big })
      const taken = listVaults().find((v) => v.remote?.folder === folder && v.id !== VAULT.id)
      if (taken) return res.status(409).json({ error: `déjà lié au coffre « ${taken.id} »` })
      setRemote(VAULT.id, { folder })
      await startVaultSync()
      res.json({ ok: true, vault: vaultInfo() })
    })
  )
  app.post('/api/vault/unlink', requireAdmin, (req, res) => {
    if (nextcloudOnly) return res.status(403).json({ error: 'les notes sont enregistrées dans Nextcloud' })
    setRemote(VAULT.id, null)
    stopSync()
    res.json({ ok: true, vault: vaultInfo() })
  })
  app.post('/api/vault/sync', (req, res) => {
    requestSync(0)
    res.json({ ok: true })
  })

  // Assistant IA : API compatible OpenAI (LLM_BASE_URL + LLM_MODEL, clé facultative).
  // Actions façon Notion (améliorer, corriger…) sur une sélection, ou instruction libre.
  const AI_ACTIONS = {
    improve: "Améliore l'écriture du texte : plus clair et plus fluide, même sens, même langue.",
    fix: "Corrige l'orthographe, la grammaire et la ponctuation du texte sans changer le style ni le sens.",
    shorten: 'Raccourcis le texte en gardant les idées essentielles.',
    expand: 'Développe le texte avec plus de détails, sans inventer de faits.',
    simplify: 'Réécris le texte en termes plus simples.',
    summarize: 'Résume le texte en quelques phrases ou puces.',
    translate_en: 'Traduis le texte en anglais.',
    translate_fr: 'Traduis le texte en français.',
    continue: "Continue l'écriture à la suite du texte fourni, dans le même style. Ne répète pas le texte existant.",
    explain: 'Explique le texte simplement.',
    complete: "Continue le texte à l'endroit exact où il s'arrête, avec une à deux phrases au plus. Réponds uniquement par la suite, sans répéter le texte donné.",
    actions: 'Extrais les actions à faire du texte sous forme de liste de tâches markdown (- [ ] ...).',
  }
  app.post('/api/ai', async (req, res) => {
    const { prompt, context, action, selection } = req.body || {}
    const instruction = AI_ACTIONS[action] || (typeof prompt === 'string' ? prompt.trim() : '')
    if (!instruction) return res.status(400).json({ error: 'prompt manquant' })
    if (!LLM_BASE_URL || !LLM_MODEL)
      return res.status(503).json({ error: 'assistant IA non configuré (LLM_BASE_URL et LLM_MODEL)' })

    const messages = [
      {
        role: 'system',
        content:
          "Tu es l'assistant d'écriture intégré à un éditeur markdown. Réponds uniquement avec le texte demandé, en markdown, sans préambule, sans explication ni guillemets autour, sans bloc de code englobant. Réponds dans la langue du texte sauf demande contraire.",
      },
    ]
    const completing = action === 'complete'
    if (context && !completing) messages.push({ role: 'user', content: `Contexte (page en cours) :\n${String(context).slice(0, 6000)}` })
    if (selection) messages.push({ role: 'user', content: `Texte concerné :\n${String(selection).slice(0, 8000)}` })
    if (completing) messages.push({ role: 'user', content: `Texte à continuer :\n${String(context || '').slice(-3000)}` })
    messages.push({ role: 'user', content: instruction })

    try {
      const r = await fetch(`${LLM_BASE_URL}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(LLM_API_KEY ? { Authorization: `Bearer ${LLM_API_KEY}` } : {}),
        },
        body: JSON.stringify({ model: LLM_MODEL, messages, temperature: completing ? 0.3 : 0.4, ...(completing ? { max_tokens: 80 } : {}) }),
        signal: AbortSignal.timeout(completing ? 20000 : 120000),
      })
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`)
      const data = await r.json()
      res.json({ text: data.choices?.[0]?.message?.content ?? '' })
    } catch (err) {
      console.error('[ia] appel impossible :', err.message)
      res.status(502).json({ error: `assistant IA injoignable : ${err.message}` })
    }
  })

  const server = http.createServer(app)
  // Messages Yjs plafonnés : un client (ou un invité) ne peut pas saturer la mémoire
  const wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 })

  server.on('upgrade', async (req, socket, head) => {
    // Origine vérifiée : une autre page ouverte dans le navigateur ne peut pas se connecter
    // au temps réel avec la session de la personne (les cookies SameSite=Lax aident aussi)
    const origin = req.headers.origin
    if (origin) {
      let sameOrigin = false
      try {
        sameOrigin = new URL(origin).host === req.headers.host
      } catch {
        sameOrigin = false
      }
      if (!sameOrigin) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
        socket.destroy()
        return
      }
    }
    if (LOCAL_TOKEN && (!localHostOk(req) || !hasLocalCookie(req))) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      socket.destroy()
      return
    }
    const session = await runSessionMiddleware(req)
    if (!session) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      socket.destroy()
      return
    }
    let room
    let shownVault = null
    try {
      const url = new URL(req.url, 'http://x')
      // /ws/<page> (et /<page> pour les clients d'avant le préfixe)
      room = decodeURIComponent(url.pathname.replace(/^\/(ws\/)?/, '')) || 'default'
      shownVault = url.searchParams.get('vault')
    } catch {
      room = ''
    }
    // Onglet resté sur un autre coffre : il renverrait son ancien contenu dans ce coffre
    if (shownVault && shownVault !== VAULT.id) {
      socket.write('HTTP/1.1 409 Conflict\r\n\r\n')
      socket.destroy()
      return
    }
    const role = validId(room) ? sessionRole(session, room) : null
    if (!role) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (conn) => {
      // Lecteurs : le client ne rend pas l'éditeur modifiable, mais rien n'empêchait
      // d'envoyer des mises à jour Yjs à la main. On filtre donc côté serveur.
      if (!canEdit(role)) makeReadOnly(conn)
      // Invité (lien public) : débit de modifications plafonné, sinon coupé
      if (session.user.guest) limitIncoming(conn, GUEST_LIMITS.realtimeBytesPerMinute)
      setupWSConnection(conn, req, { docName: room, gc: true })
    })
  })

  function limitIncoming(conn, bytesPerMinute) {
    let used = 0
    const timer = setInterval(() => (used = 0), 60_000)
    timer.unref()
    conn.once('close', () => clearInterval(timer))
    const originalOn = conn.on.bind(conn)
    conn.on = (event, listener) => {
      if (event !== 'message') return originalOn(event, listener)
      return originalOn('message', (data, isBinary) => {
        used += data?.length ?? data?.byteLength ?? 0
        if (used > bytesPerMinute) return conn.close(1008, 'trop de donnees')
        listener(data, isBinary)
      })
    }
  }

  // Protocole y-websocket : [type varUint][...] ; type 0 = sync (sous-type 0 = step1
  // "envoie-moi ton état", 1 = step2, 2 = update), type 1 = awareness.
  // Un lecteur garde step1 (pour recevoir le document) et awareness (présence).
  function makeReadOnly(conn) {
    const originalOn = conn.on.bind(conn)
    conn.on = (event, listener) => {
      if (event !== 'message') return originalOn(event, listener)
      return originalOn('message', (data, isBinary) => {
        try {
          const decoder = decoding.createDecoder(new Uint8Array(data))
          const messageType = decoding.readVarUint(decoder)
          if (messageType === 0 && decoding.readVarUint(decoder) !== 0) return
        } catch {
          return
        }
        listener(data, isBinary)
      })
    }
  }

  server.listen(PORT, HOST, () => {
    console.log(`Yariche sur http://localhost:${PORT} (données : ${DATA_DIR})`)
    console.log(LLM_BASE_URL && LLM_MODEL ? `[ia] ${LLM_BASE_URL} (modèle ${LLM_MODEL})` : '[ia] non configurée')
  })
}

main()
