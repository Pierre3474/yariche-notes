// Blocs de code façon AFFiNE / Notion : coloration syntaxique (highlight.js via
// lowlight), langue choisie dans un menu, bouton Copier, numéros de ligne,
// Tab / ⇧Tab pour indenter. Le .md garde des blocs ```langue standards.
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight'
import { createLowlight, common } from 'lowlight'
import dockerfile from 'highlight.js/lib/languages/dockerfile'
import nginx from 'highlight.js/lib/languages/nginx'
import powershell from 'highlight.js/lib/languages/powershell'
import { icon } from './icons.js'

export const lowlight = createLowlight(common)
lowlight.register({ dockerfile, nginx, powershell })

export const LANGUAGES = [
  ['plaintext', 'Texte brut'],
  ['bash', 'Bash'],
  ['c', 'C'],
  ['cpp', 'C++'],
  ['csharp', 'C#'],
  ['css', 'CSS'],
  ['diff', 'Diff'],
  ['dockerfile', 'Dockerfile'],
  ['go', 'Go'],
  ['graphql', 'GraphQL'],
  ['xml', 'HTML / XML'],
  ['ini', 'INI / TOML'],
  ['java', 'Java'],
  ['javascript', 'JavaScript'],
  ['json', 'JSON'],
  ['kotlin', 'Kotlin'],
  ['less', 'Less'],
  ['lua', 'Lua'],
  ['makefile', 'Makefile'],
  ['markdown', 'Markdown'],
  ['nginx', 'Nginx'],
  ['objectivec', 'Objective-C'],
  ['perl', 'Perl'],
  ['php', 'PHP'],
  ['powershell', 'PowerShell'],
  ['python', 'Python'],
  ['r', 'R'],
  ['ruby', 'Ruby'],
  ['rust', 'Rust'],
  ['scss', 'SCSS'],
  ['shell', 'Session shell'],
  ['sql', 'SQL'],
  ['swift', 'Swift'],
  ['typescript', 'TypeScript'],
  ['yaml', 'YAML'],
]
const ALIASES = {
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript', node: 'javascript',
  ts: 'typescript', tsx: 'typescript', py: 'python', python3: 'python', sh: 'bash', zsh: 'bash',
  console: 'shell', yml: 'yaml', html: 'xml', htm: 'xml', svg: 'xml', vue: 'xml', docker: 'dockerfile',
  ps1: 'powershell', ps: 'powershell', md: 'markdown', 'c++': 'cpp', cc: 'cpp', h: 'c', cs: 'csharp',
  'c#': 'csharp', rb: 'ruby', golang: 'go', rs: 'rust', kt: 'kotlin', toml: 'ini', conf: 'ini',
  text: 'plaintext', txt: 'plaintext', plain: 'plaintext', mk: 'makefile', objc: 'objectivec',
}
export const canonical = (lang) => {
  if (!lang) return 'plaintext'
  const l = String(lang).toLowerCase()
  return ALIASES[l] || l
}
const labelOf = (lang) => LANGUAGES.find(([id]) => id === canonical(lang))?.[1] || lang
const normalize = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

// Dernière langue choisie : reprise pour le prochain bloc (comme Notion)
export function lastCodeLanguage() {
  try {
    return localStorage.getItem('yariche-code-lang') || null
  } catch {
    return null
  }
}
function rememberLanguage(lang) {
  try {
    localStorage.setItem('yariche-code-lang', lang)
  } catch {
    /* préférence locale seulement */
  }
}

// --- Menu de choix de langue --------------------------------------------------
let openPicker = null
function closePicker() {
  openPicker?.remove()
  openPicker = null
}
function pickLanguage(anchor, current, onPick) {
  closePicker()
  const pop = document.createElement('div')
  pop.className = 'popover code-lang-menu'
  pop.innerHTML = '<input placeholder="Rechercher une langue…" /><div class="code-lang-list"></div>'
  document.body.appendChild(pop)
  openPicker = pop
  const input = pop.querySelector('input')
  const list = pop.querySelector('.code-lang-list')
  let items = []
  let selected = 0
  const draw = () => {
    const q = normalize(input.value)
    items = LANGUAGES.filter(([id, label]) => normalize(`${label} ${id}`).includes(q))
    selected = Math.max(0, items.findIndex(([id]) => id === canonical(current)))
    if (q) selected = 0
    list.innerHTML = items.length
      ? items
          .map(([id, label], i) => `<button class="code-lang-item${i === selected ? ' selected' : ''}" data-lang="${id}"><span>${esc(label)}</span>${id === canonical(current) ? icon('check', 14) : ''}</button>`)
          .join('')
      : '<div class="empty-hint">Aucune langue</div>'
    list.querySelector('.selected')?.scrollIntoView({ block: 'nearest' })
  }
  const choose = (id) => {
    closePicker()
    onPick(id)
  }
  list.addEventListener('mousedown', (e) => {
    const b = e.target.closest('[data-lang]')
    if (!b) return
    e.preventDefault()
    choose(b.dataset.lang)
  })
  input.addEventListener('input', draw)
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (!items.length) return
      selected = (selected + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
      list.querySelectorAll('.code-lang-item').forEach((b, i) => b.classList.toggle('selected', i === selected))
      list.querySelector('.selected')?.scrollIntoView({ block: 'nearest' })
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (items[selected]) choose(items[selected][0])
    } else if (e.key === 'Escape') {
      e.preventDefault()
      closePicker()
    }
  })
  draw()
  const r = anchor.getBoundingClientRect()
  const top = r.bottom + 4 + 320 > window.innerHeight ? Math.max(8, r.top - 324) : r.bottom + 4
  pop.style.left = `${Math.min(r.left, window.innerWidth - 248)}px`
  pop.style.top = `${top}px`
  requestAnimationFrame(() => input.focus())
}
document.addEventListener('mousedown', (e) => {
  if (openPicker && !openPicker.contains(e.target) && !e.target.closest('.code-lang')) closePicker()
})

