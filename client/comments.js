// Commentaires façon Notion / AFFiNE : fils ancrés sur un passage, ou sur la page.
//
// Ancrage : on ne touche pas au markdown (le .md reste propre). Chaque fil garde la
// citation + un peu de contexte avant/après ; on la retrouve dans le texte courant
// (approche "text quote selector" du W3C). Ça survit aux redémarrages serveur et aux
// modifications externes du fichier, et un passage supprimé donne un fil "détaché".
//
// État vivant : Y.Map "comments" du document Yjs de la page (temps réel entre
// clients) ; persistance : data/<page>.comments.json via l'API.
import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { attachMentionPicker, extractMentions, avatarColor } from './suggest-menu.js'
import { icon } from './icons.js'

export const commentsKey = new PluginKey('comments')
const CONTEXT = 32

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const uid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`

// ---------------------------------------------------------------------------
// Index texte <-> positions ProseMirror
// ---------------------------------------------------------------------------
export function buildIndex(doc) {
  let text = ''
  const segs = [] // { start, pos, len }
  doc.descendants((node, pos) => {
    if (node.isTextblock) {
      if (text.length) text += '\n'
      return true
    }
    if (node.isText) {
      segs.push({ start: text.length, pos, len: node.text.length })
      text += node.text
      return false
    }
    if (node.isInline && node.isLeaf) {
      segs.push({ start: text.length, pos, len: 1 })
      text += ' '
      return false
    }
    if (node.isBlock && node.isLeaf && text.length) text += '\n'
    return true
  })
  return { text, segs }
}

function posToIndex({ segs, text }, pos) {
  for (const s of segs) {
    if (pos < s.pos) return s.start
    if (pos <= s.pos + s.len) return s.start + (pos - s.pos)
  }
  return text.length
}

function indexToPos({ segs }, idx, isEnd) {
  let k = -1
  let lo = 0
  let hi = segs.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (segs[mid].start <= idx) {
      k = mid
      lo = mid + 1
    } else hi = mid - 1
  }
  if (k === -1) return segs[0] ? segs[0].pos : 0
  const s = segs[k]
  if (idx <= s.start + s.len) {
    // Fin de citation pile au début d'un segment : on reste en fin du précédent
    if (isEnd && idx === s.start && k > 0) return segs[k - 1].pos + segs[k - 1].len
    return s.pos + (idx - s.start)
  }
  if (isEnd) return s.pos + s.len
  return segs[k + 1] ? segs[k + 1].pos : s.pos + s.len
}

export function anchorFromSelection(state) {
  const { from, to, empty } = state.selection
  if (empty) return null
  const index = buildIndex(state.doc)
  const a = posToIndex(index, from)
  const b = posToIndex(index, to)
  const quote = index.text.slice(a, b)
  if (!quote.trim()) return null
  return {
    quote,
    prefix: index.text.slice(Math.max(0, a - CONTEXT), a),
    suffix: index.text.slice(b, b + CONTEXT),
  }
}

function commonSuffix(a, b) {
  let n = 0
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++
  return n
}
function commonPrefix(a, b) {
  let n = 0
  while (n < a.length && n < b.length && a[n] === b[n]) n++
  return n
}

export function locate(index, anchor) {
  if (!anchor?.quote) return null
  const { text } = index
  let best = -1
  let bestScore = -1
  let i = text.indexOf(anchor.quote)
  while (i !== -1) {
    const pre = text.slice(Math.max(0, i - anchor.prefix.length), i)
    const suf = text.slice(i + anchor.quote.length, i + anchor.quote.length + anchor.suffix.length)
    const score = commonSuffix(pre, anchor.prefix) + commonPrefix(suf, anchor.suffix)
    if (score > bestScore) {
      best = i
      bestScore = score
    }
    i = text.indexOf(anchor.quote, i + 1)
  }
  if (best === -1) return null
  return { from: indexToPos(index, best, false), to: indexToPos(index, best + anchor.quote.length, true) }
}

// ---------------------------------------------------------------------------
// Surlignage des passages commentés dans l'éditeur
// ---------------------------------------------------------------------------
export const CommentHighlights = Extension.create({
  name: 'commentHighlights',

  addOptions() {
    return { manager: null }
  },

  addProseMirrorPlugins() {
    const manager = this.options.manager
    const compute = (doc) => {
      const list = manager ? manager.anchoredForDecorations() : []
      if (!list.length) return { decos: DecorationSet.empty, positions: new Map() }
      const index = buildIndex(doc)
      const decos = []
      const positions = new Map()
      for (const t of list) {
        const range = locate(index, t.anchor)
        if (!range || range.from >= range.to) continue
        positions.set(t.id, range)
        decos.push(
          Decoration.inline(range.from, range.to, {
            class: 'comment-mark' + (t.id === manager.activeId ? ' active' : ''),
            'data-thread': t.id,
          })
        )
      }
      return { decos: DecorationSet.create(doc, decos), positions }
    }
    return [
      new Plugin({
        key: commentsKey,
        state: {
          init: (_, { doc }) => compute(doc),
          apply: (tr, old) => (tr.docChanged || tr.getMeta(commentsKey) ? compute(tr.doc) : old),
        },
        props: {
          decorations: (state) => commentsKey.getState(state).decos,
          handleClick(view, pos, event) {
            const mark = event.target.closest?.('.comment-mark')
            if (mark && manager) manager.focusThread(mark.dataset.thread, { scrollEditor: false })
            return false
          },
        },
      }),
    ]
  },
})

// ---------------------------------------------------------------------------
// Gestionnaire + panneau latéral
// ---------------------------------------------------------------------------
const rtf = new Intl.RelativeTimeFormat('fr', { numeric: 'auto' })
function relTime(ts) {
  const s = Math.round((ts - Date.now()) / 1000)
  if (s > -60) return "à l'instant"
  if (s > -3600) return rtf.format(Math.round(s / 60), 'minute')
  if (s > -86400) return rtf.format(Math.round(s / 3600), 'hour')
  if (s > -86400 * 7) return rtf.format(Math.round(s / 86400), 'day')
  return new Date(ts).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })
}

const avatar = (user) =>
  `<span class="avatar-chip" style="background:${avatarColor(user?.email)}">${esc((user?.name || '?')[0].toUpperCase())}</span>`

function renderText(msg) {
  let html = esc(msg.text)
  for (const m of msg.mentions || []) {
    html = html.split(esc(`@${m.name}`)).join(`<span class="mention-chip">@${esc(m.name)}</span>`)
  }
  return html.replace(/\n/g, '<br>')
}

export function createCommentsManager({ ydoc, room, me, role, api, getEditor, getUsers, toast, onCountChange }) {
  const map = ydoc.getMap('comments')
  const canComment = role === 'owner' || role === 'editor'
  const panel = document.getElementById('comments-panel')
  const list = document.getElementById('comments-list')
  const filterSelect = document.getElementById('comments-filter')
  const docApi = (suffix = '') => `/api/doc/${encodeURIComponent(room)}${suffix}`
  const pickers = []

  const manager = {
    activeId: null,
    draft: null,
    filter: 'open',
    destroyed: false,
  }

  // --- données -------------------------------------------------------------
  const allThreads = () => [...map.values()].filter((t) => t && t.id)
  manager.threads = allThreads
  manager.openCount = () => allThreads().filter((t) => !t.resolved).length
  manager.anchoredForDecorations = () => {
    const threads = allThreads().filter((t) => t.anchor && !t.resolved)
    if (manager.draft?.anchor) threads.push(manager.draft)
    return threads
  }

  function positions() {
    const editor = getEditor()
    return editor ? commentsKey.getState(editor.state)?.positions || new Map() : new Map()
  }

  function refreshDecorations() {
    const editor = getEditor()
    if (editor && !editor.isDestroyed) editor.view.dispatch(editor.state.tr.setMeta(commentsKey, true))
  }

  function sortedThreads() {
    const pos = positions()
    const threads = allThreads().filter((t) =>
      manager.filter === 'all' ? true : manager.filter === 'resolved' ? t.resolved : !t.resolved
    )
    const rank = (t) => (!t.anchor ? -1 : pos.has(t.id) ? pos.get(t.id).from : Number.MAX_SAFE_INTEGER)
    return threads.sort((a, b) => rank(a) - rank(b) || a.createdAt - b.createdAt)
  }

  function writeThread(thread) {
    ydoc.transact(() => map.set(thread.id, thread))
  }

  let saveTimer = null
  function scheduleSave() {
    if (!canComment) return
    clearTimeout(saveTimer)
    saveTimer = setTimeout(save, 800)
  }
  async function save() {
    saveTimer = null
    if (manager.destroyed && !map.size) return
    await api(docApi('/comments'), { method: 'POST', body: JSON.stringify(map.toJSON()) }).catch(() => {})
  }
  manager.flush = async () => {
    if (saveTimer) {
      clearTimeout(saveTimer)
      await save()
    }
  }

  const onMapChange = () => {
    scheduleSave()
    refreshDecorations()
    render()
    onCountChange?.(manager.openCount())
  }
  map.observe(onMapChange)

  manager.seed = async () => {
    if (map.size) return onMapChange()
    const saved = await api(docApi('/comments')).catch(() => ({}))
    const entries = Object.entries(saved || {})
    if (entries.length && !map.size) ydoc.transact(() => entries.forEach(([id, t]) => map.set(id, t)))
    onCountChange?.(manager.openCount())
    refreshDecorations()
    render()
  }

  async function notify(thread, message, isReply) {
    const participants = isReply
      ? [...new Set(thread.messages.map((m) => m.author?.email).filter((e) => e && e !== me.email))]
      : []
    const mentions = (message.mentions || []).map((m) => m.email)
    if (!mentions.length && !participants.length) return
    try {
      const { noAccess } = await api(docApi('/notify'), {
        method: 'POST',
        body: JSON.stringify({ mentions, participants, kind: 'comment', threadId: thread.id, excerpt: message.text }),
      })
      if (noAccess?.length) {
        const names = message.mentions.filter((m) => noAccess.includes(m.email)).map((m) => m.name)
        toast(`${names.join(', ')} n'a pas accès à cette page : pas de notification. Partage-la d'abord.`)
      }
    } catch {
      /* la notification est un bonus : le commentaire est déjà enregistré */
    }
  }

  function newMessage(text, mentions) {
    return { id: uid(), author: { email: me.email, name: me.name }, text, mentions, createdAt: Date.now() }
  }

  // --- actions -------------------------------------------------------------
  manager.startFromSelection = () => {
    const editor = getEditor()
    if (!editor || !canComment) return false
    const anchor = anchorFromSelection(editor.state)
    if (!anchor) return false
    manager.draft = { id: uid(), anchor, messages: [], createdAt: Date.now(), draft: true }
    manager.activeId = manager.draft.id
    manager.filter = manager.filter === 'resolved' ? 'open' : manager.filter
    manager.open()
    refreshDecorations()
    render({ focusDraft: true })
    return true
  }

  function commitDraft(text, mentions) {
    const d = manager.draft
    if (!d) return
    const message = newMessage(text, mentions)
    const thread = {
      id: d.id,
      anchor: d.anchor,
      resolved: false,
      createdAt: Date.now(),
      createdBy: { email: me.email, name: me.name },
      messages: [message],
    }
    manager.draft = null
    writeThread(thread)
    notify(thread, message, false)
  }

  function addPageComment(text, mentions) {
    const message = newMessage(text, mentions)
    const thread = {
      id: uid(),
      anchor: null,
      resolved: false,
      createdAt: Date.now(),
      createdBy: { email: me.email, name: me.name },
      messages: [message],
    }
    writeThread(thread)
    notify(thread, message, false)
  }

  function reply(threadId, text, mentions) {
    const t = map.get(threadId)
    if (!t) return
    const message = newMessage(text, mentions)
    const next = { ...t, messages: [...t.messages, message], resolved: false }
    writeThread(next)
    notify(t, message, true)
  }

  function setResolved(threadId, resolved) {
    const t = map.get(threadId)
    if (!t) return
    writeThread({ ...t, resolved, resolvedBy: resolved ? { email: me.email, name: me.name } : null })
    if (resolved && manager.activeId === threadId) manager.activeId = null
  }

  function deleteThread(threadId) {
    ydoc.transact(() => map.delete(threadId))
    if (manager.activeId === threadId) manager.activeId = null
  }

  function deleteMessage(threadId, messageId) {
    const t = map.get(threadId)
    if (!t) return
    const messages = t.messages.filter((m) => m.id !== messageId)
    if (!messages.length) return deleteThread(threadId)
    writeThread({ ...t, messages })
  }

  function editMessage(threadId, messageId, text) {
    const t = map.get(threadId)
    if (!t) return
    writeThread({
      ...t,
      messages: t.messages.map((m) => (m.id === messageId ? { ...m, text, editedAt: Date.now() } : m)),
    })
  }

  manager.focusThread = (id, { scrollEditor = true } = {}) => {
    const t = map.get(id)
    if (!t) return
    if (t.resolved && manager.filter === 'open') manager.filter = 'all'
    manager.activeId = id
    manager.open()
    refreshDecorations()
    render()
    panel.querySelector(`.thread[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    if (scrollEditor) scrollEditorTo(id)
  }

  function scrollEditorTo(id) {
    const editor = getEditor()
    const range = positions().get(id)
    if (!editor || !range) return
    const { node } = editor.view.domAtPos(range.from)
    const target = node.nodeType === 3 ? node.parentElement : node
    target?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }

  // --- panneau -------------------------------------------------------------
  manager.isOpen = () => !panel.classList.contains('hidden')
  manager.open = () => {
    panel.classList.remove('hidden')
    document.getElementById('app').classList.add('panel-open')
    render()
  }
  manager.close = () => {
    panel.classList.add('hidden')
    document.getElementById('app').classList.remove('panel-open')
    manager.draft = null
    manager.activeId = null
    refreshDecorations()
  }
  manager.toggle = () => (manager.isOpen() ? manager.close() : manager.open())

  filterSelect.value = manager.filter
  filterSelect.onchange = () => {
    manager.filter = filterSelect.value
    render()
  }

  function makeComposer({ placeholder, onSubmit, onCancel, autofocus = false, initial = '', submitLabel = 'Envoyer' }) {
    const wrap = document.createElement('div')
    wrap.className = 'composer'
    wrap.innerHTML = `${avatar(me)}<div class="composer-box"><textarea rows="1" placeholder="${esc(placeholder)}"></textarea><div class="composer-actions"><span class="composer-hint">@ pour mentionner</span><button class="composer-send" title="${esc(submitLabel)} (Entrée)">${icon('arrowUp', 16)}</button></div></div>`
    const ta = wrap.querySelector('textarea')
    ta.value = initial
    const picker = attachMentionPicker(ta, getUsers)
    pickers.push(picker)
    const autosize = () => {
      ta.style.height = 'auto'
      ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`
      wrap.classList.toggle('has-text', !!ta.value.trim())
    }
    ta.addEventListener('input', autosize)
    const submit = () => {
      const text = ta.value.trim()
      if (!text) return
      const mentions = extractMentions(ta)
      ta.value = ''
      autosize()
      onSubmit(text, mentions)
    }
    ta.addEventListener('keydown', (e) => {
      if (ta._pickerActive?.()) return
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault()
        submit()
      } else if (e.key === 'Escape') {
        e.stopPropagation()
        onCancel?.()
      }
    })
    wrap.querySelector('.composer-send').onmousedown = (e) => {
      e.preventDefault()
      submit()
    }
    if (autofocus) setTimeout(() => ta.focus(), 30)
    setTimeout(autosize, 0)
    return wrap
  }

  function messageHTML(thread, m) {
    const mine = m.author?.email === me.email
    return `<div class="msg" data-msg="${esc(m.id)}">
      ${avatar(m.author)}
      <div class="msg-main">
        <div class="msg-head"><span class="msg-author">${esc(m.author?.name || 'Inconnu')}</span><span class="msg-time" title="${esc(new Date(m.createdAt).toLocaleString('fr-FR'))}">${relTime(m.createdAt)}${m.editedAt ? ' · modifié' : ''}</span>
        ${mine && canComment ? `<span class="msg-tools"><button data-act="edit" title="Modifier">${icon('rename', 14)}</button><button data-act="delmsg" title="Supprimer">${icon('trash', 14)}</button></span>` : ''}</div>
        <div class="msg-text">${renderText(m)}</div>
      </div>
    </div>`
  }

  function threadCard(thread) {
    const card = document.createElement('div')
    const detached = thread.anchor && !positions().has(thread.id) && !thread.draft
    card.className =
      'thread' +
      (thread.id === manager.activeId ? ' active' : '') +
      (thread.resolved ? ' resolved' : '') +
      (thread.draft ? ' draft' : '')
    card.dataset.id = thread.id
    const canDelete = canComment && (role === 'owner' || thread.createdBy?.email === me.email)
    card.innerHTML = `
      <div class="thread-top">
        ${thread.anchor ? `<div class="thread-quote${detached ? ' detached' : ''}" title="${detached ? 'Le passage commenté a été supprimé ou modifié' : ''}">${esc(thread.anchor.quote.length > 140 ? `${thread.anchor.quote.slice(0, 140)}…` : thread.anchor.quote)}</div>` : '<div class="thread-quote page">Commentaire sur la page</div>'}
        ${!thread.draft && canComment ? `<span class="thread-tools">
          <button data-act="resolve" title="${thread.resolved ? 'Rouvrir' : 'Résoudre'}">${icon(thread.resolved ? 'undo' : 'check', 16)}</button>
          ${canDelete ? `<button data-act="delete" title="Supprimer le fil">${icon('trash', 16)}</button>` : ''}
        </span>` : ''}
      </div>
      ${thread.resolved ? `<div class="thread-resolved">${icon('check', 14)} Résolu${thread.resolvedBy ? ` par ${esc(thread.resolvedBy.name)}` : ''}</div>` : ''}
      <div class="msgs">${(thread.messages || []).map((m) => messageHTML(thread, m)).join('')}</div>`

    card.onclick = (e) => {
      if (e.target.closest('button, textarea, .composer')) return
      if (manager.activeId !== thread.id) {
        manager.activeId = thread.id
        refreshDecorations()
        panel.querySelectorAll('.thread').forEach((c) => c.classList.toggle('active', c.dataset.id === thread.id))
      }
      scrollEditorTo(thread.id)
    }
    card.querySelector('[data-act="resolve"]')?.addEventListener('click', () => setResolved(thread.id, !thread.resolved))
    card.querySelector('[data-act="delete"]')?.addEventListener('click', () => {
      if (confirm('Supprimer ce fil de commentaires ?')) deleteThread(thread.id)
    })
    card.querySelectorAll('[data-act="delmsg"]').forEach((b) =>
      b.addEventListener('click', () => deleteMessage(thread.id, b.closest('.msg').dataset.msg))
    )
    card.querySelectorAll('[data-act="edit"]').forEach((b) =>
      b.addEventListener('click', () => {
        const msgEl = b.closest('.msg')
        const msg = thread.messages.find((m) => m.id === msgEl.dataset.msg)
        const textEl = msgEl.querySelector('.msg-text')
        const composer = makeComposer({
          placeholder: 'Modifier…',
          initial: msg.text,
          autofocus: true,
          submitLabel: 'Enregistrer',
          onSubmit: (text) => editMessage(thread.id, msg.id, text),
          onCancel: () => render(),
        })
        composer.classList.add('editing')
        textEl.replaceWith(composer)
      })
    )

    if (canComment && !thread.resolved) {
      if (thread.draft) {
        card.appendChild(
          makeComposer({
            placeholder: 'Ajouter un commentaire…',
            autofocus: true,
            onSubmit: (text, mentions) => commitDraft(text, mentions),
            onCancel: () => {
              manager.draft = null
              manager.activeId = null
              refreshDecorations()
              render()
            },
          })
        )
      } else if (thread.id === manager.activeId) {
        card.appendChild(
          makeComposer({ placeholder: 'Répondre…', onSubmit: (text, mentions) => reply(thread.id, text, mentions) })
        )
      }
    }
    return card
  }

  function render({ focusDraft = false } = {}) {
    if (manager.destroyed) return
    // Ne pas écraser une saisie en cours (réponse ou modification) sur un changement distant
    const typing = list.querySelector('.composer textarea:focus')
    if (typing && typing.value.trim() && !focusDraft) return
    pickers.splice(0).forEach((p) => p.destroy())
    list.innerHTML = ''
    if (canComment && manager.filter !== 'resolved') {
      const pageComposer = makeComposer({
        placeholder: 'Commenter la page…',
        onSubmit: (text, mentions) => addPageComment(text, mentions),
      })
      pageComposer.classList.add('page-composer')
      list.appendChild(pageComposer)
    }
    const threads = sortedThreads()
    if (manager.draft) threads.unshift(manager.draft)
    for (const t of threads) list.appendChild(threadCard(t))
    if (!threads.length) {
      list.insertAdjacentHTML(
        'beforeend',
        `<div class="empty-hint comments-empty">${manager.filter === 'resolved' ? 'Aucun fil résolu.' : 'Aucun commentaire pour le moment. Sélectionne du texte puis « Commenter », ou ⌘⇧M.'}</div>`
      )
    }
    if (focusDraft) list.querySelector('.thread.draft textarea')?.focus()
  }
  manager.render = render

  manager.destroy = () => {
    manager.destroyed = true
    map.unobserve(onMapChange)
    pickers.splice(0).forEach((p) => p.destroy())
    if (saveTimer) save()
    list.innerHTML = ''
  }

  manager.canComment = canComment
  return manager
}
