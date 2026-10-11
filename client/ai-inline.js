// Assistant IA intégré à l'éditeur, façon Notion AI : une petite fenêtre sous la sélection
// ou le curseur (bouton « IA » du menu de sélection, « / » puis « IA », ⌘J). On choisit une
// action rapide ou on écrit une instruction, on relit le résultat, puis on remplace la
// sélection, on l'insère dessous ou on réessaie. Rien n'est écrit sans validation.
import { icon } from './icons.js'

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

const ON_SELECTION = [
  { id: 'improve', label: "Améliorer l'écriture", icon: 'sparkle' },
  { id: 'fix', label: "Corriger l'orthographe", icon: 'check' },
  { id: 'shorten', label: 'Raccourcir' },
  { id: 'expand', label: 'Développer' },
  { id: 'simplify', label: 'Simplifier' },
  { id: 'summarize', label: 'Résumer' },
  { id: 'translate_en', label: 'Traduire en anglais' },
  { id: 'translate_fr', label: 'Traduire en français' },
  { id: 'actions', label: 'Extraire les tâches' },
]
const ON_CURSOR = [
  { id: 'continue', label: "Continuer l'écriture", icon: 'sparkle' },
  { id: 'summarize', label: 'Résumer la page' },
  { id: 'actions', label: 'Extraire les tâches de la page' },
]

