// Menu flottant partagé par les suggestions de l'éditeur (« / » commandes, « @ » mentions)
// et par le sélecteur de mentions des zones de commentaire.
import { icon } from './icons.js'

const escapeHTML = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

export class SuggestMenu {
  constructor(extraClass = '') {
    this.el = document.createElement('div')
    this.el.className = `slash-menu popover hidden ${extraClass}`.trim()
    document.body.appendChild(this.el)
    this.items = []
    this.rows = []
    this.selected = 0
    this.onPick = null
  }

  // item : { group?, title, subtitle?, icon? (nom), iconHTML?, glyph?, meta? }
  render(items, onPick) {
    this.items = items
    this.onPick = onPick
    this.selected = 0
    this.rows = []
    this.el.innerHTML = ''
    if (!items.length) {
      this.el.innerHTML = '<div class="slash-empty">Aucun résultat</div>'
      return
    }
    let lastGroup = null
    items.forEach((item, idx) => {
      if (item.group && item.group !== lastGroup) {
        lastGroup = item.group
        const head = document.createElement('div')
        head.className = 'slash-group'
        head.textContent = item.group
        this.el.appendChild(head)
      }
      const row = document.createElement('div')
      row.className = 'slash-item' + (idx === 0 ? ' selected' : '')
      const visual = item.iconHTML || (item.icon ? icon(item.icon, 18) : `<span class="slash-glyph">${escapeHTML(item.glyph || '')}</span>`)
      row.innerHTML = `<div class="slash-icon${item.iconHTML ? ' bare' : ''}">${visual}</div><div class="slash-text"><div class="slash-item-title">${escapeHTML(item.title)}</div>${item.subtitle ? `<div class="slash-item-subtitle">${escapeHTML(item.subtitle)}</div>` : ''}</div>${item.meta ? `<span class="slash-meta">${escapeHTML(item.meta)}</span>` : ''}`
      row.onmousedown = (e) => {
        e.preventDefault()
        onPick(item)
      }
      row.onmouseenter = () => {
        this.selected = idx
        this.updateSelection(false)
      }
      this.rows.push(row)
      this.el.appendChild(row)
    })
  }

  updateSelection(scroll = true) {
    this.rows.forEach((r, idx) => r.classList.toggle('selected', idx === this.selected))
    if (scroll) this.rows[this.selected]?.scrollIntoView({ block: 'nearest' })
  }

  move(delta) {
    if (!this.items.length) return
    this.selected = (this.selected + delta + this.items.length) % this.items.length
    this.updateSelection()
  }

  enter() {
    if (this.items[this.selected] && this.onPick) this.onPick(this.items[this.selected])
  }

  get visible() {
    return !this.el.classList.contains('hidden')
  }

  show(rect) {
    if (!rect) return
    this.el.classList.remove('hidden')
    const menuHeight = this.el.offsetHeight || 380
    const flipUp = rect.bottom + menuHeight + 8 > window.innerHeight
    this.el.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - this.el.offsetWidth - 8))}px`
    this.el.style.top = flipUp ? `${Math.max(8, rect.top - menuHeight - 6)}px` : `${rect.bottom + 6}px`
  }

  hide() {
    this.el.classList.add('hidden')
  }
}

// Branche un SuggestMenu sur l'API render() de @tiptap/suggestion
export function suggestionRenderer(menu, { hideWhenEmpty = false } = {}) {
  const update = (props) => {
    if (hideWhenEmpty && !props.items.length) return menu.hide()
    menu.render(props.items, (item) => props.command(item))
    menu.show(props.clientRect?.())
  }
  return () => ({
    onStart: update,
    onUpdate: update,
    onKeyDown: (props) => {
      if (!menu.visible) return false
      const key = props.event.key
      if (key === 'ArrowDown') {
        menu.move(1)
        return true
      }
      if (key === 'ArrowUp') {
        menu.move(-1)
        return true
      }
      if (key === 'Enter' || key === 'Tab') {
        if (!menu.items.length) return false
        menu.enter()
        return true
      }
      if (key === 'Escape') {
        menu.hide()
        return true
      }
      return false
    },
    onExit: () => menu.hide(),
  })
}

// Sélecteur de @mentions pour un <textarea> (commentaires).
// Garde la correspondance « @Nom » -> email dans textarea._mentions.
export function attachMentionPicker(textarea, getUsers) {
  const menu = new SuggestMenu('mention-menu')
  textarea._mentions = new Map()
  let active = null // { start, query }

  const avatar = (u) => `<span class="avatar-chip" style="background:${avatarColor(u.email)}">${escapeHTML((u.name || '?')[0].toUpperCase())}</span>`

  function close() {
    active = null
    menu.hide()
  }

  function pick(user) {
    if (!active) return
    const before = textarea.value.slice(0, active.start)
    const after = textarea.value.slice(textarea.selectionStart)
    const inserted = `@${user.name} `
    textarea.value = before + inserted + after
    const caret = before.length + inserted.length
    textarea.setSelectionRange(caret, caret)
    textarea._mentions.set(user.name, user.email)
    close()
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    textarea.focus()
  }

  function refresh() {
    const caret = textarea.selectionStart
    const upto = textarea.value.slice(0, caret)
    const m = upto.match(/(^|\s)@([^\s@]{0,40})$/)
    if (!m) return close()
    const query = m[2].toLowerCase()
    active = { start: caret - m[2].length - 1, query }
    const users = getUsers().filter(
      (u) => u.name.toLowerCase().includes(query) || u.email.toLowerCase().includes(query)
    )
    menu.render(
      users.slice(0, 8).map((u) => ({ title: u.name, subtitle: u.email, iconHTML: avatar(u), user: u })),
      (item) => pick(item.user)
    )
    const r = textarea.getBoundingClientRect()
    menu.show({ left: r.left, top: r.top, bottom: r.bottom })
  }

  // Le composeur vérifie ce drapeau avant d'interpréter Entrée comme « envoyer »
  textarea._pickerActive = () => !!(active && menu.visible && menu.items.length)
  textarea.addEventListener('input', refresh)
  textarea.addEventListener('keydown', (e) => {
    if (!active || !menu.visible || !menu.items.length) return
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      menu.move(e.key === 'ArrowDown' ? 1 : -1)
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault()
      e.stopImmediatePropagation()
      menu.enter()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      close()
    }
  })
  textarea.addEventListener('blur', () => setTimeout(close, 150))
  return {
    destroy() {
      menu.el.remove()
    },
  }
}

// Emails mentionnés encore présents dans le texte envoyé
export function extractMentions(textarea) {
  const out = []
  for (const [name, email] of textarea._mentions || []) {
    if (textarea.value.includes(`@${name}`)) out.push({ name, email })
  }
  return out
}

const AVATAR_COLORS = ['#e25c5c', '#e8914b', '#d9a92c', '#4caf7a', '#3e9bd6', '#8b6fd6', '#d25fa6', '#5aa6a0']
export function avatarColor(email = '') {
  let h = 0
  for (const c of email) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return AVATAR_COLORS[h % AVATAR_COLORS.length]
}

// Pas de menu « / », « @ » ou « [[ » dans un bloc de code (commentaires //, chemins, décorateurs…)
export const notInCode = ({ state, range }) => state.doc.resolve(range.from).parent.type.name !== 'codeBlock'
