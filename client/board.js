// Whiteboard façon « Edgeless » d'AFFiNE : canevas infini en SVG.
// Notes, formes, texte, stylo, gomme, connecteurs, images ; sélection multiple,
// redimensionnement, annuler/rétablir (Y.UndoManager), copier-coller, zoom.
//
// État : Y.Map "edgeless" > "elements" (un Y.Map par élément) dans le Y.Doc de la
// page -> collaboration en direct élément par élément, curseurs des autres via
// l'awareness. Persistance : data/<page>.board.json (format v2), migration du v1.
import * as Y from 'yjs'
import { icon } from './icons.js'

const SVGNS = 'http://www.w3.org/2000/svg'
const LOCAL = 'board-local'
const uid = () => `e${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

// Couleurs de notes (pastel, texte sombre) et de traits ("auto" = couleur du thème)
const NOTE_COLORS = ['#fff1a8', '#ffd9a8', '#ffc9c9', '#fbcfe8', '#ddd0ff', '#c9ddff', '#bdeef2', '#cdf2c4', '#e8e8e8', '#ffffff']
const STROKE_COLORS = ['auto', '#8e8e93', '#ef4444', '#f59e0b', '#eab308', '#22c55e', '#1e96eb', '#8b5cf6', '#e660a4']
const FILL_COLORS = ['none', ...NOTE_COLORS]
const PEN_SIZES = [2, 4, 8]
const FONT_SIZES = [
  ['S', 14],
  ['M', 20],
  ['L', 28],
  ['XL', 40],
]
const SHAPES = [
  ['rect', 'Rectangle', 'shapeRect'],
  ['roundrect', 'Arrondi', 'shapeRound'],
  ['ellipse', 'Ellipse', 'shapeEllipse'],
  ['diamond', 'Losange', 'shapeDiamond'],
  ['triangle', 'Triangle', 'shapeTriangle'],
]
const MIN_ZOOM = 0.1
const MAX_ZOOM = 4

const colorCss = (c) => (!c || c === 'auto' ? 'var(--text)' : c)
const svg = (tag, attrs = {}) => {
  const n = document.createElementNS(SVGNS, tag)
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v)
  return n
}

function shapePath(shape, w, h) {
  switch (shape) {
    case 'ellipse':
      return `M0,${h / 2} A${w / 2},${h / 2} 0 1,0 ${w},${h / 2} A${w / 2},${h / 2} 0 1,0 0,${h / 2} Z`
    case 'diamond':
      return `M${w / 2},0 L${w},${h / 2} L${w / 2},${h} L0,${h / 2} Z`
    case 'triangle':
      return `M${w / 2},0 L${w},${h} L0,${h} Z`
    case 'roundrect': {
      const r = Math.min(18, w / 4, h / 4)
      return `M${r},0 H${w - r} Q${w},0 ${w},${r} V${h - r} Q${w},${h} ${w - r},${h} H${r} Q0,${h} 0,${h - r} V${r} Q0,0 ${r},0 Z`
    }
    default:
      return `M0,0 H${w} V${h} H0 Z`
  }
}

function smoothPath(pts) {
  if (!pts?.length) return ''
  if (pts.length === 1) return `M${pts[0][0]},${pts[0][1]} l0.01,0`
  let d = `M${pts[0][0]},${pts[0][1]}`
  for (let i = 1; i < pts.length - 1; i++) {
    const [x1, y1] = pts[i]
    const [x2, y2] = pts[i + 1]
    d += ` Q${x1},${y1} ${(x1 + x2) / 2},${(y1 + y2) / 2}`
  }
  const last = pts[pts.length - 1]
  return `${d} L${last[0]},${last[1]}`
}

export function mountBoard(ydoc, opts) {
  const { room, editable, provider, me, userColor, onSave, uploadImage, toast } = opts
  const root = ydoc.getMap('edgeless')
  const host = document.getElementById('board-view')
  const vpKey = `yariche-vp:${room}`

  host.innerHTML = `
    <div class="eg" tabindex="-1">
      <svg class="eg-svg">
        <g class="eg-world"><g class="eg-layer"></g><g class="eg-overlay"></g></g>
      </svg>
      <div class="eg-cursors"></div>
      <div class="eg-empty hidden">Canevas vide. Double-clique pour écrire, ou choisis un outil en bas.</div>
      <textarea class="eg-editor hidden" spellcheck="false"></textarea>
      <div class="eg-selbar popover hidden"></div>
      <div class="eg-sub popover hidden"></div>
      <div class="eg-toolbar popover"></div>
      <div class="eg-zoom popover">
        <button data-zoom="out" title="Dézoomer (⌘-)">${icon('minus', 16)}</button>
        <button data-zoom="reset" class="eg-zoom-label" title="Revenir à 100 % (⌘0)">100%</button>
        <button data-zoom="in" title="Zoomer (⌘+)">${icon('plus', 16)}</button>
        <span class="eg-sep"></span>
        <button data-zoom="fit" title="Tout afficher (⇧1)">${icon('fit', 16)}</button>
      </div>
    </div>`
  const wrap = host.querySelector('.eg')
  const svgEl = host.querySelector('.eg-svg')
  const world = host.querySelector('.eg-world')
  const layer = host.querySelector('.eg-layer')
  const overlay = host.querySelector('.eg-overlay')
  const cursorsEl = host.querySelector('.eg-cursors')
  const emptyEl = host.querySelector('.eg-empty')
  const editorEl = host.querySelector('.eg-editor')
  const selbar = host.querySelector('.eg-selbar')
  const subbar = host.querySelector('.eg-sub')
  const toolbar = host.querySelector('.eg-toolbar')
  const zoomLabel = host.querySelector('.eg-zoom-label')

  const els = () => root.get('elements')
  const isReady = () => root.has('elements')
  const tx = (fn) => ydoc.transact(fn, LOCAL)
  const get = (id) => {
    const m = els()?.get(id)
    return m ? { id, ...m.toJSON() } : null
  }
  const all = () =>
    isReady() ? [...els().entries()].map(([id, m]) => ({ id, ...m.toJSON() })).sort((a, b) => (a.z || 0) - (b.z || 0)) : []
  const maxZ = () => all().reduce((m, e) => Math.max(m, e.z || 0), 0)

  // --- état local ------------------------------------------------------------
  let vp = (() => {
    try {
      return JSON.parse(localStorage.getItem(vpKey)) || null
    } catch {
      return null
    }
  })() || { x: 0, y: 0, zoom: 1, fresh: true }
  let tool = 'select'
  const style = {
    noteFill: NOTE_COLORS[0],
    shape: 'rect',
    shapeFill: NOTE_COLORS[5],
    shapeStroke: '#1e96eb',
    penColor: 'auto',
    penSize: 4,
    textColor: 'auto',
    textSize: 20,
    connectorColor: 'auto',
    connectorMode: 'straight',
  }
  let selection = new Set()
  let drag = null // interaction en cours
  let editingId = null
  let spaceDown = false
  let hoverTarget = null
  let destroyed = false

  // --- viewport ---------------------------------------------------------------
  function applyViewport() {
    world.setAttribute('transform', `translate(${vp.x},${vp.y}) scale(${vp.zoom})`)
    const g = 24 * vp.zoom
    wrap.style.backgroundSize = `${g}px ${g}px`
    wrap.style.backgroundPosition = `${vp.x}px ${vp.y}px`
    zoomLabel.textContent = `${Math.round(vp.zoom * 100)}%`
    positionEditor()
    renderOverlay()
    renderCursors()
    try {
      localStorage.setItem(vpKey, JSON.stringify({ x: vp.x, y: vp.y, zoom: vp.zoom }))
    } catch {
      /* préférence locale */
    }
  }
  const rect = () => wrap.getBoundingClientRect()
  const toWorld = (clientX, clientY) => {
    const r = rect()
    return { x: (clientX - r.left - vp.x) / vp.zoom, y: (clientY - r.top - vp.y) / vp.zoom }
  }
  const toScreen = (x, y) => ({ x: x * vp.zoom + vp.x, y: y * vp.zoom + vp.y })
  function zoomAt(factor, clientX, clientY) {
    const r = rect()
    const cx = clientX ?? r.left + r.width / 2
    const cy = clientY ?? r.top + r.height / 2
    const before = toWorld(cx, cy)
    vp.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, vp.zoom * factor))
    vp.x = cx - r.left - before.x * vp.zoom
    vp.y = cy - r.top - before.y * vp.zoom
    applyViewport()
  }
  function fitAll() {
    const items = all()
    const r = rect()
    if (!items.length) {
      vp = { x: r.width / 2, y: r.height / 2, zoom: 1 }
      return applyViewport()
    }
    const b = unionBounds(items.map(bounds))
    const pad = 80
    const zoom = Math.min(1.5, Math.max(MIN_ZOOM, Math.min((r.width - pad * 2) / Math.max(b.w, 1), (r.height - pad * 2) / Math.max(b.h, 1))))
    vp = { zoom, x: r.width / 2 - (b.x + b.w / 2) * zoom, y: r.height / 2 - (b.y + b.h / 2) * zoom }
    applyViewport()
  }

  // --- géométrie ------------------------------------------------------------------
  const centerOf = (e) => ({ x: e.x + e.w / 2, y: e.y + e.h / 2 })
  function boundaryPoint(e, toward) {
    const c = centerOf(e)
    const dx = toward.x - c.x
    const dy = toward.y - c.y
    if (!dx && !dy) return c
    if (e.type === 'shape' && e.shape === 'ellipse') {
      const a = e.w / 2
      const b = e.h / 2
      const t = 1 / Math.sqrt((dx * dx) / (a * a) + (dy * dy) / (b * b))
      return { x: c.x + dx * t, y: c.y + dy * t }
    }
    const t = Math.min(e.w / 2 / Math.abs(dx || 1e-9), e.h / 2 / Math.abs(dy || 1e-9))
    return { x: c.x + dx * t, y: c.y + dy * t }
  }
  function connectorEnds(c) {
    const a = c.from?.id ? get(c.from.id) : null
    const b = c.to?.id ? get(c.to.id) : null
    const pa = a ? centerOf(a) : { x: c.from?.x ?? 0, y: c.from?.y ?? 0 }
    const pb = b ? centerOf(b) : { x: c.to?.x ?? 0, y: c.to?.y ?? 0 }
    return { p1: a ? boundaryPoint(a, pb) : pa, p2: b ? boundaryPoint(b, pa) : pb }
  }
  function bounds(e) {
    if (e.type === 'connector') {
      const { p1, p2 } = connectorEnds(e)
      return { x: Math.min(p1.x, p2.x), y: Math.min(p1.y, p2.y), w: Math.abs(p2.x - p1.x), h: Math.abs(p2.y - p1.y) }
    }
    return { x: e.x, y: e.y, w: e.w, h: e.h }
  }
  function unionBounds(list) {
    const x1 = Math.min(...list.map((b) => b.x))
    const y1 = Math.min(...list.map((b) => b.y))
    const x2 = Math.max(...list.map((b) => b.x + b.w))
    const y2 = Math.max(...list.map((b) => b.y + b.h))
    return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 }
  }
  const intersects = (a, b) => a.x <= b.x + b.w && a.x + a.w >= b.x && a.y <= b.y + b.h && a.y + a.h >= b.y

  function connectorPath(c) {
    const { p1, p2 } = connectorEnds(c)
    if (c.mode === 'curve') {
      const dx = (p2.x - p1.x) / 2
      return { d: `M${p1.x},${p1.y} C${p1.x + dx},${p1.y} ${p2.x - dx},${p2.y} ${p2.x},${p2.y}`, p1, p2, t1: { x: p1.x + dx, y: p1.y }, t2: { x: p2.x - dx, y: p2.y } }
    }
    return { d: `M${p1.x},${p1.y} L${p2.x},${p2.y}`, p1, p2, t1: p2, t2: p1 }
  }
  function arrowHead(tip, from, size) {
    const ang = Math.atan2(tip.y - from.y, tip.x - from.x)
    const a1 = ang + Math.PI - 0.45
    const a2 = ang + Math.PI + 0.45
    return `M${tip.x},${tip.y} L${tip.x + size * Math.cos(a1)},${tip.y + size * Math.sin(a1)} L${tip.x + size * Math.cos(a2)},${tip.y + size * Math.sin(a2)} Z`
  }

  // --- rendu des éléments ----------------------------------------------------------
  const nodes = new Map() // id -> { g, type, parts }

  function createNode(e) {
    const g = svg('g', { 'data-id': e.id, class: `eg-el eg-${e.type}` })
    const parts = {}
    if (e.type === 'note' || e.type === 'shape') {
      parts.body = svg('path', { class: 'eg-body' })
      parts.fo = svg('foreignObject', { class: 'eg-fo' })
      parts.text = document.createElement('div')
      parts.text.className = e.type === 'note' ? 'eg-note-text' : 'eg-shape-text'
      parts.fo.appendChild(parts.text)
      g.append(parts.body, parts.fo)
    } else if (e.type === 'text') {
      parts.fo = svg('foreignObject', { class: 'eg-fo' })
      parts.text = document.createElement('div')
      parts.text.className = 'eg-text'
      parts.fo.appendChild(parts.text)
      g.appendChild(parts.fo)
    } else if (e.type === 'pen') {
      parts.hit = svg('path', { class: 'eg-hit' })
      parts.path = svg('path', { class: 'eg-pen-path' })
      g.append(parts.hit, parts.path)
    } else if (e.type === 'connector') {
      parts.hit = svg('path', { class: 'eg-hit' })
      parts.path = svg('path', { class: 'eg-conn-path' })
      parts.head = svg('path', { class: 'eg-conn-head' })
      parts.tail = svg('path', { class: 'eg-conn-head' })
      g.append(parts.hit, parts.path, parts.head, parts.tail)
    } else if (e.type === 'image') {
      parts.img = svg('image', { preserveAspectRatio: 'xMidYMid meet' })
      parts.frame = svg('rect', { class: 'eg-img-frame' })
      g.append(parts.img, parts.frame)
    }
    return { g, type: e.type, parts }
  }

  function updateNode(n, e) {
    const { g, parts } = n
    g.classList.toggle('editing', editingId === e.id)
    if (e.type === 'note') {
      g.setAttribute('transform', `translate(${e.x},${e.y})`)
      parts.body.setAttribute('d', shapePath('roundrect', e.w, e.h))
      parts.body.style.fill = e.fill || NOTE_COLORS[0]
      setFo(parts.fo, e.w, e.h)
      parts.text.style.fontSize = `${e.fontSize || 15}px`
      if (parts.text.textContent !== (e.text || '')) parts.text.textContent = e.text || ''
    } else if (e.type === 'shape') {
      g.setAttribute('transform', `translate(${e.x},${e.y})`)
      parts.body.setAttribute('d', shapePath(e.shape, e.w, e.h))
      const filled = e.fill && e.fill !== 'none'
      parts.body.style.fill = filled ? e.fill : 'transparent'
      parts.body.style.stroke = colorCss(e.stroke)
      parts.body.style.strokeWidth = e.strokeWidth || 2
      setFo(parts.fo, e.w, e.h)
      parts.text.style.fontSize = `${e.fontSize || 16}px`
      parts.text.style.color = filled ? '#1a1a1a' : 'var(--text)'
      if (parts.text.textContent !== (e.text || '')) parts.text.textContent = e.text || ''
    } else if (e.type === 'text') {
      g.setAttribute('transform', `translate(${e.x},${e.y})`)
      setFo(parts.fo, e.w, e.h)
      parts.text.style.fontSize = `${e.fontSize || 20}px`
      parts.text.style.color = colorCss(e.color)
      if (parts.text.textContent !== (e.text || '')) parts.text.textContent = e.text || ''
    } else if (e.type === 'pen') {
      g.setAttribute('transform', `translate(${e.x},${e.y}) scale(${e.sx || 1},${e.sy || 1})`)
      const d = smoothPath(e.points)
      parts.path.setAttribute('d', d)
      parts.hit.setAttribute('d', d)
      parts.path.style.stroke = colorCss(e.stroke)
      parts.path.style.strokeWidth = e.strokeWidth || 4
      parts.hit.style.strokeWidth = Math.max(14, (e.strokeWidth || 4) + 10)
      parts.path.setAttribute('vector-effect', 'non-scaling-stroke')
      parts.hit.setAttribute('vector-effect', 'non-scaling-stroke')
    } else if (e.type === 'connector') {
      const { d, p1, p2, t1, t2 } = connectorPath(e)
      parts.path.setAttribute('d', d)
      parts.hit.setAttribute('d', d)
      const color = colorCss(e.stroke)
      const sw = e.strokeWidth || 2
      parts.path.style.stroke = color
      parts.path.style.strokeWidth = sw
      parts.hit.style.strokeWidth = Math.max(14, sw + 10)
      const size = 8 + sw * 2
      const arrow = e.arrow || 'end'
      parts.head.setAttribute('d', arrow === 'end' || arrow === 'both' ? arrowHead(p2, t2 === p1 ? p1 : t2, size) : '')
      parts.tail.setAttribute('d', arrow === 'both' ? arrowHead(p1, t1 === p2 ? p2 : t1, size) : '')
      parts.head.style.fill = color
      parts.tail.style.fill = color
    } else if (e.type === 'image') {
      g.setAttribute('transform', `translate(${e.x},${e.y})`)
      if (parts.img.getAttribute('href') !== e.src) parts.img.setAttribute('href', e.src)
      parts.img.setAttribute('width', e.w)
      parts.img.setAttribute('height', e.h)
      parts.frame.setAttribute('width', e.w)
      parts.frame.setAttribute('height', e.h)
    }
  }
  function setFo(fo, w, h) {
    fo.setAttribute('width', Math.max(1, w))
    fo.setAttribute('height', Math.max(1, h))
  }

  let renderQueued = false
  function scheduleRender() {
    if (renderQueued || destroyed) return
    renderQueued = true
    requestAnimationFrame(() => {
      renderQueued = false
      if (!destroyed) render()
    })
  }
  function render() {
    const items = all()
    const seen = new Set()
    let prev = null
    for (const e of items) {
      seen.add(e.id)
      let n = nodes.get(e.id)
      if (!n || n.type !== e.type) {
        n?.g.remove()
        n = createNode(e)
        nodes.set(e.id, n)
      }
      updateNode(n, e)
      const expected = prev ? prev.nextSibling : layer.firstChild
      if (expected !== n.g) layer.insertBefore(n.g, expected)
      prev = n.g
    }
    for (const [id, n] of nodes) {
      if (!seen.has(id)) {
        n.g.remove()
        nodes.delete(id)
      }
    }
    // Sélection : on retire ce qui a disparu (suppression distante)
    for (const id of [...selection]) if (!seen.has(id)) selection.delete(id)
    if (editingId && !seen.has(editingId)) stopEditing(false)
    emptyEl.classList.toggle('hidden', items.length > 0 || !isReady())
    renderOverlay()
    positionEditor()
  }

  // --- surcouche : sélection, poignées, rectangle de sélection, aperçus -------------
  function renderOverlay() {
    overlay.innerHTML = ''
    const z = vp.zoom
    const sel = [...selection].map(get).filter(Boolean)
    if (hoverTarget && !selection.has(hoverTarget) && (tool === 'connector' || tool === 'select')) {
      const h = get(hoverTarget)
      if (h && h.type !== 'connector') {
        const b = bounds(h)
        overlay.appendChild(svg('rect', { x: b.x, y: b.y, width: b.w, height: b.h, class: 'eg-hover', 'stroke-width': 1.5 / z }))
      }
    }
    if (sel.length) {
      const single = sel.length === 1 ? sel[0] : null
      if (single?.type === 'connector') {
        const { p1, p2 } = connectorEnds(single)
        for (const [end, p] of [['from', p1], ['to', p2]]) {
          overlay.appendChild(svg('circle', { cx: p.x, cy: p.y, r: 5 / z, class: 'eg-handle round', 'data-end': end, 'stroke-width': 1.5 / z }))
        }
      } else {
        const b = unionBounds(sel.map(bounds))
        overlay.appendChild(svg('rect', { x: b.x, y: b.y, width: b.w, height: b.h, class: 'eg-sel', 'stroke-width': 1.5 / z }))
        if (single && editable) {
          const s = 8 / z
          for (const [hname, hx, hy] of [['nw', b.x, b.y], ['ne', b.x + b.w, b.y], ['sw', b.x, b.y + b.h], ['se', b.x + b.w, b.y + b.h]]) {
            overlay.appendChild(svg('rect', { x: hx - s / 2, y: hy - s / 2, width: s, height: s, rx: 1.5 / z, class: `eg-handle ${hname}`, 'data-handle': hname, 'stroke-width': 1.5 / z }))
          }
        }
      }
    }
    if (drag?.kind === 'marquee') {
      const b = normRect(drag.start, drag.current)
      overlay.appendChild(svg('rect', { x: b.x, y: b.y, width: b.w, height: b.h, class: 'eg-marquee', 'stroke-width': 1 / z }))
    }
    if (drag?.kind === 'create-connector' || drag?.kind === 'connector-end') {
      const p = drag.preview
      if (p) {
        overlay.appendChild(svg('path', { d: `M${p.p1.x},${p.p1.y} L${p.p2.x},${p.p2.y}`, class: 'eg-conn-preview', 'stroke-width': 2 / z }))
      }
    }
    if (drag?.kind === 'pen' && drag.points.length) {
      const path = svg('path', { d: smoothPath(drag.points), class: 'eg-pen-path live' })
      path.style.stroke = colorCss(style.penColor)
      path.style.strokeWidth = style.penSize
      overlay.appendChild(path)
    }
    if (drag?.kind === 'create-shape' && drag.rect) {
      const b = drag.rect
      overlay.appendChild(svg('path', { d: shapePath(style.shape, b.w, b.h), transform: `translate(${b.x},${b.y})`, class: 'eg-shape-preview', 'stroke-width': 1.5 / z }))
    }
    renderSelbar()
  }
  const normRect = (a, b) => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) })

  // --- barre contextuelle de sélection (au-dessus des éléments) ----------------------
  function renderSelbar() {
    const sel = [...selection].map(get).filter(Boolean)
    if (!sel.length || !editable || drag || editingId) return selbar.classList.add('hidden')
    const types = new Set(sel.map((e) => e.type))
    const only = types.size === 1 ? [...types][0] : null
    const groups = []
    const swatches = (colors, current, key, round = true) =>
      `<div class="eg-swatches">${colors
        .map((c) => `<button class="eg-swatch${round ? ' round' : ''}${c === current ? ' on' : ''}${c === 'none' ? ' none' : ''}${c === 'auto' ? ' auto' : ''}" data-set="${key}" data-value="${c}" style="${c !== 'none' && c !== 'auto' ? `--sw:${c}` : ''}" title="${c === 'none' ? 'Aucun' : c === 'auto' ? 'Automatique' : c}"></button>`)
        .join('')}</div>`
    if (only === 'note') groups.push(swatches(NOTE_COLORS, sel[0].fill, 'fill', false))
    if (only === 'shape') {
      groups.push(`<div class="eg-seg">${SHAPES.map(([s, label, ic]) => `<button class="${sel[0].shape === s ? 'on' : ''}" data-set="shape" data-value="${s}" title="${label}">${icon(ic, 16)}</button>`).join('')}</div>`)
      groups.push(`<span class="eg-label">Fond</span>${swatches(FILL_COLORS, sel[0].fill, 'fill', false)}`)
      groups.push(`<span class="eg-label">Trait</span>${swatches(STROKE_COLORS, sel[0].stroke, 'stroke')}`)
    }
    if (only === 'pen' || only === 'connector') {
      groups.push(swatches(STROKE_COLORS, sel[0].stroke, 'stroke'))
      groups.push(`<div class="eg-seg">${PEN_SIZES.map((s) => `<button class="${(sel[0].strokeWidth || 4) === s ? 'on' : ''}" data-set="strokeWidth" data-value="${s}" title="Épaisseur ${s}"><i class="eg-dot" style="width:${s + 2}px;height:${s + 2}px"></i></button>`).join('')}</div>`)
    }
    if (only === 'connector') {
      groups.push(`<div class="eg-seg">
        <button class="${(sel[0].mode || 'straight') === 'straight' ? 'on' : ''}" data-set="mode" data-value="straight" title="Droit">${icon('connector', 16)}</button>
        <button class="${sel[0].mode === 'curve' ? 'on' : ''}" data-set="mode" data-value="curve" title="Courbe">${icon('curve', 16)}</button>
        <button class="${(sel[0].arrow || 'end') === 'none' ? 'on' : ''}" data-set="arrow" data-value="none" title="Sans flèche">${icon('divider', 16)}</button>
        <button class="${(sel[0].arrow || 'end') === 'end' ? 'on' : ''}" data-set="arrow" data-value="end" title="Flèche">${icon('arrowRight', 16)}</button>
        <button class="${sel[0].arrow === 'both' ? 'on' : ''}" data-set="arrow" data-value="both" title="Double flèche">${icon('arrowBoth', 16)}</button></div>`)
    }
    if (only === 'text') {
      groups.push(swatches(STROKE_COLORS, sel[0].color || 'auto', 'color'))
    }
    if (only === 'text' || only === 'note' || only === 'shape') {
      const cur = sel[0].fontSize || (only === 'text' ? 20 : only === 'note' ? 15 : 16)
      groups.push(`<div class="eg-seg">${FONT_SIZES.map(([label, s]) => `<button class="${cur === s ? 'on' : ''}" data-set="fontSize" data-value="${s}">${label}</button>`).join('')}</div>`)
    }
    groups.push(`<div class="eg-seg">
      <button data-act="front" title="Premier plan">${icon('front', 16)}</button>
      <button data-act="back" title="Arrière-plan">${icon('back', 16)}</button>
      <button data-act="duplicate" title="Dupliquer (⌘D)">${icon('copy', 16)}</button>
      <button data-act="delete" class="danger" title="Supprimer (⌫)">${icon('trash', 16)}</button></div>`)
    selbar.innerHTML = groups.join('<span class="eg-sep"></span>')
    selbar.classList.remove('hidden')
    // Au-dessus de la sélection, sinon en dessous si pas la place
    const b = unionBounds(sel.map(bounds))
    const tl = toScreen(b.x, b.y)
    const br = toScreen(b.x + b.w, b.y + b.h)
    const r = rect()
    const w = selbar.offsetWidth
    const h = selbar.offsetHeight
    let left = (tl.x + br.x) / 2 - w / 2
    left = Math.max(8, Math.min(left, r.width - w - 8))
    let top = tl.y - h - 14
    if (top < 8) top = br.y + 14
    selbar.style.left = `${left}px`
    selbar.style.top = `${Math.min(top, r.height - h - 70)}px`
  }
  selbar.addEventListener('pointerdown', (e) => e.stopPropagation())
  selbar.addEventListener('click', (e) => {
    const b = e.target.closest('button')
    if (!b) return
    const ids = [...selection]
    if (b.dataset.set) {
      const key = b.dataset.set
      let value = b.dataset.value
      if (key === 'strokeWidth' || key === 'fontSize') value = Number(value)
      tx(() => {
        for (const id of ids) {
          const m = els().get(id)
          if (!m) continue
          m.set(key, value)
          if (key === 'fontSize' && m.get('type') === 'text') fitText(m)
        }
      })
      // On retient le style pour les prochains éléments
      const first = get(ids[0])
      if (first?.type === 'note' && key === 'fill') style.noteFill = value
      if (first?.type === 'shape') {
        if (key === 'fill') style.shapeFill = value
        if (key === 'stroke') style.shapeStroke = value
        if (key === 'shape') style.shape = value
      }
      if (first?.type === 'pen' && key === 'stroke') style.penColor = value
      if (first?.type === 'pen' && key === 'strokeWidth') style.penSize = value
      if (first?.type === 'text' && key === 'color') style.textColor = value
      return
    }
    const act = b.dataset.act
    if (act === 'delete') deleteSelection()
    if (act === 'duplicate') duplicateSelection()
    if (act === 'front' || act === 'back') {
      const items = all()
      const zs = items.map((i) => i.z || 0)
      let z = act === 'front' ? Math.max(...zs) : Math.min(...zs)
      tx(() => {
        for (const id of ids) {
          z += act === 'front' ? 1 : -1
          els().get(id)?.set('z', z)
        }
      })
    }
  })

  // --- barre d'outils (en bas, comme AFFiNE) -----------------------------------------
  const TOOLS = [
    ['select', 'pointer', 'Sélection (V)'],
    ['hand', 'hand', 'Main (H)'],
    'sep',
    ['note', 'note', 'Note (N)'],
    ['shape', 'shapeRect', 'Forme (S)'],
    ['text', 'textT', 'Texte (T)'],
    ['pen', 'pen', 'Stylo (P)'],
    ['eraser', 'eraser', 'Gomme (E)'],
    ['connector', 'connector', 'Connecteur (C)'],
    ['image', 'image', 'Image'],
  ]
  function renderToolbar() {
    toolbar.innerHTML = TOOLS.map((t) =>
      t === 'sep'
        ? '<span class="eg-sep"></span>'
        : `<button class="eg-tool${tool === t[0] ? ' on' : ''}" data-tool="${t[0]}" title="${t[2]}" ${!editable && !['select', 'hand'].includes(t[0]) ? 'disabled' : ''}>${icon(t[0] === 'shape' ? SHAPES.find((s) => s[0] === style.shape)[2] : t[1], 20)}</button>`
    ).join('')
    renderSubbar()
  }
  function renderSubbar() {
    let html = ''
    const sw = (colors, current, key, round = true) =>
      colors
        .map((c) => `<button class="eg-swatch${round ? ' round' : ''}${c === current ? ' on' : ''}${c === 'none' ? ' none' : ''}${c === 'auto' ? ' auto' : ''}" data-style="${key}" data-value="${c}" style="${c !== 'none' && c !== 'auto' ? `--sw:${c}` : ''}"></button>`)
        .join('')
    if (tool === 'note') html = `<div class="eg-swatches">${sw(NOTE_COLORS, style.noteFill, 'noteFill', false)}</div>`
    if (tool === 'shape')
      html = `<div class="eg-seg">${SHAPES.map(([s, label, ic]) => `<button class="${style.shape === s ? 'on' : ''}" data-style="shape" data-value="${s}" title="${label}">${icon(ic, 18)}</button>`).join('')}</div><span class="eg-sep"></span><div class="eg-swatches">${sw(FILL_COLORS, style.shapeFill, 'shapeFill', false)}</div>`
    if (tool === 'pen')
      html = `<div class="eg-swatches">${sw(STROKE_COLORS, style.penColor, 'penColor')}</div><span class="eg-sep"></span><div class="eg-seg">${PEN_SIZES.map((s) => `<button class="${style.penSize === s ? 'on' : ''}" data-style="penSize" data-value="${s}"><i class="eg-dot" style="width:${s + 2}px;height:${s + 2}px"></i></button>`).join('')}</div>`
    if (tool === 'text') html = `<div class="eg-swatches">${sw(STROKE_COLORS, style.textColor, 'textColor')}</div>`
    if (tool === 'connector')
      html = `<div class="eg-swatches">${sw(STROKE_COLORS, style.connectorColor, 'connectorColor')}</div><span class="eg-sep"></span><div class="eg-seg"><button class="${style.connectorMode === 'straight' ? 'on' : ''}" data-style="connectorMode" data-value="straight">${icon('connector', 16)}</button><button class="${style.connectorMode === 'curve' ? 'on' : ''}" data-style="connectorMode" data-value="curve">${icon('curve', 16)}</button></div>`
    subbar.innerHTML = html
    subbar.classList.toggle('hidden', !html)
  }
  toolbar.addEventListener('click', (e) => {
    const b = e.target.closest('[data-tool]')
    if (!b || b.disabled) return
    if (b.dataset.tool === 'image') return pickImage()
    setTool(b.dataset.tool)
  })
  subbar.addEventListener('click', (e) => {
    const b = e.target.closest('[data-style]')
    if (!b) return
    const v = b.dataset.value
    style[b.dataset.style] = b.dataset.style === 'penSize' ? Number(v) : v
    renderToolbar()
  })
  function setTool(t) {
    if (!editable && !['select', 'hand'].includes(t)) return
    tool = t
    if (t !== 'select') selection.clear()
    stopEditing(true)
    wrap.dataset.tool = t
    renderToolbar()
    renderOverlay()
  }

  host.querySelectorAll('[data-zoom]').forEach((b) =>
    b.addEventListener('click', () => {
      const z = b.dataset.zoom
      if (z === 'in') zoomAt(1.2)
      if (z === 'out') zoomAt(1 / 1.2)
      if (z === 'reset') zoomAt(1 / vp.zoom)
      if (z === 'fit') fitAll()
    })
  )

  // --- création / modification ---------------------------------------------------------
  function addElement(props) {
    const id = uid()
    tx(() => {
      const m = new Y.Map()
      els().set(id, m)
      for (const [k, v] of Object.entries({ ...props, z: maxZ() + 1 })) m.set(k, v)
    })
    return id
  }
  function setProps(id, props) {
    const m = els()?.get(id)
    if (m) tx(() => Object.entries(props).forEach(([k, v]) => m.set(k, v)))
  }
  function deleteIds(ids) {
    if (!ids.length) return
    tx(() => {
      const gone = new Set(ids)
      for (const id of ids) els().delete(id)
      // Connecteurs rattachés à un élément supprimé : on les détache à leur position actuelle
      for (const [cid, m] of els().entries()) {
        if (m.get('type') !== 'connector') continue
        const c = { id: cid, ...m.toJSON() }
        for (const end of ['from', 'to']) {
          if (c[end]?.id && gone.has(c[end].id)) m.set(end, { x: c[end].x ?? 0, y: c[end].y ?? 0 })
        }
      }
    })
  }
  function deleteSelection() {
    const ids = [...selection]
    selection.clear()
    // Les positions libres des connecteurs doivent être mises à jour avant suppression
    freezeConnectorsAround(ids)
    deleteIds(ids)
    renderOverlay()
  }
  function freezeConnectorsAround(ids) {
    const gone = new Set(ids)
    tx(() => {
      for (const [cid, m] of els().entries()) {
        if (m.get('type') !== 'connector' || gone.has(cid)) continue
        const c = { id: cid, ...m.toJSON() }
        const { p1, p2 } = connectorEnds(c)
        if (c.from?.id && gone.has(c.from.id)) m.set('from', { x: p1.x, y: p1.y })
        if (c.to?.id && gone.has(c.to.id)) m.set('to', { x: p2.x, y: p2.y })
      }
    })
  }

  // Taille d'un texte libre = son contenu
  const measurer = document.createElement('div')
  measurer.className = 'eg-text eg-measure'
  wrap.appendChild(measurer)
  function measureText(text, fontSize) {
    measurer.style.fontSize = `${fontSize}px`
    measurer.textContent = text || ' '
    return { w: Math.min(900, measurer.offsetWidth + 4), h: measurer.offsetHeight }
  }
  function fitText(m) {
    const { w, h } = measureText(m.get('text'), m.get('fontSize') || 20)
    m.set('w', Math.max(24, w))
    m.set('h', h)
  }

  // --- édition de texte en place ------------------------------------------------------
  function startEditing(id) {
    const e = get(id)
    if (!e || !editable || !['note', 'shape', 'text'].includes(e.type)) return
    editingId = id
    selection = new Set([id])
    editorEl.value = e.text || ''
    editorEl.className = `eg-editor eg-editor-${e.type}`
    editorEl.classList.remove('hidden')
    positionEditor()
    scheduleRender()
    requestAnimationFrame(() => {
      editorEl.focus()
      editorEl.setSelectionRange(editorEl.value.length, editorEl.value.length)
    })
  }
  function positionEditor() {
    if (!editingId) return
    const e = get(editingId)
    if (!e) return
    const p = toScreen(e.x, e.y)
    const fontSize = (e.fontSize || (e.type === 'text' ? 20 : e.type === 'note' ? 15 : 16)) * vp.zoom
    Object.assign(editorEl.style, {
      left: `${p.x}px`,
      top: `${p.y}px`,
      width: `${Math.max(e.type === 'text' ? 60 : e.w, e.w) * vp.zoom}px`,
      height: `${e.h * vp.zoom}px`,
      fontSize: `${fontSize}px`,
      padding: e.type === 'text' ? '0' : `${12 * vp.zoom}px`,
      color: e.type === 'text' ? colorCss(e.color) : e.type === 'shape' && (!e.fill || e.fill === 'none') ? 'var(--text)' : '#1a1a1a',
      textAlign: e.type === 'shape' ? 'center' : 'left',
    })
    if (e.type === 'shape') {
      // Centrage vertical approximatif du texte dans la forme
      const lines = Math.max(1, (editorEl.value.match(/\n/g) || []).length + 1)
      const contentH = lines * fontSize * 1.4
      editorEl.style.paddingTop = `${Math.max(4, (e.h * vp.zoom - contentH) / 2)}px`
    }
  }
  editorEl.addEventListener('input', () => {
    if (!editingId) return
    const m = els().get(editingId)
    if (!m) return
    tx(() => {
      m.set('text', editorEl.value)
      const type = m.get('type')
      if (type === 'text') fitText(m)
      if (type === 'note') {
        // La note grandit avec son contenu, comme AFFiNE
        const needed = editorEl.scrollHeight / vp.zoom
        if (needed > m.get('h')) m.set('h', Math.ceil(needed))
      }
    })
    positionEditor()
  })
  editorEl.addEventListener('keydown', (e) => {
    e.stopPropagation()
    if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) {
      e.preventDefault()
      stopEditing(true)
    }
  })
  editorEl.addEventListener('blur', () => stopEditing(true))
  function stopEditing(commit) {
    if (!editingId) return
    const id = editingId
    editingId = null
    editorEl.classList.add('hidden')
    const e = get(id)
    // Texte libre laissé vide : on le retire (comme un clic dans le vide)
    if (commit && e?.type === 'text' && !String(e.text || '').trim()) {
      deleteIds([id])
      selection.delete(id)
    }
    scheduleRender()
  }

  // --- images --------------------------------------------------------------------------
  function pickImage() {
    if (!editable) return
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/*'
    input.onchange = () => input.files?.[0] && insertImage(input.files[0])
    input.click()
  }
  async function insertImage(file, at = null) {
    try {
      const url = await uploadImage(file)
      const img = new Image()
      img.onload = () => {
        const maxW = 480
        const ratio = img.naturalHeight / img.naturalWidth || 1
        const w = Math.min(maxW, img.naturalWidth || maxW)
        const h = w * ratio
        const r = rect()
        const c = at || toWorld(r.left + r.width / 2, r.top + r.height / 2)
        const id = addElement({ type: 'image', src: url, x: c.x - w / 2, y: c.y - h / 2, w, h })
        selection = new Set([id])
        setTool('select')
        selection = new Set([id])
        renderOverlay()
      }
      img.onerror = () => toast('Image illisible')
      img.src = url
    } catch (err) {
      toast(`Image non envoyée : ${err.message}`)
    }
  }

  // --- copier / coller / dupliquer ------------------------------------------------------
  const CLIP_MARK = 'yariche-edgeless:'
  function serializeSelection() {
    const items = [...selection].map(get).filter(Boolean)
    return items.map(({ id, ...rest }) => ({ ...rest, _id: id }))
  }
  function pasteItems(items, offset = 24) {
    const idMap = new Map()
    items.forEach((it) => idMap.set(it._id, uid()))
    const z0 = maxZ()
    tx(() => {
      items.forEach((it, i) => {
        const { _id, ...props } = it
        const next = { ...props, z: z0 + 1 + i }
        if (next.type === 'connector') {
          for (const end of ['from', 'to']) {
            const ref = next[end]
            if (ref?.id) next[end] = idMap.has(ref.id) ? { id: idMap.get(ref.id) } : { x: (ref.x ?? 0) + offset, y: (ref.y ?? 0) + offset }
            else if (ref) next[end] = { x: ref.x + offset, y: ref.y + offset }
          }
        } else {
          next.x += offset
          next.y += offset
        }
        const m = new Y.Map()
        els().set(idMap.get(_id), m)
        for (const [k, v] of Object.entries(next)) m.set(k, v)
      })
    })
    selection = new Set(idMap.values())
    renderOverlay()
  }
  function duplicateSelection() {
    const items = serializeSelection()
    if (items.length) pasteItems(items)
  }
  function copySelection(cut = false) {
    const items = serializeSelection()
    if (!items.length) return
    navigator.clipboard?.writeText(CLIP_MARK + JSON.stringify(items)).catch(() => {})
    lastClipboard = items
    if (cut) deleteSelection()
  }
  let lastClipboard = null

  // --- gestion du pointeur ---------------------------------------------------------------
  const targetId = (el) => el?.closest?.('[data-id]')?.dataset.id || null

  function onPointerDown(e) {
    if (destroyed || e.button === 2) return
    wrap.focus({ preventScroll: true })
    if (editingId && !e.target.closest('.eg-editor')) stopEditing(true)
    const p = toWorld(e.clientX, e.clientY)
    // Déplacement de la vue : outil main, espace maintenu, ou bouton du milieu
    if (tool === 'hand' || spaceDown || e.button === 1) {
      drag = { kind: 'pan', sx: e.clientX, sy: e.clientY, vx: vp.x, vy: vp.y }
      wrap.classList.add('panning')
      svgEl.setPointerCapture(e.pointerId)
      return
    }
    if (!editable && tool !== 'select') return
    const hitId = targetId(e.target)
    const handle = e.target.closest?.('[data-handle]')?.dataset.handle
    const endHandle = e.target.closest?.('[data-end]')?.dataset.end

    if (tool === 'select') {
      if (handle && editable) {
        const el = get([...selection][0])
        drag = { kind: 'resize', id: el.id, handle, orig: el, start: p }
      } else if (endHandle && editable) {
        const c = get([...selection][0])
        drag = { kind: 'connector-end', id: c.id, end: endHandle, orig: c }
      } else if (hitId) {
        if (e.shiftKey) {
          if (selection.has(hitId)) selection.delete(hitId)
          else selection.add(hitId)
        } else if (!selection.has(hitId)) selection = new Set([hitId])
        if (editable) {
          const originals = new Map([...selection].map((id) => [id, get(id)]))
          drag = { kind: 'move', start: p, originals, moved: false }
        }
      } else {
        if (!e.shiftKey) selection.clear()
        drag = { kind: 'marquee', start: p, current: p, base: new Set(selection) }
      }
    } else if (tool === 'note') {
      const w = 220
      const h = 140
      const id = addElement({ type: 'note', x: p.x - w / 2, y: p.y - h / 2, w, h, fill: style.noteFill, text: '', fontSize: 15 })
      setTool('select')
      selection = new Set([id])
      startEditing(id)
      return
    } else if (tool === 'shape') {
      drag = { kind: 'create-shape', start: p, rect: null }
    } else if (tool === 'text') {
      const id = addElement({ type: 'text', x: p.x, y: p.y - 14, w: 60, h: 28, text: '', color: style.textColor, fontSize: style.textSize })
      setTool('select')
      selection = new Set([id])
      startEditing(id)
      return
    } else if (tool === 'pen') {
      drag = { kind: 'pen', points: [[p.x, p.y]] }
    } else if (tool === 'eraser') {
      drag = { kind: 'erase', erased: new Set() }
      eraseAt(e)
    } else if (tool === 'connector') {
      const from = hitId && get(hitId)?.type !== 'connector' ? { id: hitId } : { x: p.x, y: p.y }
      drag = { kind: 'create-connector', from, start: p, preview: null }
    }
    svgEl.setPointerCapture(e.pointerId)
    renderOverlay()
  }

  let lastCursorSend = 0
  function onPointerMove(e) {
    if (destroyed) return
    const p = toWorld(e.clientX, e.clientY)
    const now = performance.now()
    if (provider && now - lastCursorSend > 40) {
      lastCursorSend = now
      provider.awareness.setLocalStateField('board', { x: p.x, y: p.y })
    }
    if (!drag) {
      const id = targetId(e.target)
      if (id !== hoverTarget) {
        hoverTarget = id
        renderOverlay()
      }
      return
    }
    switch (drag.kind) {
      case 'pan':
        vp.x = drag.vx + (e.clientX - drag.sx)
        vp.y = drag.vy + (e.clientY - drag.sy)
        applyViewport()
        break
      case 'move': {
        const dx = p.x - drag.start.x
        const dy = p.y - drag.start.y
        if (!drag.moved && Math.hypot(dx, dy) * vp.zoom < 3) return
        drag.moved = true
        tx(() => {
          for (const [id, o] of drag.originals) {
            const m = els().get(id)
            if (!m || !o) continue
            if (o.type === 'connector') {
              if (!o.from?.id && !drag.originals.has(o.from?.id)) m.set('from', { x: o.from.x + dx, y: o.from.y + dy })
              if (!o.to?.id && !drag.originals.has(o.to?.id)) m.set('to', { x: o.to.x + dx, y: o.to.y + dy })
            } else {
              m.set('x', o.x + dx)
              m.set('y', o.y + dy)
            }
          }
        })
        break
      }
      case 'resize': {
        const o = drag.orig
        let x1 = o.x
        let y1 = o.y
        let x2 = o.x + o.w
        let y2 = o.y + o.h
        if (drag.handle.includes('w')) x1 = Math.min(p.x, x2 - 16)
        if (drag.handle.includes('e')) x2 = Math.max(p.x, x1 + 16)
        if (drag.handle.includes('n')) y1 = Math.min(p.y, y2 - 16)
        if (drag.handle.includes('s')) y2 = Math.max(p.y, y1 + 16)
        let w = x2 - x1
        let h = y2 - y1
        if (o.type === 'image' || o.type === 'text' || e.shiftKey) {
          const ratio = o.h / o.w
          h = w * ratio
          if (drag.handle.includes('n')) y1 = y2 - h
          else y2 = y1 + h
        }
        const patch = { x: x1, y: y1, w, h }
        if (o.type === 'pen') {
          patch.sx = (w / o.w) * (o.sx || 1)
          patch.sy = (h / o.h) * (o.sy || 1)
        }
        if (o.type === 'text') patch.fontSize = Math.max(6, Math.round((o.fontSize || 20) * (h / o.h)))
        setProps(o.id, patch)
        break
      }
      case 'marquee': {
        drag.current = p
        const box = normRect(drag.start, p)
        selection = new Set(drag.base)
        for (const el of all()) if (intersects(bounds(el), box)) selection.add(el.id)
        renderOverlay()
        break
      }
      case 'create-shape': {
        const b = normRect(drag.start, p)
        if (e.shiftKey) b.w = b.h = Math.max(b.w, b.h)
        drag.rect = b
        renderOverlay()
        break
      }
      case 'pen': {
        const last = drag.points[drag.points.length - 1]
        if (Math.hypot(p.x - last[0], p.y - last[1]) * vp.zoom > 1.5) {
          drag.points.push([p.x, p.y])
          renderOverlay()
        }
        break
      }
      case 'erase':
        eraseAt(e)
        break
      case 'create-connector':
      case 'connector-end': {
        const overId = elementUnder(e, drag.kind === 'connector-end' ? drag.id : null)
        hoverTarget = overId
        if (drag.kind === 'create-connector') {
          const tmp = { from: drag.from, to: overId ? { id: overId } : { x: p.x, y: p.y } }
          drag.to = tmp.to
          drag.preview = connectorEnds(tmp)
        } else {
          const ref = overId ? { id: overId } : { x: p.x, y: p.y }
          setProps(drag.id, { [drag.end]: ref })
        }
        renderOverlay()
        break
      }
    }
  }

  // Élément sous le pointeur (hors connecteurs), en ignorant la surcouche
  function elementUnder(e, ignoreId) {
    const stack = document.elementsFromPoint(e.clientX, e.clientY)
    for (const node of stack) {
      const id = targetId(node)
      if (id && id !== ignoreId && get(id)?.type !== 'connector') return id
    }
    return null
  }

  function eraseAt(e) {
    const stack = document.elementsFromPoint(e.clientX, e.clientY)
    for (const node of stack) {
      const id = targetId(node)
      if (id && !drag.erased.has(id)) {
        drag.erased.add(id)
        freezeConnectorsAround([id])
        deleteIds([id])
        break
      }
    }
  }

  function onPointerUp(e) {
    if (!drag) return
    const d = drag
    drag = null
    wrap.classList.remove('panning')
    try {
      svgEl.releasePointerCapture(e.pointerId)
    } catch {
      /* déjà relâché */
    }
    if (d.kind === 'create-shape') {
      let b = d.rect
      if (!b || b.w * vp.zoom < 6 || b.h * vp.zoom < 6) b = { x: d.start.x - 80, y: d.start.y - 50, w: 160, h: 100 }
      const id = addElement({ type: 'shape', shape: style.shape, x: b.x, y: b.y, w: b.w, h: b.h, fill: style.shapeFill, stroke: style.shapeStroke, strokeWidth: 2, text: '', fontSize: 16 })
      setTool('select')
      selection = new Set([id])
    } else if (d.kind === 'pen' && d.points.length > 1) {
      const xs = d.points.map((q) => q[0])
      const ys = d.points.map((q) => q[1])
      const x = Math.min(...xs)
      const y = Math.min(...ys)
      addElement({
        type: 'pen',
        x,
        y,
        w: Math.max(1, Math.max(...xs) - x),
        h: Math.max(1, Math.max(...ys) - y),
        points: d.points.map(([px, py]) => [Math.round((px - x) * 10) / 10, Math.round((py - y) * 10) / 10]),
        stroke: style.penColor,
        strokeWidth: style.penSize,
      })
    } else if (d.kind === 'create-connector') {
      const to = d.to || { x: toWorld(e.clientX, e.clientY).x, y: toWorld(e.clientX, e.clientY).y }
      const moved = Math.hypot((to.x ?? 0) - d.start.x, (to.y ?? 0) - d.start.y) * vp.zoom > 8 || (to.id && to.id !== d.from.id)
      if (moved && !(to.id && to.id === d.from.id)) {
        const id = addElement({ type: 'connector', from: d.from, to, stroke: style.connectorColor, strokeWidth: 2, arrow: 'end', mode: style.connectorMode })
        selection = new Set([id])
        setTool('select')
        selection = new Set([id])
      }
    } else if (d.kind === 'move' && !d.moved && !e.shiftKey) {
      const id = targetId(e.target)
      if (id) selection = new Set([id])
    }
    hoverTarget = null
    renderOverlay()
  }

  function onDblClick(e) {
    if (!editable) return
    const id = targetId(e.target)
    if (id) return startEditing(id)
    if (tool !== 'select') return
    const p = toWorld(e.clientX, e.clientY)
    const nid = addElement({ type: 'text', x: p.x, y: p.y - 14, w: 60, h: 28, text: '', color: style.textColor, fontSize: style.textSize })
    selection = new Set([nid])
    startEditing(nid)
  }

  // Molette : défilement = déplacement, pincement / ⌘ = zoom (comme AFFiNE et Figma)
  function onWheel(e) {
    e.preventDefault()
    if (e.ctrlKey || e.metaKey) {
      zoomAt(Math.exp(-e.deltaY * 0.01), e.clientX, e.clientY)
    } else {
      vp.x -= e.deltaX
      vp.y -= e.deltaY
      applyViewport()
    }
  }

  // --- clavier ---------------------------------------------------------------------------
  // Portée vide au départ (la map des éléments n'existe qu'après chargement) : le doc est passé explicitement
  const undo = new Y.UndoManager([], { doc: ydoc, trackedOrigins: new Set([LOCAL]), captureTimeout: 400 })
  function boardHasFocus() {
    return !host.classList.contains('hidden') && (document.activeElement === wrap || wrap.contains(document.activeElement) || document.activeElement === document.body)
  }
  function onKeyDown(e) {
    if (destroyed || editingId || !boardHasFocus()) return
    if (e.target.closest?.('input, textarea, [contenteditable="true"], [contenteditable="plaintext-only"]')) return
    const mod = e.metaKey || e.ctrlKey
    const key = e.key.toLowerCase()
    if (e.key === ' ' && !spaceDown) {
      spaceDown = true
      wrap.classList.add('space')
      e.preventDefault()
      return
    }
    if (mod && key === 'z') {
      e.preventDefault()
      e.shiftKey ? undo.redo() : undo.undo()
      return
    }
    if (mod && key === 'y') {
      e.preventDefault()
      undo.redo()
      return
    }
    if (mod && key === 'a') {
      e.preventDefault()
      selection = new Set(all().map((x) => x.id))
      return renderOverlay()
    }
    if (mod && key === 'd' && editable) {
      e.preventDefault()
      return duplicateSelection()
    }
    if (mod && key === 'c') return copySelection(false)
    if (mod && key === 'x' && editable) return copySelection(true)
    if (mod && (key === '=' || key === '+')) {
      e.preventDefault()
      return zoomAt(1.2)
    }
    if (mod && key === '-') {
      e.preventDefault()
      return zoomAt(1 / 1.2)
    }
    if (mod && key === '0') {
      e.preventDefault()
      return zoomAt(1 / vp.zoom)
    }
    if (e.shiftKey && e.key === '!') return fitAll()
    if (mod) return
    if ((e.key === 'Delete' || e.key === 'Backspace') && selection.size && editable) {
      e.preventDefault()
      return deleteSelection()
    }
    if (e.key === 'Escape') {
      selection.clear()
      setTool('select')
      return
    }
    if (e.key === 'Enter' && selection.size === 1) {
      e.preventDefault()
      return startEditing([...selection][0])
    }
    if (e.key.startsWith('Arrow') && selection.size && editable) {
      e.preventDefault()
      const step = e.shiftKey ? 10 : 1
      const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0
      const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0
      tx(() => {
        for (const id of selection) {
          const m = els().get(id)
          if (!m || m.get('type') === 'connector') continue
          m.set('x', m.get('x') + dx)
          m.set('y', m.get('y') + dy)
        }
      })
      return
    }
    const shortcuts = { v: 'select', h: 'hand', n: 'note', s: 'shape', t: 'text', p: 'pen', e: 'eraser', c: 'connector' }
    if (shortcuts[key]) setTool(shortcuts[key])
  }
  function onKeyUp(e) {
    if (e.key === ' ') {
      spaceDown = false
      wrap.classList.remove('space')
    }
  }
  function onPaste(e) {
    if (destroyed || editingId || !boardHasFocus() || !editable) return
    if (e.target.closest?.('input, textarea, [contenteditable="true"], [contenteditable="plaintext-only"]')) return
    const file = [...(e.clipboardData?.files || [])].find((f) => f.type.startsWith('image/'))
    if (file) {
      e.preventDefault()
      return insertImage(file)
    }
    const text = e.clipboardData?.getData('text/plain') || ''
    if (text.startsWith(CLIP_MARK)) {
      e.preventDefault()
      try {
        return pasteItems(JSON.parse(text.slice(CLIP_MARK.length)))
      } catch {
        return
      }
    }
    if (lastClipboard && !text) return pasteItems(lastClipboard)
    if (text.trim()) {
      e.preventDefault()
      const r = rect()
      const c = toWorld(r.left + r.width / 2, r.top + r.height / 2)
      const id = addElement({ type: 'text', x: c.x, y: c.y, w: 60, h: 28, text: text.slice(0, 5000), color: style.textColor, fontSize: style.textSize })
      const m = els().get(id)
      tx(() => fitText(m))
      selection = new Set([id])
      renderOverlay()
    }
  }
  function onDrop(e) {
    const file = [...(e.dataTransfer?.files || [])].find((f) => f.type.startsWith('image/'))
    if (!file || !editable) return
    e.preventDefault()
    insertImage(file, toWorld(e.clientX, e.clientY))
  }
  const onDragOver = (e) => {
    if ([...(e.dataTransfer?.types || [])].includes('Files')) e.preventDefault()
  }

  svgEl.addEventListener('pointerdown', onPointerDown)
  svgEl.addEventListener('pointermove', onPointerMove)
  svgEl.addEventListener('pointerup', onPointerUp)
  svgEl.addEventListener('pointercancel', onPointerUp)
  svgEl.addEventListener('dblclick', onDblClick)
  svgEl.addEventListener('pointerleave', () => provider?.awareness.setLocalStateField('board', null))
  wrap.addEventListener('wheel', onWheel, { passive: false })
  wrap.addEventListener('drop', onDrop)
  wrap.addEventListener('dragover', onDragOver)
  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('keyup', onKeyUp)
  window.addEventListener('paste', onPaste)
  const onResize = () => applyViewport()
  window.addEventListener('resize', onResize)

  // --- curseurs des autres participants ----------------------------------------------------
  function renderCursors() {
    if (!provider) return
    cursorsEl.innerHTML = ''
    for (const [clientId, s] of provider.awareness.getStates()) {
      if (clientId === provider.awareness.clientID || !s.board || !s.user) continue
      const p = toScreen(s.board.x, s.board.y)
      const c = document.createElement('div')
      c.className = 'eg-cursor'
      c.style.transform = `translate(${p.x}px, ${p.y}px)`
      c.innerHTML = `<svg width="18" height="18" viewBox="0 0 18 18"><path d="M1 1 L7 16 L9.5 9.5 L16 7 Z" fill="${esc(s.user.color)}" stroke="#fff" stroke-width="1.2"/></svg><span style="background:${esc(s.user.color)}">${esc(s.user.name)}</span>`
      cursorsEl.appendChild(c)
    }
  }
  const onAwareness = () => renderCursors()
  provider?.awareness.on('change', onAwareness)

  // --- chargement, migration et persistance ------------------------------------------------
  function loadInto(json) {
    root.set('elements', new Y.Map())
    const put = (id, props) => {
      const m = new Y.Map()
      els().set(id, m)
      for (const [k, v] of Object.entries(props)) if (v !== undefined) m.set(k, v)
    }
    if (json?.version === 2) {
      for (const [id, props] of Object.entries(json.elements || {})) put(id, props)
      return
    }
    // Format v1 : { notes: { id: {x,y,w,h,text,color} }, strokes: [{ color, points }] }
    let z = 1
    for (const [id, n] of Object.entries(json?.notes || {})) {
      put(id, { type: 'note', x: n.x || 0, y: n.y || 0, w: n.w || 200, h: n.h || 120, fill: n.color || NOTE_COLORS[0], text: n.text || '', fontSize: 15, z: z++ })
    }
    for (const s of json?.strokes || []) {
      if (!s.points?.length) continue
      const xs = s.points.map((q) => q[0])
      const ys = s.points.map((q) => q[1])
      const x = Math.min(...xs)
      const y = Math.min(...ys)
      put(s.id || uid(), {
        type: 'pen', x, y, w: Math.max(1, Math.max(...xs) - x), h: Math.max(1, Math.max(...ys) - y),
        points: s.points.map(([px, py]) => [px - x, py - y]), stroke: s.color || 'auto', strokeWidth: 3, z: z++,
      })
    }
  }

  let saveTimer = null
  const toJSON = () => ({ version: 2, elements: els()?.toJSON() || {} })
  function scheduleSave() {
    if (!editable || !isReady()) return
    clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      saveTimer = null
      onSave(toJSON())
    }, 800)
  }
  const onDeep = () => {
    scheduleRender()
    scheduleSave()
  }
  root.observeDeep(onDeep)

  async function seed(fetchSnapshot) {
    if (!isReady()) {
      const json = await fetchSnapshot().catch(() => null)
      if (destroyed) return
      if (!isReady()) ydoc.transact(() => loadInto(json))
    }
    undo.addToScope(els())
    undo.clear()
    render()
    if (vp.fresh) fitAll()
    else applyViewport()
  }

  setTool('select')
  applyViewport()

  return {
    seed,
    async flush() {
      if (saveTimer) {
        clearTimeout(saveTimer)
        saveTimer = null
        await onSave(toJSON())
      }
    },
    destroy() {
      destroyed = true
      root.unobserveDeep(onDeep)
      undo.destroy()
      if (saveTimer) {
        clearTimeout(saveTimer)
        onSave(toJSON())
      }
      provider?.awareness.off('change', onAwareness)
      provider?.awareness.setLocalStateField('board', null)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('paste', onPaste)
      window.removeEventListener('resize', onResize)
      host.innerHTML = ''
    },
  }
}
