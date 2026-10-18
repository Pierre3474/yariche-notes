// Colonnes et blocs dépliants façon Notion, écrits en encadrés Obsidian imbriqués :
//
//   > [!columns]                    > [!toggle]- Titre du bloc
//   >                               > contenu replié
//   > > [!column|40]
//   > > Colonne de gauche
//   >
//   > > [!column|60]
//   > > Colonne de droite
//
// Le .md reste lisible partout (Obsidian affiche des encadrés) ; « |40 » est la part de
// largeur de la colonne (parts normalisées à l'affichage). Le repli
// suit Obsidian (« - » replié, « + » ouvert) et reste local : ouvrir un bloc ne modifie
// pas le fichier des autres.
import { Extension } from '@tiptap/core'
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'

// « [!type] », « [!type|meta] », suivi de « - » ou « + » pour un encadré repliable
export const CALLOUT_RE = /^\[!([A-Za-z][\w-]*)(?:\|([^\]\n]*))?\]([+-]?)/

export function calloutOf(node) {
  if (node?.type.name !== 'blockquote') return null
  const first = node.firstChild
  if (!first?.isTextblock) return null
  const m = first.textContent.match(CALLOUT_RE)
  if (!m) return null
  return { kind: m[1].toLowerCase(), meta: m[2] ?? null, fold: m[3] || '', marker: m[0], first }
}

const isColumns = (node) => calloutOf(node)?.kind === 'columns'
const isColumn = (node) => calloutOf(node)?.kind === 'column'
const ratioOf = (node) => {
  const n = Number.parseFloat(calloutOf(node)?.meta)
  return Number.isFinite(n) && n > 0 ? n : null
}

// Ligne de marqueur d'une colonne : le marqueur, puis le saut de ligne qui le suit s'il y en a un
function markerRange(node, pos) {
  const info = calloutOf(node)
  if (!info) return null
  const from = pos + 2 // entrée dans la citation, puis dans son premier paragraphe
  let to = from + info.marker.length
  const after = info.first.childAfter(info.marker.length)
  if (after.node?.type.name === 'hardBreak' && after.offset === info.marker.length) to += 1
  const only = info.first.textContent.trim() === info.marker && info.first.childCount <= 2
  return { from, to, markerTo: from + info.marker.length, only, info }
}

const clamp = (n, min, max) => Math.min(max, Math.max(min, n))
const formatRatio = (r) => String(Math.round(r * 1000) / 10)

// Parts actuelles des colonnes d'un groupe, normalisées pour faire 1
function columnRatios(columns) {
  const raw = columns.map(({ node }) => ratioOf(node))
  const fallback = raw.some((r) => r === null) ? 1 / columns.length : 0
  const values = raw.map((r) => (r === null ? fallback : r))
  const total = values.reduce((a, b) => a + b, 0) || 1
  return values.map((v) => v / total)
}

function columnsOf(groupNode, groupPos) {
  const out = []
  groupNode.forEach((child, offset) => {
    if (isColumn(child)) out.push({ node: child, pos: groupPos + 1 + offset })
  })
  return out
}

// Réécrit les marqueurs « [!column|N] » d'un groupe (de la fin vers le début : les
// positions des premières colonnes restent valables)
function setColumnRatios(tr, columns, ratios) {
  for (let i = columns.length - 1; i >= 0; i--) {
    const { node, pos } = columns[i]
    const info = calloutOf(node)
    const meta = ratios ? `|${formatRatio(ratios[i])}` : ''
    const next = `[!column${meta}]`
    if (next !== info.marker) tr.insertText(next, pos + 2, pos + 2 + info.marker.length)
  }
  return tr
}

// Redimensionnement : la paire de colonnes de part et d'autre de la
// poignée garde sa part totale, par pas de 1/(8 × nombre de colonnes), jamais sous un pas
export function resizePair({ leftWidth, rightWidth, leftRatio, rightRatio, diffX, count }) {
  const width = leftWidth + rightWidth
  const share = leftRatio + rightRatio
  const left = clamp(leftWidth + diffX, 0, width)
  const right = clamp(rightWidth - diffX, 0, width)
  if (left === 0 && right === 0) return [leftRatio, rightRatio]
  const f = (left / width) * share
  const m = (right / width) * share
  const step = 1 / (8 * count)
  let l = Math.round(f / step) * step
  let r = m + (f - l)
  if (l < step) {
    l = step
    r = share - step
  }
  if (r < step) {
    r = step
    l = share - step
  }
  return [l, r]
}

