// Historique de versions par page : un snapshot du contenu précédent est
// gardé à chaque sauvegarde, dans <coffre>/.yariche/versions/<chemin encodé>/<horodatage>.md
import fs from 'fs'
import path from 'path'
import { storageKey } from './storage-key.js'

const MAX_VERSIONS = 30
let versionsDir = null

export function initVersionStore(dir) {
  versionsDir = dir
  fs.mkdirSync(versionsDir, { recursive: true })
}

// Un dossier par élément, nommé d'après son chemin encodé (« R521%2FConcepts%2FMIMO »)
function roomDir(room) {
  const dir = path.join(versionsDir, storageKey(room))
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

// A appeler AVANT d'ecraser le fichier courant, avec l'ancien contenu.
export function snapshotVersion(room, previousContent) {
  if (!previousContent || !previousContent.trim()) return
  const dir = roomDir(room)
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  fs.writeFileSync(path.join(dir, `${ts}.md`), previousContent, 'utf8')

  const files = fs.readdirSync(dir).sort()
  while (files.length > MAX_VERSIONS) {
    fs.unlinkSync(path.join(dir, files.shift()))
  }
}

export function listVersions(room) {
  const dir = roomDir(room)
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .reverse()
    .map((f) => f.replace(/\.md$/, ''))
}

export function readVersion(room, ts) {
  // Horodatage seulement (pas de chemin) : pas de lecture hors du dossier de versions
  if (!/^[\w-]+$/.test(String(ts))) return null
  const p = path.join(roomDir(room), `${ts}.md`)
  if (!fs.existsSync(p)) return null
  return fs.readFileSync(p, 'utf8')
}
