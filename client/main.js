// Police Inter hébergée avec l'application (aucune requête vers un service tiers)
import '@fontsource/inter/latin-400.css'
import '@fontsource/inter/latin-500.css'
import '@fontsource/inter/latin-600.css'
import '@fontsource/inter/latin-700.css'
import '@fontsource/inter/latin-ext-400.css'
import '@fontsource/inter/latin-ext-500.css'
import '@fontsource/inter/latin-ext-600.css'
import '@fontsource/inter/latin-ext-700.css'
import { Editor } from '@tiptap/core'
import { StarterKit } from '@tiptap/starter-kit'
import { Collaboration } from '@tiptap/extension-collaboration'
import { CollaborationCaret } from '@tiptap/extension-collaboration-caret'
import { Placeholder } from '@tiptap/extensions'
import { Markdown } from 'tiptap-markdown'
import { TaskList, TaskItem } from '@tiptap/extension-list'
import { Image } from '@tiptap/extension-image'
import { Link } from '@tiptap/extension-link'
import { Table, TableRow, TableHeader, TableCell } from '@tiptap/extension-table'
import { BubbleMenu } from '@tiptap/extension-bubble-menu'
import { NodeSelection, TextSelection } from '@tiptap/pm/state'
import { SlashCommand } from './slash-command.js'
import { createAiInline } from './ai-inline.js'
import { AiGhost } from './ai-ghost.js'
import { MentionMenu } from './mention.js'
import { MarkdownHighlight, MarkdownText, TaskListTight, MarkdownHardBreak } from './markdown-extras.js'
import { CodeBlock, lastCodeLanguage } from './code-block.js'
import { CommentHighlights, createCommentsManager } from './comments.js'
import { avatarColor } from './suggest-menu.js'
import { LinkDecorations } from './link-decorations.js'
import { mountBlockHandle } from './block-handle.js'
import { renderGraph } from './graph-view.js'
import { mountBoard } from './board.js'
import { mountDatabase } from './database.js'
import { mountLightbox } from './lightbox.js'
import { icon, hydrateIcons, pageIconHTML } from './icons.js'
import { createVaultUI, createOnboarding } from './vault-ui.js'
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'

// Temps réel (y-websocket) : une « room » par page, sous /ws/
const WS_HOST = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`
const CURSOR_COLORS = ['#f783ac', '#ff922b', '#51cf66', '#339af0', '#845ef7']
const UNTITLED = 'Sans titre'

let ydoc, provider, editor, blockHandle
let currentRoom = new URLSearchParams(location.search).get('doc') || null
let currentType = 'doc'
let currentRole = null
let saveTimer = null
let me = null
let currentShareMeta = null
let pendingCreateType = null
// Le serveur dit si on peut renommer la page ouverte (propriétaire, ou invité qui l'a créée)
let currentCanRename = false
let focusTitleAfterLoad = false
let focusEditorAfterLoad = false
let activeBoard = null
let activeDatabase = null
let comments = null
let usersCache = []
let lastEntries = []
let vaultUI = null
// Contenu venu du disque (ouverture, modification externe) : ne pas le réécrire tel quel
let applyingDiskContent = false

const el = (id) => document.getElementById(id)
const app = el('app')
const scroller = el('scroller')
const editorHost = el('editor')
const pageList = el('page-list')
const favoritesList = el('favorites-list')
const docTitle = el('doc-title')
const connStatus = el('conn-status')
const presenceEl = el('presence')
const shareBtn = el('share-btn')
const docCover = el('doc-cover')
const docIcon = el('doc-icon')
const coverPicker = el('cover-picker')
// BubbleMenu (tippy) détache l'élément du DOM à la destruction de l'éditeur :
// on garde la référence pour le réutiliser d'une page à l'autre.
const bubbleEl = el('bubble-menu')
const bubbleTurn = el('bubble-turn')

hydrateIcons()

// --- Petites utilitaires ---------------------------------------------------
const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(key)
      return v === null ? fallback : JSON.parse(v)
    } catch {
      return fallback
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value))
    } catch {
      /* stockage indisponible (navigation privée) : on ignore */
    }
  },
}

const escapeHTML = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

function toast(message, { action = null, onAction = null } = {}) {
  const t = document.createElement('div')
  t.className = 'toast' + (action ? ' with-action' : '')
  const text = document.createElement('span')
  text.textContent = message
  t.appendChild(text)
  const dismiss = () => {
    t.classList.remove('show')
    setTimeout(() => t.remove(), 200)
  }
  if (action) {
    const b = document.createElement('button')
    b.className = 'toast-action'
    b.textContent = action
    b.onclick = () => {
      dismiss()
      onAction?.()
    }
    t.appendChild(b)
  }
  document.body.appendChild(t)
  setTimeout(() => t.classList.add('show'), 10)
  setTimeout(dismiss, action ? 6000 : 2600)
}

function colorFor(email) {
  let hash = 0
  for (const c of email) hash = (hash * 31 + c.charCodeAt(0)) % 997
  return CURSOR_COLORS[hash % CURSOR_COLORS.length]
}

// Le coffre affiché part avec chaque requête : si le serveur a changé de coffre entre-
// temps (autre onglet, autre appareil), il refuse et on recharge au lieu d'écrire au
// mauvais endroit
const vaultQuery = () => (me?.vault ? `vault=${encodeURIComponent(me.vault)}` : '')
async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(me?.vault ? { 'X-Yariche-Vault': encodeURIComponent(me.vault) } : {}),
      ...(opts.headers || {}),
    },
  })
  if (res.status === 401) {
    location.href = '/login'
    throw new Error('non authentifie')
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    if (res.status === 409 && body.error === 'vault-changed') {
      location.href = '/'
      throw new Error('coffre changé')
    }
    const err = new Error(body.error || `API ${path} -> ${res.status}`)
    err.status = res.status
    throw err
  }
  return res.json()
}
const docApi = (room, suffix = '') => `/api/doc/${encodeURIComponent(room)}${suffix}`

async function loadUsers() {
  usersCache = await api('/api/users').catch(() => usersCache)
}

async function loadMe() {
  me = await api('/api/me')
  el('user-avatar').textContent = (me.name || me.email || '?')[0].toUpperCase()
  el('user-avatar').style.background = colorFor(me.email)
  el('user-avatar').title = me.guest ? `${me.name} (invité)` : `${me.name} — ${me.email}`
  // Invité (lien de partage) : seulement le document partagé, pas le reste de l'app
  app.classList.toggle('guest-mode', !!me.guest)
  // Mode local de l'app Mac : un seul coffre (le dossier du Mac), pas de liens de partage
  app.classList.toggle('local-mode', !!me.local)
  // Sans SSO (usage local), pas de session à fermer
  el('logout-btn').classList.toggle('hidden', me.auth === 'none')
  // Comptes locaux : l'avatar ouvre « Mon compte » (mot de passe, gestion des comptes)
  const hasAccount = (me.auth === 'local' || me.auth === 'both') && !me.guest
  el('user-avatar').style.cursor = hasAccount ? 'pointer' : ''
  el('user-avatar').onclick = hasAccount ? () => (location.href = '/account') : null
  if (hasAccount) el('user-avatar').title += ' · Mon compte'
}

// --- Menus contextuels (même composant pour la sidebar et la topbar) -------
function closeMenus() {
  document.querySelectorAll('.menu').forEach((m) => m.remove())
}
function showMenu(anchor, items) {
  closeMenus()
  const menu = document.createElement('div')
  menu.className = 'menu popover'
  for (const item of items) {
    if (!item) continue
    if (item === 'sep') {
      menu.insertAdjacentHTML('beforeend', '<div class="menu-sep"></div>')
      continue
    }
    if (item.header) {
      menu.insertAdjacentHTML('beforeend', `<div class="menu-header">${escapeHTML(item.header)}</div>`)
      continue
    }
    const b = document.createElement('button')
    b.className = 'menu-item' + (item.danger ? ' danger' : '')
    b.innerHTML = `${icon(item.icon, 18)}<span>${escapeHTML(item.label)}</span>${item.checked !== undefined ? `<span class="menu-check">${item.checked ? '✓' : ''}</span>` : ''}`
    b.onclick = (e) => {
      e.stopPropagation()
      closeMenus()
      item.run()
    }
    menu.appendChild(b)
  }
  document.body.appendChild(menu)
  const r = anchor.getBoundingClientRect()
  const left = Math.min(r.left, window.innerWidth - menu.offsetWidth - 8)
  const top = r.bottom + menu.offsetHeight + 8 > window.innerHeight ? r.top - menu.offsetHeight - 4 : r.bottom + 4
  menu.style.left = `${Math.max(8, left)}px`
  menu.style.top = `${Math.max(8, top)}px`
}
document.addEventListener('click', (e) => {
  if (!e.target.closest('.menu')) closeMenus()
  if (!e.target.closest('#emoji-picker, #doc-icon, #add-icon-btn')) el('emoji-picker').classList.add('hidden')
  if (!e.target.closest('#cover-picker, #cover-change-btn, #add-cover-btn')) coverPicker.classList.add('hidden')
})

// --- Sidebar : favoris + arborescence --------------------------------------
const collapsed = new Set(store.get('yariche-collapsed', []))
const collapsedSections = new Set(store.get('yariche-collapsed-sections', []))

const isFolder = (e) => e?.type === 'folder'
// Tri façon Obsidian : dossiers d'abord, puis ordre naturel (« Note 2 » avant « Note 10 »)
const byTree = (a, b) =>
  Number(isFolder(b)) - Number(isFolder(a)) ||
  nameOf(a.room).localeCompare(nameOf(b.room), 'fr', { numeric: true, sensitivity: 'base' }) ||
  a.room.localeCompare(b.room, 'fr', { numeric: true, sensitivity: 'base' })

// target est-il dans le sous-arbre de room ? (interdit d'y déplacer room) : son chemin
// commence par celui de room
const isInside = (target, room) => !!target && !!room && (target === room || target.startsWith(`${room}/`))

async function movePage(room, parent) {
  if (parent && (parent === room || isInside(parent, room))) return toast('Impossible de déplacer un élément dans lui-même')
  if ((entryFor(room)?.parent || null) === (parent || null)) return
  try {
    if (isInside(currentRoom, room)) await flushAll()
    const { newRoom, updatedLinks } = await api(docApi(room, '/move'), { method: 'POST', body: JSON.stringify({ parent }) })
    if (parent) {
      collapsed.delete(parent)
      store.set('yariche-collapsed', [...collapsed])
    }
    toast(parent ? `« ${nameOf(room)} » déplacé dans « ${nameOf(parent)} »` : `« ${nameOf(room)} » déplacé à la racine`)
    announceLinkUpdates(updatedLinks)
    await followIdChange(room, newRoom)
    await refreshPageList()
    if (currentType === 'folder') renderFolderView()
  } catch (err) {
    toast(err.message)
  }
}

async function createFolder(parent = null) {
  const id = joinId(parent, await uniqueName('Nouveau dossier', parent))
  await api(docApi(id, '/create'), { method: 'POST', body: JSON.stringify({ type: 'folder' }) })
  if (parent) {
    collapsed.delete(parent)
    store.set('yariche-collapsed', [...collapsed])
  }
  await refreshPageList()
  if (currentType === 'folder') renderFolderView()
  openRenameModal(id)
}

function rowMenuItems(entry) {
  const folder = isFolder(entry)
  return [
    {
      label: entry.favorite ? 'Retirer des favoris' : 'Ajouter aux favoris',
      icon: 'star',
      run: () => toggleFavorite(entry.room, !entry.favorite),
    },
    folder ? { label: 'Ouvrir le dossier', icon: 'folderOpen', run: () => navigateTo(entry.room) } : null,
    {
      label: folder ? 'Nouvelle page dans le dossier' : 'Ajouter une sous-page',
      icon: 'plus',
      run: () => createPage({ parent: entry.room }),
    },
    { label: folder ? 'Nouveau sous-dossier' : 'Nouveau dossier ici', icon: 'folder', run: () => createFolder(entry.room) },
    folder
      ? null
      : {
          label: 'Dupliquer',
          icon: 'copy',
          run: async () => {
            const { newRoom } = await api(docApi(entry.room, '/duplicate'), { method: 'POST' })
            navigateTo(newRoom)
          },
        },
    { label: 'Renommer', icon: 'rename', run: () => openRenameModal(entry.room) },
    { label: 'Déplacer vers…', icon: 'move', run: () => openMovePicker(entry.room) },
    inMacApp() ? { label: 'Afficher dans le Finder', icon: 'finder', run: () => revealInFinder(entry.room) } : null,
    'sep',
    { label: 'Déplacer dans la corbeille', icon: 'trash', danger: true, run: () => trashPage(entry.room) },
  ]
}

// « Afficher dans le Finder » (app Mac) : le coffre est synchronisé sur le Mac par le
// client Nextcloud ; l'app retrouve le dossier local (ou le demande une fois)
const inMacApp = () => !!window.webkit?.messageHandlers?.yariche
function revealInFinder(room) {
  const entry = entryFor(room)
  if (!entry?.path) return toast('Emplacement du fichier inconnu')
  postNative({
    type: 'reveal',
    path: entry.path,
    vault: me.vault,
    remoteFolder: vaultUI?.info?.remote?.folder || null,
    server: vaultUI?.info?.nextcloud?.server || null,
    serverDir: vaultUI?.info?.dir || null,
  })
}

let draggedRoom = null
// Ordre de tri de l'explorateur (comme Obsidian) : dossiers d'abord, puis selon le mode
const SORT_MODES = [
  ['name-asc', 'Nom (A → Z)'],
  ['name-desc', 'Nom (Z → A)'],
  ['modified', 'Date de modification (récent d’abord)'],
  ['created', 'Date de création (récent d’abord)'],
]
function explorerComparator() {
  const mode = store.get('yariche-sort', 'name-asc')
  const byName = (a, b) => a.room.localeCompare(b.room, 'fr', { numeric: true, sensitivity: 'base' })
  return (a, b) => {
    const folders = Number(isFolder(b)) - Number(isFolder(a))
    if (folders) return folders
    if (mode === 'modified') return (b.updatedAt || 0) - (a.updatedAt || 0) || byName(a, b)
    if (mode === 'created') return (b.createdAt || 0) - (a.createdAt || 0) || byName(a, b)
    return mode === 'name-desc' ? byName(b, a) : byName(a, b)
  }
}
// Fichiers non Markdown : petit badge comme Obsidian (CANVAS, PDF…)
const TYPE_BADGE = { board: 'CANVAS', database: 'BASE' }
// Ancre factice pour ouvrir un menu à la position de la souris (clic droit)
const pointAnchor = (e) => ({ getBoundingClientRect: () => ({ left: e.clientX, right: e.clientX, top: e.clientY, bottom: e.clientY }) })

function renderRow(container, entry, depth, inFavorites = false) {
  const children = inFavorites ? [] : lastEntries.filter((e) => e.parent === entry.room)
  const folder = isFolder(entry)
  const isCollapsed = collapsed.has(entry.room)
  const item = document.createElement('div')
  item.className = 'tree-item'
  const row = document.createElement('div')
  row.className =
    'tree-row' + (entry.room === currentRoom ? ' active' : '') + (folder ? ' folder' : ' file') + (children.length ? ' has-children' : '')
  row.dataset.room = entry.room
  // Survol : l'emplacement réel du fichier dans le coffre
  row.title = entry.path ? `${entry.path}` : entry.room

  const toggle = () => {
    if (!children.length) return
    if (collapsed.has(entry.room)) collapsed.delete(entry.room)
    else collapsed.add(entry.room)
    store.set('yariche-collapsed', [...collapsed])
    renderSidebar()
  }
  const chevron = document.createElement('button')
  chevron.className = 'tree-chevron' + (children.length ? '' : ' empty') + (isCollapsed ? '' : ' open')
  chevron.innerHTML = icon('chevron', 12)
  chevron.tabIndex = -1
  chevron.onclick = (e) => {
    e.stopPropagation()
    toggle()
  }

  const name = document.createElement('span')
  name.className = 'tree-name'
  const emoji = entry.icon && entry.icon !== '📄' ? `<span class="tree-emoji">${escapeHTML(entry.icon)}</span>` : ''
  name.innerHTML = `${emoji}${escapeHTML(nameOf(entry.room))}`

  row.append(chevron, name)
  if (TYPE_BADGE[entry.type]) row.insertAdjacentHTML('beforeend', `<span class="tree-badge">${TYPE_BADGE[entry.type]}</span>`)
  // Partagé (avec des comptes, par lien ou lien d'invité) ; un dossier partagé = espace d'équipe
  if (entry.shared)
    row.insertAdjacentHTML('beforeend', `<span class="tree-shared" title="${isFolder(entry) ? 'Espace partagé' : 'Partagé'}">${icon('people', 12)}</span>`)

  const actions = document.createElement('span')
  actions.className = 'tree-actions'
  const moreBtn = document.createElement('button')
  moreBtn.innerHTML = icon('more', 14)
  moreBtn.title = 'Plus (ou clic droit)'
  moreBtn.onclick = (e) => {
    e.stopPropagation()
    showMenu(moreBtn, rowMenuItems(entry))
  }
  actions.appendChild(moreBtn)
  if (!inFavorites && folder) {
    const addBtn = document.createElement('button')
    addBtn.innerHTML = icon('plus', 14)
    addBtn.title = 'Nouveau dans ce dossier'
    addBtn.onclick = (e) => {
      e.stopPropagation()
      showMenu(addBtn, [
        { label: 'Note', icon: 'page', run: () => createPage({ parent: entry.room }) },
        { label: 'Dossier', icon: 'folder', run: () => createFolder(entry.room) },
        { label: 'Base de données', icon: 'database', run: () => createPage({ type: 'database', parent: entry.room }) },
        { label: 'Whiteboard', icon: 'board', run: () => createPage({ type: 'board', parent: entry.room }) },
      ])
    }
    actions.appendChild(addBtn)
  }
  row.appendChild(actions)

  // Dossier : un clic déplie/replie (comme Obsidian) ; fichier : on l'ouvre
  row.onclick = () => (folder ? (children.length ? toggle() : navigateTo(entry.room)) : navigateTo(entry.room))
  row.oncontextmenu = (e) => {
    e.preventDefault()
    if (me?.guest) return
    showMenu(pointAnchor(e), rowMenuItems(entry))
  }

  // Glisser-déposer : déposer sur une ligne range l'élément dedans
  if (!inFavorites) {
    row.draggable = true
    row.addEventListener('dragstart', (e) => {
      draggedRoom = entry.room
      e.dataTransfer.setData('application/x-yariche-page', entry.room)
      e.dataTransfer.effectAllowed = 'move'
      requestAnimationFrame(() => row.classList.add('dragging'))
    })
    row.addEventListener('dragend', () => {
      draggedRoom = null
      row.classList.remove('dragging')
      document.querySelectorAll('.drop-into, .drop-root').forEach((n) => n.classList.remove('drop-into', 'drop-root'))
    })
    row.addEventListener('dragover', (e) => {
      if (!draggedRoom || draggedRoom === entry.room || isInside(entry.room, draggedRoom)) return
      e.preventDefault()
      e.stopPropagation()
      row.classList.add('drop-into')
    })
    row.addEventListener('dragleave', () => row.classList.remove('drop-into'))
    row.addEventListener('drop', (e) => {
      e.preventDefault()
      e.stopPropagation()
      row.classList.remove('drop-into')
      const room = e.dataTransfer.getData('application/x-yariche-page')
      if (room) movePage(room, entry.room)
    })
  }
  item.appendChild(row)

  if (children.length && !isCollapsed) {
    const kids = document.createElement('div')
    kids.className = 'tree-children'
    children.sort(explorerComparator()).forEach((c) => renderRow(kids, c, depth + 1))
    item.appendChild(kids)
  }
  container.appendChild(item)
}

function renderSidebar() {
  if (activeTagFilter) return
  pageList.innerHTML = ''
  const known = new Set(lastEntries.map((e) => e.room))
  lastEntries
    .filter((e) => !e.parent || !known.has(e.parent))
    .sort(explorerComparator())
    .forEach((e) => renderRow(pageList, e, 0))
  if (!lastEntries.length) pageList.innerHTML = '<div class="empty-hint">Aucune page</div>'

  favoritesList.innerHTML = ''
  const favs = lastEntries.filter((e) => e.favorite)
  if (!favs.length) favoritesList.innerHTML = '<div class="empty-hint">Aucun favori</div>'
  favs.sort(byTree).forEach((e) => renderRow(favoritesList, e, 0, true))

  document.querySelectorAll('.section-label').forEach((label) => {
    const key = label.dataset.section
    label.classList.toggle('collapsed', collapsedSections.has(key))
    label.parentElement
      .querySelectorAll(':scope > nav, :scope > .tag-filter-banner')
      .forEach((n) => n.classList.toggle('section-hidden', collapsedSections.has(key)))
  })
}

// Déposer sur le titre « Pages » ou dans le vide de la liste : retour à la racine
for (const zone of [pageList, document.querySelector('.section-label[data-section="pages"]')]) {
  zone.addEventListener('dragover', (e) => {
    if (!draggedRoom || e.target.closest('.tree-row')) return
    e.preventDefault()
    zone.classList.add('drop-root')
  })
  zone.addEventListener('dragleave', (e) => {
    if (!zone.contains(e.relatedTarget)) zone.classList.remove('drop-root')
  })
  zone.addEventListener('drop', (e) => {
    if (e.target.closest('.tree-row')) return
    e.preventDefault()
    zone.classList.remove('drop-root')
    const room = e.dataTransfer.getData('application/x-yariche-page')
    if (room) movePage(room, null)
  })
}


document.querySelectorAll('.section-label').forEach((label) => {
  label.onclick = (e) => {
    if (e.target.closest('button')) return
    const key = label.dataset.section
    if (collapsedSections.has(key)) collapsedSections.delete(key)
    else collapsedSections.add(key)
    store.set('yariche-collapsed-sections', [...collapsedSections])
    renderSidebar()
  }
})

async function refreshPageList() {
  const entries = await api('/api/docs')
  lastEntries = entries
  renderSidebar()
  renderBreadcrumb()
  updateFavButton()
}

const entryFor = (room) => lastEntries.find((e) => e.room === room)
// L'identifiant d'une page est son chemin dans le coffre (« R521/Concepts/MIMO ») :
// le nom affiché est son dernier segment, son dossier le reste
const nameOf = (id) => String(id || '').slice(String(id || '').lastIndexOf('/') + 1)
const joinId = (parent, name) => (parent ? `${parent}/${name}` : name)
const foldName = (s) => String(s).normalize('NFC').toLowerCase()
// Lien [[…]] → page, comme Obsidian : chemin (ou fin de chemin) si le lien contient « / »,
// sinon par nom ; homonymes : celui du même dossier, puis le chemin le plus court
function resolveLinkClient(target, fromId = currentRoom) {
  let t = String(target || '').trim().replace(/\.md$/i, '').replace(/^\/+/, '')
  if (!t) return null
  const pages = lastEntries.filter((e) => !isFolder(e))
  const want = foldName(t)
  const hits = t.includes('/')
    ? pages.filter((e) => foldName(e.room) === want || foldName(e.room).endsWith(`/${want}`))
    : pages.filter((e) => foldName(nameOf(e.room)) === want)
  if (hits.length <= 1) return hits[0]?.room || null
  const folder = fromId && fromId.includes('/') ? fromId.slice(0, fromId.lastIndexOf('/')) : null
  const same = hits.find((e) => (e.parent || null) === folder)
  if (same) return same.room
  return hits.map((e) => e.room).sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))[0]
}
// Texte de lien vers une page : son nom s'il est unique, sinon son chemin complet
function linkTextFor(id) {
  const name = nameOf(id)
  const twins = lastEntries.filter((e) => !isFolder(e) && e.room !== id && foldName(nameOf(e.room)) === foldName(name))
  return twins.length ? id : name
}

// --- Création / navigation --------------------------------------------------
// Nom libre dans un dossier (comme Obsidian, un nom n'a à être unique que dans son
// dossier ; un nom mis à la corbeille est de nouveau libre)
async function uniqueName(base, parent = null) {
  const taken = new Set(lastEntries.filter((e) => (e.parent || null) === (parent || null)).map((e) => foldName(nameOf(e.room))))
  if (!taken.has(foldName(base))) return base
  let n = 2
  while (taken.has(foldName(`${base} ${n}`))) n++
  return `${base} ${n}`
}

// Emplacement des nouvelles notes : le dossier de la note ouverte (comme le réglage
// « Même dossier que la note actuelle » d'Obsidian)
function defaultNewParent() {
  const cur = currentRoom ? entryFor(currentRoom) : null
  if (!cur) return null
  return isFolder(cur) ? cur.room : cur.parent || null
}

async function createPage({ type = 'doc', parent = null, name } = {}) {
  if (parent && entryFor(parent)?.path) toast(`Créée dans ${entryFor(parent).path.replace(/\.md$/, '/')}`)
  const base = name || (type === 'board' ? 'Whiteboard' : type === 'database' ? 'Base de données' : UNTITLED)
  const room = joinId(parent, await uniqueName(base, parent))
  pendingCreateType = type
  if (parent) {
    collapsed.delete(parent)
    store.set('yariche-collapsed', [...collapsed])
  }
  focusTitleAfterLoad = true
  navigateTo(room)
}

// params : { thread, row } -> ouvre un fil de commentaires ou une ligne de base
function navigateTo(room, params = {}) {
  closeDrawer()
  const url = new URL(location.href)
  url.search = ''
  url.searchParams.set('doc', room)
  for (const [k, v] of Object.entries(params)) if (v) url.searchParams.set(k, v)
  if (room === currentRoom) {
    history.replaceState({}, '', url)
    applyDeepLink(params)
    return
  }
  history.pushState({}, '', url)
  loadRoom(room)
}

function applyDeepLink({ thread, row } = {}) {
  if (thread) comments?.focusThread(thread)
  if (row) activeDatabase?.openRow(row)
}

function pushRecent(room) {
  const recents = store.get('yariche-recent', []).filter((r) => r.room !== room)
  recents.unshift({ room, at: Date.now() })
  store.set('yariche-recent', recents.slice(0, 12))
}

// Un élément a changé de chemin (déplacé, renommé) : la page ouverte, si elle est dedans,
// est rouverte à sa nouvelle adresse
async function followIdChange(oldId, newId) {
  if (!newId || newId === oldId) return
  const recents = store.get('yariche-recent', []).map((r) =>
    r.room === oldId || r.room.startsWith(`${oldId}/`) ? { ...r, room: newId + r.room.slice(oldId.length) } : r
  )
  store.set('yariche-recent', recents)
  if (!currentRoom || !(currentRoom === oldId || currentRoom.startsWith(`${oldId}/`))) return
  const next = newId + currentRoom.slice(oldId.length)
  history.replaceState({}, '', `?doc=${encodeURIComponent(next)}`)
  await loadRoom(next)
}

async function trashPage(room) {
  const parent = entryFor(room)?.parent || null
  // La page ouverte est-elle celle-ci, ou dans ce qui part à la corbeille ?
  const affectsCurrent = !!currentRoom && (room === currentRoom || isInside(currentRoom, room))
  let trashId
  try {
    ;({ trashId } = await api(docApi(room, '/delete'), { method: 'POST' }))
  } catch (err) {
    return toast(err.status === 403 ? 'Seul le propriétaire peut mettre cette page à la corbeille' : err.message)
  }
  toast(`« ${nameOf(room)} » déplacé dans la corbeille`, { action: 'Annuler', onAction: () => restorePage(trashId, { open: affectsCurrent }) })
  await refreshPageList()
  if (currentType === 'trash') renderTrashView()
  if (affectsCurrent) {
    if (parent && entryFor(parent)) navigateTo(parent)
    else openLanding({ push: true })
  } else if (currentType === 'folder') renderFolderView()
}

async function restorePage(room, { open = false } = {}) {
  let restored
  try {
    restored = await api(docApi(room, '/restore'), { method: 'POST' })
  } catch (err) {
    return toast(err.message)
  }
  // Le nom d'origine a pu être repris (ou non, s'il est pris entre-temps)
  if (restored.room && restored.room !== room) {
    if (currentRoom === room) {
      currentRoom = restored.room
      history.replaceState({}, '', `?doc=${encodeURIComponent(restored.room)}`)
    }
    room = restored.room
  }
  toast(`« ${nameOf(room)} » restauré`)
  await refreshPageList()
  if (room === currentRoom) loadRoom(room)
  else if (open) navigateTo(room)
  else if (currentType === 'trash') renderTrashView()
}

async function deleteForever(rooms, { leave = false } = {}) {
  if (!rooms.length) return
  const label = rooms.length === 1 ? `« ${nameOf(rooms[0])} »` : `ces ${rooms.length} éléments`
  if (!confirm(`Supprimer ${label} définitivement ? Les pages et fichiers seront effacés du disque, c'est irréversible.`)) return
  for (const room of rooms) {
    await api(docApi(room, '/delete-permanent'), { method: 'POST' }).catch((err) => toast(err.message))
  }
  toast(rooms.length === 1 ? `${label} supprimé définitivement` : `${rooms.length} éléments supprimés définitivement`)
  await refreshPageList()
  if (leave) openLanding({ push: true })
  else if (currentType === 'trash') renderTrashView()
}