function dividerWidget(groupPos, index) {
  return (view) => {
    const handle = document.createElement('div')
    handle.className = 'col-divider'
    handle.contentEditable = 'false'
    handle.title = 'Glisser pour redimensionner · double-clic pour égaliser'
    if (!view.editable) return handle
    handle.addEventListener('mousedown', (event) => {
      event.preventDefault()
      const group = view.state.doc.nodeAt(groupPos)
      if (!group || !isColumns(group)) return
      const columns = columnsOf(group, groupPos)
      const left = columns[index - 1]
      const right = columns[index]
      const leftDom = left && view.nodeDOM(left.pos)
      const rightDom = right && view.nodeDOM(right.pos)
      if (!leftDom || !rightDom) return
      const ratios = columnRatios(columns)
      const start = {
        x: event.clientX,
        leftWidth: leftDom.getBoundingClientRect().width,
        rightWidth: rightDom.getBoundingClientRect().width,
        leftRatio: ratios[index - 1],
        rightRatio: ratios[index],
      }
      let next = null
      handle.classList.add('dragging')
      document.body.classList.add('col-resizing')
      const move = (e) => {
        next = resizePair({ ...start, diffX: e.clientX - start.x, count: columns.length })
        // Aperçu sans transaction, validé au relâchement
        leftDom.style.flexGrow = String(next[0])
        rightDom.style.flexGrow = String(next[1])
      }
      const up = () => {
        window.removeEventListener('mousemove', move)
        window.removeEventListener('mouseup', up)
        handle.classList.remove('dragging')
        document.body.classList.remove('col-resizing')
        if (!next) return
        const updated = [...ratios]
        updated[index - 1] = next[0]
        updated[index] = next[1]
        const current = view.state.doc.nodeAt(groupPos)
        if (!current || !isColumns(current)) return
        view.dispatch(setColumnRatios(view.state.tr, columnsOf(current, groupPos), updated))
      }
      window.addEventListener('mousemove', move)
      window.addEventListener('mouseup', up)
    })
    // Double-clic : colonnes égales (marqueurs sans part)
    handle.addEventListener('dblclick', (event) => {
      event.preventDefault()
      const group = view.state.doc.nodeAt(groupPos)
      if (group && isColumns(group)) view.dispatch(setColumnRatios(view.state.tr, columnsOf(group, groupPos), null))
    })
    return handle
  }
}

function chevronWidget(pos, folded) {
  return (view) => {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = `callout-fold${folded ? ' folded' : ''}`
    btn.contentEditable = 'false'
    btn.tabIndex = -1
    btn.setAttribute('aria-label', folded ? 'Déplier' : 'Replier')
    btn.innerHTML =
      '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>'
    btn.addEventListener('mousedown', (e) => e.preventDefault())
    btn.addEventListener('click', (e) => {
      e.preventDefault()
      view.dispatch(view.state.tr.setMeta(foldKey, { toggle: pos }))
    })
    return btn
  }
}

const foldKey = new PluginKey('calloutFold')

