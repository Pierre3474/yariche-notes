// Métadonnées des éléments du coffre (pages, bases, whiteboards, dossiers), repérés par
// leur CHEMIN dans le coffre, sans extension : « R521/Concepts/MIMO ». Comme dans
// Obsidian, deux notes peuvent porter le même nom dans des dossiers différents ; le
// dossier parent se déduit du chemin.
//
// Corbeille : le dossier .trash/ du coffre. Un élément supprimé y garde son chemin
// (« .trash/R521/Concepts/MIMO ») et retient son emplacement d'origine (originalId).
//
// Un fichier JSON dans .yariche/ : pas de base de données à installer, et rien de
// visible dans le dossier de notes (Nextcloud, Obsidian).
import fs from 'fs'
import path from 'path'

let nodesPath
let cache = {}
let version = 0 // change à chaque modification (caches de résolution des liens)

export const TRASH = '.trash'
export const isTrashId = (id) => id === TRASH || id.startsWith(`${TRASH}/`)
export const parentIdOf = (id) => {
  const i = id.lastIndexOf('/')
  return i === -1 ? null : id.slice(0, i)
}
export const baseName = (id) => id.slice(id.lastIndexOf('/') + 1)
export const isInside = (id, root) => id === root || id.startsWith(`${root}/`)