async function toggleFavorite(room, on) {
  await api(docApi(room, '/favorite'), { method: 'POST', body: JSON.stringify({ on }) })
  await refreshPageList()
}

async function uploadFile(file, room = currentRoom) {
  const form = new FormData()
  form.append('file', file)
  const res = await fetch(`${docApi(room, '/upload')}?${vaultQuery()}`, { method: 'POST', body: form })
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'upload échoué')
  return (await res.json()).url
}

const isPdf = (file) => file.type === 'application/pdf' || /\.pdf$/i.test(file.name)

// Fonctionne pour l'éditeur principal comme pour ceux des lignes de base.
// Image : insérée comme image. PDF : insérée comme intégration Obsidian ![[nom.pdf]]
// (affichée en carte cliquable, le fichier reste dans attachments/).
async function uploadAndInsertImage(file, ed, pos) {
  try {
    const url = await uploadFile(file)
    if (ed.isDestroyed) return
    const at = pos ?? ed.state.selection.from
    if (isPdf(file)) {
      ed.view.dispatch(ed.state.tr.insertText(`![[${url.split('/').pop()}]]`, at))
    } else {
      ed.view.dispatch(ed.state.tr.insert(at, ed.schema.nodes.image.create({ src: url })))
    }
  } catch (err) {
    toast(`${isPdf(file) ? 'PDF' : 'Image'} non envoyé : ${err.message}`)
  }
}

function pickImageFor(ed) {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = 'image/*,application/pdf'
  input.onchange = () => {
    const file = input.files?.[0]
    if (file) uploadAndInsertImage(file, ed)
  }
  input.click()
}

// « / Page », « / Base de données », « / Whiteboard » : sous-page + lien, puis on y va
async function createSubpageFromSlash(ed, range, type) {
  ed.chain().focus().deleteRange(range).run()
  const base = type === 'board' ? 'Whiteboard' : type === 'database' ? 'Base de données' : UNTITLED
  const name = await uniqueName(base, currentRoom)
  const id = joinId(currentRoom, name)
  await api(docApi(id, '/create'), { method: 'POST', body: JSON.stringify({ type }) })
  // Nom seul s'il désigne bien cette page, sinon son chemin (homonymes ailleurs)
  const text = lastEntries.some((e) => !isFolder(e) && foldName(nameOf(e.room)) === foldName(name)) ? id : name
  ed.chain().focus().insertContent({ type: 'text', text: `[[${text}]] ` }).run()
  await flushAll()
  focusTitleAfterLoad = true
  navigateTo(id)
}

function notifyMention(user, { kind = 'doc', rowId = null, excerpt = '' } = {}) {
  api(docApi(currentRoom, '/notify'), {
    method: 'POST',
    body: JSON.stringify({ mentions: [user.email], kind, rowId, excerpt }),
  })
    .then(({ noAccess }) => {
      if (noAccess?.length) toast(`${user.name} n'a pas accès à cette page : pas de notification. Partage-la d'abord.`)
    })
    .catch(() => {})
}

