// Réglages du serveur (hors coffre) : coffre actif, compte Nextcloud, admins.
// Fichier privé (0600) dans DATA_DIR : il peut contenir un mot de passe d'application.
import fs from 'fs'
import path from 'path'

let settingsPath = null
let settings = {}

export function initSettings(dataDir) {
  settingsPath = path.join(dataDir, 'settings.json')
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
  } catch {
    settings = {}
  }
}

export const getSettings = () => settings

export function updateSettings(patch) {
  settings = { ...settings, ...patch }
  const tmp = `${settingsPath}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2), { encoding: 'utf8', mode: 0o600 })
  fs.renameSync(tmp, settingsPath)
  return settings
}

// Admins : ADMIN_EMAILS (liste séparée par des virgules) ; sinon la première personne
// qui se connecte. En mode dev (sans SSO), l'utilisateur fictif est admin.
const envAdmins = (process.env.ADMIN_EMAILS || '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean)

export function isAdmin(email, devMode = false) {
  if (!email) return false
  if (envAdmins.length) return envAdmins.includes(email.toLowerCase())
  if (devMode) return true
  if (!settings.firstUser) updateSettings({ firstUser: email })
  return settings.firstUser === email
}
