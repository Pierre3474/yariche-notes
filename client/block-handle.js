// Poignée de bloc façon Notion/AFFiNE : au survol d'un bloc de premier niveau,
// un "+" (insère un bloc dessous et ouvre le menu /) et un "⋮⋮" pour le glisser.
// Le déplacement réutilise le drag & drop natif de ProseMirror (view.dragging),
// donc il passe par une transaction normale et se synchronise via Yjs.
import { NodeSelection, TextSelection } from '@tiptap/pm/state'

const el = (id) => document.getElementById(id)

export function mountBlockHandle(editor, scroller, { onMenu = null } = {}) {
  const handle = el('block-handle')
  const addBtn = el('block-add')
  const grip = el('block-grip')
  let current = null // { pos, dom }
  // Pendant l'appui sur la poignée on la fige : si elle bouge ou se masque
  // avant que Chrome n'émette dragstart, le glisser est annulé.
  let pressed = false

  function blockAt(clientY) {
    const view = editor.view
    const rect = view.dom.getBoundingClientRect()
    const hit = view.posAtCoords({ left: rect.left + 16, top: clientY })
    if (!hit) return null
    const $pos = view.state.doc.resolve(hit.inside >= 0 ? hit.inside : hit.pos)
    if ($pos.depth < 1 && hit.inside < 0) return null
    const pos = $pos.depth >= 1 ? $pos.before(1) : hit.inside
    const dom = view.nodeDOM(pos)
    if (!(dom instanceof HTMLElement)) return null
    return { pos, dom }
  }

  function place(block) {
    current = block
    const editorRect = editor.view.dom.getBoundingClientRect()
    const r = block.dom.getBoundingClientRect()
    const lineHeight = parseFloat(getComputedStyle(block.dom).lineHeight) || 24
    handle.style.top = `${r.top + Math.min(lineHeight, r.height) / 2 - 12 + (parseFloat(getComputedStyle(block.dom).paddingTop) || 0)}px`
    handle.style.left = `${editorRect.left - 52}px`
    handle.classList.remove('hidden')
  }

  function hide() {
    handle.classList.add('hidden')
    current = null
  }

  function onMove(e) {
    if (pressed) return
    if (!editor.isEditable) return hide()
    const rect = editor.view.dom.getBoundingClientRect()
    if (e.clientX < rect.left - 80 || e.clientX > rect.right + 20) return hide()
    if (e.clientY < rect.top || e.clientY > rect.bottom) return hide()
    const block = blockAt(e.clientY)
    if (block) place(block)
    else hide()
  }

  addBtn.onclick = () => {
    if (!current) return
    const { state, view } = editor
    const node = state.doc.nodeAt(current.pos)
    if (!node) return
    const after = current.pos + node.nodeSize
    const tr = state.tr.insert(after, state.schema.nodes.paragraph.create())
    tr.setSelection(TextSelection.create(tr.doc, after + 1))
    view.dispatch(tr)
    view.focus()
    editor.commands.insertContent('/')
    hide()
  }

  grip.ondragstart = (e) => {
    if (!current) return
    const view = editor.view
    const sel = NodeSelection.create(view.state.doc, current.pos)
    view.dispatch(view.state.tr.setSelection(sel))
    const slice = sel.content()
    view.dragging = { slice, move: true }
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', current.dom.textContent || '')
    e.dataTransfer.setDragImage(current.dom, 0, 0)
    handle.classList.add('dragging')
  }
  grip.ondragend = () => {
    pressed = false
    handle.classList.remove('dragging')
  }
  grip.onmousedown = () => {
    pressed = true
    window.addEventListener('mouseup', () => (pressed = false), { once: true })
  }

  // Clic sur la poignée = sélection du bloc entier + menu du bloc (comme Notion)
  grip.onclick = (e) => {
    if (!current) return
    e.stopPropagation()
    const view = editor.view
    view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, current.pos)))
    view.focus()
    onMenu?.(current.pos, grip)
  }

  const onLeave = (e) => {
    if (!pressed && !handle.contains(e.relatedTarget)) hide()
  }
  scroller.addEventListener('mousemove', onMove)
  scroller.addEventListener('mouseleave', onLeave)
  const onScroll = () => {
    if (!pressed) hide()
  }
  scroller.addEventListener('scroll', onScroll)
  handle.onmousemove = (e) => e.stopPropagation()

  return {
    destroy() {
      scroller.removeEventListener('mousemove', onMove)
      scroller.removeEventListener('mouseleave', onLeave)
      scroller.removeEventListener('scroll', onScroll)
      hide()
    },
  }
}