// --- Glisser un bloc sur le bord d'un autre : colonnes (comme Notion) ---------------
// Bord droit (dernier quart) ou bord gauche (30 px) d'un bloc de premier niveau. Sur un
// groupe de colonnes : une colonne de plus de ce côté, toutes égales.
function dropTarget(view, event) {
  const dragging = view.dragging
  if (!dragging?.move || !dragging.slice || dragging.slice.content.childCount !== 1 || dragging.slice.openStart) return null
  const moved = dragging.slice.content.firstChild
  if (!moved.isBlock || isColumns(moved)) return null
  const hit = view.posAtCoords({ left: event.clientX, top: event.clientY })
  if (!hit) return null
  const $pos = view.state.doc.resolve(hit.inside >= 0 ? hit.inside : hit.pos)
  if ($pos.depth < 1) return null
  const pos = $pos.before(1)
  const node = view.state.doc.nodeAt(pos)
  const dom = view.nodeDOM(pos)
  if (!node || !(dom instanceof HTMLElement)) return null
  const { selection } = view.state
  if (selection.from === pos) return null // sur lui-même
  const r = dom.getBoundingClientRect()
  let side = null
  if (event.clientX >= r.right - Math.min(120, r.width / 4) && event.clientX <= r.right + 60) side = 'right'
  else if (event.clientX <= r.left + 30 && event.clientX >= r.left - 60) side = 'left'
  if (!side) return null
  return { pos, node, moved, side, rect: r }
}

let dropLine = null
function showDropLine(target) {
  if (!target) {
    dropLine?.remove()
    dropLine = null
    return
  }
  if (!dropLine) {
    dropLine = document.createElement('div')
    dropLine.className = 'col-drop-line'
    document.body.appendChild(dropLine)
  }
  const { rect, side } = target
  dropLine.style.top = `${rect.top}px`
  dropLine.style.height = `${rect.height}px`
  dropLine.style.left = `${side === 'right' ? rect.right + 4 : rect.left - 8}px`
}

export function dropIntoColumns(view, target) {
  const { state } = view
  const { schema } = state
  const para = (text) => schema.nodes.paragraph.create(null, text ? schema.text(text) : null)
  const column = (content) => schema.nodes.blockquote.create(null, [para('[!column]'), content])
  const source = state.selection
  let group
  if (isColumns(target.node)) {
    const children = []
    target.node.forEach((child) => children.push(child))
    const added = column(target.moved)
    // Après le dernier enfant ou juste après la ligne [!columns]
    const at = target.side === 'right' ? children.length : children.findIndex((c) => isColumn(c))
    children.splice(at < 0 ? children.length : at, 0, added)
    group = schema.nodes.blockquote.create(null, children)
  } else {
    const pair = target.side === 'right' ? [column(target.node), column(target.moved)] : [column(target.moved), column(target.node)]
    group = schema.nodes.blockquote.create(null, [para('[!columns]'), ...pair])
  }
  const tr = state.tr.replaceWith(target.pos, target.pos + target.node.nodeSize, group)
  // Une colonne de plus : parts remises à égalité
  if (isColumns(target.node)) setColumnRatios(tr, columnsOf(tr.doc.nodeAt(target.pos), target.pos), null)
  tr.delete(tr.mapping.map(source.from), tr.mapping.map(source.to))
  view.dispatch(tr.scrollIntoView())
  view.dragging = null
  return true
}

function buildDecorations(doc, inverted) {
  const decorations = []
  doc.descendants((node, pos) => {
    if (node.type.name !== 'blockquote') return true
    const info = calloutOf(node)
    if (!info) return true

    if (info.kind === 'columns') {
      decorations.push(Decoration.node(pos, pos + node.nodeSize, { class: 'callout-columns' }))
      // Ligne « [!columns] » seule : invisible ; sinon on masque juste le marqueur
      const range = markerRange(node, pos)
      if (range.only) decorations.push(Decoration.node(pos + 1, pos + 1 + info.first.nodeSize, { class: 'callout-hidden-line' }))
      else decorations.push(Decoration.inline(range.from, range.to, { class: 'callout-hidden' }))
      const columns = columnsOf(node, pos)
      const ratios = columnRatios(columns)
      columns.forEach((col, i) => {
        decorations.push(
          Decoration.node(col.pos, col.pos + col.node.nodeSize, { class: 'callout-column', style: `flex-grow: ${ratios[i]}` })
        )
        const r = markerRange(col.node, col.pos)
        decorations.push(Decoration.inline(r.from, r.to, { class: 'callout-hidden', inclusiveEnd: false }))
        if (i > 0) decorations.push(Decoration.widget(col.pos, dividerWidget(pos, i), { side: -1, key: `coldiv:${pos}:${i}`, ignoreSelection: true }))
      })
      return true
    }
    if (info.kind === 'column') return true

    // Encadré repliable : « - » replié par défaut, « + » ouvert ; clic = inversion locale
    if (!info.fold) return true
    const folded = (info.fold === '-') !== inverted.has(pos)
    decorations.push(Decoration.widget(pos + 2, chevronWidget(pos, folded), { side: -1, key: `fold:${pos}:${folded}`, ignoreSelection: true }))
    if (folded) {
      decorations.push(Decoration.node(pos, pos + node.nodeSize, { class: 'callout-folded' }))
      // Corps écrit sur la ligne suivante du même paragraphe (« > [!toggle]- Titre\n> texte »)
      let breakAt = -1
      info.first.forEach((child, offset) => {
        if (breakAt === -1 && child.type.name === 'hardBreak') breakAt = offset
      })
      if (breakAt !== -1) decorations.push(Decoration.inline(pos + 2 + breakAt, pos + 1 + info.first.nodeSize - 1, { class: 'callout-fold-hidden' }))
    }
    return true
  })
  return DecorationSet.create(doc, decorations)
}