// Écriture atomique : un arrêt brutal ne laisse jamais un JSON tronqué
function writeJsonAtomic(p, value) {
  const tmp = `${p}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
  fs.renameSync(tmp, p)
}

export function initMetaStore(internalDir) {
  nodesPath = path.join(internalDir, 'nodes.json')
  try {
    cache = JSON.parse(fs.readFileSync(nodesPath, 'utf8'))
  } catch {
    cache = {}
    writeJsonAtomic(nodesPath, cache)
  }
  version++
}

function persist() {
  version++
  writeJsonAtomic(nodesPath, cache)
}

export const getDocMeta = (id) => cache[id] || null
export const allMetaEntries = () => Object.entries(cache)

const newMeta = (owner, type) => ({
  owner,
  type, // 'doc' | 'board' | 'database' | 'folder'
  visibility: 'private', // 'private' | 'link' | 'shared'
  linkRole: 'viewer', // rôle accordé si visibility === 'link'
  shares: {}, // { email: 'viewer' | 'editor' }
  appearance: { icon: null, cover: null }, // pas d'icône par défaut (comme Notion/AFFiNE)
  createdAt: Date.now(),
  deletedAt: null,
})

export function ensureDocMeta(id, owner, type = 'doc') {
  if (!cache[id]) {
    cache[id] = newMeta(owner, type)
    persist()
  } else if (!cache[id].appearance) {
    cache[id].appearance = { icon: null, cover: null }
    persist()
  }
  return cache[id]
}

// Création brute (fichiers ou dossiers ajoutés hors de Yariche)
export function createMeta(id, { owner, type = 'doc', ino = null }) {
  if (cache[id]) return cache[id]
  cache[id] = { ...newMeta(owner, type), ...(ino ? { ino } : {}) }
  persist()
  return cache[id]
}

export function duplicateDoc(id, newId, owner) {
  const meta = cache[id]
  if (!meta) return null
  const copy = { ...structuredClone(meta), owner, shares: {}, visibility: 'private', createdAt: Date.now(), deletedAt: null }
  delete copy.ino
  delete copy.shareLink
  delete copy.favoritedBy
  cache[newId] = copy
  persist()
  return cache[newId]
}

// Tous les descendants (sous-pages, contenu d'un dossier), en profondeur
export const descendantsOf = (id) => Object.keys(cache).filter((k) => k !== id && k.startsWith(`${id}/`))

// Déplace / renomme un élément et tout ce qu'il contient : les chemins changent de
// préfixe. Renvoie les paires [ancien, nouveau] (pour les fichiers annexes à suivre).
export function moveSubtree(fromId, toId) {
  const pairs = []
  for (const key of Object.keys(cache)) {
    if (!isInside(key, fromId)) continue
    pairs.push([key, toId + key.slice(fromId.length)])
  }
  // Clés cibles déjà prises (ne devrait pas arriver : vérifié par l'appelant)
  if (pairs.some(([, to]) => cache[to] && !pairs.some(([from]) => from === to))) throw new Error('destination déjà utilisée')
  const moved = pairs.map(([from, to]) => [to, cache[from]])
  for (const [from] of pairs) delete cache[from]
  for (const [to, meta] of moved) cache[to] = meta
  for (const [from, to] of pairs) {
    if (linksIndex[from]) {
      linksIndex[to] = linksIndex[from]
      delete linksIndex[from]
    }
  }
  persist()
  if (pairs.length) persistLinks()
  return pairs
}

// Racine d'un élément mis à la corbeille (après déplacement dans .trash/)
export function markTrashed(trashId, originalId) {
  const meta = cache[trashId]
  if (!meta) return
  meta.deletedAt = Date.now()
  meta.trashRoot = true
  meta.originalId = originalId
  persist()
}
export function clearTrashed(id) {
  const meta = cache[id]
  if (!meta) return
  meta.deletedAt = null
  delete meta.trashRoot
  delete meta.originalId
  persist()
}

export function listTrashForUser(email) {
  return Object.entries(cache)
    .filter(([id, meta]) => isTrashId(id) && meta.trashRoot && meta.owner === email)
    .map(([id, meta]) => {
      const original = meta.originalId || id.slice(TRASH.length + 1)
      return {
        room: id,
        name: baseName(original),
        icon: meta.appearance?.icon || null,
        type: meta.type || 'doc',
        deletedAt: meta.deletedAt,
        children: descendantsOf(id).length,
        // Emplacement d'origine, pour « était dans Travail / Clients »
        path: original.split('/').slice(0, -1),
      }
    })
}

// Inodes vus sur le disque : un fichier déplacé hors de Yariche garde le sien, ce qui
// permet de suivre ses métadonnées (icône, partage, commentaires…)
export function setInodes(map) {
  let changed = false
  for (const [id, ino] of Object.entries(map)) {
    if (cache[id] && ino && cache[id].ino !== ino) {
      cache[id].ino = ino
      changed = true
    }
  }
  if (changed) persist()
}

// Lien de partage pour des invités sans compte : { token, role, createdAt } ou null
export function setShareLink(id, link) {
  const meta = cache[id]
  if (!meta) return null
  if (link) meta.shareLink = link
  else delete meta.shareLink
  persist()
  return meta.shareLink || null
}

// Pages d'un utilisateur reprises par un autre (mode sans connexion → vrai compte)
export function reassignOwner(from, to) {
  let count = 0
  for (const meta of Object.values(cache)) {
    if (reassignInMeta(meta, from, to)) count++
  }
  if (count) persist()
  return count
}
export function reassignInMeta(meta, from, to) {
  let changed = false
  if (meta.owner === from) {
    meta.owner = to
    changed = true
  }
  if (meta.shares?.[from]) {
    if (!meta.shares[to]) meta.shares[to] = meta.shares[from]
    delete meta.shares[from]
    changed = true
  }
  if (meta.favoritedBy?.includes(from)) {
    meta.favoritedBy = [...new Set(meta.favoritedBy.map((e) => (e === from ? to : e)))]
    changed = true
  }
  return changed
}

// Élément disparu (supprimé hors de Yariche) ou purgé de la corbeille : il est oublié,
// avec tout ce qu'il contenait
export function removeMeta(id) {
  const keys = [id, ...descendantsOf(id)].filter((k) => cache[k])
  if (!keys.length) return []
  for (const k of keys) {
    delete cache[k]
    delete linksIndex[k]
  }
  persist()
  persistLinks()
  return keys
}

// Icône = un emoji (quelques caractères, pas de balisage) ; couverture = identifiant de dégradé
const cleanIcon = (v) => (typeof v === 'string' && v.length <= 16 && !/[<>&"'`\\]/.test(v) ? v : null)
const cleanCover = (v) => (typeof v === 'string' && /^[\w-]{1,40}$/.test(v) ? v : null)