// Images en chemin relatif (« photo.png », « ../attachments/x.png ») : comme dans
// Obsidian, cherchées depuis le dossier de la note, puis depuis la racine du coffre, puis
// par nom. Seul l'affichage change : le .md garde le chemin tel qu'il est écrit.
function normalizeVaultPath(p) {
  const out = []
  for (const part of p.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return out.join('/')
}
function resolveImageSrc(src) {
  if (!src || /^(?:[a-z][a-z0-9+.-]*:|\/|#)/i.test(src)) return src
  let rel = src
  try {
    rel = decodeURIComponent(src)
  } catch {
    /* chemin déjà décodé */
  }
  const params = new URLSearchParams({ name: rel.split('/').pop() })
  const notePath = currentRoom ? entryFor(currentRoom)?.path || '' : ''
  const noteDir = notePath.includes('/') ? notePath.slice(0, notePath.lastIndexOf('/') + 1) : ''
  if (noteDir) params.append('path', normalizeVaultPath(noteDir + rel))
  params.append('path', normalizeVaultPath(rel))
  return `/api/vault-file?${params}`
}
const VaultImage = Image.extend({
  addAttributes() {
    const parent = this.parent?.() || {}
    return { ...parent, src: { ...parent.src, renderHTML: (attrs) => ({ src: resolveImageSrc(attrs.src) }) } }
  },
})

// Extensions communes à l'éditeur de page et à ceux des lignes de base.
// L'ordre compte : tiptap-markdown se greffe sur les extensions déjà
// enregistrées portant le même nom (image, link, table...)
// Tiptap 3 : l'historique (undoRedo) vient de Yjs ; le lien est configuré à part ; pas de
// souligné (pas de Markdown pour ça) ni de paragraphe final ajouté d'office (le fichier
// ouvert doit rester identique)
const STARTER_KIT = {
  undoRedo: false,
  text: false,
  codeBlock: false,
  hardBreak: false,
  link: false,
  underline: false,
  trailingNode: false,
}

function contentExtensions({ onMention }) {
  return [
    VaultImage,
    Link.configure({ openOnClick: false, autolink: true, HTMLAttributes: { rel: 'noopener', target: '_blank' } }),
    Table.configure({ resizable: false }),
    TableRow,
    TableHeader,
    TableCell,
    MarkdownHighlight.configure({ multicolor: false }),
    CodeBlock,
    Markdown.configure({ html: false, transformPastedText: true, linkify: true, breaks: true }),
    SlashCommand.configure({ insertImage: pickImageFor, createSubpage: createSubpageFromSlash, openAi: openAiInline, aiEnabled: () => !!me?.ai }),
    MentionMenu.configure({ getUsers: () => usersCache, getPages: () => lastEntries, onMentionUser: onMention }),
    AiGhost.configure({
      enabled: () => !!me?.ai && !me?.guest && aiGhostOn(),
      request: async (before) => (await api('/api/ai', { method: 'POST', body: JSON.stringify({ action: 'complete', context: before }) })).text,
    }),
    TaskList,
    TaskListTight,
    TaskItem.configure({ nested: true }),
    LinkDecorations.configure({
      // Lien vers une page existante (résolu comme Obsidian), sinon création de la page
      // dans le dossier de la note ouverte
      onWikilinkClick: (page) => {
        const id = resolveLinkClient(page)
        if (id) return navigateTo(id)
        const target = page.trim().replace(/\.md$/i, '').replace(/^\/+/, '')
        const name = nameOf(target)
        if (!name || name.startsWith('.')) return
        // [[Dossier/Nouvelle note]] : créée dans ce dossier s'il existe
        const dir = target.includes('/') ? target.slice(0, target.lastIndexOf('/')) : null
        createPage({ name, parent: dir && entryFor(dir) ? dir : defaultNewParent() })
      },
      onTagClick: (tag) => filterByTag(tag),
    }),
  ]
}

const imageEditorProps = (getEd) => ({
  handleDrop: (view, event, slice, moved) => {
    if (moved) return false
    const file = event.dataTransfer?.files?.[0]
    if (!file || !(file.type.startsWith('image/') || isPdf(file))) return false
    event.preventDefault()
    uploadAndInsertImage(file, getEd(), view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos)
    return true
  },
  handlePaste: (view, event) => {
    const file = [...(event.clipboardData?.files || [])].find((f) => f.type.startsWith('image/') || isPdf(f))
    if (!file) return false
    event.preventDefault()
    uploadAndInsertImage(file, getEd())
    return true
  },
  // Cmd/Ctrl+clic ouvre un lien (clic simple = édition, comme Notion)
  handleClick: (view, pos, event) => {
    const a = event.target.closest?.('a[href]')
    if (a && (event.metaKey || event.ctrlKey)) {
      window.open(a.href, '_blank', 'noopener')
      return true
    }
    return false
  },
})

// Éditeur du corps d'une ligne de base : fragment Yjs « row:<id> » du même document
function createRowEditor(element, field, { editable, initialMarkdown, onMarkdown }) {
  const doc = ydoc
  const fragment = doc.getXmlFragment(field)
  const wasEmpty = fragment.length === 0
  let timer = null
  let ed = null
  const push = () => {
    timer = null
    if (ed && !ed.isDestroyed) onMarkdown(ed.storage.markdown.getMarkdown())
  }
  ed = new Editor({
    element,
    editable,
    extensions: [
      StarterKit.configure(STARTER_KIT),
      MarkdownText,
      MarkdownHardBreak,
      Collaboration.configure({ document: doc, field }),
      Placeholder.configure({ placeholder: 'Tape « / » pour les commandes, « @ » pour mentionner', showOnlyCurrent: true }),
      ...contentExtensions({
        onMention: (u, e) =>
          notifyMention(u, { kind: 'row', rowId: field.slice(4), excerpt: e.state.selection.$from.parent.textContent }),
      }),
    ],
    onUpdate: editable
      ? () => {
          clearTimeout(timer)
          timer = setTimeout(push, 800)
        }
      : undefined,
    editorProps: editable ? imageEditorProps(() => ed) : {},
  })
  // Le binding Yjs rend le fragment au tick suivant : on ne remplit qu'après
  if (wasEmpty && initialMarkdown?.trim() && editable) {
    setTimeout(() => {
      if (!ed.isDestroyed && doc.getXmlFragment(field).length === 0) ed.commands.setContent(initialMarkdown, { emitUpdate: false })
    }, 40)
  }
  return {
    editor: ed,
    flush() {
      if (timer) {
        clearTimeout(timer)
        push()
      }
    },
    destroy() {
      this.flush()
      ed.destroy()
    },
  }
}

function destroyCurrent() {
  // Frappe en attente de sauvegarde : on l'envoie avant de détruire l'éditeur
  if (saveTimer && editor && !editor.isDestroyed) {
    const markdown = editor.storage.markdown.getMarkdown()
    api(docApi(currentRoom), { method: 'POST', body: JSON.stringify({ markdown }) }).catch(() => {})
  }
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = null
  if (comments) comments.destroy()
  comments = null
  if (blockHandle) blockHandle.destroy()
  if (editor) editor.destroy()
  if (provider) provider.destroy()
  if (ydoc) ydoc.destroy()
  if (activeBoard) activeBoard.destroy()
  if (activeDatabase) activeDatabase.destroy()
  editor = null
  ydoc = null
  provider = null
  blockHandle = null
  activeBoard = null
  activeDatabase = null
  el('toc').classList.add('hidden')
  document.getElementById('access-denied-msg')?.remove()
}

function showView(type) {
  const special = type === 'empty' || type === 'trash'
  app.classList.toggle('no-page', special)
  el('main').classList.toggle('db-page', type === 'database')
  scroller.classList.toggle('hidden', type === 'board')
  editorHost.classList.toggle('hidden', type !== 'doc')
  el('folder-view').classList.toggle('hidden', type !== 'folder')
  el('special-view').classList.toggle('hidden', !special)
  if (special) docCover.className = 'doc-cover no-cover'
  el('backlinks-panel').classList.add('hidden')
  el('board-view').classList.toggle('hidden', type !== 'board')
  el('db-view').classList.toggle('hidden', type !== 'database')
  el('doc-header').classList.toggle('hidden', type === 'board' || special)
}

// --- En-tête : fil d'Ariane, titre, icône, couverture ----------------------
function renderBreadcrumb() {
  const bc = el('breadcrumb')
  renderLocation()
  el('trash-toggle').classList.toggle('active', currentType === 'trash')
  if (!currentRoom) {
    bc.innerHTML = currentType === 'trash' ? `<span class="crumb current">${icon('trash', 16)}<span>Corbeille</span></span>` : ''
    return
  }
  // Comme l'en-tête d'une note dans Obsidian : « Dossier / Sous-dossier / Note »
  const chain = []
  let cur = entryFor(currentRoom) || { room: currentRoom, type: currentType }
  const seen = new Set()
  while (cur && !seen.has(cur.room)) {
    seen.add(cur.room)
    chain.unshift(cur)
    cur = cur.parent ? entryFor(cur.parent) : null
  }
  bc.innerHTML = ''
  chain.forEach((entry, i) => {
    if (i > 0) bc.insertAdjacentHTML('beforeend', '<span class="crumb-sep">/</span>')
    const crumb = document.createElement('button')
    const isCurrent = i === chain.length - 1
    crumb.className = 'crumb' + (isCurrent ? ' current' : '') + (isFolder(entry) ? ' is-folder' : '')
    crumb.innerHTML = `<span>${escapeHTML(nameOf(entry.room))}</span>`
    // Note courante : renommer ; dossier : le révéler dans l'explorateur (comme Obsidian) ; page parente : l'ouvrir
    crumb.title = isCurrent ? (currentCanRename ? 'Renommer' : entry.room) : isFolder(entry) ? "Révéler dans l'explorateur" : entry.room
    crumb.onclick = () => {
      if (isCurrent) return currentCanRename && openRenameModal(entry.room)
      if (isFolder(entry)) return revealInSidebar(entry.room, { flash: true, expandSelf: true })
      navigateTo(entry.room)
    }
    bc.appendChild(crumb)
  })
}

// Le chemin est dans l'en-tête et la barre d'état (comme Obsidian) : rien au-dessus du titre
function renderLocation() {
  el('doc-location').classList.add('hidden')
}

// Déplie l'arborescence jusqu'à la page ouverte et la fait défiler à l'écran
function revealInSidebar(room, { flash = false, expandSelf = false } = {}) {
  if (!room) return
  let changed = false
  if (expandSelf && collapsed.delete(room)) changed = true
  const seen = new Set()
  let cur = entryFor(room)
  while (cur?.parent && !seen.has(cur.parent)) {
    seen.add(cur.parent)
    if (collapsed.delete(cur.parent)) changed = true
    cur = entryFor(cur.parent)
  }
  if (collapsedSections.delete('pages')) changed = true
  if (changed) {
    store.set('yariche-collapsed', [...collapsed])
    store.set('yariche-collapsed-sections', [...collapsedSections])
    renderSidebar()
  }
  requestAnimationFrame(() => {
    const row = pageList.querySelector(`.tree-row[data-room="${CSS.escape(room)}"]`)
    row?.scrollIntoView({ block: 'nearest' })
    if (flash && row) {
      row.classList.add('flash')
      setTimeout(() => row.classList.remove('flash'), 1200)
    }
  })
}

function updateFavButton() {
  if (!currentRoom) return
  const fav = !!entryFor(currentRoom)?.favorite
  const btn = el('fav-btn')
  btn.classList.toggle('on', fav)
  btn.title = fav ? 'Retirer des favoris' : 'Ajouter aux favoris'
}

function applyAppearance(appearance, editable) {
  const emoji = appearance?.icon && appearance.icon !== '📄' ? appearance.icon : null
  docIcon.textContent = emoji || ''
  docIcon.classList.toggle('hidden', !emoji)
  docIcon.disabled = !editable
  el('add-icon-btn').classList.toggle('hidden', !!emoji || !editable)
  const cover = currentType === 'doc' ? appearance?.cover : null
  docCover.className = 'doc-cover ' + (cover ? `cover-${cover}` : 'no-cover')
  el('add-cover-btn').classList.toggle('hidden', !!cover || !editable || currentType !== 'doc')
  // Rangée masquée quand il n'y a plus rien à ajouter (sinon trou de 32px sous l'icône)
  el('doc-header-controls').classList.toggle('hidden', !editable || (!!emoji && (!!cover || currentType !== 'doc')))
  el('cover-change-btn').classList.toggle('hidden', !editable)
  el('cover-remove-btn').classList.toggle('hidden', !editable)
  el('doc-header').classList.toggle('has-icon', !!emoji)
  coverPicker.classList.add('hidden')
}

async function saveAppearance(patch) {
  await api(docApi(currentRoom, '/appearance'), { method: 'POST', body: JSON.stringify(patch) })
  await refreshPageList()
}

// Titre éditable en place : Entrée valide et renvoie dans le corps (Notion/AFFiNE)
docTitle.onkeydown = (e) => {
  if (e.key === 'Enter') {
    e.preventDefault()
    focusEditorAfterLoad = true
    docTitle.blur()
  } else if (e.key === 'Escape') {
    docTitle.textContent = nameOf(currentRoom)
    docTitle.blur()
  }
}
docTitle.onpaste = (e) => {
  e.preventDefault()
  document.execCommand('insertText', false, e.clipboardData.getData('text/plain').replace(/\n/g, ' '))
}
docTitle.onblur = async () => {
  const name = docTitle.textContent.replace(/\s+/g, ' ').trim()
  if (!name || name === nameOf(currentRoom)) {
    docTitle.textContent = nameOf(currentRoom)
    if (focusEditorAfterLoad) {
      focusEditorAfterLoad = false
      editor?.commands.focus('start')
    }
    return
  }
  if (/[/\\]/.test(name)) {
    docTitle.textContent = nameOf(currentRoom)
    return toast('Pas de « / » dans un nom : pour ranger la page ailleurs, déplace-la')
  }
  try {
    await flushAll()
    const from = currentRoom
    const { newRoom, updatedLinks } = await api(docApi(from, '/rename'), { method: 'POST', body: JSON.stringify({ newName: name }) })
    announceLinkUpdates(updatedLinks)
    await followIdChange(from, newRoom)
  } catch (err) {
    docTitle.textContent = nameOf(currentRoom)
    focusEditorAfterLoad = false
    toast(err.message)
  }
}

// --- Chargement d'une page -------------------------------------------------
async function loadRoom(room) {
  if (!room) return openLanding()
  destroyCurrent()
  app.classList.remove('no-page')
  currentRoom = room
  docTitle.textContent = nameOf(room)
  document.title = `${nameOf(room)} · Yariche`

  try {
    // Création seulement quand elle est demandée (nouvelle page, journal, lien vers une
    // page à créer) : ouvrir l'adresse d'une page supprimée ne la recrée pas
    if (pendingCreateType && (!me.guest || me.role === 'editor')) {
      await api(docApi(room, '/create'), { method: 'POST', body: JSON.stringify({ type: pendingCreateType }) })
    }
  } catch (err) {
    if (err.status === 403) return renderAccessDenied()
    throw err
  }
  pendingCreateType = null

  let docInfo
  try {
    docInfo = await api(docApi(room))
  } catch (err) {
    if (err.status === 403) return renderAccessDenied()
    if (err.status === 404) return renderNotFound(room)
    throw err
  }
  const { role: realRole, appearance, type, deletedAt, path: storedAt, frontmatter, canRename } = docInfo
  currentCanRename = !!canRename
  setStatusPath(storedAt)
  renderProperties(type === 'doc' ? frontmatter : '')
  setStatusCounts({ backlinks: null, words: null, chars: null })
  // Page à la corbeille : consultable, pas modifiable (comme Notion)
  const role = deletedAt ? 'viewer' : realRole
  renderTrashBanner(room, !!deletedAt, realRole)
  currentType = type
  currentRole = role
  const editable = role === 'owner' || role === 'editor'
  showView(type)
  applyAppearance(appearance, editable)
  docTitle.contentEditable = currentCanRename ? 'plaintext-only' : 'false'
  el('share-btn').dataset.type = type
  pushRecent(room)

  const userColor = colorFor(me.email)
  ydoc = new Y.Doc()
  provider = new WebsocketProvider(WS_HOST, encodeURIComponent(room), ydoc, { params: me.vault ? { vault: me.vault } : {} })
  provider.awareness.setLocalStateField('user', { name: me.name, email: me.email, color: userColor })
  provider.on('status', ({ status }) => {
    connStatus.textContent = status === 'connected' ? 'en ligne' : 'hors ligne'
    connStatus.className = `conn-status ${status === 'connected' ? 'online' : 'offline'}`
  })
  provider.awareness.on('change', renderPresence)

  const params = new URLSearchParams(location.search)
  const panelWasOpen = !el('comments-panel').classList.contains('hidden')
  comments = createCommentsManager({
    ydoc,
    room,
    me,
    role,
    api,
    getEditor: () => editor,
    getUsers: () => usersCache,
    toast,
    onCountChange: updateCommentsCount,
  })
  updateCommentsCount(0)
  bubbleEl.querySelector('[data-action="comment"]').classList.toggle('hidden', !comments.canComment)
  bubbleEl.querySelector('[data-action="ai"]').classList.toggle('hidden', !me?.ai)
  const saveJSON = (suffix) => (json) =>
    api(docApi(room, suffix), { method: 'POST', body: JSON.stringify(json) }).catch(() => toast('Sauvegarde impossible'))

  if (type === 'board') {
    activeBoard = mountBoard(ydoc, {
      room,
      editable,
      provider,
      me,
      userColor,
      toast,
      onSave: saveJSON('/board'),
      uploadImage: (file) => uploadFile(file, room),
    })
  } else if (type === 'database') {
    activeDatabase = mountDatabase(ydoc, {
      room,
      editable,
      me,
      api,
      toast,
      getUsers: () => usersCache,
      onSave: saveJSON('/db'),
      createRowEditor,
      openRowId: params.get('row'),
      onRowOpened: (rowId) => {
        const url = new URL(location.href)
        if (rowId) url.searchParams.set('row', rowId)
        else url.searchParams.delete('row')
        history.replaceState({}, '', url)
      },
    })
  } else if (type === 'folder') {
    // Un dossier n'a pas de contenu : on affiche ce qu'il contient
  } else {
    mountEditor(room, editable, userColor)
  }
  const board = activeBoard
  const database = activeDatabase
  const manager = comments
  provider.once('sync', async (isSynced) => {
    if (!isSynced || manager !== comments) return
    if (board) board.seed(() => api(docApi(room, '/board')))
    if (database) database.seed()
    await manager.seed()
    if (panelWasOpen) manager.open()
    if (params.get('thread')) manager.focusThread(params.get('thread'))
  })

  await refreshShareAccess(room)
  await refreshPageList()
  revealInSidebar(room)
  applyMode()
  if (type === 'folder') renderFolderView()
  if (type === 'folder') {
    const n = lastEntries.filter((e) => e.parent === room).length
    setStatusCounts({ backlinks: null, extra: `${n} élément${n > 1 ? 's' : ''}` })
  }
  pollConflict()

  if (focusTitleAfterLoad && currentCanRename && type === 'board') {
    // Pas de titre dans le canevas : on propose directement de nommer la page
    openRenameModal(room)
  } else if (focusTitleAfterLoad && currentCanRename) {
    docTitle.focus()
    const range = document.createRange()
    range.selectNodeContents(docTitle)
    const sel = window.getSelection()
    sel.removeAllRanges()
    sel.addRange(range)
  } else if (focusEditorAfterLoad) {
    editor?.commands.focus('start')
  }
  focusTitleAfterLoad = false
  focusEditorAfterLoad = false
}

function mountEditor(room, editable, userColor) {
  editor = new Editor({
    element: editorHost,
    editable,
    extensions: [
      StarterKit.configure(STARTER_KIT),
      MarkdownText,
      MarkdownHardBreak,
      Collaboration.configure({ document: ydoc }),
      CollaborationCaret.configure({ provider, user: { name: me.name, email: me.email, color: userColor } }),
      Placeholder.configure({
        placeholder: ({ node }) =>
          node.type.name === 'heading' ? `Titre ${node.attrs.level}` : 'Tape « / » pour les commandes',
        showOnlyCurrent: true,
        includeChildren: false,
      }),
      ...contentExtensions({
        onMention: (u, e) => notifyMention(u, { excerpt: e.state.selection.$from.parent.textContent }),
      }),
      CommentHighlights.configure({ manager: comments }),
      BubbleMenu.configure({
        element: bubbleEl,
        // Floating UI (Tiptap 3) : posée sur la page, suit le défilement de l'éditeur
        appendTo: () => document.body,
        options: { strategy: 'fixed', placement: 'top-start', offset: 8, flip: true, shift: { padding: 8 }, scrollTarget: scroller },
        shouldShow: ({ editor: ed, state, view }) =>
          ed.isEditable &&
          view.hasFocus() &&
          !state.selection.empty &&
          !(state.selection instanceof NodeSelection) &&
          !ed.isActive('codeBlock'),
      }),
    ],
    onUpdate: editable ? () => !applyingDiskContent && scheduleSave() : undefined,
    onTransaction: ({ transaction }) => {
      updateBubbleState()
      scheduleToc()
      if (transaction.docChanged) scheduleCounts()
    },
    editorProps: editable ? imageEditorProps(() => editor) : {},
  })

  if (editable) blockHandle = mountBlockHandle(editor, scroller, { onMenu: openBlockMenu })

  // Si le document Yjs est vide (première ouverture, aucun autre client),
  // on seed depuis le fichier .md existant sur disque.
  provider.once('sync', async (isSynced) => {
    if (!isSynced || !editor) return
    scheduleCounts()
    if (editor.getText().trim().length === 0) {
      const { content } = await api(docApi(room))
      if (content && content.trim()) applyDiskContent(room, content)
    }
    scheduleToc()
  })

  refreshBacklinks(room)
}

// --- En-tête façon Obsidian : ← →, lecture / édition ---------------------------
el('nav-back').onclick = () => history.back()
el('nav-forward').onclick = () => history.forward()

let readingMode = store.get('yariche-reading', false)
function applyMode() {
  const btn = el('mode-btn')
  const canEdit = currentType === 'doc' && (currentRole === 'owner' || currentRole === 'editor')
  btn.classList.toggle('hidden', !canEdit)
  // Comme Obsidian : l'icône indique le mode dans lequel on passera
  btn.innerHTML = icon(readingMode ? 'rename' : 'book', 18)
  btn.title = readingMode ? 'Lecture seule — cliquer pour modifier (⌘E)' : 'Édition — cliquer pour lire (⌘E)'
  app.classList.toggle('reading-mode', readingMode && canEdit)
  if (editor && !editor.isDestroyed && canEdit && editor.isEditable === readingMode) editor.setEditable(!readingMode)
}
function toggleReading() {
  readingMode = !readingMode
  store.set('yariche-reading', readingMode)
  applyMode()
  toast(readingMode ? 'Mode lecture' : 'Mode édition')
}
el('mode-btn').onclick = toggleReading
// ⌘E : bascule lecture/édition comme Obsidian. Écouté en capture pour passer
// avant l'éditeur (qui l'utilisait pour le code en ligne : utiliser `code`).
window.addEventListener(
  'keydown',
  (e) => {
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.code === 'KeyE' && currentType === 'doc') {
      e.preventDefault()
      e.stopPropagation()
      toggleReading()
    }
  },
  true
)

// --- Propriétés (en-tête YAML d'Obsidian), en lecture ---------------------------
// Lecture simple : « clé: valeur », « clé: [a, b] » et listes « - a » sous une clé.
function parseFrontmatter(text) {
  const lines = String(text || '').replace(/^---[ \t]*\r?\n/, '').replace(/\r?\n---[ \t]*(\r?\n)?$/, '').split(/\r?\n/)
  const props = []
  for (const line of lines) {
    const item = line.match(/^\s+-\s+(.*)$/)
    if (item && props.length) {
      const last = props[props.length - 1]
      last.value = [...(Array.isArray(last.value) ? last.value : last.value ? [last.value] : []), item[1].replace(/^["']|["']$/g, '')]
      continue
    }
    const kv = line.match(/^([^:#\s][^:]*):\s*(.*)$/)
    if (!kv) continue
    let value = kv[2].trim()
    if (/^\[.*\]$/.test(value)) value = value.slice(1, -1).split(',').map((v) => v.trim().replace(/^["']|["']$/g, '')).filter(Boolean)
    else value = value.replace(/^["']|["']$/g, '')
    props.push({ key: kv[1].trim(), value })
  }
  return props
}
function renderProperties(frontmatter) {
  const box = el('doc-properties')
  const props = parseFrontmatter(frontmatter)
  box.classList.toggle('hidden', !props.length)
  if (!props.length) return (box.innerHTML = '')
  const iconFor = (key) => (/tag/i.test(key) ? 'hash' : /date|jour|created|updated/i.test(key) ? 'calendar' : /alias/i.test(key) ? 'link' : 'textAa')
  box.innerHTML = `<div class="dp-title">Propriétés <span>· en-tête YAML du fichier, conservé tel quel</span></div>${props
    .map(({ key, value }) => {
      const list = Array.isArray(value) ? value : null
      const shown = list
        ? list.map((v) => `<span class="dp-tag">${/tag/i.test(key) ? '#' : ''}${escapeHTML(v)}</span>`).join('')
        : escapeHTML(value)
      return `<div class="dp-row"><span class="dp-key">${icon(iconFor(key), 16)}${escapeHTML(key)}</span><span class="dp-value">${shown || '<span class="muted">Vide</span>'}</span></div>`
    })
    .join('')}`
}

// --- Barre d'état (bas de fenêtre, comme Obsidian) ------------------------------
let statusPathValue = ''
function setStatusPath(path) {
  statusPathValue = path || ''
  const b = el('status-path')
  b.innerHTML = path ? `${icon('folder', 12)}<span>${escapeHTML(path)}</span>` : ''
  b.title = path ? `Rangé dans le coffre : ${path} — cliquer pour copier le chemin` : ''
  b.classList.toggle('hidden', !path)
}
el('status-path').onclick = () => {
  if (!statusPathValue) return
  navigator.clipboard
    ?.writeText(statusPathValue)
    .then(() => toast(`Chemin copié : ${statusPathValue}`))
    .catch(() => toast(statusPathValue))
}
// Champ absent = inchangé ; null = effacé
function setStatusCounts({ backlinks, words, chars, extra } = {}) {
  const plural = (n, one, many) => `${n.toLocaleString('fr-FR')} ${n > 1 ? many : one}`
  if (backlinks !== undefined) el('status-backlinks').textContent = backlinks === null ? '' : plural(backlinks, 'rétrolien', 'rétroliens')
  if (extra !== undefined) {
    el('status-words').textContent = extra || ''
    el('status-chars').textContent = ''
    return
  }
  if (words !== undefined) el('status-words').textContent = words === null ? '' : plural(words, 'mot', 'mots')
  if (chars !== undefined) el('status-chars').textContent = chars === null ? '' : plural(chars, 'caractère', 'caractères')
}
let countTimer = null
function scheduleCounts() {
  clearTimeout(countTimer)
  countTimer = setTimeout(() => {
    if (!editor || editor.isDestroyed) return
    const text = editor.getText()
    setStatusCounts({ words: (text.match(/\S+/g) || []).length, chars: text.length })
  }, 250)
}

// --- Barre de mise en forme (sélection) ------------------------------------
function currentBlockKind() {
  if (!editor) return 'p'
  if (editor.isActive('heading', { level: 1 })) return 'h1'
  if (editor.isActive('heading', { level: 2 })) return 'h2'
  if (editor.isActive('heading', { level: 3 })) return 'h3'
  if (editor.isActive('taskList')) return 'task'
  if (editor.isActive('bulletList')) return 'bullet'
  if (editor.isActive('orderedList')) return 'ordered'
  if (editor.isActive('blockquote')) return 'quote'
  if (editor.isActive('codeBlock')) return 'code'
  return 'p'
}
function updateBubbleState() {
  if (!editor) return
  bubbleEl.querySelectorAll('[data-mark]').forEach((b) => b.classList.toggle('active', editor.isActive(b.dataset.mark)))
  bubbleTurn.value = currentBlockKind()
}
function promptLink() {
  if (!editor) return
  const prev = editor.getAttributes('link').href || ''
  const href = window.prompt('Adresse du lien (vide pour retirer) :', prev)
  if (href === null) return
  if (!href.trim()) editor.chain().focus().extendMarkRange('link').unsetLink().run()
  else editor.chain().focus().extendMarkRange('link').setLink({ href: href.trim() }).run()
}
bubbleEl.querySelectorAll('[data-mark]').forEach((b) => {
  b.onmousedown = (e) => e.preventDefault()
  b.onclick = () => {
    const mark = b.dataset.mark
    if (mark === 'link') return promptLink()
    const cmd = { bold: 'toggleBold', italic: 'toggleItalic', strike: 'toggleStrike', code: 'toggleCode', highlight: 'toggleHighlight' }[mark]
    editor.chain().focus()[cmd]().run()
  }
})
// Complétion en grisé : active par défaut, désactivable depuis la palette de commandes
function aiGhostOn() {
  try {
    return localStorage.getItem('yariche-ai-ghost') !== 'off'
  } catch {
    return true
  }
}
function toggleAiGhost() {
  try {
    localStorage.setItem('yariche-ai-ghost', aiGhostOn() ? 'off' : 'on')
  } catch {}
  toast(aiGhostOn() ? 'Complétion IA activée (Tab pour accepter)' : 'Complétion IA désactivée')
}
// Assistant IA intégré (menu de sélection, « / », ⌘J)
const aiInline = createAiInline({ api, getEditor: () => editor, toast })
function openAiInline() {
  if (!me?.ai) return toast("Assistant IA non configuré sur ce serveur")
  aiInline.open()
}
const bubbleAi = bubbleEl.querySelector('[data-action="ai"]')
bubbleAi.onmousedown = (e) => e.preventDefault()
bubbleAi.onclick = openAiInline
const bubbleComment = bubbleEl.querySelector('[data-action="comment"]')
bubbleComment.onmousedown = (e) => e.preventDefault()
bubbleComment.onclick = () => comments?.startFromSelection()
bubbleTurn.onchange = (e) => turnInto(e.target.value)
function turnInto(kind) {
  if (!editor) return
  const c = editor.chain().focus()
  // On repasse d'abord en paragraphe pour que les toggle* ne s'annulent pas entre eux
  if (editor.isActive('bulletList')) c.toggleBulletList()
  if (editor.isActive('orderedList')) c.toggleOrderedList()
  if (editor.isActive('taskList')) c.toggleTaskList()
  if (editor.isActive('blockquote')) c.toggleBlockquote()
  if (editor.isActive('codeBlock')) c.toggleCodeBlock()
  const apply = {
    p: () => c.setParagraph(),
    h1: () => c.setNode('heading', { level: 1 }),
    h2: () => c.setNode('heading', { level: 2 }),
    h3: () => c.setNode('heading', { level: 3 }),
    bullet: () => c.setParagraph().toggleBulletList(),
    ordered: () => c.setParagraph().toggleOrderedList(),
    task: () => c.setParagraph().toggleTaskList(),
    quote: () => c.setParagraph().toggleBlockquote(),
    code: () => c.setParagraph().toggleCodeBlock(),
  }[kind]
  // Plusieurs blocs sélectionnés → UN bloc de code, une ligne par bloc (et pas un bloc de
  // code par ligne)
  if (kind === 'code' && !editor.isActive('codeBlock') && mergeIntoCodeBlock()) return
  apply().run()
}

// Texte d'un bloc, retours à la ligne compris (⇧Entrée, sous-blocs d'une liste ou citation)
function blockLines(node) {
  if (node.isTextblock) {
    let text = ''
    node.forEach((child) => (text += child.isText ? child.text : child.type.name === 'hardBreak' ? '\n' : ''))
    return [text]
  }
  const lines = []
  node.forEach((child) => lines.push(...blockLines(child)))
  return lines
}
function mergeIntoCodeBlock() {
  const { state } = editor
  const { $from, $to } = state.selection
  const range = $from.blockRange($to)
  if (!range || range.endIndex - range.startIndex < 2) return false
  const lines = []
  for (let i = range.startIndex; i < range.endIndex; i++) lines.push(...blockLines(range.parent.child(i)))
  const text = lines.join('\n')
  const code = state.schema.nodes.codeBlock.create({ language: lastCodeLanguage() }, text ? state.schema.text(text) : null)
  const tr = state.tr.replaceWith(range.start, range.end, code)
  tr.setSelection(TextSelection.create(tr.doc, range.start + 1 + text.length))
  editor.view.dispatch(tr.scrollIntoView())
  editor.commands.focus()
  return true
}

// --- Sommaire flottant (lignes à droite, panneau au survol) ----------------
let tocTimer = null
let tocHeadings = []
function scheduleToc() {
  clearTimeout(tocTimer)
  tocTimer = setTimeout(renderToc, 250)
}
function renderToc() {
  const toc = el('toc')
  if (!editor || currentType !== 'doc') return toc.classList.add('hidden')
  tocHeadings = [...editor.view.dom.querySelectorAll('h1, h2, h3')].filter((h) => h.textContent.trim())
  if (tocHeadings.length < 2) return toc.classList.add('hidden')
  toc.classList.remove('hidden')
  el('toc-lines').innerHTML = tocHeadings.map((h) => `<div class="toc-line l${h.tagName[1]}"></div>`).join('')
  const panel = el('toc-panel')
  panel.innerHTML = '<div class="toc-title">Sommaire</div>'
  tocHeadings.forEach((h, i) => {
    const item = document.createElement('div')
    item.className = `toc-item l${h.tagName[1]}`
    item.textContent = h.textContent
    item.onclick = () => tocHeadings[i]?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    panel.appendChild(item)
  })
  highlightToc()
}
function highlightToc() {
  if (!tocHeadings.length) return
  const top = scroller.getBoundingClientRect().top + 80
  let active = 0
  tocHeadings.forEach((h, i) => {
    if (h.getBoundingClientRect().top <= top) active = i
  })
  el('toc-lines').querySelectorAll('.toc-line').forEach((l, i) => l.classList.toggle('active', i === active))
  el('toc-panel').querySelectorAll('.toc-item').forEach((l, i) => l.classList.toggle('active', i === active))
}
scroller.addEventListener('scroll', highlightToc, { passive: true })

// --- Rétroliens -------------------------------------------------------------
async function refreshBacklinks(room) {
  const panel = el('backlinks-panel')
  const list = el('backlinks-list')
  // Invité : les rétroliens montreraient des pages hors de son partage (le serveur refuse)
  if (me.guest) return panel.classList.add('hidden')
  try {
    const { backlinks } = await api(docApi(room, '/backlinks'))
    if (room !== currentRoom) return
    setStatusCounts({ backlinks: backlinks.length })
    panel.classList.remove('hidden')
    panel.querySelector('.backlinks-head span').textContent = `Liens bidirectionnels · ${backlinks.length}`
    list.innerHTML = backlinks.length ? '' : '<div class="empty-hint">Aucune page ne pointe ici pour le moment.</div>'
    for (const source of backlinks) {
      const chip = document.createElement('button')
      chip.className = 'backlink-row'
      chip.innerHTML = `${pageIconHTML(entryFor(source) || {}, 16)}<span>${escapeHTML(nameOf(source))}</span>`
      chip.title = source
      chip.onclick = () => navigateTo(source)
      list.appendChild(chip)
    }
  } catch {
    panel.classList.add('hidden')
  }
}
el('backlinks-toggle').onclick = () => {
  const list = el('backlinks-list')
  list.classList.toggle('hidden')
  el('backlinks-toggle').textContent = list.classList.contains('hidden') ? 'Afficher' : 'Masquer'
}

function renderAccessDenied() {
  editorHost.classList.add('hidden')
  editorHost.insertAdjacentHTML(
    'afterend',
    '<p id="access-denied-msg" class="empty-hint" style="max-width:752px;margin:0 auto;">Tu n\'as pas accès à ce document. Demande au propriétaire de le partager avec ton compte.</p>'
  )
}

// Adresse d'une page qui n'existe pas (supprimée, déplacée ailleurs, lien d'un ancien
// onglet) : rien n'est créé sans le demander
function renderNotFound(room) {
  editorHost.classList.add('hidden')
  docTitle.contentEditable = 'false'
  editorHost.insertAdjacentHTML(
    'afterend',
    `<div id="access-denied-msg" class="empty-hint" style="max-width:752px;margin:0 auto;">
      <p>Cette page n'existe pas (ou plus) : <b>${escapeHTML(room)}</b></p>
      ${me.guest ? '' : '<p><button class="primary-btn" id="not-found-create">Créer cette page</button></p>'}
    </div>`
  )
  const btn = el('not-found-create')
  if (!btn) return
  btn.onclick = () => {
    const dir = room.includes('/') ? room.slice(0, room.lastIndexOf('/')) : null
    createPage({ name: nameOf(room), parent: dir && entryFor(dir) ? dir : null })
  }
}

async function refreshShareAccess(room) {
  // Invité : pas de réglages de partage (réservés au propriétaire, le serveur refuse)
  if (me.guest) {
    currentShareMeta = null
    return shareBtn.classList.add('hidden')
  }
  try {
    currentShareMeta = await api(docApi(room, '/share'))
    shareBtn.classList.remove('hidden')
  } catch {
    currentShareMeta = null
    shareBtn.classList.add('hidden')
  }
}

// --- Sauvegarde -------------------------------------------------------------
async function saveNow(room = currentRoom) {
  if (!editor) return
  const markdown = editor.storage.markdown.getMarkdown()
  await api(docApi(room), { method: 'POST', body: JSON.stringify({ markdown }) })
}
function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer)
  const room = currentRoom
  saveTimer = setTimeout(() => {
    saveTimer = null
    saveNow(room).then(() => refreshBacklinks(room)).catch(() => toast('Sauvegarde impossible'))
  }, 1500)
}
async function flushSave() {
  if (!saveTimer) return
  clearTimeout(saveTimer)
  saveTimer = null
  await saveNow()
}
// Avant un renommage : tout ce qui n'est pas encore écrit sur disque
async function flushAll() {
  await flushSave()
  await comments?.flush()
  await activeBoard?.flush?.()
  await activeDatabase?.flush?.()
}
window.addEventListener('beforeunload', () => {
  if (saveTimer && editor) {
    navigator.sendBeacon?.(
      `${docApi(currentRoom)}?${vaultQuery()}`,
      new Blob([JSON.stringify({ markdown: editor.storage.markdown.getMarkdown() })], { type: 'application/json' })
    )
  }
})

function renderPresence() {
  presenceEl.innerHTML = ''
  const seen = new Set()
  // Comme AFFiNE/Notion : on n'affiche que les autres collaborateurs
  for (const [clientId, s] of provider.awareness.getStates()) {
    if (clientId === provider.awareness.clientID) continue
    // Mes autres onglets / appareils ne sont pas des collaborateurs
    if (!s.user || s.user.email === me.email || seen.has(s.user.name)) continue
    seen.add(s.user.name)
    const dot = document.createElement('div')
    dot.className = 'presence-dot'
    dot.style.background = s.user.color
    dot.title = s.user.name
    dot.textContent = s.user.name[0].toUpperCase()
    presenceEl.appendChild(dot)
  }
}

// Contenu lu sur le disque (première ouverture, modification faite dans Nextcloud ou
// Obsidian) : affiché sans être réenregistré. Le serveur retient sa mise en forme par
// l'éditeur comme référence ; tant qu'on ne modifie rien, le fichier reste identique
// octet pour octet (pas d'aller-retour inutile vers Nextcloud).
function applyDiskContent(room, content) {
  if (!editor || editor.isDestroyed) return
  applyingDiskContent = true
  try {
    editor.commands.setContent(content, { emitUpdate: false })
  } finally {
    applyingDiskContent = false
  }
  const markdown = editor.storage.markdown.getMarkdown()
  api(docApi(room), { method: 'POST', body: JSON.stringify({ markdown, baseline: true }) }).catch(() => {})
}

let conflictInterval = null
function pollConflict() {
  if (conflictInterval) clearInterval(conflictInterval)
  const room = currentRoom
  conflictInterval = setInterval(async () => {
    try {
      const { conflict } = await api(docApi(room, '/conflict'))
      const canWrite = currentRole === 'owner' || currentRole === 'editor'
      // Rien en attente d'enregistrement ici : on prend la version extérieure d'office
      // (un seul onglet l'applique, les autres la reçoivent en direct)
      if (conflict && canWrite && !saveTimer && editor && !editor.isDestroyed && room === currentRoom) {
        const claim = await api(docApi(room, '/conflict/claim'), { method: 'POST', body: JSON.stringify({ id: conflict.id }) })
        if (claim.ok && room === currentRoom) {
          await reloadFromDisk(room)
          toast('Note mise à jour : modifiée dans Nextcloud ou un autre éditeur')
        }
        el('conflict-banner').classList.add('hidden')
        return
      }
      el('conflict-banner').classList.toggle('hidden', !conflict)
    } catch {
      /* silencieux */
    }
  }, 4000)
}
async function reloadFromDisk(room) {
  const { content, frontmatter } = await api(docApi(room))
  if (room !== currentRoom) return
  applyDiskContent(room, content)
  renderProperties(frontmatter)
}
el('conflict-reload').onclick = async () => {
  await reloadFromDisk(currentRoom)
  await api(docApi(currentRoom, '/ack'), { method: 'POST' })
  el('conflict-banner').classList.add('hidden')
}
el('conflict-dismiss').onclick = async () => {
  await api(docApi(currentRoom, '/ack'), { method: 'POST' })
  el('conflict-banner').classList.add('hidden')
}

// --- Boutons sidebar --------------------------------------------------------
el('new-page-btn').onclick = () => createPage({ parent: defaultNewParent() })
// Barre d'outils de l'explorateur (comme Obsidian) : note, dossier, tri, tout replier
el('explorer-new-folder').onclick = (e) => {
  e.stopPropagation()
  createFolder(defaultNewParent())
}
el('explorer-sort').onclick = (e) => {
  e.stopPropagation()
  const mode = store.get('yariche-sort', 'name-asc')
  showMenu(
    e.currentTarget,
    SORT_MODES.map(([id, label]) => ({
      label,
      icon: 'sort',
      checked: mode === id,
      run: () => {
        store.set('yariche-sort', id)
        renderSidebar()
      },
    }))
  )
}
el('explorer-collapse').onclick = (e) => {
  e.stopPropagation()
  const parents = lastEntries.filter((x) => lastEntries.some((c) => c.parent === x.room)).map((x) => x.room)
  const anyOpen = parents.some((r) => !collapsed.has(r))
  if (anyOpen) parents.forEach((r) => collapsed.add(r))
  else collapsed.clear()
  store.set('yariche-collapsed', [...collapsed])
  renderSidebar()
  if (!anyOpen) revealInSidebar(currentRoom)
}
el('section-new-page').onclick = (e) => {
  e.stopPropagation()
  createPage({ parent: defaultNewParent() })
}
el('section-new-page').oncontextmenu = (e) => {
  e.preventDefault()
  showMenu(e.currentTarget, [
    { label: 'Page', icon: 'page', run: () => createPage({ type: 'doc' }) },
    { label: 'Whiteboard', icon: 'board', run: () => createPage({ type: 'board' }) },
    { label: 'Base de données', icon: 'database', run: () => createPage({ type: 'database' }) },
    { label: 'Dossier', icon: 'folder', run: () => createFolder(null) },
  ])
}
el('search-btn').onclick = () => openPalette()

// Notes du jour rangées dans un dossier « Journal » (comme les daily notes d'Obsidian)
async function openJournal() {
  const d = new Date()
  const name = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  const id = joinId('Journal', name)
  if (!entryFor(id)) {
    if (!entryFor('Journal')) {
      await api(docApi('Journal', '/create'), { method: 'POST', body: JSON.stringify({ type: 'folder' }) }).catch(() => {})
    }
    pendingCreateType = 'doc'
  }
  navigateTo(id)
}
el('journal-btn').onclick = openJournal

function announceLinkUpdates(rooms = []) {
  if (rooms.length) toast(rooms.length === 1 ? `Lien mis à jour dans « ${nameOf(rooms[0])} »` : `Liens mis à jour dans ${rooms.length} pages`)
}

let renamingRoom = null
function openRenameModal(room) {
  renamingRoom = room
  el('rename-input').value = nameOf(room)
  el('rename-status').textContent = ''
  el('rename-modal').classList.remove('hidden')
  el('rename-input').focus()
  el('rename-input').select()
}
el('rename-close').onclick = () => el('rename-modal').classList.add('hidden')
async function confirmRename() {
  const newName = el('rename-input').value.trim()
  if (!newName || !renamingRoom) return
  if (/[/\\]/.test(newName)) {
    el('rename-status').textContent = 'Pas de « / » dans un nom : pour ranger l’élément ailleurs, déplace-le'
    return
  }
  try {
    const from = renamingRoom
    const wasOpen = isInside(currentRoom, from)
    if (wasOpen) await flushAll()
    const { newRoom, updatedLinks } = await api(docApi(from, '/rename'), { method: 'POST', body: JSON.stringify({ newName }) })
    announceLinkUpdates(updatedLinks)
    el('rename-modal').classList.add('hidden')
    await followIdChange(from, newRoom)
    if (!wasOpen) {
      await refreshPageList()
      if (currentType === 'folder') renderFolderView()
    }
  } catch (err) {
    el('rename-status').textContent = err.message
  }
}
el('rename-confirm').onclick = confirmRename
el('rename-input').onkeydown = (e) => {
  if (e.key === 'Enter') confirmRename()
}

// --- Accès IA (MCP) : jetons personnels -------------------------------------
const fmtDay = (ts) => (ts ? new Date(ts).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' }) : 'jamais')
async function renderAiTokens() {
  const list = el('ai-token-list')
  const tokens = await api('/api/tokens').catch(() => [])
  list.innerHTML = tokens.length ? '' : '<div class="empty-hint">Aucun jeton.</div>'
  for (const t of tokens) {
    const row = document.createElement('div')
    row.className = 'token-row'
    row.innerHTML = `<span class="token-name">${escapeHTML(t.name)}</span><span class="token-meta">${t.scope === 'write' ? 'lire et modifier' : 'lire'} · créé le ${fmtDay(t.createdAt)} · utilisé ${t.lastUsedAt ? `le ${fmtDay(t.lastUsedAt)}` : 'jamais'}</span>`
    const revoke = document.createElement('button')
    revoke.className = 'link-btn'
    revoke.textContent = 'Révoquer'
    revoke.onclick = async () => {
      if (!confirm(`Révoquer « ${t.name} » ? L’IA qui l’utilise perdra l’accès tout de suite.`)) return
      await api(`/api/tokens/${encodeURIComponent(t.id)}`, { method: 'DELETE' }).catch((err) => toast(err.message))
      renderAiTokens()
    }
    row.appendChild(revoke)
    list.appendChild(row)
  }
}
function openAiAccess() {
  el('ai-token-new').classList.add('hidden')
  el('ai-token-value').value = ''
  el('ai-access-modal').classList.remove('hidden')
  renderAiTokens()
}
el('ai-access-btn').onclick = openAiAccess
el('ai-access-close').onclick = () => {
  el('ai-access-modal').classList.add('hidden')
  el('ai-token-value').value = '' // le jeton ne reste pas dans la page
  el('ai-token-command').value = ''
}
el('ai-token-create').onclick = async () => {
  try {
    const { token } = await api('/api/tokens', {
      method: 'POST',
      body: JSON.stringify({ name: el('ai-token-name').value.trim() || 'Assistant', scope: el('ai-token-scope').value }),
    })
    el('ai-token-value').value = token
    el('ai-token-command').value = `npx mcp-remote ${location.origin}/mcp --header "Authorization: Bearer ${token}"`
    el('ai-token-new').classList.remove('hidden')
    el('ai-token-name').value = ''
    renderAiTokens()
  } catch (err) {
    toast(err.message)
  }
}
const copyField = (id, done) => () =>
  navigator.clipboard
    ?.writeText(el(id).value)
    .then(() => toast(done))
    .catch(() => el(id).select())
el('ai-token-copy').onclick = copyField('ai-token-value', 'Jeton copié')
el('ai-command-copy').onclick = copyField('ai-token-command', 'Commande copiée')

// --- Import / export .md ----------------------------------------------------
el('import-btn').onclick = () => el('import-input').click()
el('import-input').onchange = async (e) => {
  const files = [...e.target.files]
  e.target.value = ''
  let last = null
  for (const file of files) {
    const base = file.name.replace(/\.(md|markdown|txt)$/i, '').replace(/[/\\]/g, '-').replace(/^\.+/, '') || UNTITLED
    const room = await uniqueName(base)
    await api(docApi(room, '/create'), { method: 'POST', body: JSON.stringify({ type: 'doc' }) })
    await api(docApi(room), { method: 'POST', body: JSON.stringify({ markdown: await file.text() }) })
    lastEntries.push({ room })
    last = room
  }
  if (last) {
    toast(files.length > 1 ? `${files.length} pages importées` : `« ${last} » importée`)
    navigateTo(last)
  }
}

async function exportCurrent() {
  await flushSave()
  const { content, raw } = await api(docApi(currentRoom))
  const blob = new Blob([raw ?? content], { type: 'text/markdown;charset=utf-8' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `${nameOf(currentRoom)}.md`
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 1000)
}

// --- Topbar : favori + menu "…" --------------------------------------------
mountLightbox()

// Export PDF : la boîte d'impression du navigateur (« Enregistrer au format PDF »),
// la feuille @media print masque l'interface et la syntaxe ![[…]]
async function exportPdf() {
  await flushSave()
  const previous = document.title
  document.title = nameOf(currentRoom)
  window.addEventListener('afterprint', () => (document.title = previous), { once: true })
  window.print()
}

el('fav-btn').onclick = () => toggleFavorite(currentRoom, !entryFor(currentRoom)?.favorite)

function setFullWidth(on) {
  app.classList.toggle('full-width', on)
  store.set('yariche-full-width', on)
}
setFullWidth(store.get('yariche-full-width', false))

el('doc-menu-btn').onclick = (e) => {
  e.stopPropagation()
  const isOwner = currentRole === 'owner'
  const items = [
    {
      label: entryFor(currentRoom)?.favorite ? 'Retirer des favoris' : 'Ajouter aux favoris',
      icon: 'star',
      run: () => toggleFavorite(currentRoom, !entryFor(currentRoom)?.favorite),
    },
    { label: 'Pleine largeur', icon: 'widen', checked: app.classList.contains('full-width'), run: () => setFullWidth(!app.classList.contains('full-width')) },
    'sep',
    { label: 'Historique des versions', icon: 'history', run: openHistory },
    {
      label: 'Dupliquer',
      icon: 'copy',
      run: async () => {
        await flushSave()
        const { newRoom } = await api(docApi(currentRoom, '/duplicate'), { method: 'POST' })
        navigateTo(newRoom)
      },
    },
    { label: 'Ajouter une sous-page', icon: 'plus', run: () => createPage({ parent: currentRoom }) },
    isOwner ? { label: 'Déplacer vers…', icon: 'move', run: () => openMovePicker(currentRoom) } : null,
    inMacApp() ? { label: 'Afficher dans le Finder', icon: 'finder', run: () => revealInFinder(currentRoom) } : null,
    { label: 'Copier le lien', icon: 'link', run: copyLink },
  ]
  if (currentType === 'doc') items.push({ label: 'Exporter en Markdown', icon: 'download', run: exportCurrent }, { label: 'Exporter en PDF', icon: 'download', run: exportPdf })
  if (isOwner) items.push('sep', { label: 'Déplacer dans la corbeille', icon: 'trash', danger: true, run: () => trashPage(currentRoom) })
  showMenu(e.currentTarget, items)
}

function copyLink() {
  navigator.clipboard
    ?.writeText(location.href)
    .then(() => toast('Lien copié'))
    .catch(() => toast(location.href))
}

// --- Panneau IA -------------------------------------------------------------
const aiPanel = el('ai-panel')
const aiPrompt = el('ai-prompt')
const aiSend = el('ai-send')
const aiStatus = el('ai-status')
const aiResponse = el('ai-response')
const aiInsertRow = el('ai-insert-row')
let lastAiText = ''

el('ai-toggle').onclick = () => {
  aiPanel.classList.toggle('hidden')
  if (!aiPanel.classList.contains('hidden')) aiPrompt.focus()
}
el('ai-close').onclick = () => aiPanel.classList.add('hidden')
aiPrompt.onkeydown = (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) aiSend.click()
}
aiSend.onclick = async () => {
  const prompt = aiPrompt.value.trim()
  if (!prompt) return
  aiSend.disabled = true
  aiStatus.textContent = 'Réflexion…'
  aiResponse.textContent = ''
  aiInsertRow.classList.add('hidden')
  try {
    const context = editor ? editor.storage.markdown.getMarkdown().slice(0, 4000) : ''
    const data = await api('/api/ai', { method: 'POST', body: JSON.stringify({ prompt, context }) })
    lastAiText = data.text || ''
    aiResponse.textContent = lastAiText
    aiInsertRow.classList.toggle('hidden', !editor)
    aiStatus.textContent = ''
  } catch (err) {
    aiStatus.textContent = ''
    aiResponse.textContent = `Erreur : ${err.message}`
  } finally {
    aiSend.disabled = false
  }
}
el('ai-insert').onclick = () => {
  if (!lastAiText || !editor) return
  editor.chain().focus().insertContent(lastAiText).run()
}

// --- Partage ----------------------------------------------------------------
const shareModal = el('share-modal')
const shareVisibility = el('share-visibility')
const shareLinkRole = el('share-link-role')
const shareList = el('share-list')
let draftShares = {}

function renderShareList() {
  shareList.innerHTML = ''
  for (const [email, role] of Object.entries(draftShares)) {
    const row = document.createElement('div')
    row.className = 'share-row'
    row.innerHTML = `
      <span>${escapeHTML(email)}</span>
      <span>
        <select class="share-role-select">
          <option value="viewer" ${role === 'viewer' ? 'selected' : ''}>peut lire</option>
          <option value="editor" ${role === 'editor' ? 'selected' : ''}>peut modifier</option>
        </select>
        <button class="share-remove">retirer</button>
      </span>`
    row.querySelector('select').onchange = (e) => (draftShares[email] = e.target.value)
    row.querySelector('.share-remove').onclick = () => {
      delete draftShares[email]
      renderShareList()
    }
    shareList.appendChild(row)
  }
}
// Lien d'invité (personnes sans compte) : actif dès qu'il existe, révocable
let guestLink = null
function renderGuestLink() {
  el('guest-link-on').checked = !!guestLink
  el('guest-link-role').value = guestLink?.role || 'editor'
  el('guest-link-box').classList.toggle('hidden', !guestLink)
  el('guest-link-new').classList.toggle('hidden', !guestLink)
  el('guest-link-url').value = guestLink?.url || ''
}
async function saveGuestLink(options) {
  const room = currentRoom
  try {
    const r = options
      ? await api(docApi(room, '/share-link'), { method: 'POST', body: JSON.stringify(options) })
      : await api(docApi(room, '/share-link'), { method: 'DELETE' })
    guestLink = r.link
    renderGuestLink()
    if (guestLink && options?.copy) copyGuestLink()
  } catch (err) {
    toast(err.message)
    renderGuestLink()
  }
}
function copyGuestLink() {
  if (!guestLink) return
  navigator.clipboard
    ?.writeText(guestLink.url)
    .then(() => toast('Lien d’invité copié'))
    .catch(() => el('guest-link-url').select())
}
el('guest-link-on').onchange = (e) =>
  e.target.checked ? saveGuestLink({ role: el('guest-link-role').value, copy: true }) : saveGuestLink(null)
el('guest-link-role').onchange = () => guestLink && saveGuestLink({ role: el('guest-link-role').value })
el('guest-link-copy').onclick = copyGuestLink
el('guest-link-new').onclick = () => {
  if (confirm('Créer un nouveau lien ? L’ancien ne marchera plus pour personne.'))
    saveGuestLink({ role: el('guest-link-role').value, regenerate: true, copy: true })
}

shareBtn.onclick = () => {
  el('share-doc-name').textContent = nameOf(currentRoom)
  const folderShare = currentType === 'folder'
  el('guest-link-help-text').textContent = folderShare
    ? 'Espace d’équipe : la personne donne son prénom et accède à tout ce que contient ce dossier, y compris ce qui y sera ajouté. En « peut modifier », elle peut aussi y créer des pages.'
    : 'La personne donne son prénom et n’accède qu’à cette page et à ses sous-pages.'
  el('share-space-hint').classList.toggle('hidden', !folderShare)
  // Serveur privé (connexion limitée) : on partage par lien d'invité, pas par compte
  shareModal.querySelectorAll('.account-share').forEach((s) => s.classList.toggle('hidden', !!me.privateServer))
  guestLink = null
  renderGuestLink()
  api(docApi(currentRoom, '/share-link'))
    .then((r) => {
      guestLink = r.link
      renderGuestLink()
    })
    .catch(() => {})
  shareVisibility.value = currentShareMeta.visibility
  shareLinkRole.value = currentShareMeta.linkRole
  shareLinkRole.classList.toggle('hidden', currentShareMeta.visibility !== 'link')
  draftShares = { ...currentShareMeta.shares }
  renderShareList()
  el('share-status').textContent = ''
  shareModal.classList.remove('hidden')
}
el('share-close').onclick = () => shareModal.classList.add('hidden')
el('copy-link-btn').onclick = copyLink
shareVisibility.onchange = () => shareLinkRole.classList.toggle('hidden', shareVisibility.value !== 'link')
el('invite-add').onclick = () => {
  const email = el('invite-email').value.trim()
  if (!email) return
  draftShares[email] = el('invite-role').value
  el('invite-email').value = ''
  renderShareList()
}
el('share-save').onclick = async () => {
  el('share-status').textContent = 'Enregistrement…'
  currentShareMeta = await api(docApi(currentRoom, '/share'), {
    method: 'POST',
    body: JSON.stringify({ visibility: shareVisibility.value, linkRole: shareLinkRole.value, shares: draftShares }),
  })
  el('share-status').textContent = 'Enregistré.'
  loadUsers()
  setTimeout(() => shareModal.classList.add('hidden'), 600)
}

// --- Icône (sélecteur d'emoji) + couverture --------------------------------
const EMOJIS = '📝 📌 📚 💡 🚀 ✅ 🎯 🗓️ 📊 📈 🧠 🔥 ⭐ ❤️ 🏠 💼 🛠️ 🧪 🎨 🎵 📷 ✈️ 🍳 🌱 🐛 🔒 🌍 💬 📦 🧾 🎓 ⚙️ 🖥️ 📱 🔗 🧭 🗂️ 🏷️ 🧩 🎮'.split(' ')
function openEmojiPicker(anchor) {
  const picker = el('emoji-picker')
  picker.innerHTML = '<div class="emoji-head"><span>Icône</span><button id="emoji-remove">Retirer</button></div><div class="emoji-grid"></div>'
  const grid = picker.querySelector('.emoji-grid')
  for (const e of EMOJIS) {
    const b = document.createElement('button')
    b.textContent = e
    b.onclick = async () => {
      picker.classList.add('hidden')
      await saveAppearance({ icon: e })
      applyAppearance({ icon: e, cover: currentCover() }, true)
    }
    grid.appendChild(b)
  }
  picker.querySelector('#emoji-remove').onclick = async () => {
    picker.classList.add('hidden')
    await saveAppearance({ icon: null })
    applyAppearance({ icon: null, cover: currentCover() }, true)
  }
  picker.classList.remove('hidden')
  const r = anchor.getBoundingClientRect()
  picker.style.left = `${r.left}px`
  picker.style.top = `${r.bottom + 6}px`
}
const currentCover = () => [...docCover.classList].find((c) => c.startsWith('cover-'))?.slice(6) || null
const currentEmoji = () => docIcon.textContent || null

docIcon.onclick = (e) => {
  if (!docIcon.disabled) openEmojiPicker(e.currentTarget)
}
el('add-icon-btn').onclick = (e) => openEmojiPicker(e.currentTarget)

function openCoverPicker(anchor) {
  coverPicker.classList.remove('hidden')
  const r = anchor.getBoundingClientRect()
  coverPicker.style.left = `${r.left}px`
  coverPicker.style.top = `${r.bottom + 6}px`
}
el('add-cover-btn').onclick = (e) => openCoverPicker(e.currentTarget)
el('cover-change-btn').onclick = (e) => openCoverPicker(e.currentTarget)
el('cover-remove-btn').onclick = async () => {
  await saveAppearance({ cover: null })
  applyAppearance({ icon: currentEmoji(), cover: null }, true)
}
coverPicker.querySelectorAll('.cover-swatch').forEach((sw) => {
  sw.onclick = async () => {
    const cover = sw.dataset.cover
    coverPicker.classList.add('hidden')
    await saveAppearance({ cover })
    applyAppearance({ icon: currentEmoji(), cover }, true)
  }
})

// --- App macOS (WKWebView) : pont natif -------------------------------------
const nativeBridge = window.webkit?.messageHandlers?.yariche
function postNative(message) {
  try {
    nativeBridge?.postMessage(message)
  } catch {
    /* hors de l'app Mac */
  }
}
window.__yaricheToast = toast
// L'app Mac demande quel coffre est ouvert (dossier local à choisir), ou ouvre le choix
// du dossier de travail (coffre pas encore synchronisé sur le Mac)
window.__yaricheVault = () => me?.vault || null
window.__yaricheOpenVaultModal = () => vaultUI?.openModal()
// Zones qui jouent le rôle de barre de titre : un clic-glisser y déplace la fenêtre
const DRAG_ZONES = '.topbar, .sidebar-top, .rp-header, .peek-bar'
const NO_DRAG = 'button, a, input, select, textarea, [contenteditable="true"], [contenteditable="plaintext-only"], .crumb, .presence-dot'
let dragQueued = false
let lastDragPayload = ''
function sendDragRegions() {
  if (!nativeBridge || dragQueued) return
  dragQueued = true
  requestAnimationFrame(() => {
    dragQueued = false
    const rect = (n) => {
      const r = n.getBoundingClientRect()
      return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]
    }
    const zones = [...document.querySelectorAll(DRAG_ZONES)].filter((z) => z.getClientRects().length)
    const drag = zones.map(rect).filter((r) => r[2] > 0 && r[3] > 0)
    const noDrag = zones.flatMap((z) => [...z.querySelectorAll(NO_DRAG)].filter((n) => n.getClientRects().length).map(rect))
    const payload = JSON.stringify([drag, noDrag])
    if (payload === lastDragPayload) return
    lastDragPayload = payload
    postNative({ type: 'dragRegions', drag, noDrag })
  })
}
if (nativeBridge) {
  new ResizeObserver(sendDragRegions).observe(document.body)
  new MutationObserver(sendDragRegions).observe(app, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'hidden'] })
  sendDragRegions()
}

// --- Thème ------------------------------------------------------------------
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme
  el('theme-toggle').innerHTML = icon(theme === 'light' ? 'moon' : 'sun', 18)
  postNative({ type: 'theme', theme })
}
applyTheme(store.get('yariche-theme', null) || 'dark')
function toggleTheme() {
  const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light'
  applyTheme(next)
  store.set('yariche-theme', next)
}
el('theme-toggle').onclick = toggleTheme

// --- Sidebar repliable + redimensionnable ----------------------------------
// Téléphone : la barre latérale devient un tiroir par-dessus la note, fermé par défaut
const narrow = window.matchMedia('(max-width: 760px)')
function setSidebarCollapsed(on, { remember = true } = {}) {
  app.classList.toggle('sidebar-collapsed', on)
  el('sidebar-open').classList.toggle('hidden', !on)
  if (remember && !narrow.matches) store.set('yariche-sidebar-collapsed', on)
}
setSidebarCollapsed(narrow.matches || store.get('yariche-sidebar-collapsed', false), { remember: false })
narrow.addEventListener('change', (e) =>
  setSidebarCollapsed(e.matches || store.get('yariche-sidebar-collapsed', false), { remember: false })
)
// Toucher la note (ou ouvrir une page) referme le tiroir
el('sidebar-backdrop').onclick = () => setSidebarCollapsed(true)
const closeDrawer = () => narrow.matches && setSidebarCollapsed(true, { remember: false })
el('sidebar-collapse').onclick = () => setSidebarCollapsed(true)
el('sidebar-open').onclick = () => setSidebarCollapsed(false)

const savedWidth = store.get('yariche-sidebar-width', null)
if (savedWidth) app.style.setProperty('--sidebar-w', `${savedWidth}px`)
el('sidebar-resizer').onmousedown = (e) => {
  e.preventDefault()
  document.body.classList.add('resizing')
  const onMove = (ev) => {
    const w = Math.min(480, Math.max(200, ev.clientX))
    app.style.setProperty('--sidebar-w', `${w}px`)
    store.set('yariche-sidebar-width', w)
  }
  const onUp = () => {
    document.body.classList.remove('resizing')
    window.removeEventListener('mousemove', onMove)
    window.removeEventListener('mouseup', onUp)
  }
  window.addEventListener('mousemove', onMove)
  window.addEventListener('mouseup', onUp)
}

// --- Filtre par tag ---------------------------------------------------------
let activeTagFilter = null
async function filterByTag(tag) {
  activeTagFilter = tag
  const { rooms } = await api(`/api/tag/${encodeURIComponent(tag)}`)
  el('tag-filter-banner').classList.remove('hidden')
  el('tag-filter-label').textContent = `#${tag} · ${rooms.length}`
  pageList.innerHTML = ''
  for (const room of rooms.sort()) renderRow(pageList, entryFor(room) || { room }, 0, true)
}
el('tag-filter-clear').onclick = () => {
  activeTagFilter = null
  el('tag-filter-banner').classList.add('hidden')
  renderSidebar()
}

// --- Graphe -----------------------------------------------------------------
let stopGraph = null
async function openGraph() {
  const data = await api('/api/graph')
  el('graph-overlay').classList.remove('hidden')
  stopGraph = renderGraph(el('graph-canvas'), data, (id) => {
    el('graph-overlay').classList.add('hidden')
    if (stopGraph) stopGraph()
    navigateTo(id)
  })
}
el('graph-toggle').onclick = openGraph
el('graph-close').onclick = () => {
  el('graph-overlay').classList.add('hidden')
  if (stopGraph) stopGraph()
}

// --- Historique de versions -------------------------------------------------
async function openHistory() {
  const { versions } = await api(docApi(currentRoom, '/versions'))
  el('history-doc-name').textContent = currentRoom
  const list = el('history-list')
  list.innerHTML = versions.length ? '' : '<div class="empty-hint">Aucune version antérieure pour l\'instant.</div>'
  for (const ts of versions) {
    const row = document.createElement('div')
    row.className = 'history-row'
    const [datePart, timePart] = ts.split('T')
    row.innerHTML = `<span>${datePart} ${timePart.split('-').slice(0, 3).join(':')}</span>`
    const btn = document.createElement('button')
    btn.className = 'secondary-btn'
    btn.textContent = 'Restaurer'
    btn.onclick = async () => {
      if (!confirm('Remplacer le contenu actuel par cette version ?')) return
      const { content } = await api(docApi(currentRoom, `/versions/${ts}/restore`), { method: 'POST' })
      editor?.commands.setContent(content, { emitUpdate: false })
      el('history-modal').classList.add('hidden')
      await refreshBacklinks(currentRoom)
    }
    row.appendChild(btn)
    list.appendChild(row)
  }
  el('history-modal').classList.remove('hidden')
}
el('history-close').onclick = () => el('history-modal').classList.add('hidden')

// --- Palette Cmd+K : récents, pages, contenu, actions ----------------------
const paletteOverlay = el('palette-overlay')
const paletteInput = el('palette-input')
const paletteResults = el('palette-results')
let paletteItems = []
let paletteSelected = 0
let paletteToken = 0

// Commandes (⌘P, comme la palette de commandes d'Obsidian) ; hint = raccourci affiché
function commandList() {
  const page = currentRoom && currentType !== 'trash' ? currentRoom : null
  const owner = currentRole === 'owner'
  return [
    { label: 'Nouvelle page', icon: 'page', hint: '⌘N', run: () => createPage({ type: 'doc' }) },
    { label: 'Nouveau dossier', icon: 'folder', run: () => createFolder(null) },
    { label: 'Nouveau whiteboard', icon: 'board', run: () => createPage({ type: 'board' }) },
    { label: 'Nouvelle base de données', icon: 'database', run: () => createPage({ type: 'database' }) },
    { label: 'Ouvrir une page…', icon: 'search', hint: '⌘O', run: () => openPalette('switch') },
    { label: 'Rechercher dans toutes les pages', icon: 'search', hint: '⌘⇧F', run: () => openPalette('search') },
    { label: 'Ouvrir le journal du jour', icon: 'calendar', run: openJournal },
    { label: 'Accès IA (MCP)…', icon: 'sparkle', run: openAiAccess },
    { label: 'Graphe des liens', icon: 'graph', run: openGraph },
    { label: 'Ouvrir la corbeille', icon: 'trash', run: () => openSpecialView('trash', { push: true }) },
    page ? { label: "Révéler la page dans l'explorateur", icon: 'folderOpen', run: () => revealInSidebar(page) } : null,
    page && inMacApp() ? { label: 'Afficher dans le Finder', icon: 'finder', run: () => revealInFinder(page) } : null,
    page && owner ? { label: 'Renommer la page', icon: 'rename', run: () => openRenameModal(page) } : null,
    page && owner ? { label: 'Déplacer la page vers…', icon: 'move', run: () => openMovePicker(page) } : null,
    page && currentType !== 'folder' ? { label: 'Dupliquer la page', icon: 'copy', run: async () => {
      await flushAll()
      const { newRoom } = await api(docApi(page, '/duplicate'), { method: 'POST' })
      navigateTo(newRoom)
    } } : null,
    page && owner ? { label: 'Déplacer la page dans la corbeille', icon: 'trash', run: () => trashPage(page) } : null,
    page ? { label: entryFor(page)?.favorite ? 'Retirer des favoris' : 'Ajouter aux favoris', icon: 'star', run: () => toggleFavorite(page, !entryFor(page)?.favorite) } : null,
    page && currentType === 'doc' ? { label: 'Exporter la page en .md', icon: 'download', run: exportCurrent } : null,
    page && currentType === 'doc' ? { label: 'Exporter la page en PDF', icon: 'download', run: exportPdf } : null,
    page ? { label: 'Historique des versions', icon: 'history', run: openHistory } : null,
    page ? { label: 'Commentaires', icon: 'message', hint: '⌘⇧M', run: () => comments?.toggle() } : null,
    { label: 'Importer des fichiers .md', icon: 'import', run: () => el('import-input').click() },
    { label: "Replier tout l'explorateur", icon: 'chevronUp', run: () => {
      lastEntries.filter((e) => lastEntries.some((c) => c.parent === e.room)).forEach((e) => collapsed.add(e.room))
      store.set('yariche-collapsed', [...collapsed])
      renderSidebar()
    } },
    { label: "Déplier tout l'explorateur", icon: 'chevronDown', run: () => {
      collapsed.clear()
      store.set('yariche-collapsed', [])
      renderSidebar()
    } },
    { label: 'Changer de dossier de travail…', icon: 'folderOpen', run: () => vaultUI?.openModal() },
    me?.ai ? { label: aiGhostOn() ? 'Désactiver la complétion IA' : 'Activer la complétion IA', icon: 'sparkle', run: toggleAiGhost } : null,
    vaultUI?.info?.remote ? { label: 'Synchroniser avec Nextcloud maintenant', icon: 'refresh', run: () => vaultUI.syncNow() } : null,
    { label: 'Basculer thème clair / sombre', icon: 'sun', run: toggleTheme },
    { label: 'Afficher / masquer la barre latérale', icon: 'sidebar', hint: '⌘\\', run: () => setSidebarCollapsed(!app.classList.contains('sidebar-collapsed')) },
    { label: 'Pleine largeur', icon: 'widen', run: () => setFullWidth(!app.classList.contains('full-width')) },
    { label: 'Raccourcis clavier', icon: 'textAa', hint: '⌘/', run: openShortcutsHelp },
  ].filter(Boolean)
}

const rtf = new Intl.RelativeTimeFormat('fr', { numeric: 'auto' })
function relTime(ts) {
  const s = Math.round((ts - Date.now()) / 1000)
  if (s > -60) return "à l'instant"
  if (s > -3600) return rtf.format(Math.round(s / 60), 'minute')
  if (s > -86400) return rtf.format(Math.round(s / 3600), 'hour')
  return rtf.format(Math.round(s / 86400), 'day')
}

const normalize = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')

function highlight(text, q) {
  if (!q) return escapeHTML(text)
  const i = normalize(text).indexOf(normalize(q))
  if (i === -1) return escapeHTML(text)
  return `${escapeHTML(text.slice(0, i))}<mark>${escapeHTML(text.slice(i, i + q.length))}</mark>${escapeHTML(text.slice(i + q.length))}`
}

function drawPalette(groups, q) {
  paletteResults.innerHTML = ''
  paletteItems = []
  for (const g of groups) {
    if (!g.items.length) continue
    paletteResults.insertAdjacentHTML('beforeend', `<div class="palette-group">${g.title}</div>`)
    for (const item of g.items) {
      const idx = paletteItems.length
      const row = document.createElement('div')
      row.className = 'palette-item'
      row.innerHTML = `<span class="palette-icon">${item.iconHTML}</span><span class="palette-text"><span class="palette-label">${highlight(item.label, q)}</span>${item.snippet ? `<span class="palette-snippet">${highlight(item.snippet, q)}</span>` : ''}</span>${item.meta ? `<span class="palette-meta">${escapeHTML(item.meta)}</span>` : ''}`
      row.onmouseenter = () => selectPalette(idx, false)
      row.onclick = () => runPalette(idx)
      paletteResults.appendChild(row)
      paletteItems.push({ ...item, row })
    }
  }
  if (!paletteItems.length) paletteResults.innerHTML = '<div class="empty-hint palette-empty">Aucun résultat</div>'
  selectPalette(0)
}
function selectPalette(idx, scroll = true) {
  paletteSelected = idx
  paletteItems.forEach((it, i) => it.row.classList.toggle('selected', i === idx))
  if (scroll) paletteItems[idx]?.row.scrollIntoView({ block: 'nearest' })
}
function runPalette(idx) {
  const item = paletteItems[idx]
  if (!item) return
  closePalette()
  item.run()
}
const pageItem = (entry, extra = {}) => ({
  label: nameOf(entry.room),
  iconHTML: pageIconHTML(entry, 18),
  run: () => navigateTo(entry.room),
  ...extra,
})

// Modes de la palette : null (tout), switch (⌘O, pages), commands (⌘P),
// search (⌘⇧F, contenu), move (« Déplacer vers… »)
let paletteMode = null
function openMovePicker(room) {
  openPalette({ kind: 'move', room })
}

async function renderPaletteResults(query) {
  const q = query.trim()
  const token = ++paletteToken
  // Dossier d'un élément, lisible : « R521 / Concepts »
  const pathLabel = (entry) => (entry.room?.includes('/') ? entry.room.slice(0, entry.room.lastIndexOf('/')).split('/').join(' / ') : '')
  const cmdItems = (list) => list.map((c) => ({ ...c, iconHTML: icon(c.icon, 18), meta: c.hint || '' }))
  if (paletteMode?.kind === 'commands') {
    const nq = normalize(q)
    drawPalette([{ title: 'Commandes', items: cmdItems(commandList().filter((c) => normalize(c.label).includes(nq))) }], q)
    return
  }
  if (paletteMode?.kind === 'switch') {
    const nq = normalize(q)
    const recents = store.get('yariche-recent', []).map((r) => entryFor(r.room)).filter(Boolean)
    // Recherche sur le chemin entier (« r521 mimo »), les noms qui correspondent d'abord
    const rank = (e) => {
      const i = normalize(nameOf(e.room)).indexOf(nq)
      return i >= 0 ? i : 1000 + normalize(e.room).indexOf(nq)
    }
    const ordered = q ? lastEntries.filter((e) => normalize(e.room).includes(nq)).sort((a, b) => rank(a) - rank(b) || byTree(a, b)) : [...recents, ...lastEntries.filter((e) => !recents.includes(e)).sort(byTree)]
    const items = ordered.slice(0, 50).map((e) => pageItem(e, { meta: pathLabel(e) }))
    if (q && !lastEntries.some((e) => normalize(nameOf(e.room)) === nq) && !/[/\\]/.test(q) && !q.startsWith('.')) {
      items.push({ label: `Créer « ${q} »`, iconHTML: icon('plus', 18), run: () => createPage({ name: q, parent: defaultNewParent() }) })
    }
    drawPalette([{ title: q ? 'Pages' : 'Pages récentes et toutes les pages', items }], q)
    return
  }
  if (paletteMode?.kind === 'search') {
    if (!q) {
      paletteResults.innerHTML = '<div class="empty-hint palette-empty">Tape un mot : la recherche porte sur le contenu de toutes les pages et des lignes de base.</div>'
      paletteItems = []
      return
    }
    const hits = await api(`/api/search?q=${encodeURIComponent(q)}`).catch(() => [])
    if (token !== paletteToken) return
    drawPalette([{ title: `Résultats (${hits.length})`, items: hits.map((h) => (h.rowId
      ? { label: h.label, iconHTML: icon('page', 18), snippet: `${nameOf(h.room)} · ${h.snippet}`, run: () => navigateTo(h.room, { row: h.rowId }) }
      : pageItem(h, { snippet: h.snippet, meta: pathLabel(entryFor(h.room) || {}) }))) }], q)
    return
  }
  if (paletteMode?.kind === 'move') {
    const room = paletteMode.room
    const nq = normalize(q)
    const current = entryFor(room)?.parent || null
    const targets = lastEntries
      .filter((e) => e.room !== room && !isInside(e.room, room) && e.room !== current && normalize(e.room).includes(nq))
      .sort(byTree)
      .slice(0, 40)
    const items = targets.map((e) => ({
      label: nameOf(e.room),
      iconHTML: isFolder(e) ? icon('folder', 18) : pageIconHTML(e, 18),
      meta: pathLabel(e),
      run: () => movePage(room, e.room),
    }))
    const root = current && (!q || normalize('racine pages').includes(nq))
      ? [{ label: 'Racine (Pages)', iconHTML: icon('arrowUp', 18), run: () => movePage(room, null) }]
      : []
    drawPalette([{ title: 'Destination', items: [...root, ...items] }], q)
    return
  }
  if (!q) {
    const recents = store
      .get('yariche-recent', [])
      .map((r) => ({ ...r, entry: entryFor(r.room) }))
      .filter((r) => r.entry)
      .slice(0, 6)
    drawPalette(
      [
        { title: 'Récents', items: recents.map((r) => pageItem(r.entry, { meta: relTime(r.at) })) },
        { title: 'Commandes', items: cmdItems(commandList().slice(0, 6)) },
      ],
      ''
    )
    return
  }
  const nq = normalize(q)
  const pages = lastEntries.filter((e) => normalize(e.room).includes(nq)).slice(0, 8)
  const actions = cmdItems(commandList().filter((a) => normalize(a.label).includes(nq)))
  const groups = [
    { title: 'Pages', items: pages.map((e) => pageItem(e)) },
    { title: 'Actions', items: actions },
  ]
  drawPalette(groups, q)
  const hits = await api(`/api/search?q=${encodeURIComponent(q)}`).catch(() => [])
  if (token !== paletteToken) return
  const inTitles = new Set(pages.map((p) => p.room))
  const content = hits
    .filter((h) => h.rowId || !inTitles.has(h.room))
    .map((h) =>
      h.rowId
        ? {
            label: h.label,
            iconHTML: icon('page', 18),
            snippet: `${nameOf(h.room)} · ${h.snippet}`,
            run: () => navigateTo(h.room, { row: h.rowId }),
          }
        : pageItem(h, { snippet: h.snippet })
    )
  if (!content.length) return
  const selected = paletteSelected
  drawPalette([groups[0], { title: 'Dans le contenu', items: content }, groups[1]], q)
  selectPalette(Math.min(selected, paletteItems.length - 1), false)
}

const PALETTE_PLACEHOLDERS = {
  switch: 'Ouvrir une page…',
  commands: 'Taper une commande…',
  search: 'Rechercher dans toutes les pages…',
}
function openPalette(mode = null) {
  paletteMode = typeof mode === 'string' ? { kind: mode } : mode
  paletteInput.placeholder =
    paletteMode?.kind === 'move'
      ? `Déplacer « ${nameOf(paletteMode.room)} » vers…`
      : PALETTE_PLACEHOLDERS[paletteMode?.kind] || 'Rechercher une page ou taper une commande…'
  paletteOverlay.classList.remove('hidden')
  paletteInput.value = ''
  renderPaletteResults('')
  paletteInput.focus()
}
function closePalette() {
  paletteOverlay.classList.add('hidden')
  paletteMode = null
  paletteInput.placeholder = 'Rechercher une page ou taper une commande…'
}
let paletteDebounce = null
paletteInput.oninput = () => {
  clearTimeout(paletteDebounce)
  paletteDebounce = setTimeout(() => renderPaletteResults(paletteInput.value), 120)
}
paletteInput.onkeydown = (e) => {
  if (e.key === 'Escape') return closePalette()
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    selectPalette(Math.min(paletteSelected + 1, paletteItems.length - 1))
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    selectPalette(Math.max(paletteSelected - 1, 0))
  } else if (e.key === 'Enter') {
    e.preventDefault()
    clearTimeout(paletteDebounce)
    runPalette(paletteSelected)
  }
}
paletteOverlay.addEventListener('mousedown', (e) => {
  if (e.target === paletteOverlay) closePalette()
})

// --- Vues sans page : écran vide (façon Obsidian) et Corbeille (façon AFFiNE) ---
function setURL(params, push) {
  const url = new URL(location.href)
  url.search = ''
  for (const [k, v] of Object.entries(params)) if (v) url.searchParams.set(k, v)
  history[push ? 'pushState' : 'replaceState']({}, '', url)
}

function openSpecialView(kind, { push = false } = {}) {
  destroyCurrent()
  currentRoom = null
  currentType = kind
  currentRole = null
  setURL(kind === 'trash' ? { view: 'trash' } : {}, push)
  document.title = kind === 'trash' ? 'Corbeille · Yariche' : 'Yariche'
  // Aucune page connectée en temps réel : le serveur, lui, vient de répondre
  connStatus.textContent = 'en ligne'
  connStatus.className = 'conn-status online'
  showView(kind)
  el('trash-banner').classList.add('hidden')
  el('comments-panel').classList.add('hidden')
  app.classList.remove('panel-open')
  updateCommentsCount(0)
  renderSidebar()
  renderBreadcrumb()
  setStatusPath(kind === 'trash' ? '.trash/' : '')
  renderProperties('')
  setStatusCounts({ backlinks: null, words: null, chars: null })
  applyMode()
  if (kind === 'trash') renderTrashView({ refetch: true })
  else renderEmptyView()
}

// Sans page précise : la dernière consultée, sinon la première, sinon l'écran vide.
// (Plus de page « accueil » recréée d'office à chaque ouverture.)
function openLanding({ push = false } = {}) {
  if (me?.guest && me.shareRoot) {
    setURL({ doc: me.shareRoot }, push)
    return loadRoom(me.shareRoot)
  }
  const recent = store
    .get('yariche-recent', [])
    .map((r) => entryFor(r.room))
    .find((e) => e && !isFolder(e))
  const target = recent || [...lastEntries].filter((e) => !isFolder(e)).sort(byTree)[0]
  if (target) {
    setURL({ doc: target.room }, push)
    return loadRoom(target.room)
  }
  openSpecialView('empty', { push })
}

function renderEmptyView() {
  const view = el('special-view')
  view.innerHTML = `<div class="empty-view">
    <div class="ev-logo">Y</div>
    <h1>Aucune page ouverte</h1>
    <p>${lastEntries.length ? 'Ouvre une page depuis la barre latérale, ou :' : 'Ton espace est vide. Pour commencer :'}</p>
    <div class="ev-actions">
      <button data-ev="new">${icon('page', 16)}<span>Créer une page</span><kbd>⌘N</kbd></button>
      <button data-ev="open">${icon('search', 16)}<span>Ouvrir une page</span><kbd>⌘O</kbd></button>
      <button data-ev="folder">${icon('folder', 16)}<span>Créer un dossier</span></button>
      <button data-ev="journal">${icon('calendar', 16)}<span>Journal du jour</span></button>
      <button data-ev="import">${icon('import', 16)}<span>Importer des fichiers .md</span></button>
    </div>
  </div>`
  const act = {
    new: () => createPage(),
    open: () => openPalette('switch'),
    folder: () => createFolder(null),
    journal: openJournal,
    import: () => el('import-input').click(),
  }
  view.querySelectorAll('[data-ev]').forEach((b) => (b.onclick = act[b.dataset.ev]))
}

function renderTrashBanner(room, trashed, role) {
  const banner = el('trash-banner')
  banner.classList.toggle('hidden', !trashed)
  if (!trashed) return
  const owner = role === 'owner'
  banner.innerHTML = `${icon('trash', 16)}<span>Cette page est dans la corbeille.</span>${
    owner
      ? `<button class="banner-btn" data-restore>Restaurer la page</button><button class="banner-btn danger" data-forever>Supprimer définitivement</button>`
      : ''
  }`
  banner.querySelector('[data-restore]')?.addEventListener('click', () => restorePage(room))
  banner.querySelector('[data-forever]')?.addEventListener('click', () => deleteForever([room], { leave: true }))
}

let trashItems = []
let trashSelection = new Set()
let trashQuery = ''
async function renderTrashView({ refetch = false } = {}) {
  if (refetch || !trashItems) trashItems = (await api('/api/trash').catch(() => [])).sort((a, b) => b.deletedAt - a.deletedAt)
  if (currentType !== 'trash') return
  trashSelection = new Set([...trashSelection].filter((r) => trashItems.some((i) => i.room === r)))
  const view = el('special-view')
  const count = trashItems.length
  view.innerHTML = `<div class="trash-view">
    <div class="tv-head">
      <div class="tv-icon">${icon('trash', 24)}</div>
      <div>
        <h1>Corbeille</h1>
        <p class="tv-sub">${count ? `${count} élément${count > 1 ? 's' : ''} · rien n'est effacé tant que tu ne supprimes pas définitivement` : 'Rien à la corbeille'}</p>
      </div>
    </div>
    ${count ? `<div class="tv-toolbar">
      <label class="tv-check" title="Tout sélectionner"><input type="checkbox" data-all /></label>
      <div class="tv-search">${icon('search', 16)}<input placeholder="Rechercher dans la corbeille…" /></div>
      <span class="topbar-spacer"></span>
      <button class="secondary-btn" data-bulk="restore">${icon('undo', 14)}<span>Restaurer</span></button>
      <button class="danger-btn" data-bulk="delete">Supprimer</button>
      <button class="danger-btn subtle" data-empty>Vider la corbeille</button>
    </div>` : ''}
    <div class="tv-list"></div>
  </div>`
  const search = view.querySelector('.tv-search input')
  if (search) {
    search.value = trashQuery
    search.oninput = () => {
      trashQuery = search.value
      drawTrashList()
    }
  }
  view.querySelector('[data-all]')?.addEventListener('change', (e) => {
    const shown = filteredTrash()
    shown.forEach((i) => (e.target.checked ? trashSelection.add(i.room) : trashSelection.delete(i.room)))
    drawTrashList()
  })
  view.querySelector('[data-bulk="restore"]')?.addEventListener('click', async () => {
    const rooms = [...trashSelection]
    for (const room of rooms) await api(docApi(room, '/restore'), { method: 'POST' }).catch(() => {})
    toast(`${rooms.length} élément${rooms.length > 1 ? 's' : ''} restauré${rooms.length > 1 ? 's' : ''}`)
    trashSelection.clear()
    await refreshPageList()
    renderTrashView({ refetch: true })
  })
  view.querySelector('[data-bulk="delete"]')?.addEventListener('click', async () => {
    await deleteForever([...trashSelection])
    trashSelection.clear()
  })
  view.querySelector('[data-empty]')?.addEventListener('click', async () => {
    if (!confirm(`Vider la corbeille ? ${count} élément${count > 1 ? 's' : ''} et leur contenu seront effacés du disque, c'est irréversible.`)) return
    const { deleted } = await api('/api/trash/empty', { method: 'POST' })
    toast(`Corbeille vidée (${deleted} élément${deleted > 1 ? 's' : ''})`)
    trashSelection.clear()
    await refreshPageList()
    renderTrashView({ refetch: true })
  })
  drawTrashList()
}

function filteredTrash() {
  const q = normalize(trashQuery)
  return trashItems.filter((i) => normalize(`${i.name || i.room} ${(i.path || []).join(' ')}`).includes(q))
}

function drawTrashList() {
  const view = el('special-view')
  const list = view.querySelector('.tv-list')
  if (!list) return
  const shown = filteredTrash()
  const all = view.querySelector('[data-all]')
  if (all) all.checked = shown.length > 0 && shown.every((i) => trashSelection.has(i.room))
  view.querySelectorAll('[data-bulk]').forEach((b) => (b.disabled = !trashSelection.size))
  const restoreBtn = view.querySelector('[data-bulk="restore"] span')
  if (restoreBtn) restoreBtn.textContent = trashSelection.size ? `Restaurer (${trashSelection.size})` : 'Restaurer'
  const deleteBtn = view.querySelector('[data-bulk="delete"]')
  if (deleteBtn) deleteBtn.textContent = trashSelection.size ? `Supprimer (${trashSelection.size})` : 'Supprimer'
  list.innerHTML = ''
  if (!trashItems.length) {
    list.innerHTML = `<div class="tv-empty">${icon('trash', 40)}<p>La corbeille est vide</p><span>Pour y envoyer une page : glisse-la sur « Corbeille » dans la barre latérale, ou menu « … » → Déplacer dans la corbeille.</span></div>`
    return
  }
  if (!shown.length) {
    list.innerHTML = '<div class="empty-hint tv-none">Aucun élément ne correspond.</div>'
    return
  }
  const typeLabel = { folder: 'Dossier', board: 'Whiteboard', database: 'Base de données', doc: 'Page' }
  for (const it of shown) {
    const row = document.createElement('div')
    row.className = 'tv-row' + (trashSelection.has(it.room) ? ' selected' : '')
    const where = it.path?.length ? it.path.join(' / ') : 'Racine'
    row.innerHTML = `<label class="tv-check"><input type="checkbox" ${trashSelection.has(it.room) ? 'checked' : ''} /></label>
      <span class="tv-row-icon">${it.type === 'folder' && !it.icon ? icon('folder', 18) : pageIconHTML(it, 18)}</span>
      <span class="tv-main">
        <span class="tv-name">${escapeHTML(it.name || nameOf(it.room))}</span>
        <span class="tv-where">${typeLabel[it.type] || 'Page'} · était dans ${icon('folder', 12)}<b>${escapeHTML(where)}</b>${it.children ? ` · avec ${it.children} élément${it.children > 1 ? 's' : ''}` : ''}</span>
      </span>
      <span class="tv-date" title="${escapeHTML(new Date(it.deletedAt).toLocaleString('fr-FR'))}">supprimé ${relTime(it.deletedAt)}</span>
      <span class="tv-actions">
        <button class="tv-restore" title="Restaurer">${icon('undo', 16)}<span>Restaurer</span></button>
        <button class="tv-delete" title="Supprimer définitivement">${icon('trash', 16)}</button>
      </span>`
    row.querySelector('input').onchange = (e) => {
      if (e.target.checked) trashSelection.add(it.room)
      else trashSelection.delete(it.room)
      drawTrashList()
    }
    row.querySelector('.tv-restore').onclick = (e) => {
      e.stopPropagation()
      restorePage(it.room)
    }
    row.querySelector('.tv-delete').onclick = (e) => {
      e.stopPropagation()
      deleteForever([it.room])
    }
    // Clic sur la ligne : aperçu de la page (lecture seule, avec le bandeau Restaurer)
    row.onclick = (e) => {
      if (e.target.closest('label, button')) return
      navigateTo(it.room)
    }
    list.appendChild(row)
  }
}

// « Corbeille » dans la barre latérale : ouvre la vue, et accepte le glisser-déposer
const trashNav = el('trash-toggle')
trashNav.onclick = () => openSpecialView('trash', { push: true })
trashNav.addEventListener('dragover', (e) => {
  if (!draggedRoom) return
  e.preventDefault()
  trashNav.classList.add('drop-trash')
})
trashNav.addEventListener('dragleave', () => trashNav.classList.remove('drop-trash'))
trashNav.addEventListener('drop', (e) => {
  e.preventDefault()
  trashNav.classList.remove('drop-trash')
  const room = e.dataTransfer.getData('application/x-yariche-page')
  if (room) trashPage(room)
})

// Fermer une modale en cliquant sur le fond
document.querySelectorAll('.modal-overlay').forEach((o) =>
  o.addEventListener('mousedown', (e) => {
    if (e.target === o) o.classList.add('hidden')
  })
)

// --- Raccourcis clavier globaux --------------------------------------------
const SHORTCUTS = [
  ['Navigation', [
    ['⌘O', 'Ouvrir une page (sélecteur rapide, comme Obsidian)'],
    ['⌘⇧O', 'Ouvrir / changer de coffre'],
    ['⌘J', "Assistant IA sur la sélection ou le curseur"],
    ['⌘P', 'Palette de commandes'],
    ['⌘K', 'Rechercher une page ou une commande'],
    ['⌘⇧F', 'Rechercher dans le contenu de toutes les pages'],
    ['⌥⌘← / ⌥⌘→', 'Page précédente / suivante'],
    ['⌘\\', 'Afficher / masquer la barre latérale'],
    ['⌘E', 'Basculer lecture / édition'],
  ]],
  ['Pages', [
    ['⌘N  (⌥⌘N dans un navigateur)', 'Nouvelle page'],
    ['⌘⇧M', 'Commenter la sélection / panneau des commentaires'],
    ['⌘/', 'Cette aide'],
  ]],
  ['Édition', [
    ['/', 'Menu des blocs'],
    ['@', 'Mentionner une personne, une page, une date'],
    ['[[', 'Lien vers une page'],
    ['⌘B · ⌘I · ⌘⇧S · `code`', 'Gras · italique · barré · code'],
    ['⌘⇧H', 'Surligner'],
    ['⌘⇧↑ / ⌘⇧↓', 'Monter / descendre le bloc'],
    ['Tab / ⇧Tab', 'Indenter (listes, code)'],
  ]],
]
function openShortcutsHelp() {
  let overlay = el('shortcuts-modal')
  if (!overlay) {
    overlay = document.createElement('div')
    overlay.id = 'shortcuts-modal'
    overlay.className = 'modal-overlay'
    overlay.innerHTML = `<div class="modal shortcuts-modal"><div class="modal-header"><span>Raccourcis clavier</span><button class="icon-btn" data-close>✕</button></div><div class="modal-section shortcuts-body">${SHORTCUTS.map(
      ([title, rows]) => `<div class="sc-group"><div class="sc-title">${title}</div>${rows.map(([k, d]) => `<div class="sc-row"><span>${escapeHTML(d)}</span><kbd>${escapeHTML(k)}</kbd></div>`).join('')}</div>`
    ).join('')}</div></div>`
    overlay.addEventListener('mousedown', (e) => {
      if (e.target === overlay || e.target.closest('[data-close]')) overlay.classList.add('hidden')
    })
    app.appendChild(overlay)
  }
  overlay.classList.remove('hidden')
}

window.addEventListener('keydown', (e) => {
  const mod = e.metaKey || e.ctrlKey
  // Invité : pas de palette, de création ni de recherche (seulement ⌘E et ⌘\)
  if (me?.guest && mod && !['KeyE', 'Backslash'].includes(e.code)) return
  // Raccourcis façon Obsidian (e.code : indépendant de la disposition du clavier et de ⌥)
  if (mod && !e.shiftKey && !e.altKey && e.code === 'KeyO') {
    e.preventDefault()
    return openPalette('switch')
  }
  // ⌘J : assistant IA dans l'éditeur (sélection ou curseur)
  if (mod && !e.shiftKey && !e.altKey && e.code === 'KeyJ' && editor?.isFocused) {
    e.preventDefault()
    return openAiInline()
  }
  // ⌘⇧O : ouvrir / changer de coffre (menu du nom du coffre)
  if (mod && e.shiftKey && !e.altKey && e.code === 'KeyO') {
    e.preventDefault()
    const anchor = el('vault-switcher')
    if (vaultUI && anchor) vaultUI.openSwitcher(anchor)
    return
  }
  if (mod && !e.shiftKey && !e.altKey && e.code === 'KeyP') {
    e.preventDefault()
    return openPalette('commands')
  }
  if (mod && e.shiftKey && !e.altKey && e.code === 'KeyF') {
    e.preventDefault()
    return openPalette('search')
  }
  if (mod && !e.shiftKey && e.code === 'KeyN') {
    e.preventDefault()
    return createPage({ parent: defaultNewParent() })
  }
  if (mod && e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
    e.preventDefault()
    return e.key === 'ArrowLeft' ? history.back() : history.forward()
  }
  if (mod && !e.altKey && (e.key === '/' || e.code === 'Slash')) {
    e.preventDefault()
    return openShortcutsHelp()
  }
  if (mod && e.key.toLowerCase() === 'k') {
    e.preventDefault()
    // Dans le texte avec une sélection : ⌘K = lien (comme Notion/AFFiNE)
    if (editor?.isFocused && !editor.state.selection.empty) return promptLink()
    if (paletteOverlay.classList.contains('hidden')) openPalette()
    else closePalette()
  } else if (mod && e.shiftKey && e.key.toLowerCase() === 'm') {
    // Comme Notion : commenter la sélection, sinon ouvrir/fermer le panneau
    e.preventDefault()
    if (editor?.isFocused && !editor.state.selection.empty && comments?.startFromSelection()) return
    comments?.toggle()
  } else if (mod && e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && editor?.isFocused) {
    e.preventDefault()
    const pos = editor.state.selection.$from.before(1)
    moveBlock(pos, e.key === 'ArrowUp' ? -1 : 1)
  } else if (mod && e.key === '\\') {
    e.preventDefault()
    setSidebarCollapsed(!app.classList.contains('sidebar-collapsed'))
  } else if (e.key === 'Escape') {
    closeMenus()
    document.querySelectorAll('.modal-overlay:not(.hidden)').forEach((m) => m.classList.add('hidden'))
    el('emoji-picker').classList.add('hidden')
    coverPicker.classList.add('hidden')
  }
})

function routeFromURL() {
  const params = new URLSearchParams(location.search)
  if (params.get('view') === 'trash') return openSpecialView('trash')
  const doc = params.get('doc')
  return doc ? loadRoom(doc) : openLanding()
}
window.addEventListener('popstate', routeFromURL)

// --- Vue d'un dossier : son contenu, comme une page de sous-pages ---------------
function renderFolderView() {
  const view = el('folder-view')
  const items = lastEntries.filter((e) => e.parent === currentRoom).sort(byTree)
  const editable = currentRole === 'owner' || currentRole === 'editor'
  view.innerHTML = `${editable ? `<div class="folder-actions">
      <button class="secondary-btn" data-new="doc">${icon('page', 14)}<span>Nouvelle page</span></button>
      <button class="secondary-btn" data-new="folder">${icon('folder', 14)}<span>Nouveau dossier</span></button>
      <button class="secondary-btn" data-new="database">${icon('database', 14)}<span>Base de données</span></button>
      <button class="secondary-btn" data-new="board">${icon('board', 14)}<span>Whiteboard</span></button>
    </div>` : ''}
    <div class="folder-list">${items.length ? '' : '<div class="empty-hint folder-empty">Ce dossier est vide. Tu peux aussi y glisser des pages depuis la barre latérale.</div>'}</div>`
  const list = view.querySelector('.folder-list')
  const typeLabel = { folder: 'Dossier', board: 'Whiteboard', database: 'Base de données', doc: 'Page' }
  for (const e of items) {
    const count = lastEntries.filter((x) => x.parent === e.room).length
    const row = document.createElement('button')
    row.className = 'folder-item'
    row.innerHTML = `<span class="folder-item-icon">${isFolder(e) && !e.icon ? icon('folder', 20) : pageIconHTML(e, 20)}</span><span class="folder-item-name">${escapeHTML(nameOf(e.room))}</span><span class="folder-item-meta">${typeLabel[e.type] || 'Page'}${count ? ` · ${count} élément${count > 1 ? 's' : ''}` : ''}</span>`
    row.onclick = () => navigateTo(e.room)
    list.appendChild(row)
  }
  view.querySelectorAll('[data-new]').forEach((b) =>
    b.addEventListener('click', () => (b.dataset.new === 'folder' ? createFolder(currentRoom) : createPage({ type: b.dataset.new, parent: currentRoom })))
  )
}

// --- Commentaires : bouton, compteur -----------------------------------------
function updateCommentsCount(n) {
  const badge = el('comments-count')
  badge.textContent = n > 99 ? '99+' : String(n)
  badge.classList.toggle('hidden', !n)
}
el('comments-btn').onclick = () => comments?.toggle()
el('comments-close').onclick = () => comments?.close()

// --- Menu de bloc (clic sur la poignée ⋮⋮, comme Notion) -----------------------
const TURN_KINDS = [
  ['p', 'Texte', 'text'],
  ['h1', 'Titre 1', 'heading'],
  ['h2', 'Titre 2', 'heading'],
  ['h3', 'Titre 3', 'heading'],
  ['bullet', 'Liste à puces', 'bullets'],
  ['ordered', 'Liste numérotée', 'numbers'],
  ['task', 'Liste de tâches', 'todo'],
  ['quote', 'Citation', 'quote'],
  ['code', 'Bloc de code', 'code'],
]
function selectBlockContent(pos) {
  const node = editor.state.doc.nodeAt(pos)
  if (!node) return false
  const from = pos + 1
  const to = pos + node.nodeSize - 1
  if (to <= from) return false
  editor.view.dispatch(editor.state.tr.setSelection(TextSelection.between(editor.state.doc.resolve(from), editor.state.doc.resolve(to))))
  return true
}
function moveBlock(pos, dir) {
  const { state, view } = editor
  const $pos = state.doc.resolve(pos)
  const index = $pos.index(0)
  const node = state.doc.child(index)
  if (dir < 0 && index === 0) return
  if (dir > 0 && index >= state.doc.childCount - 1) return
  const neighbour = state.doc.child(index + dir)
  let tr = state.tr.delete(pos, pos + node.nodeSize)
  const target = dir < 0 ? pos - neighbour.nodeSize : pos + neighbour.nodeSize
  tr = tr.insert(target, node)
  tr = tr.setSelection(TextSelection.near(tr.doc.resolve(target + 1)))
  view.dispatch(tr.scrollIntoView())
  view.focus()
}
function openBlockMenu(pos, anchor) {
  if (!editor) return
  const node = editor.state.doc.nodeAt(pos)
  if (!node) return
  const items = [
    comments?.canComment && node.textContent.trim()
      ? { label: 'Commenter', icon: 'message', run: () => selectBlockContent(pos) && comments.startFromSelection() }
      : null,
    {
      label: 'Dupliquer',
      icon: 'copy',
      run: () => editor.chain().insertContentAt(pos + node.nodeSize, node.toJSON()).run(),
    },
    { label: 'Monter', icon: 'chevronUp', hint: '⌘⇧↑', run: () => moveBlock(pos, -1) },
    { label: 'Descendre', icon: 'chevronDown', hint: '⌘⇧↓', run: () => moveBlock(pos, 1) },
    { label: 'Copier le texte', icon: 'copy', run: () => navigator.clipboard?.writeText(node.textContent).then(() => toast('Texte copié')) },
    'sep',
    { header: 'Transformer en' },
    ...TURN_KINDS.map(([kind, label, ic]) => ({
      label,
      icon: ic,
      run: () => {
        if (selectBlockContent(pos) || node.isTextblock) turnInto(kind)
      },
    })),
    'sep',
    {
      label: 'Supprimer',
      icon: 'trash',
      danger: true,
      run: () => editor.chain().focus().deleteRange({ from: pos, to: pos + node.nodeSize }).run(),
    },
  ]
  showMenu(anchor, items)
}

// --- Boîte de réception ---------------------------------------------------------
let inboxItems = []
async function refreshInbox() {
  try {
    const { items, unread } = await api('/api/notifications')
    inboxItems = items
    const badge = el('inbox-badge')
    badge.textContent = unread > 99 ? '99+' : String(unread)
    badge.classList.toggle('hidden', !unread)
    postNative({ type: 'badge', count: unread })
    if (!el('inbox-panel').classList.contains('hidden')) renderInbox()
  } catch {
    /* hors ligne : on réessaiera */
  }
}
function renderInbox() {
  const list = el('inbox-list')
  list.innerHTML = inboxItems.length ? '' : '<div class="empty-hint inbox-empty">Rien pour le moment. Tu verras ici les @mentions et les réponses à tes commentaires.</div>'
  for (const n of inboxItems) {
    const item = document.createElement('button')
    item.className = 'inbox-item' + (n.read ? '' : ' unread')
    const what =
      n.type === 'reply'
        ? 'a répondu à un commentaire'
        : n.kind === 'comment'
          ? "t'a mentionné dans un commentaire"
          : n.kind === 'row'
            ? "t'a mentionné dans une ligne"
            : "t'a mentionné"
    item.innerHTML = `<span class="avatar-chip" style="background:${avatarColor(n.from?.email)}">${escapeHTML((n.from?.name || '?')[0].toUpperCase())}</span>
      <span class="inbox-main"><span class="inbox-line"><b>${escapeHTML(n.from?.name || 'Quelqu’un')}</b> ${what} · <span class="inbox-room" title="${escapeHTML(n.room)}">${escapeHTML(nameOf(n.room))}</span></span>
      ${n.excerpt ? `<span class="inbox-excerpt">${escapeHTML(n.excerpt)}</span>` : ''}
      <span class="inbox-time">${relTime(n.createdAt)}</span></span>${n.read ? '' : '<i class="unread-dot"></i>'}`
    item.onclick = async () => {
      el('inbox-panel').classList.add('hidden')
      if (!n.read) await api('/api/notifications/read', { method: 'POST', body: JSON.stringify({ ids: [n.id] }) }).catch(() => {})
      navigateTo(n.room, { thread: n.threadId, row: n.rowId })
      refreshInbox()
    }
    list.appendChild(item)
  }
}
el('inbox-btn').onclick = (e) => {
  e.stopPropagation()
  const panel = el('inbox-panel')
  const opening = panel.classList.contains('hidden')
  panel.classList.toggle('hidden', !opening)
  if (opening) {
    const r = el('inbox-btn').getBoundingClientRect()
    panel.style.left = `${r.right + 8}px`
    panel.style.top = `${Math.max(8, r.top - 8)}px`
    renderInbox()
    refreshInbox()
  }
}
el('inbox-read-all').onclick = async () => {
  await api('/api/notifications/read', { method: 'POST', body: JSON.stringify({}) }).catch(() => {})
  refreshInbox()
}
document.addEventListener('mousedown', (e) => {
  if (!e.target.closest('#inbox-panel, #inbox-btn')) el('inbox-panel').classList.add('hidden')
})

async function boot() {
  await loadMe()
  if (me.guest) {
    // Invité : le document partagé (et ses sous-pages), rien d'autre
    await refreshPageList()
    await routeFromURL()
    setInterval(() => document.visibilityState === 'visible' && refreshPageList().catch(() => {}), 15000)
    return
  }
  const onboarding = createOnboarding({ api, toast })
  vaultUI = createVaultUI({ api, toast, showMenu, onboarding })
  // Premier lancement : connexion à Nextcloud et choix du dossier avant tout
  vaultUI
    .refresh()
    .then((info) => info?.setup?.step && onboarding.show(info))
    .catch(() => {})
  // État de la synchro Nextcloud (et coffre changé ailleurs → rechargement)
  setInterval(() => document.visibilityState === 'visible' && vaultUI.refresh().catch(() => {}), 10000)
  el('vault-switcher').onclick = (e) => {
    e.stopPropagation()
    vaultUI.openSwitcher(e.currentTarget)
  }
  await loadUsers()
  await refreshPageList()
  await routeFromURL()
  refreshInbox()
  setInterval(refreshInbox, 30000)
  // Fichiers ajoutés, déplacés ou supprimés ailleurs (Nextcloud, Obsidian, Finder)
  setInterval(() => document.visibilityState === 'visible' && refreshPageList().catch(() => {}), 15000)
  setInterval(loadUsers, 5 * 60000)
  window.addEventListener('focus', refreshInbox)
}
boot()
