// Comptes locaux (connexion par identifiant + mot de passe, sans fournisseur SSO).
// Fichier privé (0600) dans DATA_DIR : mots de passe hachés avec scrypt, jamais en clair.
import fs from 'fs'
import path from 'path'
import { randomBytes, scrypt, timingSafeEqual } from 'crypto'
import { promisify } from 'util'

const scryptAsync = promisify(scrypt)
const N = 16384
const R = 8
const P = 1
const KEYLEN = 64

export const MIN_PASSWORD = 10
export const USERNAME_RE = /^[a-z0-9][a-z0-9._@+-]{1,63}$/

let file = null
let data = { users: [] }

export function initAccounts(dataDir) {
  file = path.join(dataDir, 'accounts.json')
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!Array.isArray(data.users)) data = { users: [] }
  } catch {
    data = { users: [] }
  }
}

function save() {
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 })
  fs.renameSync(tmp, file)
}

async function hash(password) {
  const salt = randomBytes(16)
  const key = await scryptAsync(password, salt, KEYLEN, { N, r: R, p: P })
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`
}

async function check(password, stored) {
  const [alg, n, r, p, salt, key] = String(stored || '').split('$')
  if (alg !== 'scrypt') return false
  const expected = Buffer.from(key, 'base64')
  const actual = await scryptAsync(password, Buffer.from(salt, 'base64'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
  })
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

export const normalizeUsername = (v) => String(v || '').trim().toLowerCase()
export const accountCount = () => data.users.length
export const listAccounts = () =>
  data.users.map(({ id, username, name, createdAt, lastLoginAt }) => ({ id, username, name, createdAt, lastLoginAt }))
export const findAccount = (username) => data.users.find((u) => u.username === normalizeUsername(username)) || null

export function validate({ username, password }) {
  if (!USERNAME_RE.test(username)) return 'Identifiant invalide : 2 à 64 caractères (lettres, chiffres, . _ - @ +).'
  if (typeof password !== 'string' || password.length < MIN_PASSWORD)
    return `Mot de passe trop court : ${MIN_PASSWORD} caractères minimum.`
  if (password.length > 200) return 'Mot de passe trop long.'
  return null
}

export async function createAccount({ username, name, password }) {
  username = normalizeUsername(username)
  const problem = validate({ username, password })
  if (problem) throw new Error(problem)
  if (findAccount(username)) throw new Error('Cet identifiant existe déjà.')
  const user = {
    id: randomBytes(8).toString('hex'),
    username,
    name: String(name || '').trim().slice(0, 60) || username,
    hash: await hash(password),
    createdAt: Date.now(),
    lastLoginAt: null,
  }
  data.users.push(user)
  save()
  return user
}

// Un hachage factice garde le temps de réponse identique quand l'identifiant n'existe pas
const DUMMY = await hash(randomBytes(8).toString('hex'))

export async function verifyLogin(username, password) {
  const user = findAccount(username)
  const ok = await check(String(password || ''), user ? user.hash : DUMMY)
  if (!user || !ok) return null
  user.lastLoginAt = Date.now()
  save()
  return user
}

export async function setPassword(username, password) {
  const user = findAccount(username)
  if (!user) throw new Error('Compte introuvable.')
  const problem = validate({ username: user.username, password })
  if (problem) throw new Error(problem)
  user.hash = await hash(password)
  save()
}

export function removeAccount(username) {
  const before = data.users.length
  data.users = data.users.filter((u) => u.username !== normalizeUsername(username))
  if (data.users.length !== before) save()
  return data.users.length !== before
}