export function updateAppearance(id, { icon, cover }) {
  const meta = cache[id]
  if (!meta) return null
  if (!meta.appearance) meta.appearance = { icon: null, cover: null }
  if (icon !== undefined) meta.appearance.icon = icon === null ? null : cleanIcon(icon)
  if (cover !== undefined) meta.appearance.cover = cover === null ? null : cleanCover(cover)
  persist()
  return meta.appearance
}

const ROLES = new Set(['viewer', 'editor'])
const IDENTITY_RE = /^([^\s@]+@[^\s@]+|[a-z0-9][a-z0-9._-]{0,63})$/i
const VISIBILITIES = new Set(['private', 'link', 'shared'])

// Seules les valeurs prévues passent : le rôle « owner » ne se donne pas par un partage
export function updateShareSettings(id, { visibility, linkRole, shares } = {}) {
  const meta = cache[id]
  if (!meta) return null
  if (VISIBILITIES.has(visibility)) meta.visibility = visibility
  if (ROLES.has(linkRole)) meta.linkRole = linkRole
  if (shares && typeof shares === 'object') {
    meta.shares = Object.fromEntries(
      Object.entries(shares)
        // Email, ou identifiant SSO (comptes sans email)
        .filter(([email, role]) => IDENTITY_RE.test(email) && email.length <= 254 && ROLES.has(role))
        .slice(0, 500)
        .map(([email, role]) => [email.toLowerCase(), role])
    )
  }
  persist()
  return meta
}

// Tous les emails rencontrés (propriétaires + invités) : candidats aux @mentions
export function allKnownEmails() {
  const emails = new Set()
  for (const meta of Object.values(cache)) {
    if (meta.owner) emails.add(meta.owner)
    for (const email of Object.keys(meta.shares || {})) emails.add(email)
  }
  return [...emails]
}

export function setFavorite(id, email, on) {
  const meta = cache[id]
  if (!meta) return
  const set = new Set(meta.favoritedBy || [])
  if (on) set.add(email)
  else set.delete(email)
  meta.favoritedBy = [...set]
  persist()
}

// Éléments de la barre latérale : les siens et ceux partagés avec soi, directement ou par
// un dossier partagé (espace d'équipe). Les pages ouvertes « à qui a le lien » n'y sont pas.
export function listRoomsForUser(email) {
  const listed = (id) => !!cache[id] && !isTrashId(id) && !!inheritedRole(id, email, memberRole)
  return Object.entries(cache)
    .filter(([id]) => listed(id))
    .map(([id, meta]) => {
      const parent = parentIdOf(id)
      return {
        room: id,
        name: baseName(id),
        icon: meta.appearance?.icon || null,
        // Parent inaccessible (espace partagé dans un dossier privé) : affiché à la racine
        parent: parent && listed(parent) ? parent : null,
        type: meta.type || 'doc',
        favorite: (meta.favoritedBy || []).includes(email),
        shared: isShared(meta),
      }
    })
}

const RANK = { viewer: 1, editor: 2, owner: 3 }
const isShared = (meta) =>
  Object.keys(meta.shares || {}).length > 0 || meta.visibility === 'link' || !!meta.shareLink
function memberRole(meta, email) {
  if (!meta || !email) return null
  if (meta.owner === email) return 'owner'
  return meta.shares?.[email] || null
}
function ownRole(meta, email) {
  if (!meta || !email) return null
  return memberRole(meta, email) || (meta.visibility === 'link' ? meta.linkRole : null)
}
// Meilleur rôle entre celui de l'élément et ceux de ses dossiers parents
function inheritedRole(id, email, roleOf) {
  let best = null
  for (let cur = id; cur; cur = parentIdOf(cur)) {
    const role = roleOf(cache[cur], email)
    if (role && (!best || RANK[role] > RANK[best])) best = role
    if (best === 'owner') break
  }
  return best
}

// Rôle sur l'élément : 'owner' | 'editor' | 'viewer' | null. Un dossier partagé est un
// espace d'équipe : tout ce qu'il contient l'est aussi, y compris ce qui est créé après
// (comme les Teamspaces de Notion). Le propriétaire d'un dossier l'est de son contenu.
export function getRole(id, email) {
  if (!cache[id]) return null
  return inheritedRole(id, email, ownRole)
}

