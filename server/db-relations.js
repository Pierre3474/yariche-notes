// Relations entre bases (façon Notion) : une relation « dans les deux sens » garde une
// propriété miroir dans la base liée. Quand une ligne est liée d'un côté, le serveur
// reporte le lien de l'autre côté : dans le document Yjs vivant si la base est ouverte
// (les éditeurs le voient en direct), et toujours dans son fichier .db.json.
//
// Types Yjs testés par « duck typing » : y-websocket charge la build CommonJS de yjs,
// pas la même instance que le serveur.

const ID_RE = /^[A-Za-z0-9_-]{1,40}$/
const MAX_LINKS = 500

const isId = (v) => typeof v === 'string' && ID_RE.test(v)
const idList = (v) => (Array.isArray(v) ? v.filter(isId).slice(0, MAX_LINKS) : [])

// Propriété relation acceptée depuis un client : champs connus seulement
function cleanRelationProp(p) {
  if (!p || !isId(p.id) || p.type !== 'relation') return null
  return {
    id: p.id,
    name: String(p.name || 'Relation').slice(0, 120),
    type: 'relation',
    target: typeof p.target === 'string' ? p.target.slice(0, 1024) : null,
    twoWay: !!p.twoWay,
    reverseProp: isId(p.reverseProp) ? p.reverseProp : null,
    ...(p.limit === 1 ? { limit: 1 } : {}),
  }
}

export function validateOps(ops) {
  if (!Array.isArray(ops) || !ops.length || ops.length > 200) return null
  const out = []
  for (const op of ops) {
    if (op?.op === 'ensureProp') {
      const prop = cleanRelationProp(op.prop)
      if (!prop) return null
      out.push({ op: 'ensureProp', prop })
    } else if (op?.op === 'updateProp' && isId(op.propId)) {
      const patch = {}
      if (typeof op.patch?.twoWay === 'boolean') patch.twoWay = op.patch.twoWay
      if (op.patch?.reverseProp === null || isId(op.patch?.reverseProp)) patch.reverseProp = op.patch.reverseProp
      if (typeof op.patch?.target === 'string') patch.target = op.patch.target.slice(0, 1024)
      out.push({ op: 'updateProp', propId: op.propId, patch })
    } else if (op?.op === 'dropProp' && isId(op.propId)) {
      out.push({ op: 'dropProp', propId: op.propId })
    } else if (op?.op === 'link' && isId(op.propId) && isId(op.rowId)) {
      out.push({ op: 'link', propId: op.propId, rowId: op.rowId, add: idList(op.add), remove: idList(op.remove) })
    } else return null
  }
  return out
}

// Accès commun au JSON (fichier) et au Y.Map vivant
function jsonAdapter(json) {
  json.schema ||= {}
  json.propOrder ||= []
  json.rows ||= {}
  return {
    getProp: (id) => json.schema[id],
    setProp: (id, p) => {
      json.schema[id] = p
    },
    addOrder: (id) => {
      if (!json.propOrder.includes(id)) json.propOrder.push(id)
    },
    dropProp: (id) => {
      delete json.schema[id]
      json.propOrder = json.propOrder.filter((x) => x !== id)
    },
    getCell: (rowId, propId) => json.rows[rowId]?.[propId],
    hasRow: (rowId) => !!json.rows[rowId],
    setCell: (rowId, propId, value) => {
      if (value === undefined) delete json.rows[rowId][propId]
      else json.rows[rowId][propId] = value
    },
  }
}

function yAdapter(root) {
  const schema = root.get('schema')
  const order = root.get('propOrder')
  const rows = root.get('rows')
  return {
    getProp: (id) => schema.get(id),
    setProp: (id, p) => schema.set(id, p),
    addOrder: (id) => {
      if (!order.toArray().includes(id)) order.push([id])
    },
    dropProp: (id) => {
      schema.delete(id)
      const i = order.toArray().indexOf(id)
      if (i >= 0) order.delete(i, 1)
    },
    getCell: (rowId, propId) => rows.get(rowId)?.get(propId),
    hasRow: (rowId) => !!rows.get(rowId),
    setCell: (rowId, propId, value) => {
      const r = rows.get(rowId)
      if (value === undefined) r.delete(propId)
      else r.set(propId, value)
      r.set('_edited', Date.now())
    },
  }
}

function applyTo(db, ops) {
  let changed = false
  for (const op of ops) {
    if (op.op === 'ensureProp') {
      const existing = db.getProp(op.prop.id)
      if (existing && existing.type !== 'relation') continue
      db.setProp(op.prop.id, existing ? { ...existing, ...op.prop, name: existing.name } : op.prop)
      db.addOrder(op.prop.id)
      changed = true
    } else if (op.op === 'updateProp') {
      const p = db.getProp(op.propId)
      if (p?.type !== 'relation') continue
      db.setProp(op.propId, { ...p, ...op.patch })
      changed = true
    } else if (op.op === 'dropProp') {
      if (db.getProp(op.propId)?.type !== 'relation') continue
      db.dropProp(op.propId)
      changed = true
    } else if (op.op === 'link') {
      const p = db.getProp(op.propId)
      if (p?.type !== 'relation' || !db.hasRow(op.rowId)) continue
      const current = idList(db.getCell(op.rowId, op.propId))
      let next = current.filter((id) => !op.remove.includes(id))
      for (const id of op.add) if (!next.includes(id)) next.push(id)
      if (p.limit === 1) next = next.slice(-1)
      if (next.length === current.length && next.every((id, i) => id === current[i])) continue
      db.setCell(op.rowId, op.propId, next.length ? next : undefined)
      changed = true
    }
  }
  return changed
}

// Applique les opérations à la base `room` ; renvoie le JSON écrit, ou null si rien n'a changé.
// readJSON(room) / writeJSON(room, json) : fichier .db.json ; liveDoc : document Yjs ouvert
export function applyRelationOps({ ops, liveDoc, readJSON, writeJSON }) {
  const root = liveDoc?.getMap?.('database')
  if (root?.get('schema') && root.get('rows') && root.get('propOrder')) {
    let changed = false
    liveDoc.transact(() => {
      changed = applyTo(yAdapter(root), ops)
    }, 'server-relation')
    if (!changed) return null
    const json = { version: 2, ...root.toJSON() }
    writeJSON(json)
    return json
  }
  const json = readJSON()
  if (!json || json.version !== 2) throw Object.assign(new Error('base liée illisible'), { status: 409 })
  if (!applyTo(jsonAdapter(json), ops)) return null
  writeJSON(json)
  return json
}

// Après un renommage ou un déplacement : les relations qui visaient l'ancien chemin
// d'une base visent le nouveau. rename(oldId) -> newId | null
export function retargetRelations(json, rename) {
  let changed = false
  for (const [id, p] of Object.entries(json?.schema || {})) {
    if (p?.type !== 'relation' || !p.target) continue
    const next = rename(p.target)
    if (next && next !== p.target) {
      json.schema[id] = { ...p, target: next }
      changed = true
    }
  }
  return changed
}