// --- Extension -----------------------------------------------------------------
export const CodeBlock = CodeBlockLowlight.extend({
  addKeyboardShortcuts() {
    const outdent = ({ editor }) => {
      if (!editor.isActive('codeBlock')) return false
      const { state } = editor
      const { $from } = state.selection
      const text = $from.parent.textContent
      const lineStart = text.lastIndexOf('\n', $from.parentOffset - 1) + 1
      const spaces = text.slice(lineStart).match(/^ {1,2}/)?.[0].length || 0
      if (spaces) editor.view.dispatch(state.tr.delete($from.start() + lineStart, $from.start() + lineStart + spaces))
      return true
    }
    return {
      ...this.parent?.(),
      // Dans le code, Tab indente au lieu de quitter l'éditeur
      // insertText et pas insertContent : ce dernier lit la chaîne comme du HTML et avale les espaces
      Tab: ({ editor }) => {
        if (!editor.isActive('codeBlock')) return false
        editor.view.dispatch(editor.state.tr.insertText('  '))
        return true
      },
      'Shift-Tab': outdent,
    }
  },

  addNodeView() {
    return ({ node, editor, getPos }) => {
      let current = node
      let lines = 0
      const dom = document.createElement('div')
      dom.className = 'code-block'
      const toolbar = document.createElement('div')
      toolbar.className = 'code-toolbar'
      toolbar.contentEditable = 'false'
      const langBtn = document.createElement('button')
      langBtn.type = 'button'
      langBtn.className = 'code-lang'
      const copyBtn = document.createElement('button')
      copyBtn.type = 'button'
      copyBtn.className = 'code-copy'
      copyBtn.innerHTML = `${icon('copy', 14)}<span>Copier</span>`
      toolbar.append(langBtn, copyBtn)
      const body = document.createElement('div')
      body.className = 'code-body'
      const gutter = document.createElement('div')
      gutter.className = 'code-gutter'
      gutter.contentEditable = 'false'
      gutter.setAttribute('aria-hidden', 'true')
      const pre = document.createElement('pre')
      const code = document.createElement('code')
      pre.appendChild(code)
      body.append(gutter, pre)
      dom.append(toolbar, body)

      const render = () => {
        const lang = canonical(current.attrs.language)
        langBtn.innerHTML = `<span>${esc(labelOf(current.attrs.language))}</span>${editor.isEditable ? icon('chevronDown', 12) : ''}`
        langBtn.disabled = !editor.isEditable
        code.className = `hljs language-${lang}`
        dom.dataset.language = lang
        const count = Math.max(1, current.textContent.split('\n').length)
        if (count !== lines) {
          lines = count
          gutter.textContent = Array.from({ length: count }, (_, i) => i + 1).join('\n')
        }
      }

      langBtn.addEventListener('click', () => {
        if (!editor.isEditable) return
        pickLanguage(langBtn, current.attrs.language, (lang) => {
          const pos = getPos()
          if (typeof pos !== 'number') return
          rememberLanguage(lang)
          editor.view.dispatch(
            editor.state.tr.setNodeMarkup(pos, undefined, { ...current.attrs, language: lang === 'plaintext' ? null : lang })
          )
          editor.commands.focus()
        })
      })
      copyBtn.addEventListener('click', () => {
        navigator.clipboard
          ?.writeText(current.textContent)
          .then(() => {
            copyBtn.classList.add('done')
            copyBtn.innerHTML = `${icon('check', 14)}<span>Copié</span>`
            setTimeout(() => {
              copyBtn.classList.remove('done')
              copyBtn.innerHTML = `${icon('copy', 14)}<span>Copier</span>`
            }, 1400)
          })
          .catch(() => {})
      })

      render()
      return {
        dom,
        contentDOM: code,
        update(updated) {
          if (updated.type !== current.type) return false
          current = updated
          render()
          return true
        },
        ignoreMutation(mutation) {
          if (mutation.type === 'selection') return false
          return !code.contains(mutation.target)
        },
        stopEvent(event) {
          return toolbar.contains(event.target)
        },
      }
    }
  },
}).configure({ lowlight, defaultLanguage: 'plaintext' })