// Position dans une partie masquée (marqueur de colonne, ligne [!columns]) : renvoie
// la première position visible, sinon null
function visibleTarget(doc, pos) {
  const $pos = doc.resolve(pos)
  for (let d = $pos.depth; d > 0; d--) {
    const node = $pos.node(d)
    if (node.type.name !== 'blockquote') continue
    const info = calloutOf(node)
    if (!info || (info.kind !== 'column' && info.kind !== 'columns')) continue
    const start = $pos.before(d)
    const range = markerRange(node, start)
    if (info.kind === 'columns' && range.only && pos >= start + 1 && pos <= start + 1 + info.first.nodeSize) {
      const firstCol = columnsOf(node, start)[0]
      if (!firstCol) return null
      const r = markerRange(firstCol.node, firstCol.pos)
      return r.to
    }
    if (pos >= range.from && pos < range.to) return range.to
    return null
  }
  return null
}

export const CalloutBlocks = Extension.create({
  name: 'calloutBlocks',

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: foldKey,
        state: {
          init: (_, { doc }) => ({ inverted: new Set(), decorations: buildDecorations(doc, new Set()) }),
          apply(tr, value, _old, newState) {
            const meta = tr.getMeta(foldKey)
            if (!tr.docChanged && !meta) return value
            let inverted = value.inverted
            if (tr.docChanged) {
              inverted = new Set()
              for (const pos of value.inverted) {
                const mapped = tr.mapping.mapResult(pos, 1)
                if (!mapped.deleted) inverted.add(mapped.pos)
              }
            }
            if (meta?.toggle !== undefined) {
              inverted = new Set(inverted)
              if (inverted.has(meta.toggle)) inverted.delete(meta.toggle)
              else inverted.add(meta.toggle)
            }
            if (meta?.open !== undefined) inverted = new Set(inverted).add(meta.open)
            return { inverted, decorations: buildDecorations(newState.doc, inverted) }
          },
        },
        props: {
          decorations: (state) => foldKey.getState(state).decorations,
          handleDrop(view, event) {
            const target = dropTarget(view, event)
            showDropLine(null)
            return target ? dropIntoColumns(view, target) : false
          },
          handleDOMEvents: {
            dragover(view, event) {
              showDropLine(dropTarget(view, event))
              return false
            },
            dragleave(view, event) {
              if (!view.dom.contains(event.relatedTarget)) showDropLine(null)
              return false
            },
            dragend() {
              showDropLine(null)
              return false
            },
          },
          // Texte tapé juste après un marqueur de colonne seul : saut de ligne d'abord,
          // pour écrire « [!column]\nTexte » (et non « [!column]Texte », un titre pour Obsidian)
          handleTextInput(view, from, to, text) {
            const { state } = view
            const $from = state.doc.resolve(from)
            const quote = $from.depth >= 2 ? $from.node($from.depth - 1) : null
            const info = calloutOf(quote)
            if (!info || (info.kind !== 'column' && info.kind !== 'columns')) return false
            if ($from.index($from.depth - 1) !== 0 || from !== to) return false
            const range = markerRange(quote, $from.before($from.depth - 1))
            // Frappe dans la partie masquée (le navigateur peut y laisser son curseur) :
            // le texte va après le marqueur
            if (from < range.from || from >= range.to) {
              if (from !== range.to || range.to !== range.markerTo) return false
            }
            const hardBreak = state.schema.nodes.hardBreak
            if (!hardBreak) return false
            const tr = state.tr
            if (range.to > range.markerTo) {
              tr.insertText(text, range.to)
              tr.setSelection(TextSelection.create(tr.doc, range.to + text.length))
            } else {
              tr.insert(range.markerTo, [hardBreak.create(), state.schema.text(text)])
              tr.setSelection(TextSelection.create(tr.doc, range.markerTo + 1 + text.length))
            }
            view.dispatch(tr)
            return true
          },
          handleKeyDown(view, event) {
            if (event.key !== 'Backspace' || !view.state.selection.empty) return false
            const { $from } = view.state.selection
            const quote = $from.depth >= 2 ? $from.node($from.depth - 1) : null
            const info = calloutOf(quote)
            if (!info || (info.kind !== 'column' && info.kind !== 'columns')) return false
            const start = $from.before($from.depth - 1)
            const range = markerRange(quote, start)
            // Effacer le saut de ligne masqué ou le marqueur casserait la colonne
            if ($from.pos === range.to || $from.pos === range.markerTo) return true
            // Début du 2e paragraphe d'une colonne dont la 1re ligne est un marqueur seul
            if ($from.parentOffset === 0 && $from.index($from.depth - 1) === 1 && range.only) return true
            return false
          },
        },
        // Le curseur ne reste jamais dans une partie masquée (flèches, clic)
        appendTransaction(transactions, _old, state) {
          if (!transactions.some((tr) => tr.selectionSet || tr.docChanged)) return null
          const { selection } = state
          if (!selection.empty || !(selection instanceof TextSelection)) return null
          const target = visibleTarget(state.doc, selection.from)
          if (target === null || target === selection.from) return null
          return state.tr.setSelection(TextSelection.create(state.doc, target))
        },
      }),
    ]
  },

  addCommands() {
    return {
      // Groupe de n colonnes égales ; le curseur va dans la première
      insertColumns:
        (count = 2) =>
        ({ state, dispatch, tr }) => {
          const { schema } = state
          const para = (text) => schema.nodes.paragraph.create(null, text ? schema.text(text) : null)
          const columns = Array.from({ length: count }, () => schema.nodes.blockquote.create(null, [para('[!column]')]))
          const group = schema.nodes.blockquote.create(null, [para('[!columns]'), ...columns])
          if (dispatch) {
            const { $from } = tr.selection
            const emptyBlock = $from.parent.isTextblock && $from.parent.content.size === 0 && $from.depth > 0
            const from = emptyBlock ? $from.before() : $from.after()
            const to = emptyBlock ? $from.after() : from
            tr.replaceWith(from, to, group)
            // group(1) > [!columns](n) > colonne(1) > paragraphe(1) > fin du marqueur
            const caret = from + 1 + para('[!columns]').nodeSize + 1 + 1 + '[!column]'.length
            tr.setSelection(TextSelection.create(tr.doc, caret))
            tr.scrollIntoView()
          }
          return true
        },
      // Bloc dépliant « [!toggle]- » ouvert pour celui qui le crée
      insertToggle:
        () =>
        ({ state, dispatch, tr }) => {
          const { schema } = state
          const quote = schema.nodes.blockquote.create(null, schema.nodes.paragraph.create(null, schema.text('[!toggle]- ')))
          if (dispatch) {
            const { $from } = tr.selection
            const emptyBlock = $from.parent.isTextblock && $from.parent.content.size === 0 && $from.depth > 0
            const from = emptyBlock ? $from.before() : $from.after()
            tr.replaceWith(from, emptyBlock ? $from.after() : from, quote)
            tr.setSelection(TextSelection.create(tr.doc, from + 2 + '[!toggle]- '.length))
            tr.setMeta(foldKey, { open: from })
            tr.scrollIntoView()
          }
          return true
        },
    }
  },
})
