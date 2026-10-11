// Bases de données façon Notion.
//
// Tout l'état vit dans le Y.Doc de la page (map "database") : édition simultanée
// cellule par cellule, annulation locale (Y.UndoManager). Le contenu de chaque ligne
// (corps de la « page » de la ligne) est un fragment Yjs "row:<id>" édité par Tiptap
// dans le panneau latéral ; sa version markdown est recopiée dans la ligne (_body)
// pour la persistance JSON et la recherche.
import * as Y from 'yjs'
import { icon } from './icons.js'
import { avatarColor } from './suggest-menu.js'

// Adresse d'une cellule URL utilisable comme lien : web, mail ou téléphone seulement
const safeHref = (value) => {
  const v = String(value).trim()
  if (/^(https?:|mailto:|tel:)/i.test(v)) return v
  if (/^[a-z][a-z0-9+.-]*:/i.test(v)) return null
  return `https://${v}`
}


const LOCAL = 'db-local'
const uid = () => Math.random().toString(36).slice(2, 10)
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const normalize = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')

export const PROP_TYPES = [
  { type: 'text', label: 'Texte', icon: 'textAa' },
  { type: 'number', label: 'Nombre', icon: 'hash' },
  { type: 'select', label: 'Sélection', icon: 'select' },
  { type: 'multi_select', label: 'Sélection multiple', icon: 'multi' },
  { type: 'status', label: 'Statut', icon: 'status' },
  { type: 'date', label: 'Date', icon: 'calendar' },
  { type: 'person', label: 'Personne', icon: 'person' },
  { type: 'checkbox', label: 'Case à cocher', icon: 'checkbox' },
  { type: 'url', label: 'URL', icon: 'link' },
  { type: 'email', label: 'E-mail', icon: 'mail' },
  { type: 'created_time', label: 'Date de création', icon: 'clock' },
  { type: 'edited_time', label: 'Dernière modification', icon: 'clock' },
]
const TYPE_ICON = Object.fromEntries([['title', 'textAa'], ...PROP_TYPES.map((t) => [t.type, t.icon])])
const TYPE_LABEL = Object.fromEntries([['title', 'Titre'], ...PROP_TYPES.map((t) => [t.type, t.label])])
const OPTION_TYPES = new Set(['select', 'multi_select', 'status'])
const READONLY_TYPES = new Set(['created_time', 'edited_time'])

const VIEW_TYPES = [
  { type: 'table', label: 'Tableau', icon: 'table' },
  { type: 'board', label: 'Kanban', icon: 'kanban' },
  { type: 'list', label: 'Liste', icon: 'list' },
  { type: 'gallery', label: 'Galerie', icon: 'gallery' },
  { type: 'calendar', label: 'Calendrier', icon: 'calendar' },
]
const VIEW_ICON = Object.fromEntries(VIEW_TYPES.map((v) => [v.type, v.icon]))

export const COLORS = ['default', 'gray', 'brown', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'red']
const COLOR_LABELS = {
  default: 'Par défaut', gray: 'Gris', brown: 'Marron', orange: 'Orange', yellow: 'Jaune',
  green: 'Vert', blue: 'Bleu', purple: 'Violet', pink: 'Rose', red: 'Rouge',
}
const STATUS_GROUPS = [
  { id: 'todo', label: 'À faire' },
  { id: 'progress', label: 'En cours' },
  { id: 'done', label: 'Terminé' },
]

const FILTER_OPS = {
  text: [['contains', 'contient'], ['not_contains', 'ne contient pas'], ['is', 'est'], ['is_not', "n'est pas"], ['empty', 'est vide'], ['not_empty', "n'est pas vide"]],
  number: [['eq', '='], ['neq', '≠'], ['gt', '>'], ['lt', '<'], ['gte', '≥'], ['lte', '≤'], ['empty', 'est vide'], ['not_empty', "n'est pas vide"]],
  option: [['is', 'est'], ['is_not', "n'est pas"], ['empty', 'est vide'], ['not_empty', "n'est pas vide"]],
  multi: [['contains', 'contient'], ['not_contains', 'ne contient pas'], ['empty', 'est vide'], ['not_empty', "n'est pas vide"]],
  date: [['is', 'est le'], ['before', 'est avant le'], ['after', 'est après le'], ['empty', 'est vide'], ['not_empty', "n'est pas vide"]],
  checkbox: [['checked', 'est cochée'], ['unchecked', "n'est pas cochée"]],
}
function filterKind(type) {
  if (type === 'number') return 'number'
  if (type === 'select' || type === 'status') return 'option'
  if (type === 'multi_select' || type === 'person') return 'multi'
  if (type === 'date' || type === 'created_time' || type === 'edited_time') return 'date'
  if (type === 'checkbox') return 'checkbox'
  return 'text'
}
const NO_VALUE_OPS = new Set(['empty', 'not_empty', 'checked', 'unchecked'])

const CALCS = {
  all: [['count', 'Tout compter'], ['count_values', 'Compter les valeurs'], ['empty', 'Vides'], ['not_empty', 'Non vides'], ['pct_empty', '% vides'], ['pct_not_empty', '% non vides']],
  number: [['sum', 'Somme'], ['avg', 'Moyenne'], ['min', 'Min'], ['max', 'Max'], ['median', 'Médiane']],
  checkbox: [['checked', 'Cochées'], ['unchecked', 'Non cochées'], ['pct_checked', '% cochées']],
}

// --- formats ---------------------------------------------------------------
const fmtDate = (iso) => {
  if (!iso) return ''
  const d = new Date(`${String(iso).slice(0, 10)}T12:00:00`)
  if (Number.isNaN(d.getTime())) return String(iso)
  return d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' })
}
const fmtDateTime = (ts) =>
  ts ? new Date(ts).toLocaleString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''
const isoDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const tsToIso = (ts) => (ts ? isoDay(new Date(ts)) : '')

function fmtNumber(prop, v) {
  if (v === null || v === undefined || v === '' || Number.isNaN(Number(v))) return ''
  const n = Number(v)
  switch (prop.format) {
    case 'percent':
      return `${n.toLocaleString('fr-FR', { maximumFractionDigits: 2 })} %`
    case 'euro':
      return n.toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' })
    case 'dollar':
      return n.toLocaleString('fr-FR', { style: 'currency', currency: 'USD' })
    default:
      return n.toLocaleString('fr-FR', { maximumFractionDigits: 6 })
  }
}

function hostOf(url) {
  try {
    const u = new URL(/^[a-z]+:/i.test(url) ? url : `https://${url}`)
    return (u.host + (u.pathname !== '/' ? u.pathname : '')).replace(/^www\./, '')
  } catch {
    return url
  }
}

