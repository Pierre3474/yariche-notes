// Équations façon Notion, en syntaxe Obsidian : $x^2$ dans le texte, $$…$$ en bloc.
// Rendu KaTeX ; le .md garde le LaTeX tel quel (sans les \ et * échappés qu'ajoutait
// l'enregistrement du texte brut).
import { Node, mergeAttributes, InputRule } from '@tiptap/core'
import katex from 'katex'

// --- Lecture markdown-it --------------------------------------------------------
const escAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// $…$ : comme Obsidian, pas d'espace juste après le $ ouvrant ni avant le $ fermant,
// et pas de chiffre juste après le fermant (« 5 $ et 10 $ » reste du texte)
function mathInline(state, silent) {
  const { src, pos, posMax } = state
  if (src.charCodeAt(pos) !== 0x24 /* $ */ || src.charCodeAt(pos + 1) === 0x24) return false
  if (pos > 0 && src.charCodeAt(pos - 1) === 0x5c /* \ */) return false
  const first = src[pos + 1]
  if (!first || /\s/.test(first)) return false
  let end = pos + 1
  for (;;) {
    end = src.indexOf('$', end)
    if (end === -1 || end > posMax) return false
    if (src.charCodeAt(end - 1) === 0x5c) {
      end++
      continue
    }
    break
  }
  if (end === pos + 1 || /\s/.test(src[end - 1]) || /\d/.test(src[end + 1] || '')) return false
  if (!silent) {
    const token = state.push('math_inline', 'span', 0)
    token.content = src.slice(pos + 1, end)
    token.markup = '$'
  }
  state.pos = end + 1
  return true
}

// $$ en début de ligne, jusqu'à la ligne qui finit par $$ (ou $$ … $$ sur une ligne)
function mathBlock(state, startLine, endLine, silent) {
  let pos = state.bMarks[startLine] + state.tShift[startLine]
  let max = state.eMarks[startLine]
  if (state.sCount[startLine] - state.blkIndent >= 4) return false
  if (pos + 2 > max || state.src.slice(pos, pos + 2) !== '$$') return false
  const firstLine = state.src.slice(pos + 2, max)
  let content
  let line = startLine
  if (firstLine.trim().endsWith('$$') && firstLine.trim().length >= 2) {
    content = firstLine.trim().slice(0, -2)
  } else {
    const lines = firstLine.trim() ? [firstLine] : []
    let closed = false
    while (++line < endLine) {
      pos = state.bMarks[line] + state.tShift[line]
      max = state.eMarks[line]
      if (pos < max && state.sCount[line] < state.blkIndent) break
      const text = state.src.slice(pos, max)
      if (text.trimEnd().endsWith('$$')) {
        const before = text.trimEnd().slice(0, -2)
        if (before.trim()) lines.push(before)
        closed = true
        break
      }
      lines.push(state.src.slice(state.bMarks[line] + Math.min(state.tShift[line], state.blkIndent), max))
    }
    if (!closed) return false
    content = lines.join('\n')
  }
  if (silent) return true
  state.line = line + 1
  const token = state.push('math_block', 'div', 0)
  token.block = true
  token.content = content.trim()
  token.markup = '$$'
  token.map = [startLine, state.line]
  return true
}

function markdownItMath(md) {
  md.inline.ruler.before('escape', 'math_inline', mathInline)
  md.block.ruler.before('fence', 'math_block', mathBlock, { alt: ['paragraph', 'reference', 'blockquote', 'list'] })
  md.renderer.rules.math_inline = (tokens, i) => `<span data-type="math-inline" data-latex="${escAttr(tokens[i].content)}"></span>`
  md.renderer.rules.math_block = (tokens, i) => `<div data-type="math-block" data-latex="${escAttr(tokens[i].content)}"></div>\n`
}