export function canEdit(role) {
  return role === 'owner' || role === 'editor'
}

// --- Liens [[…]] : résolus comme dans Obsidian -----------------------------------------
// L'index garde le texte des liens de chaque page (« MIMO », « R521/Concepts/MIMO »),
// résolus à la demande : ajouter ou déplacer une page change leur cible.
let linksIndex = {}
let linksPath = null

export function initLinksIndex(internalDir) {
  linksPath = path.join(internalDir, 'links.json')
  try {
    linksIndex = JSON.parse(fs.readFileSync(linksPath, 'utf8'))
  } catch {
    linksIndex = {}
  }
  // Entrées orphelines (pages disparues)
  const stale = Object.keys(linksIndex).filter((id) => !cache[id])
  if (stale.length) {
    stale.forEach((id) => delete linksIndex[id])
    persistLinks()
  }
}

function persistLinks() {
  if (linksPath) writeJsonAtomic(linksPath, linksIndex)
}

export function setLinks(id, targets) {
  linksIndex[id] = [...new Set(targets)]
  persistLinks()
}

// Plusieurs pages d'un coup (indexation d'un coffre importé) : une seule écriture
export function setLinksMany(map) {
  for (const [id, targets] of Object.entries(map)) linksIndex[id] = [...new Set(targets)]
  persistLinks()
}
export const hasLinks = (id) => Object.hasOwn(linksIndex, id)

const fold = (s) => String(s).normalize('NFC').toLowerCase()
let byNameCache = { version: -1, map: new Map() }
function pagesByName() {
  if (byNameCache.version === version) return byNameCache.map
  const map = new Map()
  for (const [id, meta] of Object.entries(cache)) {
    if (isTrashId(id) || meta.type === 'folder') continue
    const key = fold(baseName(id))
    if (!map.has(key)) map.set(key, [])
    map.get(key).push(id)
  }
  byNameCache = { version, map }
  return map
}

// Cible d'un lien [[target]] écrit dans la page fromId, ou null. Même règle qu'Obsidian :
// chemin complet ou fin de chemin si le lien contient « / », sinon le nom ; en cas
// d'homonymes, celui du même dossier, puis le chemin le plus court.
export function resolveLink(target, fromId = null) {
  let t = String(target || '').trim().replace(/\.md$/i, '')
  if (!t) return null
  if (t.includes('/')) {
    t = t.replace(/^\/+/, '')
    const want = fold(t)
    const hits = Object.keys(cache).filter(
      (id) => !isTrashId(id) && cache[id].type !== 'folder' && (fold(id) === want || fold(id).endsWith(`/${want}`))
    )
    return pick(hits, fromId)
  }
  return pick(pagesByName().get(fold(t)) || [], fromId)
}
function pick(ids, fromId) {
  if (!ids.length) return null
  if (ids.length === 1) return ids[0]
  const folder = fromId ? parentIdOf(fromId) : null
  const same = ids.find((id) => parentIdOf(id) === folder)
  if (same) return same
  return [...ids].sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))[0]
}

// Pages qui pointent vers id (liens résolus)
export function getBacklinks(id) {
  return Object.entries(linksIndex)
    .filter(([source, targets]) => cache[source] && !isTrashId(source) && targets.some((t) => resolveLink(t, source) === id))
    .map(([source]) => source)
}

// Textes de liens à réécrire quand id change de nom : { source: [textes] }
export function linkTextsTo(id) {
  const out = {}
  for (const [source, targets] of Object.entries(linksIndex)) {
    const hits = targets.filter((t) => resolveLink(t, source) === id)
    if (hits.length) out[source] = hits
  }
  return out
}

export function getGraphData(email) {
  const visible = Object.keys(cache).filter((id) => !isTrashId(id) && cache[id].type !== 'folder' && getRole(id, email))
  const visibleSet = new Set(visible)
  const edges = []
  for (const [source, targets] of Object.entries(linksIndex)) {
    if (!visibleSet.has(source)) continue
    for (const t of targets) {
      const target = resolveLink(t, source)
      if (target && visibleSet.has(target)) edges.push({ from: source, to: target })
    }
  }
  return { nodes: visible, edges }
}
