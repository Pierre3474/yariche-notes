// Migration des métadonnées d'un coffre vers l'identification par chemin (v2).
//
// v1 (.yariche/meta.json) : éléments repérés par leur NOM, unique dans tout le coffre,
// avec un pointeur « parent » ; les fichiers étaient déjà rangés selon ces parents.
// v2 (.yariche/nodes.json) : éléments repérés par leur CHEMIN (« R521/Concepts/MIMO »).
//
// Les fichiers ne bougent pas : le chemin v2 est exactement là où v1 les avait rangés.
// Versions et commentaires (fichiers par élément) sont renommés, l'ancien meta.json est
// gardé en meta.v1.json.
import fs from 'fs'
import path from 'path'
import { storageKey } from './storage-key.js'

export function migrateVaultToV2(internalDir, { renameNotification = () => {}, log = console } = {}) {
  const v1Path = path.join(internalDir, 'meta.json')
  const v2Path = path.join(internalDir, 'nodes.json')
  if (fs.existsSync(v2Path) || !fs.existsSync(v1Path)) return null
  let v1
  try {
    v1 = JSON.parse(fs.readFileSync(v1Path, 'utf8'))
  } catch {
    return null
  }

  // Chemin v1 d'un élément (même règle que l'ancien rangement : à la corbeille, la racine
  // supprimée va dans .trash/ et ses sous-pages la suivent)
  const segments = (name, seen = new Set()) => {
    const m = v1[name]
    if (!m || seen.has(name)) return []
    seen.add(name)
    if (m.deletedAt && (m.trashRoot || !m.parent || !v1[m.parent]?.deletedAt)) return ['.trash']
    const parent = m.parent && v1[m.parent] ? m.parent : null
    return parent ? [...segments(parent, seen), parent] : []
  }
  // Emplacement d'origine d'un élément à la corbeille (sans tenir compte de la corbeille)
  const originalOf = (name, seen = new Set()) => {
    const m = v1[name]
    if (!m || seen.has(name)) return name
    seen.add(name)
    const own = m.originalName || name
    const parent = m.parent && v1[m.parent] ? m.parent : null
    return parent ? `${originalOf(parent, seen)}/${own}` : own
  }

  const nodes = {}
  const renamed = [] // [ancien nom, nouvel identifiant]
  for (const [name, m] of Object.entries(v1)) {
    const id = [...segments(name), name].join('/')
    const next = { ...m }
    delete next.parent
    delete next.trashedWith
    delete next.originalName
    if (m.deletedAt && id.startsWith('.trash/') && id.split('/').length === 2) {
      next.trashRoot = true
      next.originalId = originalOf(name)
    } else {
      delete next.trashRoot
    }
    if (nodes[id]) {
      log.warn(`[migration] ${id} en double, « ${name} » ignoré`)
      continue
    }
    nodes[id] = next
    if (id !== name) renamed.push([name, id])
  }

  // Fichiers par élément : versions (dossier) et commentaires (fichier)
  const moveIfExists = (from, to) => {
    if (from !== to && fs.existsSync(from) && !fs.existsSync(to)) fs.renameSync(from, to)
  }
  for (const name of Object.keys(v1)) {
    const id = [...segments(name), name].join('/')
    moveIfExists(path.join(internalDir, 'versions', name), path.join(internalDir, 'versions', storageKey(id)))
    moveIfExists(path.join(internalDir, 'comments', `${name}.json`), path.join(internalDir, 'comments', `${storageKey(id)}.json`))
  }

  // Index des liens : mêmes textes de liens, rangés sous le nouvel identifiant
  const linksPath = path.join(internalDir, 'links.json')
  try {
    const links = JSON.parse(fs.readFileSync(linksPath, 'utf8'))
    const next = {}
    for (const [name, targets] of Object.entries(links)) {
      if (!v1[name]) continue
      next[[...segments(name), name].join('/')] = targets
    }
    fs.writeFileSync(`${linksPath}.tmp`, JSON.stringify(next, null, 2))
    fs.renameSync(`${linksPath}.tmp`, linksPath)
  } catch {
    /* pas d'index : il se reconstruit à l'enregistrement */
  }

  for (const [from, to] of renamed) renameNotification(from, to)

  fs.writeFileSync(`${v2Path}.tmp`, JSON.stringify(nodes, null, 2))
  fs.renameSync(`${v2Path}.tmp`, v2Path)
  fs.renameSync(v1Path, path.join(internalDir, 'meta.v1.json'))
  log.log(`[migration] ${Object.keys(nodes).length} élément(s) repérés par leur chemin (${renamed.length} renommés)`)
  return { count: Object.keys(nodes).length, renamed }
}