// --- Rendu et édition -------------------------------------------------------------
function renderLatex(el, latex, displayMode) {
  if (!latex.trim()) {
    el.classList.add('math-empty')
    el.textContent = displayMode ? 'Nouvelle équation' : 'équation'
    return
  }
  el.classList.remove('math-empty')
  try {
    katex.render(latex, el, { displayMode, throwOnError: false, strict: 'ignore', trust: false, output: 'htmlAndMathml' })
  } catch {
    el.textContent = latex
  }
}

let openEditor = null
export function closeMathEditor(commit = true) {
  const current = openEditor
  openEditor = null
  current?.close(commit)
}

// Petite fenêtre sous l'équation : LaTeX + aperçu, Entrée (⌘Entrée en bloc) pour valider
function editLatex(anchor, { latex, displayMode, onDone }) {
  closeMathEditor()
  const pop = document.createElement('div')
  pop.className = 'popover math-editor'
  pop.innerHTML = `<textarea spellcheck="false" placeholder="${displayMode ? 'E = mc^2' : 'x^2'}"></textarea>
    <div class="math-editor-preview"></div>
    <div class="math-editor-foot"><span>${displayMode ? '⌘Entrée' : 'Entrée'} pour valider · Échap pour annuler</span><button class="primary-btn" type="button">Valider</button></div>`
  document.body.appendChild(pop)
  const input = pop.querySelector('textarea')
  const preview = pop.querySelector('.math-editor-preview')
  input.value = latex
  input.rows = displayMode ? 4 : 1
  const draw = () => renderLatex(preview, input.value, displayMode)
  draw()
  const close = (commit) => {
    if (!pop.isConnected) return
    pop.remove()
    document.removeEventListener('mousedown', outside, true)
    onDone(commit ? input.value : null)
  }
  const outside = (e) => {
    if (!pop.contains(e.target)) closeMathEditor(true)
  }
  input.addEventListener('input', draw)
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      closeMathEditor(false)
    } else if (e.key === 'Enter' && (!displayMode || e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      closeMathEditor(true)
    }
  })
  pop.querySelector('button').addEventListener('click', () => closeMathEditor(true))
  document.addEventListener('mousedown', outside, true)
  const r = anchor.getBoundingClientRect()
  const width = Math.min(420, window.innerWidth - 16)
  pop.style.width = `${width}px`
  pop.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - width - 8))}px`
  pop.style.top = `${r.bottom + 6 + 220 > window.innerHeight ? Math.max(8, r.top - 226) : r.bottom + 6}px`
  openEditor = { close }
  requestAnimationFrame(() => {
    input.focus()
    input.select()
  })
}

function mathNodeView(displayMode) {
  return ({ node, editor, getPos }) => {
    let current = node
    const dom = document.createElement(displayMode ? 'div' : 'span')
    dom.className = displayMode ? 'math-block' : 'math-inline'
    dom.dataset.type = displayMode ? 'math-block' : 'math-inline'
    dom.contentEditable = 'false'
    const draw = () => renderLatex(dom, current.attrs.latex, displayMode)
    const open = () => {
      if (!editor.isEditable) return
      dom.classList.add('editing')
      editLatex(dom, {
        latex: current.attrs.latex,
        displayMode,
        onDone: (value) => {
          dom.classList.remove('editing')
          const pos = getPos()
          if (typeof pos !== 'number') return
          if (value === null) {
            // Annulée à la création : l'équation vide disparaît
            if (!current.attrs.latex.trim()) editor.chain().focus().deleteRange({ from: pos, to: pos + current.nodeSize }).run()
            else editor.commands.focus()
            return
          }
          const latex = value.trim()
          if (!latex) editor.chain().focus().deleteRange({ from: pos, to: pos + current.nodeSize }).run()
          else if (latex !== current.attrs.latex)
            editor.chain().focus().command(({ tr }) => {
              tr.setNodeMarkup(pos, undefined, { ...current.attrs, latex })
              return true
            }).run()
          else editor.commands.focus()
        },
      })
    }
    dom.addEventListener('click', (e) => {
      e.preventDefault()
      open()
    })
    draw()
    // Équation qui vient d'être insérée vide ici (pas chez les autres) : éditeur ouvert d'office
    if (openNext && !current.attrs.latex && editor.isEditable) requestAnimationFrame(() => dom.isConnected && open())
    openNext = false
    return {
      dom,
      update(updated) {
        if (updated.type !== current.type) return false
        const changed = updated.attrs.latex !== current.attrs.latex
        current = updated
        if (changed) draw()
        return true
      },
      ignoreMutation: () => true,
      stopEvent: (e) => e.type === 'click' || e.type === 'mousedown',
    }
  }
}

const latexAttribute = {
  latex: {
    default: '',
    parseHTML: (el) => el.getAttribute('data-latex') || '',
    renderHTML: (attrs) => ({ 'data-latex': attrs.latex }),
  },
}
// Drapeau local : la prochaine équation vide créée par cet éditeur s'ouvre en édition
let openNext = false

export const MathInline = Node.create({
  name: 'mathInline',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addAttributes: () => latexAttribute,
  parseHTML: () => [{ tag: 'span[data-type="math-inline"]' }],
  renderHTML: ({ HTMLAttributes }) => ['span', mergeAttributes({ 'data-type': 'math-inline' }, HTMLAttributes)],
  renderText: ({ node }) => `$${node.attrs.latex}$`,
  addNodeView: () => mathNodeView(false),
  addStorage() {
    return {
      markdown: {
        serialize(state, node) {
          state.write(`$${node.attrs.latex}$`)
        },
        parse: {
          setup(markdownit) {
            markdownit.use(markdownItMath)
          },
        },
      },
    }
  },
  addCommands() {
    return {
      insertMathInline:
        (latex = '') =>
        ({ commands }) => {
          openNext = !latex
          return commands.insertContent({ type: this.name, attrs: { latex } })
        },
    }
  },
  // $x^2$ tapé dans le texte devient une équation (le $ fermant déclenche)
  addInputRules() {
    return [
      new InputRule({
        find: /(^|[^$\\\w])\$([^\s$](?:[^$]*[^\s$\\])?)\$$/,
        handler: ({ state, range, match }) => {
          const start = range.from + match[1].length
          state.tr.replaceWith(start, range.to, this.type.create({ latex: match[2] }))
        },
      }),
    ]
  },
})

export const MathBlock = Node.create({
  name: 'mathBlock',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,
  addAttributes: () => latexAttribute,
  parseHTML: () => [{ tag: 'div[data-type="math-block"]' }],
  renderHTML: ({ HTMLAttributes }) => ['div', mergeAttributes({ 'data-type': 'math-block' }, HTMLAttributes)],
  addNodeView: () => mathNodeView(true),
  addStorage() {
    return {
      markdown: {
        // text(…, false) remet le préfixe du conteneur (« > », liste) à chaque ligne
        serialize(state, node) {
          state.write('$$')
          state.ensureNewLine()
          state.text(node.attrs.latex, false)
          state.ensureNewLine()
          state.write('$$')
          state.closeBlock(node)
        },
        parse: {},
      },
    }
  },
  addCommands() {
    return {
      insertMathBlock:
        (latex = '') =>
        ({ commands }) => {
          openNext = !latex
          return commands.insertContent({ type: this.name, attrs: { latex } })
        },
    }
  },
  // « $$ » puis Entrée ou espace sur une ligne vide : bloc d'équation
  addInputRules() {
    return [
      new InputRule({
        find: /^\$\$\s$/,
        handler: ({ state, range }) => {
          const $from = state.doc.resolve(range.from)
          if ($from.parent.textContent.trim() !== '$$') return null
          openNext = true
          state.tr.replaceRangeWith($from.before(), $from.after(), this.type.create())
        },
      }),
    ]
  },
})
