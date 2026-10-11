// Utilisateurs connus (pour les @mentions) et notifications (boîte de réception).
// Même approche que meta-store : JSON à côté des .md, suffisant à l'échelle homelab.
import fs from 'fs'
import path from 'path'

let usersPath
let notifPath
let users = {}
let notifs = {}

const MAX_NOTIFS_PER_USER = 200

function readJson(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch {
    return fallback
  }
}

function write(p, value) {
  fs.writeFileSync(p, JSON.stringify(value, null, 2), 'utf8')
}

export function initSocialStore(dataDir) {
  usersPath = path.join(dataDir, '_users.json')
  notifPath = path.join(dataDir, '_notifications.json')
  users = readJson(usersPath, {})
  notifs = readJson(notifPath, {})
}

const displayName = (email) => (email || '').split('@')[0]

// Appelé à chaque /api/me : on ne réécrit le fichier que si quelque chose change
// (ou au plus une fois par heure pour lastSeen).
export function touchUser({ email, name }) {
  if (!email) return
  const prev = users[email]
  const nextName = name || displayName(email)
  if (prev && prev.name === nextName && Date.now() - (prev.lastSeen || 0) < 3600_000) return
  users[email] = { name: nextName, lastSeen: Date.now() }
  write(usersPath, users)
}

export function listUsers(extraEmails = []) {
  const map = new Map(Object.entries(users).map(([email, u]) => [email, { email, name: u.name }]))
  for (const email of extraEmails) {
    if (email && !map.has(email)) map.set(email, { email, name: displayName(email) })
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name))
}

export function addNotification(email, notif) {
  const list = notifs[email] || (notifs[email] = [])
  list.unshift({
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: Date.now(),
    read: false,
    ...notif,
  })
  if (list.length > MAX_NOTIFS_PER_USER) list.length = MAX_NOTIFS_PER_USER
  write(notifPath, notifs)
}

export function listNotifications(email) {
  return notifs[email] || []
}

export function markNotificationsRead(email, ids) {
  const list = notifs[email]
  if (!list) return
  const wanted = ids ? new Set(ids) : null
  for (const n of list) if (!wanted || wanted.has(n.id)) n.read = true
  write(notifPath, notifs)
}

// Suivi des renommages / suppressions de pages pour ne pas laisser de liens morts
export function renameRoomInNotifications(oldRoom, newRoom) {
  let changed = false
  for (const list of Object.values(notifs)) {
    for (const n of list) {
      if (n.room === oldRoom) {
        n.room = newRoom
        changed = true
      }
    }
  }
  if (changed) write(notifPath, notifs)
}

export function dropRoomNotifications(room) {
  let changed = false
  for (const [email, list] of Object.entries(notifs)) {
    const kept = list.filter((n) => n.room !== room)
    if (kept.length !== list.length) {
      notifs[email] = kept
      changed = true
    }
  }
  if (changed) write(notifPath, notifs)
}