export function createAiInline({ api, getEditor, toast }) {
  const root = document.createElement('div')
  root.id = 'ai-inline'
  root.className = 'ai-inline popover hidden'
  root.innerHTML = `
    <form class="ai-inline-bar">
      <span class="ai-inline-spark">${icon('sparkle', 16)}</span>
      <input class="ai-inline-input" placeholder="Demande à l'IA de modifier ou d'écrire…" autocomplete="off" />
      <button type="submit" class="ai-inline-send" title="Envoyer (Entrée)">↵</button>
    </form>
    <div class="ai-inline-actions"></div>
    <div class="ai-inline-result hidden">
      <div class="ai-inline-text"></div>
      <div class="ai-inline-buttons"></div>
    </div>`
  document.body.appendChild(root)
  const input = root.querySelector('.ai-inline-input')
  const actionsEl = root.querySelector('.ai-inline-actions')
  const resultEl = root.querySelector('.ai-inline-result')
  const textEl = root.querySelector('.ai-inline-text')
  const buttonsEl = root.querySelector('.ai-inline-buttons')

  let range = null // { from, to } au moment de l'ouverture
  let selectionText = ''
  let last = null // dernière requête (pour « Réessayer »)
  let text = ''
  let busy = false
  let token = 0

  const isOpen = () => !root.classList.contains('hidden')

  function close() {
    token++
    root.classList.add('hidden')
    busy = false
    const ed = getEditor()
    if (ed && !ed.isDestroyed) ed.commands.focus()
  }

  function place() {
    const ed = getEditor()
    if (!ed || !range) return
    const c = ed.view.coordsAtPos(range.to)
    const w = Math.min(460, window.innerWidth - 24)
    root.style.width = `${w}px`
    const left = Math.max(12, Math.min(c.left, window.innerWidth - w - 12))
    root.style.left = `${left}px`
    const h = root.offsetHeight
    const below = c.bottom + 8
    root.style.top = `${below + h > window.innerHeight - 12 ? Math.max(12, c.top - h - 8) : below}px`
  }

  function showActions() {
    const items = selectionText ? ON_SELECTION : ON_CURSOR
    actionsEl.innerHTML = items
      .map((a) => `<button type="button" class="ai-inline-item" data-id="${a.id}">${a.icon ? icon(a.icon, 15) : '<span class="ai-inline-dot"></span>'}<span>${esc(a.label)}</span></button>`)
      .join('')
    actionsEl.classList.remove('hidden')
    resultEl.classList.add('hidden')
  }

  function showResult(html, buttons) {
    actionsEl.classList.add('hidden')
    resultEl.classList.remove('hidden')
    textEl.innerHTML = html
    buttonsEl.innerHTML = ''
    for (const b of buttons) {
      const el = document.createElement('button')
      el.type = 'button'
      el.className = `ai-inline-btn${b.primary ? ' primary' : ''}`
      el.textContent = b.label
      el.onclick = b.run
      buttonsEl.appendChild(el)
    }
    place()
  }

  function insertAfterBlock(ed, md) {
    const $to = ed.state.doc.resolve(range.to)
    const parent = $to.parent
    // Ligne vide : on écrit à la place du curseur, sinon sous le bloc courant
    if (parent.isTextblock && parent.content.size === 0 && range.from === range.to) {
      ed.chain().focus().insertContentAt(range.to, md).run()
    } else {
      const pos = $to.depth > 0 ? $to.after($to.depth) : range.to
      ed.chain().focus().insertContentAt(pos, md).run()
    }
  }

  function apply(mode) {
    const ed = getEditor()
    if (!ed || ed.isDestroyed || !text) return
    if (mode === 'replace') ed.chain().focus().insertContentAt({ from: range.from, to: range.to }, text).run()
    else insertAfterBlock(ed, text)
    root.classList.add('hidden')
  }

  async function run(req) {
    const ed = getEditor()
    if (!ed || busy) return
    last = req
    busy = true
    const mine = ++token
    actionsEl.classList.add('hidden')
    showResult('<span class="ai-inline-think">Réflexion…</span>', [{ label: 'Annuler', run: close }])
    try {
      // Page entière pour résumer ; sinon ce qui précède le curseur (continuer, rédiger)
      const whole = req.action === 'summarize' || req.action === 'actions'
      const before = ed.state.doc.textBetween(Math.max(0, range.from - 4000), range.from, '\n\n', ' ')
      const body = { ...req }
      if (selectionText) body.selection = selectionText
      body.context = whole && !selectionText ? ed.state.doc.textBetween(0, ed.state.doc.content.size, '\n\n', ' ').slice(0, 8000) : before
      const data = await api('/api/ai', { method: 'POST', body: JSON.stringify(body) })
      if (mine !== token) return
      text = String(data.text || '')
        .replace(/^```(?:markdown|md)?\n([\s\S]*?)\n```$/i, '$1')
        .trim()
      if (!text) return showResult('<span class="ai-inline-err">Réponse vide.</span>', [{ label: 'Réessayer', run: () => run(last) }, { label: 'Fermer', run: close }])
      const buttons = []
      if (selectionText) buttons.push({ label: 'Remplacer', primary: true, run: () => apply('replace') })
      buttons.push({ label: 'Insérer dessous', primary: !selectionText, run: () => apply('below') })
      buttons.push({ label: 'Réessayer', run: () => run(last) }, { label: 'Fermer', run: close })
      showResult(esc(text), buttons)
    } catch (err) {
      if (mine !== token) return
      showResult(`<span class="ai-inline-err">${esc(err.message)}</span>`, [{ label: 'Réessayer', run: () => run(last) }, { label: 'Fermer', run: close }])
    } finally {
      if (mine === token) busy = false
    }
  }

  function open({ prompt = '' } = {}) {
    const ed = getEditor()
    if (!ed || !ed.isEditable) return false
    const { from, to } = ed.state.selection
    range = { from, to }
    selectionText = from === to ? '' : ed.state.doc.textBetween(from, to, '\n\n', ' ').trim()
    text = ''
    busy = false
    token++
    input.value = prompt
    root.classList.remove('hidden')
    showActions()
    place()
    input.focus()
    return true
  }

  root.querySelector('.ai-inline-bar').onsubmit = (e) => {
    e.preventDefault()
    const prompt = input.value.trim()
    if (prompt) run({ prompt })
  }
  actionsEl.addEventListener('click', (e) => {
    const b = e.target.closest('[data-id]')
    if (b) run({ action: b.dataset.id })
  })
  root.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      close()
    }
  })
  // Clic ailleurs : la fenêtre se ferme (sauf pendant une requête, pour ne pas la perdre)
  document.addEventListener('mousedown', (e) => {
    if (isOpen() && !busy && !root.contains(e.target)) close()
  })
  window.addEventListener('resize', () => isOpen() && place())

  return { open, close, isOpen }
}