// ===========================================================================
export function mountDatabase(ydoc, opts) {
  const { room, editable, me, getUsers, api, onSave, createRowEditor, onRowOpened, toast } = opts
  const root = ydoc.getMap('database')
  const container = document.getElementById('db-view')
  const storageKey = `yariche-dbview:${room}`
  let activeViewId = (() => {
    try {
      return localStorage.getItem(storageKey)
    } catch {
      return null
    }
  })()
  let search = ''
  let searchOpen = false
  let openRowId = opts.openRowId || null
  let rowEditor = null
  let calMonth = (() => {
    const d = new Date()
    return new Date(d.getFullYear(), d.getMonth(), 1)
  })()
  let destroyed = false
  let popover = null
  let popoverCommit = null

  container.innerHTML = `
    <div class="db-toolbar">
      <div class="db-tabs"></div>
      <div class="topbar-spacer"></div>
      <div class="db-tools">
        <div class="db-search hidden"><input type="text" placeholder="Rechercher…" /></div>
        <button class="db-tool" data-tool="search" title="Rechercher">${icon('search', 16)}</button>
        <button class="db-tool" data-tool="filter" title="Filtrer">${icon('filter', 16)}</button>
        <button class="db-tool" data-tool="sort" title="Trier">${icon('sort', 16)}</button>
        <button class="db-tool" data-tool="settings" title="Paramètres de la vue">${icon('more', 16)}</button>
        ${editable ? `<button class="primary-btn db-new">Nouveau</button>` : ''}
      </div>
    </div>
    <div class="db-chips hidden"></div>
    <div class="db-body"><div class="db-loading">Chargement…</div></div>`
  const tabsEl = container.querySelector('.db-tabs')
  const chipsEl = container.querySelector('.db-chips')
  const body = container.querySelector('.db-body')
  const searchWrap = container.querySelector('.db-search')
  const searchInput = searchWrap.querySelector('input')

  const peek = document.createElement('aside')
  peek.className = 'db-peek hidden'
  peek.innerHTML = `
    <div class="peek-bar">
      <button class="icon-btn" data-peek="close" title="Fermer (Échap)">${icon('chevronsRight', 18)}</button>
      <button class="icon-btn" data-peek="prev" title="Ligne précédente">${icon('chevronUp', 18)}</button>
      <button class="icon-btn" data-peek="next" title="Ligne suivante">${icon('chevronDown', 18)}</button>
      <div class="topbar-spacer"></div>
      <button class="icon-btn" data-peek="more" title="Plus">${icon('more', 18)}</button>
    </div>
    <div class="peek-scroll">
      <div class="peek-inner">
        <h1 class="peek-title" data-placeholder="Sans titre" spellcheck="false"></h1>
        <div class="peek-props"></div>
        ${editable ? `<button class="ghost-btn peek-add-prop">${icon('plus', 16)}<span>Ajouter une propriété</span></button>` : ''}
        <div class="peek-divider"></div>
        <div class="peek-editor"></div>
      </div>
    </div>`
  document.getElementById('app').appendChild(peek)
  const peekTitle = peek.querySelector('.peek-title')
  const peekProps = peek.querySelector('.peek-props')
  const peekEditorEl = peek.querySelector('.peek-editor')

  // --- accès aux données -----------------------------------------------------
  const isReady = () => root.has('schema') && root.has('rows') && root.has('views')
  const S = () => root.get('schema')
  const PO = () => root.get('propOrder')
  const R = () => root.get('rows')
  const RO = () => root.get('rowOrder')
  const V = () => root.get('views')
  const VO = () => root.get('viewOrder')
  const tx = (fn) => ydoc.transact(fn, LOCAL)

  const props = () => PO().toArray().map((id) => S().get(id)).filter(Boolean)
  const prop = (id) => S().get(id)
  const titleProp = () => props().find((p) => p.type === 'title') || props()[0]
  const rowIds = () => {
    const rows = R()
    const ordered = RO().toArray().filter((id) => rows.has(id))
    // Lignes présentes dans la map mais absentes de l'ordre (édition concurrente) : à la fin
    const seen = new Set(ordered)
    for (const id of rows.keys()) if (!seen.has(id)) ordered.push(id)
    return ordered
  }
  const rowData = (id) => R().get(id)?.toJSON() || null
  const views = () => VO().toArray().map((id) => V().get(id)).filter(Boolean)
  const currentView = () => {
    const all = views()
    return all.find((v) => v.id === activeViewId) || all[0]
  }
  const rowTitle = (row) => (row && row[titleProp()?.id]) || ''

  function cellValue(p, row) {
    if (p.type === 'created_time') return row._created || null
    if (p.type === 'edited_time') return row._edited || null
    return row[p.id]
  }

  function cellText(p, row) {
    const v = cellValue(p, row)
    switch (p.type) {
      case 'select':
      case 'status':
        return p.options?.find((o) => o.id === v)?.name || ''
      case 'multi_select':
        return (Array.isArray(v) ? v : []).map((id) => p.options?.find((o) => o.id === id)?.name).filter(Boolean).join(', ')
      case 'person':
        return (Array.isArray(v) ? v : []).map((e) => userName(e)).join(', ')
      case 'date':
        return fmtDate(v)
      case 'created_time':
      case 'edited_time':
        return fmtDateTime(v)
      case 'checkbox':
        return v ? 'Oui' : ''
      case 'number':
        return fmtNumber(p, v)
      default:
        return v == null ? '' : String(v)
    }
  }

  function isEmptyValue(p, row) {
    const v = cellValue(p, row)
    if (p.type === 'checkbox') return !v
    if (Array.isArray(v)) return v.length === 0
    return v === null || v === undefined || v === ''
  }

  const users = () => getUsers() || []
  const userName = (email) => users().find((u) => u.email === email)?.name || String(email).split('@')[0]

  // --- écritures ---------------------------------------------------------------
  function touch(rowMap) {
    rowMap.set('_edited', Date.now())
  }
  function setCell(rowId, propId, value) {
    const r = R().get(rowId)
    if (!r) return
    tx(() => {
      r.set(propId, value)
      touch(r)
    })
  }
  function addRow(initial = {}, { index = null, open = false } = {}) {
    const id = uid()
    tx(() => {
      const r = new Y.Map()
      R().set(id, r)
      r.set('_created', Date.now())
      r.set('_edited', Date.now())
      r.set('_createdBy', me.email)
      for (const [k, v] of Object.entries(initial)) r.set(k, v)
      if (index === null) RO().push([id])
      else RO().insert(Math.max(0, Math.min(index, RO().length)), [id])
    })
    if (open) openPeek(id)
    return id
  }
  function deleteRows(ids) {
    tx(() => {
      for (const id of ids) {
        R().delete(id)
        const i = RO().toArray().indexOf(id)
        if (i >= 0) RO().delete(i, 1)
      }
    })
    if (ids.includes(openRowId)) closePeek()
  }
  function duplicateRow(id) {
    const data = rowData(id)
    if (!data) return
    const { _created, _edited, _createdBy, ...cells } = data
    const t = titleProp()
    if (t && cells[t.id]) cells[t.id] = `${cells[t.id]} (copie)`
    const index = RO().toArray().indexOf(id) + 1
    return addRow(cells, { index })
  }
  function moveRow(id, beforeId) {
    tx(() => {
      const order = RO().toArray()
      const from = order.indexOf(id)
      if (from >= 0) RO().delete(from, 1)
      const list = RO().toArray()
      const to = beforeId ? list.indexOf(beforeId) : -1
      RO().insert(to >= 0 ? to : list.length, [id])
    })
  }
  function updateProp(id, patch) {
    const p = S().get(id)
    if (p) tx(() => S().set(id, { ...p, ...patch }))
  }
  function addProp(type, { index = null, name = null } = {}) {
    const id = uid()
    const label = name || TYPE_LABEL[type] || 'Propriété'
    const existing = new Set(props().map((p) => p.name))
    let finalName = label
    let n = 2
    while (existing.has(finalName)) finalName = `${label} ${n++}`
    const p = { id, name: finalName, type }
    if (OPTION_TYPES.has(type)) p.options = type === 'status' ? defaultStatusOptions() : []
    if (type === 'number') p.format = 'number'
    tx(() => {
      S().set(id, p)
      if (index === null) PO().push([id])
      else PO().insert(Math.max(0, Math.min(index, PO().length)), [id])
    })
    return id
  }
  function deleteProp(id) {
    tx(() => {
      S().delete(id)
      const i = PO().toArray().indexOf(id)
      if (i >= 0) PO().delete(i, 1)
      for (const v of views()) {
        const patch = {}
        if (v.groupBy === id) patch.groupBy = null
        if (v.dateProp === id) patch.dateProp = null
        if (v.filters?.some((f) => f.propId === id)) patch.filters = v.filters.filter((f) => f.propId !== id)
        if (v.sorts?.some((s) => s.propId === id)) patch.sorts = v.sorts.filter((s) => s.propId !== id)
        if (Object.keys(patch).length) V().set(v.id, { ...v, ...patch })
      }
    })
  }
  function moveProp(id, beforeId) {
    tx(() => {
      const order = PO().toArray()
      const from = order.indexOf(id)
      if (from >= 0) PO().delete(from, 1)
      const list = PO().toArray()
      const to = beforeId ? list.indexOf(beforeId) : -1
      PO().insert(to >= 0 ? to : list.length, [id])
    })
  }
  function updateView(id, patch) {
    const v = V().get(id)
    if (v) tx(() => V().set(id, { ...v, ...patch }))
  }
  function addView(type) {
    const id = uid()
    const label = VIEW_TYPES.find((v) => v.type === type)?.label || 'Vue'
    const view = { id, name: label, type, filters: [], sorts: [], hidden: [] }
    if (type === 'board') view.groupBy = props().find((p) => p.type === 'status' || p.type === 'select')?.id || null
    if (type === 'calendar') view.dateProp = props().find((p) => p.type === 'date')?.id || null
    tx(() => {
      V().set(id, view)
      VO().push([id])
    })
    setActiveView(id)
    return id
  }
  function deleteView(id) {
    if (views().length <= 1) return toast('Une base garde au moins une vue.')
    tx(() => {
      V().delete(id)
      const i = VO().toArray().indexOf(id)
      if (i >= 0) VO().delete(i, 1)
    })
    if (activeViewId === id) setActiveView(views()[0]?.id)
  }
  function setActiveView(id) {
    activeViewId = id
    try {
      localStorage.setItem(storageKey, id)
    } catch {
      /* préférence locale seulement */
    }
    scheduleRender()
  }

  function defaultStatusOptions() {
    return [
      { id: uid(), name: 'Pas commencé', color: 'default', group: 'todo' },
      { id: uid(), name: 'En cours', color: 'blue', group: 'progress' },
      { id: uid(), name: 'Terminé', color: 'green', group: 'done' },
    ]
  }
  // Ordre des couleurs des nouvelles options : vives d'abord, gris en dernier
  const OPTION_PALETTE = ['blue', 'green', 'yellow', 'orange', 'red', 'purple', 'pink', 'brown', 'gray']
  function nextColor(p) {
    return OPTION_PALETTE[(p.options || []).length % OPTION_PALETTE.length]
  }
  function createOption(propId, name, extra = {}) {
    const p = prop(propId)
    const option = { id: uid(), name: name.trim(), color: nextColor(p), ...extra }
    if (p.type === 'status' && !option.group) option.group = 'todo'
    updateProp(propId, { options: [...(p.options || []), option] })
    return option
  }
  function updateOption(propId, optionId, patch) {
    const p = prop(propId)
    updateProp(propId, { options: p.options.map((o) => (o.id === optionId ? { ...o, ...patch } : o)) })
  }
  function deleteOption(propId, optionId) {
    const p = prop(propId)
    tx(() => {
      S().set(propId, { ...p, options: p.options.filter((o) => o.id !== optionId) })
      for (const id of rowIds()) {
        const r = R().get(id)
        const v = r.get(propId)
        if (v === optionId) r.delete(propId)
        else if (Array.isArray(v) && v.includes(optionId)) r.set(propId, v.filter((x) => x !== optionId))
      }
    })
  }

  // Changement de type : on convertit ce qui peut l'être (texte <-> options, etc.)
  function changePropType(propId, type) {
    const p = prop(propId)
    if (!p || p.type === type || p.type === 'title') return
    const next = { ...p, type }
    delete next.format
    if (type === 'number') next.format = 'number'
    if (OPTION_TYPES.has(type)) {
      next.options = OPTION_TYPES.has(p.type)
        ? p.options.map((o) => ({ ...o, group: type === 'status' ? o.group || 'todo' : undefined }))
        : type === 'status'
          ? defaultStatusOptions()
          : []
    } else delete next.options
    tx(() => {
      const byName = new Map((next.options || []).map((o) => [normalize(o.name), o]))
      const ensure = (name) => {
        const key = normalize(name)
        if (!key) return null
        if (!byName.has(key)) {
          const o = { id: uid(), name: name.trim(), color: OPTION_PALETTE[next.options.length % OPTION_PALETTE.length] }
          if (type === 'status') o.group = 'todo'
          next.options.push(o)
          byName.set(key, o)
        }
        return byName.get(key).id
      }
      for (const id of rowIds()) {
        const r = R().get(id)
        const row = r.toJSON()
        if (isEmptyValue(p, row)) {
          r.delete(propId)
          continue
        }
        const text = cellText(p, row)
        let value
        switch (type) {
          case 'number': {
            const n = parseFloat(String(text).replace(/\s/g, '').replace(',', '.'))
            value = Number.isFinite(n) ? n : null
            break
          }
          case 'checkbox':
            value = row[propId] === true || /^(oui|yes|true|x|1)$/i.test(text)
            break
          case 'date':
            value = /^\d{4}-\d{2}-\d{2}/.test(String(row[propId])) ? String(row[propId]).slice(0, 10) : null
            break
          case 'select':
          case 'status':
            value = ensure(text.split(',')[0] || '')
            break
          case 'multi_select':
            value = text.split(',').map((s) => ensure(s)).filter(Boolean)
            break
          case 'person':
            value = Array.isArray(row[propId]) ? row[propId] : []
            break
          case 'created_time':
          case 'edited_time':
            value = null
            break
          default:
            value = text
        }
        if (value === null || value === undefined || (Array.isArray(value) && !value.length)) r.delete(propId)
        else r.set(propId, value)
      }
      S().set(propId, next)
    })
  }

  // --- chargement / migration -----------------------------------------------
  function loadInto(json) {
    root.set('schema', new Y.Map())
    root.set('propOrder', new Y.Array())
    root.set('rows', new Y.Map())
    root.set('rowOrder', new Y.Array())
    root.set('views', new Y.Map())
    root.set('viewOrder', new Y.Array())
    const putRow = (id, cells) => {
      const r = new Y.Map()
      R().set(id, r)
      for (const [k, v] of Object.entries(cells)) if (v !== undefined) r.set(k, v)
    }
    if (json?.version === 2) {
      for (const [id, p] of Object.entries(json.schema || {})) S().set(id, p)
      PO().push((json.propOrder || []).filter((id) => S().has(id)))
      for (const [id, cells] of Object.entries(json.rows || {})) putRow(id, cells)
      RO().push((json.rowOrder || []).filter((id) => R().has(id)))
      for (const [id, v] of Object.entries(json.views || {})) V().set(id, v)
      VO().push((json.viewOrder || []).filter((id) => V().has(id)))
      if (!VO().length) {
        const id = uid()
        V().set(id, { id, name: 'Tableau', type: 'table', filters: [], sorts: [], hidden: [] })
        VO().push([id])
      }
      return
    }
    if (json?.properties) {
      // Format v1 (première version de Yariche) : { properties: [...], rows: [{ id, cells }] }
      const v1Props = json.properties
      const titleSrc = v1Props.find((p) => p.type === 'text') || v1Props[0]
      const optionMaps = {}
      for (const p of v1Props) {
        const np = { id: p.id, name: p.name, type: p === titleSrc ? 'title' : p.type }
        if (p.type === 'select') {
          optionMaps[p.id] = {}
          np.options = (p.options || []).map((name, i) => {
            const o = { id: uid(), name, color: OPTION_PALETTE[i % OPTION_PALETTE.length] }
            optionMaps[p.id][name] = o.id
            return o
          })
        }
        if (p.type === 'number') np.format = 'number'
        S().set(np.id, np)
      }
      PO().push(v1Props.map((p) => p.id))
      for (const r of json.rows || []) {
        const cells = { _created: Date.now(), _edited: Date.now() }
        for (const [k, v] of Object.entries(r.cells || {})) {
          cells[k] = optionMaps[k] ? optionMaps[k][v] : v
        }
        putRow(r.id, cells)
      }
      RO().push((json.rows || []).map((r) => r.id))
      const tableId = uid()
      V().set(tableId, { id: tableId, name: 'Tableau', type: 'table', filters: [], sorts: [], hidden: [] })
      VO().push([tableId])
      const sel = v1Props.find((p) => p.type === 'select')
      if (sel) {
        const boardId = uid()
        V().set(boardId, { id: boardId, name: 'Kanban', type: 'board', groupBy: sel.id, filters: [], sorts: [], hidden: [] })
        VO().push([boardId])
      }
      return
    }
    // Nouvelle base : comme Notion, un titre, un statut, une date et 3 lignes vides
    const title = { id: 'title', name: 'Nom', type: 'title' }
    const status = { id: uid(), name: 'Statut', type: 'status', options: defaultStatusOptions() }
    const date = { id: uid(), name: 'Date', type: 'date' }
    for (const p of [title, status, date]) S().set(p.id, p)
    PO().push([title.id, status.id, date.id])
    const ids = [uid(), uid(), uid()]
    ids.forEach((id) => putRow(id, { _created: Date.now(), _edited: Date.now(), _createdBy: me.email }))
    RO().push(ids)
    const tableId = uid()
    const boardId = uid()
    V().set(tableId, { id: tableId, name: 'Tableau', type: 'table', filters: [], sorts: [], hidden: [] })
    V().set(boardId, { id: boardId, name: 'Kanban', type: 'board', groupBy: status.id, filters: [], sorts: [], hidden: [] })
    VO().push([tableId, boardId])
  }

  async function seed() {
    if (!isReady()) {
      const json = await api(`/api/doc/${encodeURIComponent(room)}/db`).catch(() => null)
      if (destroyed) return
      // Un autre client a pu initialiser pendant la requête
      if (!isReady()) ydoc.transact(() => loadInto(json))
    }
    undo.clear()
    render()
    if (openRowId) openPeek(openRowId)
  }

  function toJSON() {
    return {
      version: 2,
      schema: S().toJSON(),
      propOrder: PO().toArray(),
      rows: Object.fromEntries([...R().entries()].map(([id, r]) => [id, r.toJSON()])),
      rowOrder: RO().toArray(),
      views: V().toJSON(),
      viewOrder: VO().toArray(),
    }
  }

  let saveTimer = null
  function scheduleSave() {
    if (!editable || !isReady()) return
    clearTimeout(saveTimer)
    saveTimer = setTimeout(save, 900)
  }
  async function save() {
    saveTimer = null
    if (isReady()) await onSave(toJSON())
  }

  const undo = new Y.UndoManager(root, { trackedOrigins: new Set([LOCAL]), captureTimeout: 500 })

  let renderQueued = false
  function scheduleRender() {
    if (renderQueued || destroyed) return
    renderQueued = true
    requestAnimationFrame(() => {
      renderQueued = false
      if (!destroyed) render()
    })
  }
  const onDeepChange = () => {
    scheduleRender()
    scheduleSave()
  }
  root.observeDeep(onDeepChange)

  // --- pipeline de vue : recherche, filtres, tris ------------------------------
  function matchFilter(f, row) {
    const p = prop(f.propId)
    if (!p) return true
    const kind = filterKind(p.type)
    const v = cellValue(p, row)
    switch (f.op) {
      case 'empty':
        return isEmptyValue(p, row)
      case 'not_empty':
        return !isEmptyValue(p, row)
      case 'checked':
        return !!v
      case 'unchecked':
        return !v
    }
    if (f.value === undefined || f.value === null || f.value === '') return true
    if (kind === 'text') {
      const hay = normalize(cellText(p, row))
      const needle = normalize(f.value)
      if (f.op === 'contains') return hay.includes(needle)
      if (f.op === 'not_contains') return !hay.includes(needle)
      if (f.op === 'is') return hay === needle
      if (f.op === 'is_not') return hay !== needle
    }
    if (kind === 'number') {
      const n = Number(v)
      const x = Number(f.value)
      if (v === null || v === undefined || v === '') return false
      return { eq: n === x, neq: n !== x, gt: n > x, lt: n < x, gte: n >= x, lte: n <= x }[f.op] ?? true
    }
    if (kind === 'option') {
      if (f.op === 'is') return v === f.value
      if (f.op === 'is_not') return v !== f.value
    }
    if (kind === 'multi') {
      const arr = Array.isArray(v) ? v : []
      if (f.op === 'contains') return arr.includes(f.value)
      if (f.op === 'not_contains') return !arr.includes(f.value)
    }
    if (kind === 'date') {
      const day = p.type === 'date' ? String(v || '').slice(0, 10) : tsToIso(v)
      if (!day) return false
      if (f.op === 'is') return day === f.value
      if (f.op === 'before') return day < f.value
      if (f.op === 'after') return day > f.value
    }
    return true
  }

  function compareRows(p, a, b) {
    const va = cellValue(p, a)
    const vb = cellValue(p, b)
    const ea = isEmptyValue(p, a)
    const eb = isEmptyValue(p, b)
    if (ea || eb) return ea === eb ? 0 : ea ? 1 : -1
    if (p.type === 'number' || p.type === 'created_time' || p.type === 'edited_time') return Number(va) - Number(vb)
    if (p.type === 'checkbox') return (va ? 1 : 0) - (vb ? 1 : 0)
    if (p.type === 'select' || p.type === 'status') {
      const ia = p.options.findIndex((o) => o.id === va)
      const ib = p.options.findIndex((o) => o.id === vb)
      return ia - ib
    }
    if (p.type === 'date') return String(va).localeCompare(String(vb))
    return cellText(p, a).localeCompare(cellText(p, b), 'fr', { numeric: true, sensitivity: 'base' })
  }

  function visibleRows(view) {
    let list = rowIds().map((id) => ({ id, ...rowData(id) }))
    if (search.trim()) {
      const q = normalize(search.trim())
      list = list.filter((r) => props().some((p) => normalize(cellText(p, r)).includes(q)) || normalize(r._body).includes(q))
    }
    for (const f of view.filters || []) list = list.filter((r) => matchFilter(f, r))
    const sorts = (view.sorts || []).filter((s) => prop(s.propId))
    if (sorts.length) {
      list.sort((a, b) => {
        for (const s of sorts) {
          const p = prop(s.propId)
          // Les valeurs vides restent en bas quel que soit le sens (comme Notion)
          const ea = isEmptyValue(p, a)
          const eb = isEmptyValue(p, b)
          if (ea !== eb) return ea ? 1 : -1
          const c = compareRows(p, a, b)
          if (c) return s.dir === 'desc' ? -c : c
        }
        return 0
      })
    }
    return list
  }

  const shownProps = (view, { exclude = [] } = {}) =>
    props().filter((p) => !(view.hidden || []).includes(p.id) && !exclude.includes(p.id))

  // --- rendu des valeurs --------------------------------------------------------
  const tagHTML = (o) => (o ? `<span class="tag c-${o.color || 'default'}">${esc(o.name)}</span>` : '')
  const statusHTML = (o) =>
    o ? `<span class="status-pill c-${o.color || 'default'}"><i class="dot"></i>${esc(o.name)}</span>` : ''
  const personHTML = (email) =>
    `<span class="person"><span class="avatar-chip" style="background:${avatarColor(email)}">${esc(userName(email)[0]?.toUpperCase() || '?')}</span>${esc(userName(email))}</span>`

  function valueHTML(p, row, { compact = false } = {}) {
    const v = cellValue(p, row)
    switch (p.type) {
      case 'title':
        return v ? esc(v) : '<span class="muted">Sans titre</span>'
      case 'select':
        return tagHTML(p.options?.find((o) => o.id === v))
      case 'status':
        return statusHTML(p.options?.find((o) => o.id === v))
      case 'multi_select':
        return (Array.isArray(v) ? v : []).map((id) => tagHTML(p.options?.find((o) => o.id === id))).join('')
      case 'person':
        return (Array.isArray(v) ? v : []).map(personHTML).join('')
      case 'checkbox':
        return `<span class="db-check${v ? ' on' : ''}" data-check>${v ? icon('check', 12) : ''}</span>`
      case 'date':
        return v ? `<span class="db-date">${esc(fmtDate(v))}</span>` : ''
      case 'created_time':
      case 'edited_time':
        return v ? `<span class="db-date">${esc(fmtDateTime(v))}</span>` : ''
      case 'number':
        return esc(fmtNumber(p, v))
      case 'url': {
        if (!v) return ''
        // Lien seulement vers le web (ou mail, téléphone) : « javascript: » et autres
        // protocoles restent du texte (une cellule peut venir d'un invité)
        const href = safeHref(v)
        return href
          ? `<a class="db-link" href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(compact ? hostOf(v) : v)}</a>`
          : esc(v)
      }
      case 'email':
        return v ? `<a class="db-link" href="mailto:${esc(v)}">${esc(v)}</a>` : ''
      default:
        return esc(v ?? '')
    }
  }

  // --- popovers ------------------------------------------------------------------
  function closePopover({ commit = true } = {}) {
    if (!popover) return
    const fn = popoverCommit
    popoverCommit = null
    popover.remove()
    popover = null
    if (commit && fn) fn()
  }
  function openPopover(anchor, className, { cover = false, width = null, align = 'left' } = {}) {
    closePopover()
    const pop = document.createElement('div')
    pop.className = `popover db-pop ${className}`
    document.body.appendChild(pop)
    popover = pop
    const place = () => {
      const r = anchor.getBoundingClientRect()
      if (width) pop.style.width = `${Math.max(width, cover ? r.width : 0)}px`
      const w = pop.offsetWidth
      const h = pop.offsetHeight
      let left = align === 'right' ? r.right - w : r.left
      left = Math.max(8, Math.min(left, window.innerWidth - w - 8))
      let top = cover ? r.top : r.bottom + 4
      if (top + h > window.innerHeight - 8) top = Math.max(8, (cover ? r.bottom : r.top) - h - 4)
      pop.style.left = `${left}px`
      pop.style.top = `${top}px`
    }
    pop._place = place
    requestAnimationFrame(place)
    return pop
  }
  const onDocMouseDown = (e) => {
    if (!popover) return
    if (popover.contains(e.target) || e.target.closest('.db-pop')) return
    closePopover()
  }
  document.addEventListener('mousedown', onDocMouseDown, true)

  // Menu simple (items : { label, icon?, danger?, checked?, run, keepOpen? } | 'sep' | { header })
  function openMenu(anchor, items, { align = 'left', width = 240 } = {}) {
    const pop = openPopover(anchor, 'db-menu', { width, align })
    fillMenu(pop, items)
    return pop
  }
  function fillMenu(pop, items) {
    pop.innerHTML = ''
    for (const item of items) {
      if (!item) continue
      if (item === 'sep') {
        pop.insertAdjacentHTML('beforeend', '<div class="menu-sep"></div>')
        continue
      }
      if (item.header) {
        pop.insertAdjacentHTML('beforeend', `<div class="db-menu-header">${esc(item.header)}</div>`)
        continue
      }
      if (item.element) {
        pop.appendChild(item.element)
        continue
      }
      const b = document.createElement('button')
      b.className = 'menu-item' + (item.danger ? ' danger' : '')
      b.innerHTML = `${item.iconHTML || (item.icon ? icon(item.icon, 16) : '')}<span>${esc(item.label)}</span>${item.hint ? `<span class="menu-hint">${esc(item.hint)}</span>` : ''}${item.checked !== undefined ? `<span class="menu-check">${item.checked ? icon('check', 14) : ''}</span>` : ''}${item.submenu ? `<span class="menu-hint">${icon('chevron', 14)}</span>` : ''}`
      b.onclick = (e) => {
        e.stopPropagation()
        if (!item.keepOpen) closePopover()
        item.run?.(b)
      }
      pop.appendChild(b)
    }
    pop._place?.()
  }

  // --- éditeurs de cellule ---------------------------------------------------------
  function openCellEditor(anchor, rowId, p) {
    if (!editable || READONLY_TYPES.has(p.type)) return
    const row = rowData(rowId)
    if (!row) return
    if (p.type === 'checkbox') return setCell(rowId, p.id, !row[p.id])
    if (OPTION_TYPES.has(p.type)) return openOptionEditor(anchor, rowId, p)
    if (p.type === 'person') return openPersonEditor(anchor, rowId, p)
    if (p.type === 'date') return openDateEditor(anchor, rowId, p)
    // Texte, titre, nombre, URL, e-mail : champ en surimpression de la cellule
    const pop = openPopover(anchor, 'db-text-editor', { cover: true, width: 280 })
    const multiline = p.type === 'text' || p.type === 'title'
    const input = document.createElement(multiline ? 'textarea' : 'input')
    if (!multiline) input.type = p.type === 'number' ? 'number' : p.type === 'email' ? 'email' : 'text'
    if (p.type === 'number') input.step = 'any'
    input.value = row[p.id] ?? ''
    if (multiline) input.rows = 1
    pop.appendChild(input)
    const autosize = () => {
      if (!multiline) return
      input.style.height = 'auto'
      input.style.height = `${Math.min(input.scrollHeight, 300)}px`
    }
    input.addEventListener('input', autosize)
    let cancelled = false
    popoverCommit = () => {
      if (cancelled) return
      let value = input.value
      if (p.type === 'number') value = value === '' ? null : Number(value)
      else value = value.replace(/\s+$/, '')
      const prev = row[p.id] ?? (p.type === 'number' ? null : '')
      if (value !== prev) {
        if (value === null || value === '') {
          const r = R().get(rowId)
          if (r) tx(() => {
            r.delete(p.id)
            touch(r)
          })
        } else setCell(rowId, p.id, value)
      }
    }
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !(multiline && e.shiftKey)) {
        e.preventDefault()
        closePopover()
      } else if (e.key === 'Escape') {
        cancelled = true
        closePopover()
      }
    })
    requestAnimationFrame(() => {
      autosize()
      input.focus()
      input.select?.()
    })
  }

  function openOptionEditor(anchor, rowId, p) {
    const pop = openPopover(anchor, 'db-option-editor', { cover: true, width: 300 })
    const multi = p.type === 'multi_select'
    let query = ''
    let highlighted = 0
    let rows = []
    // Structure fixe : zone d'étiquettes + champ (jamais recréé, sinon on perd des frappes) + liste
    pop.innerHTML = '<div class="opt-top"><span class="opt-chips"></span><input /></div><div class="opt-list"></div>'
    const chipsEl = pop.querySelector('.opt-chips')
    const input = pop.querySelector('input')
    const listEl = pop.querySelector('.opt-list')
    const current = () => {
      const row = rowData(rowId) || {}
      const v = row[p.id]
      return multi ? (Array.isArray(v) ? v : []) : v ? [v] : []
    }
    const setValue = (ids) => {
      const r = R().get(rowId)
      if (!r) return
      tx(() => {
        if (!ids.length) r.delete(p.id)
        else r.set(p.id, multi ? ids : ids[0])
        touch(r)
      })
    }
    const pick = (option) => {
      if (multi) {
        const cur = current()
        setValue(cur.includes(option.id) ? cur.filter((x) => x !== option.id) : [...cur, option.id])
        query = ''
        input.value = ''
        draw()
      } else {
        setValue([option.id])
        closePopover()
      }
    }
    const highlight = () => rows.forEach((r, i) => r.el.classList.toggle('selected', i === highlighted))
    const draw = () => {
      const fresh = prop(p.id)
      if (!fresh) return closePopover()
      const selected = current()
      const opts = (fresh.options || []).filter((o) => normalize(o.name).includes(normalize(query)))
      const exact = (fresh.options || []).some((o) => normalize(o.name) === normalize(query.trim()))
      chipsEl.innerHTML = selected
        .map((id) => fresh.options.find((o) => o.id === id))
        .filter(Boolean)
        .map((o) => `<span class="tag c-${o.color}">${esc(o.name)}<button class="tag-x" data-remove="${esc(o.id)}">×</button></span>`)
        .join('')
      input.placeholder = selected.length ? '' : 'Rechercher ou créer une option…'
      chipsEl.querySelectorAll('[data-remove]').forEach((b) =>
        b.addEventListener('mousedown', (e) => {
          e.preventDefault()
          setValue(current().filter((x) => x !== b.dataset.remove))
          draw()
        })
      )
      listEl.innerHTML = `<div class="db-menu-header">${opts.length || query ? 'Sélectionne une option ou crée-en une' : 'Aucune option : tape pour en créer une'}</div>`
      rows = []
      const groups = fresh.type === 'status' ? STATUS_GROUPS : [{ id: null }]
      for (const g of groups) {
        const inGroup = opts.filter((o) => g.id === null || (o.group || 'todo') === g.id)
        if (g.id && !inGroup.length) continue
        if (g.id) listEl.insertAdjacentHTML('beforeend', `<div class="opt-group">${esc(g.label)}</div>`)
        for (const o of inGroup) {
          const item = document.createElement('div')
          item.className = 'opt-item'
          item.innerHTML = `${fresh.type === 'status' ? statusHTML(o) : tagHTML(o)}<span class="topbar-spacer"></span>${selected.includes(o.id) ? `<span class="menu-check">${icon('check', 14)}</span>` : ''}<button class="opt-more" title="Modifier">${icon('more', 14)}</button>`
          item.addEventListener('mousedown', (e) => {
            if (e.target.closest('.opt-more')) return
            e.preventDefault()
            pick(o)
          })
          item.querySelector('.opt-more').addEventListener('mousedown', (e) => {
            e.preventDefault()
            e.stopPropagation()
            openOptionSettings(item.querySelector('.opt-more'), p.id, o, draw)
          })
          rows.push({ el: item, run: () => pick(o) })
          listEl.appendChild(item)
        }
      }
      if (query.trim() && !exact) {
        const create = document.createElement('div')
        create.className = 'opt-item create'
        create.innerHTML = `<span class="muted">Créer</span> <span class="tag c-${nextColor(fresh)}">${esc(query.trim())}</span>`
        const doCreate = () => {
          const o = createOption(p.id, query.trim())
          query = ''
          input.value = ''
          pick(o)
        }
        create.addEventListener('mousedown', (e) => {
          e.preventDefault()
          doCreate()
        })
        rows.push({ el: create, run: doCreate })
        listEl.appendChild(create)
      }
      highlighted = Math.min(highlighted, Math.max(0, rows.length - 1))
      highlight()
      pop._place?.()
    }
    input.addEventListener('input', () => {
      query = input.value
      highlighted = 0
      draw()
    })
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        if (!rows.length) return
        highlighted = (highlighted + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length
        highlight()
      } else if (e.key === 'Enter') {
        e.preventDefault()
        rows[highlighted]?.run()
      } else if (e.key === 'Escape') {
        closePopover()
      } else if (e.key === 'Backspace' && !input.value && current().length) {
        setValue(current().slice(0, -1))
        draw()
      }
    })
    draw()
    requestAnimationFrame(() => input.focus())
  }

  function openOptionSettings(anchor, propId, option, redraw) {
    // Petit panneau imbriqué : renommer, couleur, groupe (statut), supprimer
    const sub = document.createElement('div')
    sub.className = 'popover db-pop db-menu opt-settings'
    document.body.appendChild(sub)
    const r = anchor.getBoundingClientRect()
    sub.style.left = `${Math.min(r.right + 6, window.innerWidth - 230)}px`
    sub.style.top = `${Math.max(8, Math.min(r.top - 8, window.innerHeight - 420))}px`
    const p = prop(propId)
    sub.innerHTML = `<div class="opt-rename"><input value="${esc(option.name)}" /></div>
      <button class="menu-item danger" data-del>${icon('trash', 16)}<span>Supprimer</span></button>
      ${p.type === 'status' ? `<div class="db-menu-header">Groupe</div>${STATUS_GROUPS.map((g) => `<button class="menu-item" data-group="${g.id}"><span>${esc(g.label)}</span><span class="menu-check">${(option.group || 'todo') === g.id ? icon('check', 14) : ''}</span></button>`).join('')}` : ''}
      <div class="db-menu-header">Couleurs</div>
      ${COLORS.map((c) => `<button class="menu-item" data-color="${c}"><span class="swatch c-${c}"></span><span>${COLOR_LABELS[c]}</span><span class="menu-check">${option.color === c ? icon('check', 14) : ''}</span></button>`).join('')}`
    const input = sub.querySelector('input')
    const close = () => {
      const name = input.value.trim()
      if (name && name !== option.name) updateOption(propId, option.id, { name })
      sub.remove()
      document.removeEventListener('mousedown', outside, true)
      redraw?.()
    }
    const outside = (e) => {
      if (!sub.contains(e.target)) {
        e.stopPropagation()
        close()
      }
    }
    setTimeout(() => document.addEventListener('mousedown', outside, true), 0)
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === 'Escape') {
        e.preventDefault()
        close()
      }
    })
    sub.querySelector('[data-del]').onmousedown = (e) => {
      e.preventDefault()
      deleteOption(propId, option.id)
      input.value = option.name
      close()
    }
    sub.querySelectorAll('[data-color]').forEach((b) =>
      b.addEventListener('mousedown', (e) => {
        e.preventDefault()
        updateOption(propId, option.id, { color: b.dataset.color })
        option = { ...option, color: b.dataset.color }
        close()
      })
    )
    sub.querySelectorAll('[data-group]').forEach((b) =>
      b.addEventListener('mousedown', (e) => {
        e.preventDefault()
        updateOption(propId, option.id, { group: b.dataset.group })
        close()
      })
    )
    setTimeout(() => input.focus(), 0)
  }

  function openPersonEditor(anchor, rowId, p) {
    const pop = openPopover(anchor, 'db-option-editor', { cover: true, width: 300 })
    pop.innerHTML = '<div class="opt-top"><input placeholder="Rechercher une personne…" /></div><div class="opt-list"></div>'
    const input = pop.querySelector('input')
    const listEl = pop.querySelector('.opt-list')
    const current = () => {
      const v = rowData(rowId)?.[p.id]
      return Array.isArray(v) ? v : []
    }
    const draw = () => {
      const q = normalize(input.value)
      const list = users().filter((u) => normalize(u.name).includes(q) || normalize(u.email).includes(q))
      listEl.innerHTML = list.length ? '' : '<div class="empty-hint">Aucune personne trouvée</div>'
      for (const u of list) {
        const item = document.createElement('div')
        item.className = 'opt-item'
        item.innerHTML = `${personHTML(u.email)}<span class="topbar-spacer"></span>${current().includes(u.email) ? `<span class="menu-check">${icon('check', 14)}</span>` : ''}`
        item.addEventListener('mousedown', (e) => {
          e.preventDefault()
          const cur = current()
          const next = cur.includes(u.email) ? cur.filter((x) => x !== u.email) : [...cur, u.email]
          const r = R().get(rowId)
          tx(() => {
            if (next.length) r.set(p.id, next)
            else r.delete(p.id)
            touch(r)
          })
          draw()
        })
        listEl.appendChild(item)
      }
      pop._place?.()
    }
    input.addEventListener('input', draw)
    input.addEventListener('keydown', (e) => e.key === 'Escape' && closePopover())
    draw()
    requestAnimationFrame(() => input.focus())
  }

  function openDateEditor(anchor, rowId, p) {
    const pop = openPopover(anchor, 'db-date-editor', { cover: false, width: 260 })
    const v = rowData(rowId)?.[p.id] || ''
    pop.innerHTML = `<input type="date" value="${esc(String(v).slice(0, 10))}" />
      <div class="db-date-actions"><button class="ghost-btn" data-today>Aujourd'hui</button><button class="ghost-btn" data-clear>Effacer</button></div>`
    const input = pop.querySelector('input')
    const apply = (value) => {
      const r = R().get(rowId)
      if (!r) return
      tx(() => {
        if (value) r.set(p.id, value)
        else r.delete(p.id)
        touch(r)
      })
    }
    input.addEventListener('change', () => apply(input.value))
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === 'Escape') closePopover()
    })
    pop.querySelector('[data-today]').onclick = () => {
      apply(isoDay(new Date()))
      closePopover()
    }
    pop.querySelector('[data-clear]').onclick = () => {
      apply(null)
      closePopover()
    }
    requestAnimationFrame(() => {
      input.focus()
      try {
        input.showPicker?.()
      } catch {
        /* showPicker exige un geste utilisateur selon les navigateurs */
      }
    })
  }

  // --- menus de propriétés ------------------------------------------------------
  function typeMenuItems(onPick, current = null) {
    return PROP_TYPES.map((t) => ({
      label: t.label,
      icon: t.icon,
      checked: current ? current === t.type : undefined,
      run: () => onPick(t.type),
    }))
  }

  function openAddPropMenu(anchor, { index = null, onDone = null } = {}) {
    openMenu(anchor, [{ header: 'Type de propriété' }, ...typeMenuItems((type) => {
      const id = addProp(type, { index })
      onDone?.(id)
      requestAnimationFrame(() => {
        const head = container.querySelector(`.dbt-th[data-prop="${CSS.escape(id)}"]`)
        if (head) openPropMenu(head, id, { rename: true })
      })
    })])
  }

  function openPropMenu(anchor, propId, { rename = false } = {}) {
    const p = prop(propId)
    if (!p) return
    const view = currentView()
    const renameRow = document.createElement('div')
    renameRow.className = 'opt-rename'
    renameRow.innerHTML = `<span class="rename-icon">${icon(TYPE_ICON[p.type], 16)}</span><input value="${esc(p.name)}" ${editable ? '' : 'disabled'} />`
    const input = renameRow.querySelector('input')
    const commitName = () => {
      const name = input.value.trim()
      if (editable && name && name !== prop(propId)?.name) updateProp(propId, { name })
    }
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        closePopover()
      }
    })
    const items = [
      { element: renameRow },
      editable && p.type !== 'title'
        ? { label: `Type : ${TYPE_LABEL[p.type]}`, icon: TYPE_ICON[p.type], submenu: true, keepOpen: true,
            run: () => {
              commitName()
              openMenu(anchor, [{ header: 'Changer le type' }, ...typeMenuItems((type) => changePropType(propId, type), p.type)])
            } }
        : null,
      editable && OPTION_TYPES.has(p.type)
        ? { label: 'Modifier les options', icon: 'select', keepOpen: true, run: () => openOptionsManager(anchor, propId) }
        : null,
      editable && p.type === 'number'
        ? { label: 'Format du nombre', icon: 'hash', keepOpen: true, run: () =>
            openMenu(anchor, [['number', 'Nombre'], ['percent', 'Pourcentage'], ['euro', 'Euro'], ['dollar', 'Dollar']].map(([f, label]) => ({
              label, checked: (p.format || 'number') === f, run: () => updateProp(propId, { format: f }),
            }))) }
        : null,
      'sep',
      { label: 'Trier par ordre croissant', icon: 'sortAsc', run: () => updateView(view.id, { sorts: [{ propId, dir: 'asc' }] }) },
      { label: 'Trier par ordre décroissant', icon: 'sortDesc', run: () => updateView(view.id, { sorts: [{ propId, dir: 'desc' }] }) },
      { label: 'Filtrer', icon: 'filter', run: () => addFilter(propId) },
      p.type !== 'title' ? { label: 'Masquer dans la vue', icon: 'eyeOff', run: () => updateView(view.id, { hidden: [...new Set([...(view.hidden || []), propId])] }) } : null,
      editable ? 'sep' : null,
      editable ? { label: 'Insérer à gauche', icon: 'arrowLeft', run: () => openAddPropMenu(anchor, { index: PO().toArray().indexOf(propId) }) } : null,
      editable ? { label: 'Insérer à droite', icon: 'arrowRight', run: () => openAddPropMenu(anchor, { index: PO().toArray().indexOf(propId) + 1 }) } : null,
      editable && p.type !== 'title'
        ? { label: 'Dupliquer la propriété', icon: 'copy', run: () => {
            const id = uid()
            const copy = { ...structuredClone(p), id, name: `${p.name} (copie)` }
            tx(() => {
              S().set(id, copy)
              PO().insert(PO().toArray().indexOf(propId) + 1, [id])
              for (const rid of rowIds()) {
                const r = R().get(rid)
                if (r.has(propId)) r.set(id, structuredClone(r.get(propId)))
              }
            })
          } }
        : null,
      editable && p.type !== 'title'
        ? { label: 'Supprimer la propriété', icon: 'trash', danger: true, run: () => {
            if (confirm(`Supprimer la propriété « ${p.name} » et ses valeurs ?`)) deleteProp(propId)
          } }
        : null,
    ]
    openMenu(anchor, items, { width: 260 })
    popoverCommit = commitName
    if (rename) requestAnimationFrame(() => {
      input.focus()
      input.select()
    })
  }

  function openOptionsManager(anchor, propId) {
    const pop = openPopover(anchor, 'db-menu', { width: 280 })
    const draw = () => {
      const p = prop(propId)
      pop.innerHTML = `<div class="db-menu-header">Options de « ${esc(p.name)} »</div>`
      const listEl = document.createElement('div')
      listEl.className = 'opt-list'
      const groups = p.type === 'status' ? STATUS_GROUPS : [{ id: null }]
      for (const g of groups) {
        if (g.id) listEl.insertAdjacentHTML('beforeend', `<div class="opt-group">${esc(g.label)}</div>`)
        for (const o of p.options.filter((x) => g.id === null || (x.group || 'todo') === g.id)) {
          const item = document.createElement('div')
          item.className = 'opt-item'
          item.innerHTML = `${p.type === 'status' ? statusHTML(o) : tagHTML(o)}<span class="topbar-spacer"></span><button class="opt-more">${icon('more', 14)}</button>`
          item.querySelector('.opt-more').addEventListener('mousedown', (e) => {
            e.preventDefault()
            e.stopPropagation()
            openOptionSettings(item.querySelector('.opt-more'), propId, o, draw)
          })
          listEl.appendChild(item)
        }
      }
      pop.appendChild(listEl)
      const add = document.createElement('div')
      add.className = 'opt-rename'
      add.innerHTML = `<span class="rename-icon">${icon('plus', 16)}</span><input placeholder="Nouvelle option…" />`
      add.querySelector('input').addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && e.target.value.trim()) {
          createOption(propId, e.target.value.trim())
          draw()
          pop.querySelector('.opt-rename:last-child input')?.focus()
        } else if (e.key === 'Escape') closePopover()
      })
      pop.appendChild(add)
      pop._place?.()
    }
    draw()
  }

  // --- filtres & tris ------------------------------------------------------------
  function addFilter(propId) {
    const view = currentView()
    const p = prop(propId)
    const kind = filterKind(p.type)
    const f = { id: uid(), propId, op: FILTER_OPS[kind][0][0], value: '' }
    updateView(view.id, { filters: [...(view.filters || []), f] })
    requestAnimationFrame(() => {
      const chip = chipsEl.querySelector(`[data-filter="${CSS.escape(f.id)}"]`)
      if (chip) openFilterEditor(chip, f.id)
    })
  }

  function openFilterEditor(anchor, filterId) {
    const view = currentView()
    const f = (view.filters || []).find((x) => x.id === filterId)
    if (!f) return
    const p = prop(f.propId)
    const kind = filterKind(p.type)
    const pop = openPopover(anchor, 'db-filter-editor', { width: 300 })
    const save = (patch) => {
      const v = currentView()
      updateView(v.id, { filters: v.filters.map((x) => (x.id === filterId ? { ...x, ...patch } : x)) })
    }
    const draw = () => {
      const cur = (currentView().filters || []).find((x) => x.id === filterId) || f
      pop.innerHTML = `<div class="filter-head"><span>${icon(TYPE_ICON[p.type], 14)} ${esc(p.name)}</span>
        <select>${FILTER_OPS[kind].map(([op, label]) => `<option value="${op}" ${cur.op === op ? 'selected' : ''}>${esc(label)}</option>`).join('')}</select>
        <button class="icon-btn" data-remove title="Supprimer le filtre">${icon('trash', 14)}</button></div>
        <div class="filter-value"></div>`
      pop.querySelector('select').onchange = (e) => {
        save({ op: e.target.value })
        draw()
      }
      pop.querySelector('[data-remove]').onclick = () => {
        const v = currentView()
        updateView(v.id, { filters: v.filters.filter((x) => x.id !== filterId) })
        closePopover({ commit: false })
      }
      const valueEl = pop.querySelector('.filter-value')
      if (NO_VALUE_OPS.has(cur.op)) return pop._place?.()
      if (kind === 'text' || kind === 'number') {
        valueEl.innerHTML = `<input type="${kind === 'number' ? 'number' : 'text'}" placeholder="Valeur…" value="${esc(cur.value ?? '')}" />`
        const input = valueEl.querySelector('input')
        input.addEventListener('input', () => save({ value: input.value }))
        input.addEventListener('keydown', (e) => e.key === 'Enter' && closePopover())
        requestAnimationFrame(() => input.focus())
      } else if (kind === 'date') {
        valueEl.innerHTML = `<input type="date" value="${esc(cur.value || '')}" />`
        valueEl.querySelector('input').addEventListener('change', (e) => save({ value: e.target.value }))
      } else {
        const choices =
          p.type === 'person'
            ? users().map((u) => ({ id: u.email, html: personHTML(u.email) }))
            : (p.options || []).map((o) => ({ id: o.id, html: p.type === 'status' ? statusHTML(o) : tagHTML(o) }))
        valueEl.innerHTML = choices.length ? '' : '<div class="empty-hint">Aucune option</div>'
        for (const c of choices) {
          const item = document.createElement('div')
          item.className = 'opt-item'
          item.innerHTML = `${c.html}<span class="topbar-spacer"></span>${cur.value === c.id ? `<span class="menu-check">${icon('check', 14)}</span>` : ''}`
          item.onclick = () => {
            save({ value: cur.value === c.id ? '' : c.id })
            draw()
          }
          valueEl.appendChild(item)
        }
      }
      pop._place?.()
    }
    draw()
  }

  function openPropPicker(anchor, onPick, { exclude = [] } = {}) {
    openMenu(anchor, [
      { header: 'Propriété' },
      ...props()
        .filter((p) => !exclude.includes(p.id))
        .map((p) => ({ label: p.name, icon: TYPE_ICON[p.type], run: () => onPick(p.id) })),
    ])
  }

  function openSortEditor(anchor) {
    const pop = openPopover(anchor, 'db-sort-editor', { width: 340 })
    const draw = () => {
      const view = currentView()
      const sorts = view.sorts || []
      pop.innerHTML = sorts.length ? '' : '<div class="empty-hint">Aucun tri.</div>'
      sorts.forEach((s, i) => {
        const p = prop(s.propId)
        if (!p) return
        const row = document.createElement('div')
        row.className = 'sort-row'
        row.innerHTML = `<select data-prop>${props().map((x) => `<option value="${esc(x.id)}" ${x.id === s.propId ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select>
          <select data-dir><option value="asc" ${s.dir !== 'desc' ? 'selected' : ''}>Croissant</option><option value="desc" ${s.dir === 'desc' ? 'selected' : ''}>Décroissant</option></select>
          <button class="icon-btn" title="Retirer">${icon('x', 14)}</button>`
        row.querySelector('[data-prop]').onchange = (e) => {
          const next = [...sorts]
          next[i] = { ...s, propId: e.target.value }
          updateView(view.id, { sorts: next })
          draw()
        }
        row.querySelector('[data-dir]').onchange = (e) => {
          const next = [...sorts]
          next[i] = { ...s, dir: e.target.value }
          updateView(view.id, { sorts: next })
        }
        row.querySelector('button').onclick = () => {
          updateView(view.id, { sorts: sorts.filter((_, j) => j !== i) })
          draw()
        }
        pop.appendChild(row)
      })
      const add = document.createElement('button')
      add.className = 'ghost-btn'
      add.innerHTML = `${icon('plus', 14)}<span>Ajouter un tri</span>`
      add.onclick = () => {
        const used = new Set(sorts.map((s) => s.propId))
        const next = props().find((p) => !used.has(p.id))
        if (next) {
          updateView(view.id, { sorts: [...sorts, { propId: next.id, dir: 'asc' }] })
          draw()
        }
      }
      pop.appendChild(add)
      pop._place?.()
    }
    draw()
  }

  // --- barre d'outils ----------------------------------------------------------------
  function renderTabs() {
    const view = currentView()
    tabsEl.innerHTML = ''
    for (const v of views()) {
      const b = document.createElement('button')
      b.className = 'db-tab' + (v.id === view.id ? ' active' : '')
      b.innerHTML = `${icon(VIEW_ICON[v.type] || 'table', 16)}<span>${esc(v.name)}</span>`
      b.onclick = () => (v.id === view.id && editable ? openViewMenu(b) : setActiveView(v.id))
      b.oncontextmenu = (e) => {
        e.preventDefault()
        setActiveView(v.id)
        requestAnimationFrame(() => openViewMenu(tabsEl.querySelector('.db-tab.active')))
      }
      tabsEl.appendChild(b)
    }
    if (editable) {
      const add = document.createElement('button')
      add.className = 'db-tab add'
      add.title = 'Ajouter une vue'
      add.innerHTML = icon('plus', 16)
      add.onclick = () =>
        openMenu(add, [{ header: 'Nouvelle vue' }, ...VIEW_TYPES.map((t) => ({ label: t.label, icon: t.icon, run: () => addView(t.type) }))])
      tabsEl.appendChild(add)
    }
  }

  function openViewMenu(anchor) {
    const view = currentView()
    const renameRow = document.createElement('div')
    renameRow.className = 'opt-rename'
    renameRow.innerHTML = `<span class="rename-icon">${icon(VIEW_ICON[view.type], 16)}</span><input value="${esc(view.name)}" />`
    const input = renameRow.querySelector('input')
    input.addEventListener('keydown', (e) => e.key === 'Enter' && closePopover())
    const groupable = props().filter((p) => p.type === 'select' || p.type === 'status')
    const dates = props().filter((p) => p.type === 'date' || p.type === 'created_time' || p.type === 'edited_time')
    const items = [
      { element: renameRow },
      { header: 'Disposition' },
      ...VIEW_TYPES.map((t) => ({
        label: t.label,
        icon: t.icon,
        checked: view.type === t.type,
        run: () => {
          const patch = { type: t.type }
          if (t.type === 'board' && !view.groupBy) patch.groupBy = groupable[0]?.id || null
          if (t.type === 'calendar' && !view.dateProp) patch.dateProp = dates[0]?.id || null
          updateView(view.id, patch)
        },
      })),
      view.type === 'board' ? { header: 'Grouper par' } : null,
      ...(view.type === 'board'
        ? groupable.map((p) => ({ label: p.name, icon: TYPE_ICON[p.type], checked: view.groupBy === p.id, run: () => updateView(view.id, { groupBy: p.id }) }))
        : []),
      view.type === 'calendar' ? { header: 'Afficher le calendrier par' } : null,
      ...(view.type === 'calendar'
        ? dates.map((p) => ({ label: p.name, icon: TYPE_ICON[p.type], checked: view.dateProp === p.id, run: () => updateView(view.id, { dateProp: p.id }) }))
        : []),
      'sep',
      { label: 'Propriétés affichées', icon: 'eye', keepOpen: true, run: () => openVisibilityMenu(anchor) },
      { label: 'Dupliquer la vue', icon: 'copy', run: () => {
          const id = uid()
          tx(() => {
            V().set(id, { ...structuredClone(view), id, name: `${view.name} (copie)` })
            VO().insert(VO().toArray().indexOf(view.id) + 1, [id])
          })
          setActiveView(id)
        } },
      views().length > 1 ? { label: 'Supprimer la vue', icon: 'trash', danger: true, run: () => deleteView(view.id) } : null,
    ]
    openMenu(anchor, items, { width: 260 })
    popoverCommit = () => {
      const name = input.value.trim()
      if (name && name !== view.name) updateView(view.id, { name })
    }
    requestAnimationFrame(() => input.focus())
  }

  function openVisibilityMenu(anchor) {
    const pop = openPopover(anchor, 'db-menu', { width: 260 })
    const draw = () => {
      const view = currentView()
      pop.innerHTML = '<div class="db-menu-header">Propriétés affichées</div>'
      for (const p of props()) {
        const hidden = (view.hidden || []).includes(p.id)
        const b = document.createElement('button')
        b.className = 'menu-item'
        b.innerHTML = `${icon(TYPE_ICON[p.type], 16)}<span>${esc(p.name)}</span><span class="menu-hint">${p.type === 'title' ? '' : icon(hidden ? 'eyeOff' : 'eye', 16)}</span>`
        if (p.type !== 'title') {
          b.onclick = () => {
            const v = currentView()
            const set = new Set(v.hidden || [])
            if (set.has(p.id)) set.delete(p.id)
            else set.add(p.id)
            updateView(v.id, { hidden: [...set] })
            draw()
          }
        }
        pop.appendChild(b)
      }
      pop._place?.()
    }
    draw()
  }

  function renderChips(view) {
    const filters = view.filters || []
    const sorts = (view.sorts || []).filter((s) => prop(s.propId))
    const show = filters.length || sorts.length
    chipsEl.classList.toggle('hidden', !show)
    container.querySelector('[data-tool="filter"]').classList.toggle('on', filters.length > 0)
    container.querySelector('[data-tool="sort"]').classList.toggle('on', sorts.length > 0)
    if (!show) return
    chipsEl.innerHTML = ''
    if (sorts.length) {
      const chip = document.createElement('button')
      chip.className = 'db-chip on'
      const first = prop(sorts[0].propId)
      chip.innerHTML = `${icon(sorts[0].dir === 'desc' ? 'sortDesc' : 'sortAsc', 14)}<span>${sorts.length > 1 ? `${sorts.length} tris` : esc(first.name)}</span>${icon('chevronDown', 12)}`
      chip.onclick = () => openSortEditor(chip)
      chipsEl.appendChild(chip)
      if (filters.length) chipsEl.insertAdjacentHTML('beforeend', '<span class="db-chip-sep"></span>')
    }
    for (const f of filters) {
      const p = prop(f.propId)
      if (!p) continue
      const opLabel = FILTER_OPS[filterKind(p.type)].find(([op]) => op === f.op)?.[1] || ''
      let valueLabel = ''
      if (!NO_VALUE_OPS.has(f.op) && f.value !== '' && f.value != null) {
        if (OPTION_TYPES.has(p.type)) valueLabel = p.options.find((o) => o.id === f.value)?.name || ''
        else if (p.type === 'person') valueLabel = userName(f.value)
        else if (filterKind(p.type) === 'date') valueLabel = fmtDate(f.value)
        else valueLabel = f.value
      }
      const chip = document.createElement('button')
      chip.className = 'db-chip' + (valueLabel || NO_VALUE_OPS.has(f.op) ? ' on' : '')
      chip.dataset.filter = f.id
      chip.innerHTML = `${icon(TYPE_ICON[p.type], 14)}<span>${esc(p.name)}${valueLabel || NO_VALUE_OPS.has(f.op) ? ` : ${esc(NO_VALUE_OPS.has(f.op) ? opLabel : `${f.op === 'is' || f.op === 'contains' ? '' : `${opLabel} `}${valueLabel}`)}` : ''}</span>${icon('chevronDown', 12)}`
      chip.onclick = () => openFilterEditor(chip, f.id)
      chipsEl.appendChild(chip)
    }
    const add = document.createElement('button')
    add.className = 'db-chip ghost'
    add.innerHTML = `${icon('plus', 14)}<span>Filtre</span>`
    add.onclick = () => openPropPicker(add, (id) => addFilter(id))
    chipsEl.appendChild(add)
  }

  container.querySelector('[data-tool="filter"]').onclick = (e) =>
    openPropPicker(e.currentTarget, (id) => addFilter(id))
  container.querySelector('[data-tool="sort"]').onclick = (e) => {
    const view = currentView()
    if ((view.sorts || []).length) return openSortEditor(e.currentTarget)
    openPropPicker(e.currentTarget, (id) => updateView(view.id, { sorts: [{ propId: id, dir: 'asc' }] }))
  }
  container.querySelector('[data-tool="settings"]').onclick = (e) => openViewMenu(e.currentTarget)
  container.querySelector('[data-tool="search"]').onclick = () => {
    searchOpen = !searchOpen || !!search
    searchWrap.classList.toggle('hidden', !searchOpen)
    if (searchOpen) searchInput.focus()
  }
  searchInput.addEventListener('input', () => {
    search = searchInput.value
    scheduleRender()
  })
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      search = ''
      searchInput.value = ''
      searchOpen = false
      searchWrap.classList.add('hidden')
      scheduleRender()
    }
  })
  container.querySelector('.db-new')?.addEventListener('click', () => {
    const view = currentView()
    addRow(defaultsForView(view), { open: true })
  })

  // Valeurs par défaut d'une nouvelle ligne : on respecte les filtres "est" de la vue
  // (sinon la ligne créée disparaîtrait aussitôt, comme le fait Notion)
  function defaultsForView(view, extra = {}) {
    const init = {}
    for (const f of view.filters || []) {
      const p = prop(f.propId)
      if (!p || f.value === '' || f.value == null) continue
      if ((p.type === 'select' || p.type === 'status') && f.op === 'is') init[p.id] = f.value
      if ((p.type === 'multi_select' || p.type === 'person') && f.op === 'contains') init[p.id] = [f.value]
      if (p.type === 'checkbox' && f.op === 'checked') init[p.id] = true
      if (filterKind(p.type) === 'text' && (f.op === 'is' || f.op === 'contains') && p.type !== 'title') init[p.id] = f.value
    }
    return { ...init, ...extra }
  }

  // --- vue Tableau ---------------------------------------------------------------
  const colWidth = (view, p) => view.widths?.[p.id] || (p.type === 'title' ? 280 : p.type === 'checkbox' ? 110 : 200)

  function renderTable(view) {
    const cols = shownProps(view)
    const rows = visibleRows(view)
    const manualOrder = !(view.sorts || []).length
    const wrap = document.createElement('div')
    wrap.className = 'dbt'
    const head = document.createElement('div')
    head.className = 'dbt-head'
    head.innerHTML = '<div class="dbt-gutter"></div>'
    for (const p of cols) {
      const th = document.createElement('div')
      th.className = 'dbt-th'
      th.dataset.prop = p.id
      th.style.width = `${colWidth(view, p)}px`
      th.innerHTML = `${icon(TYPE_ICON[p.type], 16)}<span>${esc(p.name)}</span><span class="dbt-resize"></span>`
      th.draggable = editable
      th.addEventListener('click', (e) => {
        if (e.target.closest('.dbt-resize')) return
        openPropMenu(th, p.id)
      })
      th.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('application/x-yariche-prop', p.id)
        e.dataTransfer.effectAllowed = 'move'
      })
      th.addEventListener('dragover', (e) => {
        if (e.dataTransfer.types.includes('application/x-yariche-prop')) {
          e.preventDefault()
          th.classList.add('drop-left')
        }
      })
      th.addEventListener('dragleave', () => th.classList.remove('drop-left'))
      th.addEventListener('drop', (e) => {
        th.classList.remove('drop-left')
        const id = e.dataTransfer.getData('application/x-yariche-prop')
        if (id && id !== p.id) moveProp(id, p.id)
      })
      th.querySelector('.dbt-resize').addEventListener('mousedown', (e) => {
        e.preventDefault()
        e.stopPropagation()
        const startX = e.clientX
        const startW = th.offsetWidth
        const cells = container.querySelectorAll(`[data-col="${CSS.escape(p.id)}"]`)
        document.body.classList.add('resizing')
        const move = (ev) => {
          const w = Math.max(80, startW + ev.clientX - startX)
          th.style.width = `${w}px`
          cells.forEach((c) => (c.style.width = `${w}px`))
        }
        const up = () => {
          document.body.classList.remove('resizing')
          window.removeEventListener('mousemove', move)
          window.removeEventListener('mouseup', up)
          updateView(view.id, { widths: { ...(currentView().widths || {}), [p.id]: th.offsetWidth } })
        }
        window.addEventListener('mousemove', move)
        window.addEventListener('mouseup', up)
      })
      head.appendChild(th)
    }
    if (editable) {
      const add = document.createElement('div')
      add.className = 'dbt-th add'
      add.title = 'Ajouter une propriété'
      add.innerHTML = icon('plus', 16)
      add.onclick = () => openAddPropMenu(add)
      head.appendChild(add)
    }
    wrap.appendChild(head)

    for (const row of rows) {
      const tr = document.createElement('div')
      tr.className = 'dbt-row' + (row.id === openRowId ? ' open' : '')
      tr.dataset.row = row.id
      const gutter = document.createElement('div')
      gutter.className = 'dbt-gutter'
      if (editable) {
        gutter.innerHTML = `<button class="row-btn" data-row-menu title="Glisser pour déplacer / menu">${icon('grip', 14)}</button>`
        const grip = gutter.querySelector('[data-row-menu]')
        grip.draggable = manualOrder
        grip.addEventListener('dragstart', (e) => {
          e.dataTransfer.setData('application/x-yariche-row', row.id)
          e.dataTransfer.effectAllowed = 'move'
        })
        grip.onclick = () => openRowMenu(grip, row.id)
      }
      tr.appendChild(gutter)
      for (const p of cols) {
        const td = document.createElement('div')
        td.className = `dbt-td t-${p.type}`
        td.dataset.col = p.id
        td.style.width = `${colWidth(view, p)}px`
        td.innerHTML = `<div class="dbt-val">${valueHTML(p, row)}</div>`
        if (p.type === 'title') {
          td.insertAdjacentHTML('beforeend', `<button class="open-btn">${icon('open', 12)}<span>Ouvrir</span></button>`)
          td.querySelector('.open-btn').onclick = (e) => {
            e.stopPropagation()
            openPeek(row.id)
          }
        }
        td.addEventListener('click', (e) => {
          if (e.target.closest('a')) return
          if (!editable) {
            if (p.type === 'title') openPeek(row.id)
            return
          }
          openCellEditor(td, row.id, p)
        })
        tr.appendChild(td)
      }
      tr.appendChild(Object.assign(document.createElement('div'), { className: 'dbt-td filler' }))
      if (editable && manualOrder) {
        tr.addEventListener('dragover', (e) => {
          if (!e.dataTransfer.types.includes('application/x-yariche-row')) return
          e.preventDefault()
          const r = tr.getBoundingClientRect()
          const after = e.clientY > r.top + r.height / 2
          tr.classList.toggle('drop-before', !after)
          tr.classList.toggle('drop-after', after)
        })
        tr.addEventListener('dragleave', () => tr.classList.remove('drop-before', 'drop-after'))
        tr.addEventListener('drop', (e) => {
          const id = e.dataTransfer.getData('application/x-yariche-row')
          const after = tr.classList.contains('drop-after')
          tr.classList.remove('drop-before', 'drop-after')
          if (!id || id === row.id) return
          e.preventDefault()
          const order = rowIds()
          const beforeId = after ? order[order.indexOf(row.id) + 1] || null : row.id
          if (beforeId !== id) moveRow(id, beforeId)
        })
      }
      wrap.appendChild(tr)
    }

    if (editable) {
      const add = document.createElement('button')
      add.className = 'dbt-new'
      add.innerHTML = `${icon('plus', 16)}<span>Nouvelle page</span>`
      add.onclick = () => {
        const id = addRow(defaultsForView(currentView()))
        requestAnimationFrame(() => {
          const cell = container.querySelector(`.dbt-row[data-row="${CSS.escape(id)}"] .t-title`)
          if (cell) openCellEditor(cell, id, titleProp())
        })
      }
      wrap.appendChild(add)
    }

    // Ligne de calculs
    const foot = document.createElement('div')
    foot.className = 'dbt-foot'
    foot.innerHTML = '<div class="dbt-gutter"></div>'
    for (const p of cols) {
      const cell = document.createElement('button')
      cell.className = 'dbt-calc'
      cell.dataset.col = p.id
      cell.style.width = `${colWidth(view, p)}px`
      const calc = view.calcs?.[p.id]
      cell.innerHTML = calc ? calcHTML(calc, p, rows) : `<span class="calc-empty">Calculer ${icon('chevronDown', 12)}</span>`
      cell.classList.toggle('set', !!calc)
      cell.onclick = () => {
        const opts = [...CALCS.all, ...(p.type === 'number' ? CALCS.number : []), ...(p.type === 'checkbox' ? CALCS.checkbox : [])]
        openMenu(cell, [
          { label: 'Aucun', checked: !calc, run: () => setCalc(p.id, null) },
          ...opts.map(([id, label]) => ({ label, checked: calc === id, run: () => setCalc(p.id, id) })),
        ], { width: 220 })
      }
      foot.appendChild(cell)
    }
    wrap.appendChild(foot)
    body.appendChild(wrap)
    if (!rows.length && (search || (view.filters || []).length)) {
      body.insertAdjacentHTML('beforeend', '<div class="empty-hint db-empty">Aucune ligne ne correspond.</div>')
    }
  }

  function setCalc(propId, calc) {
    const view = currentView()
    const calcs = { ...(view.calcs || {}) }
    if (calc) calcs[propId] = calc
    else delete calcs[propId]
    updateView(view.id, { calcs })
  }

  function calcHTML(calc, p, rows) {
    const label = [...CALCS.all, ...CALCS.number, ...CALCS.checkbox].find(([id]) => id === calc)?.[1] || ''
    const values = rows.map((r) => cellValue(p, r))
    const filled = rows.filter((r) => !isEmptyValue(p, r)).length
    const nums = values.map(Number).filter((n, i) => values[i] !== null && values[i] !== undefined && values[i] !== '' && Number.isFinite(n))
    const pct = (n) => (rows.length ? `${Math.round((n / rows.length) * 100)} %` : '0 %')
    let value = ''
    switch (calc) {
      case 'count': value = rows.length; break
      case 'count_values': value = values.reduce((acc, v) => acc + (Array.isArray(v) ? v.length : v || v === 0 ? 1 : 0), 0); break
      case 'empty': value = rows.length - filled; break
      case 'not_empty': value = filled; break
      case 'pct_empty': value = pct(rows.length - filled); break
      case 'pct_not_empty': value = pct(filled); break
      case 'sum': value = fmtNumber(p, nums.reduce((a, b) => a + b, 0)); break
      case 'avg': value = nums.length ? fmtNumber(p, nums.reduce((a, b) => a + b, 0) / nums.length) : '—'; break
      case 'min': value = nums.length ? fmtNumber(p, Math.min(...nums)) : '—'; break
      case 'max': value = nums.length ? fmtNumber(p, Math.max(...nums)) : '—'; break
      case 'median': {
        const s = [...nums].sort((a, b) => a - b)
        value = s.length ? fmtNumber(p, s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : '—'
        break
      }
      case 'checked': value = values.filter(Boolean).length; break
      case 'unchecked': value = values.filter((v) => !v).length; break
      case 'pct_checked': value = pct(values.filter(Boolean).length); break
    }
    return `<span class="calc-label">${esc(label)}</span><span class="calc-value">${esc(value)}</span>`
  }

  function openRowMenu(anchor, rowId) {
    openMenu(anchor, [
      { label: 'Ouvrir', icon: 'open', run: () => openPeek(rowId) },
      { label: 'Dupliquer', icon: 'copy', run: () => duplicateRow(rowId) },
      { label: 'Copier le lien', icon: 'link', run: () => copyRowLink(rowId) },
      'sep',
      { label: 'Supprimer', icon: 'trash', danger: true, run: () => deleteRows([rowId]) },
    ])
  }

  function copyRowLink(rowId) {
    const url = new URL(location.href)
    url.searchParams.set('doc', room)
    url.searchParams.set('row', rowId)
    navigator.clipboard?.writeText(url.toString()).then(() => toast('Lien copié')).catch(() => toast(url.toString()))
  }

  // --- vue Kanban ------------------------------------------------------------------
  function renderBoard(view) {
    const groupProp = prop(view.groupBy)
    if (!groupProp || !(groupProp.type === 'select' || groupProp.type === 'status')) {
      body.innerHTML = `<div class="db-cta"><p>Le Kanban regroupe les lignes selon une propriété « Statut » ou « Sélection ».</p>${editable ? '<button class="primary-btn">Grouper par un nouveau statut</button>' : ''}</div>`
      body.querySelector('button')?.addEventListener('click', () => {
        const id = addProp('status', { name: 'Statut' })
        updateView(view.id, { groupBy: id })
      })
      return
    }
    const rows = visibleRows(view)
    const cardProps = shownProps(view, { exclude: [groupProp.id] }).filter((p) => p.type !== 'title')
    const title = titleProp()
    const board = document.createElement('div')
    board.className = 'dbb'
    const columns = [{ option: null }, ...groupProp.options.map((o) => ({ option: o }))]
    for (const { option } of columns) {
      const colRows = rows.filter((r) => (option ? r[groupProp.id] === option.id : !groupProp.options.some((o) => o.id === r[groupProp.id])))
      if (!option && !colRows.length) continue
      const color = option?.color || 'default'
      const col = document.createElement('div')
      col.className = `dbb-col c-${color}${option ? '' : ' none'}`
      col.innerHTML = `<div class="dbb-head">${option ? (groupProp.type === 'status' ? statusHTML(option) : tagHTML(option)) : `<span class="tag c-default">Sans ${esc(groupProp.name.toLowerCase())}</span>`}<span class="dbb-count">${colRows.length}</span><span class="topbar-spacer"></span>${editable ? `${option ? `<button class="icon-btn sm" data-col-menu title="Options du groupe">${icon('more', 14)}</button>` : ''}<button class="icon-btn sm" data-col-add title="Nouvelle page">${icon('plus', 14)}</button>` : ''}</div><div class="dbb-cards"></div>`
      const cardsEl = col.querySelector('.dbb-cards')
      for (const row of colRows) {
        const card = document.createElement('div')
        card.className = 'dbb-card' + (row.id === openRowId ? ' open' : '')
        card.dataset.row = row.id
        card.draggable = editable
        card.innerHTML = `<div class="dbb-title">${valueHTML(title, row)}</div>${cardProps
          .filter((p) => !isEmptyValue(p, row))
          .map((p) => `<div class="dbb-prop t-${p.type}" data-prop="${esc(p.id)}">${valueHTML(p, row, { compact: true })}</div>`)
          .join('')}`
        card.onclick = (e) => {
          if (e.target.closest('a')) return
          const cb = e.target.closest('[data-check]')
          if (cb) {
            const propId = cb.closest('.dbb-prop')?.dataset.prop
            if (editable && propId) setCell(row.id, propId, !row[propId])
            return
          }
          openPeek(row.id)
        }
        card.addEventListener('dragstart', (e) => {
          e.dataTransfer.setData('application/x-yariche-row', row.id)
          e.dataTransfer.effectAllowed = 'move'
          requestAnimationFrame(() => card.classList.add('dragging'))
        })
        card.addEventListener('dragend', () => card.classList.remove('dragging'))
        cardsEl.appendChild(card)
      }
      if (editable) {
        const newBtn = document.createElement('button')
        newBtn.className = 'dbb-new'
        newBtn.innerHTML = `${icon('plus', 14)}<span>Nouvelle page</span>`
        const create = () => addRow(defaultsForView(view, option ? { [groupProp.id]: option.id } : {}), { open: true })
        newBtn.onclick = create
        col.querySelector('[data-col-add]')?.addEventListener('click', create)
        cardsEl.appendChild(newBtn)
        col.querySelector('[data-col-menu]')?.addEventListener('click', (e) =>
          openOptionSettings(e.currentTarget, groupProp.id, option, null)
        )
        // Glisser-déposer : changement de groupe + ordre manuel
        col.addEventListener('dragover', (e) => {
          if (!e.dataTransfer.types.includes('application/x-yariche-row')) return
          e.preventDefault()
          col.classList.add('drop')
          const cards = [...cardsEl.querySelectorAll('.dbb-card:not(.dragging)')]
          const before = cards.find((c) => e.clientY < c.getBoundingClientRect().top + c.offsetHeight / 2)
          cardsEl.querySelector('.drop-marker')?.remove()
          const marker = document.createElement('div')
          marker.className = 'drop-marker'
          cardsEl.insertBefore(marker, before || newBtn)
        })
        col.addEventListener('dragleave', (e) => {
          if (!col.contains(e.relatedTarget)) {
            col.classList.remove('drop')
            cardsEl.querySelector('.drop-marker')?.remove()
          }
        })
        col.addEventListener('drop', (e) => {
          const id = e.dataTransfer.getData('application/x-yariche-row')
          const marker = cardsEl.querySelector('.drop-marker')
          const beforeId = marker?.nextElementSibling?.dataset?.row || null
          marker?.remove()
          col.classList.remove('drop')
          if (!id) return
          e.preventDefault()
          tx(() => {
            const r = R().get(id)
            if (!r) return
            if (option) r.set(groupProp.id, option.id)
            else r.delete(groupProp.id)
            touch(r)
          })
          if (!(view.sorts || []).length && beforeId !== id) {
            if (beforeId) moveRow(id, beforeId)
            else {
              // Fin de colonne : juste après la dernière carte de cette colonne
              const last = colRows.filter((r) => r.id !== id).at(-1)
              if (last) {
                const order = rowIds()
                moveRow(id, order[order.indexOf(last.id) + 1] || null)
              }
            }
          }
        })
      }
      board.appendChild(col)
    }
    if (editable) {
      const addGroup = document.createElement('button')
      addGroup.className = 'dbb-add-group'
      addGroup.innerHTML = `${icon('plus', 14)}<span>Ajouter un groupe</span>`
      addGroup.onclick = () => {
        const name = prompt('Nom du nouveau groupe :')
        if (name?.trim()) createOption(groupProp.id, name.trim())
      }
      board.appendChild(addGroup)
    }
    body.appendChild(board)
  }

  // --- vue Liste ----------------------------------------------------------------------
  function renderList(view) {
    const rows = visibleRows(view)
    const title = titleProp()
    const extra = shownProps(view).filter((p) => p.type !== 'title')
    const list = document.createElement('div')
    list.className = 'dbl'
    for (const row of rows) {
      const item = document.createElement('div')
      item.className = 'dbl-row' + (row.id === openRowId ? ' open' : '')
      item.innerHTML = `<span class="dbl-icon">${icon('page', 18)}</span><span class="dbl-title">${valueHTML(title, row)}</span><span class="topbar-spacer"></span><span class="dbl-props">${extra
        .filter((p) => !isEmptyValue(p, row))
        .map((p) => `<span class="dbl-prop t-${p.type}">${valueHTML(p, row, { compact: true })}</span>`)
        .join('')}</span>`
      item.onclick = (e) => !e.target.closest('a') && openPeek(row.id)
      list.appendChild(item)
    }
    if (editable) {
      const add = document.createElement('button')
      add.className = 'dbt-new'
      add.innerHTML = `${icon('plus', 16)}<span>Nouvelle page</span>`
      add.onclick = () => addRow(defaultsForView(view), { open: true })
      list.appendChild(add)
    }
    body.appendChild(list)
  }

  // --- vue Galerie --------------------------------------------------------------------
  function previewHTML(row) {
    const md = row._body || ''
    const img = md.match(/!\[[^\]]*\]\(([^)\s]+)/)
    if (img) return `<img src="${esc(img[1])}" alt="" loading="lazy" />`
    const text = md
      .replace(/^#+\s*/gm, '')
      .replace(/[*_`>#=~[\]]/g, '')
      .trim()
      .slice(0, 220)
    return text ? `<div class="dbg-text">${esc(text)}</div>` : ''
  }

  function renderGallery(view) {
    const rows = visibleRows(view)
    const title = titleProp()
    const extra = shownProps(view).filter((p) => p.type !== 'title')
    const grid = document.createElement('div')
    grid.className = 'dbg'
    for (const row of rows) {
      const card = document.createElement('div')
      card.className = 'dbg-card' + (row.id === openRowId ? ' open' : '')
      card.innerHTML = `<div class="dbg-preview">${previewHTML(row)}</div><div class="dbg-body"><div class="dbg-title">${valueHTML(title, row)}</div>${extra
        .filter((p) => !isEmptyValue(p, row))
        .map((p) => `<div class="dbg-prop t-${p.type}">${valueHTML(p, row, { compact: true })}</div>`)
        .join('')}</div>`
      card.onclick = (e) => !e.target.closest('a') && openPeek(row.id)
      grid.appendChild(card)
    }
    if (editable) {
      const add = document.createElement('button')
      add.className = 'dbg-card dbg-new'
      add.innerHTML = `${icon('plus', 18)}<span>Nouvelle page</span>`
      add.onclick = () => addRow(defaultsForView(view), { open: true })
      grid.appendChild(add)
    }
    body.appendChild(grid)
  }

  // --- vue Calendrier -----------------------------------------------------------------
  function renderCalendar(view) {
    const dateProp = prop(view.dateProp)
    if (!dateProp) {
      body.innerHTML = `<div class="db-cta"><p>Le calendrier place les lignes selon une propriété « Date ».</p>${editable ? '<button class="primary-btn">Ajouter une propriété Date</button>' : ''}</div>`
      body.querySelector('button')?.addEventListener('click', () => {
        const id = addProp('date', { name: 'Date' })
        updateView(view.id, { dateProp: id })
      })
      return
    }
    const rows = visibleRows(view)
    const title = titleProp()
    const dayOf = (row) => {
      const v = cellValue(dateProp, row)
      return dateProp.type === 'date' ? String(v || '').slice(0, 10) : tsToIso(v)
    }
    const byDay = new Map()
    for (const r of rows) {
      const d = dayOf(r)
      if (!d) continue
      if (!byDay.has(d)) byDay.set(d, [])
      byDay.get(d).push(r)
    }
    const cal = document.createElement('div')
    cal.className = 'dbc'
    const monthLabel = calMonth.toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' })
    cal.innerHTML = `<div class="dbc-head"><span class="dbc-month">${esc(monthLabel.charAt(0).toUpperCase() + monthLabel.slice(1))}</span><span class="topbar-spacer"></span>
      <button class="icon-btn sm" data-cal="prev">${icon('chevronLeft', 16)}</button><button class="ghost-btn" data-cal="today">Aujourd'hui</button><button class="icon-btn sm" data-cal="next">${icon('chevron', 16)}</button></div>
      <div class="dbc-weekdays">${['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'].map((d) => `<div>${d}</div>`).join('')}</div>
      <div class="dbc-grid"></div>`
    cal.querySelector('[data-cal="prev"]').onclick = () => {
      calMonth = new Date(calMonth.getFullYear(), calMonth.getMonth() - 1, 1)
      render()
    }
    cal.querySelector('[data-cal="next"]').onclick = () => {
      calMonth = new Date(calMonth.getFullYear(), calMonth.getMonth() + 1, 1)
      render()
    }
    cal.querySelector('[data-cal="today"]').onclick = () => {
      const d = new Date()
      calMonth = new Date(d.getFullYear(), d.getMonth(), 1)
      render()
    }
    const grid = cal.querySelector('.dbc-grid')
    const first = new Date(calMonth)
    const offset = (first.getDay() + 6) % 7 // lundi = 0
    const start = new Date(first.getFullYear(), first.getMonth(), 1 - offset)
    const daysInMonth = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate()
    const weeks = Math.ceil((offset + daysInMonth) / 7)
    const todayIso = isoDay(new Date())
    const editableDate = editable && dateProp.type === 'date'
    for (let i = 0; i < weeks * 7; i++) {
      const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i)
      const iso = isoDay(d)
      const cell = document.createElement('div')
      cell.className = 'dbc-day' + (d.getMonth() !== calMonth.getMonth() ? ' out' : '') + (iso === todayIso ? ' today' : '')
      cell.innerHTML = `<div class="dbc-day-head">${editableDate ? `<button class="dbc-add" title="Nouvelle page">${icon('plus', 12)}</button>` : ''}<span class="dbc-num">${d.getDate() === 1 ? d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' }) : d.getDate()}</span></div>`
      for (const row of byDay.get(iso) || []) {
        const ev = document.createElement('div')
        ev.className = 'dbc-event' + (row.id === openRowId ? ' open' : '')
        ev.draggable = editableDate
        ev.innerHTML = valueHTML(title, row)
        ev.onclick = () => openPeek(row.id)
        ev.addEventListener('dragstart', (e) => {
          e.dataTransfer.setData('application/x-yariche-row', row.id)
          e.dataTransfer.effectAllowed = 'move'
        })
        cell.appendChild(ev)
      }
      if (editableDate) {
        cell.querySelector('.dbc-add').onclick = () => addRow(defaultsForView(view, { [dateProp.id]: iso }), { open: true })
        cell.addEventListener('dragover', (e) => {
          if (!e.dataTransfer.types.includes('application/x-yariche-row')) return
          e.preventDefault()
          cell.classList.add('drop')
        })
        cell.addEventListener('dragleave', () => cell.classList.remove('drop'))
        cell.addEventListener('drop', (e) => {
          cell.classList.remove('drop')
          const id = e.dataTransfer.getData('application/x-yariche-row')
          if (id) {
            e.preventDefault()
            setCell(id, dateProp.id, iso)
          }
        })
      }
      grid.appendChild(cell)
    }
    body.appendChild(cal)
  }

  // --- panneau latéral d'une ligne (« peek ») ----------------------------------------
  function openPeek(rowId) {
    if (!R().get(rowId)) return
    const switching = openRowId !== rowId || !rowEditor
    openRowId = rowId
    peek.classList.remove('hidden')
    document.getElementById('app').classList.add('peek-open')
    if (switching) {
      rowEditor?.destroy()
      rowEditor = null
      peekEditorEl.innerHTML = ''
      const row = rowData(rowId)
      rowEditor = createRowEditor(peekEditorEl, `row:${rowId}`, {
        editable,
        initialMarkdown: row?._body || '',
        onMarkdown: (md) => {
          const r = R().get(rowId)
          if (r && r.get('_body') !== md) tx(() => {
            r.set('_body', md)
            touch(r)
          })
        },
      })
      peek.querySelector('.peek-scroll').scrollTop = 0
    }
    renderPeek()
    onRowOpened?.(rowId)
    scheduleRender()
  }

  function closePeek() {
    if (!openRowId) return
    rowEditor?.flush?.()
    rowEditor?.destroy()
    rowEditor = null
    openRowId = null
    peek.classList.add('hidden')
    document.getElementById('app').classList.remove('peek-open')
    onRowOpened?.(null)
    scheduleRender()
  }

  function renderPeek() {
    if (!openRowId) return
    const row = rowData(openRowId)
    if (!row) return closePeek()
    const t = titleProp()
    if (document.activeElement !== peekTitle) peekTitle.textContent = row[t.id] || ''
    peekTitle.contentEditable = editable ? 'plaintext-only' : 'false'
    peekProps.innerHTML = ''
    for (const p of props()) {
      if (p.type === 'title') continue
      const line = document.createElement('div')
      line.className = 'peek-prop'
      line.innerHTML = `<button class="peek-prop-name">${icon(TYPE_ICON[p.type], 16)}<span>${esc(p.name)}</span></button><div class="peek-prop-value t-${p.type}">${valueHTML(p, row) || `<span class="muted">${READONLY_TYPES.has(p.type) ? '—' : 'Vide'}</span>`}</div>`
      const valueEl = line.querySelector('.peek-prop-value')
      valueEl.onclick = (e) => {
        if (e.target.closest('a')) return
        openCellEditor(valueEl, openRowId, p)
      }
      line.querySelector('.peek-prop-name').onclick = (e) => openPropMenu(e.currentTarget, p.id)
      peekProps.appendChild(line)
    }
  }

  peekTitle.addEventListener('input', () => {
    if (!openRowId) return
    setCell(openRowId, titleProp().id, peekTitle.textContent.replace(/\n/g, ' '))
  })
  peekTitle.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      rowEditor?.editor?.commands.focus('start')
    }
  })
  peek.querySelector('.peek-add-prop')?.addEventListener('click', (e) => openAddPropMenu(e.currentTarget))
  peek.querySelector('[data-peek="close"]').onclick = () => closePeek()
  const stepPeek = (delta) => {
    const ids = visibleRows(currentView()).map((r) => r.id)
    const i = ids.indexOf(openRowId)
    const next = ids[i + delta]
    if (next) openPeek(next)
  }
  peek.querySelector('[data-peek="prev"]').onclick = () => stepPeek(-1)
  peek.querySelector('[data-peek="next"]').onclick = () => stepPeek(1)
  peek.querySelector('[data-peek="more"]').onclick = (e) => {
    const id = openRowId
    openMenu(e.currentTarget, [
      { label: 'Copier le lien', icon: 'link', run: () => copyRowLink(id) },
      editable ? { label: 'Dupliquer', icon: 'copy', run: () => openPeek(duplicateRow(id)) } : null,
      editable ? 'sep' : null,
      editable ? { label: 'Supprimer', icon: 'trash', danger: true, run: () => deleteRows([id]) } : null,
    ], { align: 'right' })
  }

  // --- clavier ------------------------------------------------------------------------
  const onKeyDown = (e) => {
    // Déjà traité (menu « / » de l'éditeur de ligne, sélecteur…) : on ne ferme rien
    if (destroyed || e.defaultPrevented) return
    const inField = e.target.closest?.('input, textarea, [contenteditable="true"], [contenteditable="plaintext-only"], .ProseMirror')
    if (e.key === 'Escape' && popover) {
      closePopover({ commit: false })
      return
    }
    if (e.key === 'Escape' && openRowId && !document.querySelector('.modal-overlay:not(.hidden), .palette-overlay:not(.hidden)')) {
      if (inField && !e.target.closest('.db-peek')) return
      closePeek()
      return
    }
    if (inField || !editable) return
    const mod = e.metaKey || e.ctrlKey
    if (mod && e.key.toLowerCase() === 'z') {
      e.preventDefault()
      if (e.shiftKey) undo.redo()
      else undo.undo()
    } else if (mod && e.key.toLowerCase() === 'y') {
      e.preventDefault()
      undo.redo()
    }
  }
  window.addEventListener('keydown', onKeyDown)

  // --- rendu principal ----------------------------------------------------------------
  function render() {
    if (destroyed) return
    if (!isReady()) {
      body.innerHTML = '<div class="db-loading">Chargement…</div>'
      return
    }
    const view = currentView()
    if (!view) return
    renderTabs()
    renderChips(view)
    const scroll = { x: body.querySelector('.dbt, .dbb')?.scrollLeft || 0 }
    body.innerHTML = ''
    body.className = `db-body db-body-${view.type}`
    ;({ table: renderTable, board: renderBoard, list: renderList, gallery: renderGallery, calendar: renderCalendar }[view.type] || renderTable)(view)
    const scroller = body.querySelector('.dbt, .dbb')
    if (scroller) scroller.scrollLeft = scroll.x
    renderPeek()
    popover?._place?.()
  }

  return {
    seed,
    openRow: (id) => (isReady() ? openPeek(id) : (openRowId = id)),
    async flush() {
      rowEditor?.flush?.()
      if (saveTimer) {
        clearTimeout(saveTimer)
        await save()
      }
    },
    destroy() {
      destroyed = true
      root.unobserveDeep(onDeepChange)
      undo.destroy()
      closePopover({ commit: true })
      rowEditor?.flush?.()
      rowEditor?.destroy()
      if (saveTimer) {
        clearTimeout(saveTimer)
        if (isReady()) onSave(toJSON())
      }
      document.removeEventListener('mousedown', onDocMouseDown, true)
      window.removeEventListener('keydown', onKeyDown)
      document.getElementById('app').classList.remove('peek-open')
      peek.remove()
      container.innerHTML = ''
    },
  }
}
