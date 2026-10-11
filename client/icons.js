// Icones au trait : tracés Lucide (licence ISC, voir THIRD_PARTY_NOTICES.md),
// pictos monochromes 20px dans la navigation.
const paths = {
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  page: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/>',
  board: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M7 15c2-4 4 2 6-2s3-3 4-1"/>',
  database: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M9 10v10"/>',
  graph: '<circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="8" r="2.5"/><circle cx="10" cy="18" r="2.5"/><path d="M8.2 7.2 15.6 7.6M7 8.3l2.2 7.4M16.4 10l-4.6 6.3"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/>',
  import: '<path d="M12 3v12M7 10l5 5 5-5M5 21h14"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/>',
  star: '<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3l-5.6 2.9 1.1-6.2L3 9.6l6.2-.9z"/>',
  more: '<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>',
  sidebar: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
  history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/>',
  copy: '<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>',
  download: '<path d="M12 3v12M7 10l5 5 5-5M5 21h14"/>',
  widen: '<path d="M3 12h18M7 8l-4 4 4 4M17 8l4 4-4 4"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-5-5L5 21"/>',
  rename: '<path d="M12 20h9M16.5 3.5a2.1 2.1 0 1 1 3 3L7 19l-4 1 1-4z"/>',
  lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  sparkle: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/>',
  grip: '<circle cx="9" cy="6" r="1.4"/><circle cx="15" cy="6" r="1.4"/><circle cx="9" cy="12" r="1.4"/><circle cx="15" cy="12" r="1.4"/><circle cx="9" cy="18" r="1.4"/><circle cx="15" cy="18" r="1.4"/>',
  text: '<path d="M5 6V4h14v2M12 4v16M9 20h6"/>',
  quote: '<path d="M4 15V9a4 4 0 0 1 4-4M4 15h5v5H4zM14 15V9a4 4 0 0 1 4-4M14 15h5v5h-5z"/>',
  code: '<path d="m8 8-5 4 5 4M16 8l5 4-5 4M14 4l-4 16"/>',
  bullets: '<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1"/><circle cx="4.5" cy="12" r="1"/><circle cx="4.5" cy="18" r="1"/>',
  numbers: '<path d="M10 6h11M10 12h11M10 18h11M4 4h1v5M3.5 9h3M3.5 14.5a1.5 1.5 0 0 1 3 .5c0 1-3 2.5-3 3.5h3"/>',
  todo: '<rect x="3" y="4" width="7" height="7" rx="1.5"/><path d="m4.8 7.5 1.4 1.4 2.4-2.6M14 7.5h7M3 14h7v7H3zM14 17.5h7"/>',
  table: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M3 15h18M9 4v16M15 4v16"/>',
  divider: '<path d="M3 12h18"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  bold: '<path d="M7 5h6a3.5 3.5 0 0 1 0 7H7zM7 12h7a3.5 3.5 0 0 1 0 7H7z"/>',
  italic: '<path d="M19 4h-9M14 20H5M15 4 9 20"/>',
  strike: '<path d="M16 5.5A4 4 0 0 0 12.5 4h-1A3.5 3.5 0 0 0 8 7.5c0 2 2 3 4 3.5M4 12h16M8.5 18.5A4 4 0 0 0 12 20h.5a3.5 3.5 0 0 0 3.5-3.5c0-.8-.2-1.4-.6-2"/>',
  heading: '<path d="M6 4v16M18 4v16M6 12h12"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  smile: '<circle cx="12" cy="12" r="9"/><path d="M8 14s1.5 2 4 2 4-2 4-2M9 9h.01M15 9h.01"/>',
  message: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/>',
  inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.5 5h13l3.5 7v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-6z"/>',
  at: '<circle cx="12" cy="12" r="4"/><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>',
  arrowUp: '<path d="M12 19V5M5 12l7-7 7 7"/>',
  arrowLeft: '<path d="M19 12H5M12 19l-7-7 7-7"/>',
  arrowRight: '<path d="M5 12h14M12 5l7 7-7 7"/>',
  arrowBoth: '<path d="M4 12h16M8 8l-4 4 4 4M16 8l4 4-4 4"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  chevronUp: '<path d="m18 15-6-6-6 6"/>',
  chevronLeft: '<path d="m15 18-6-6 6-6"/>',
  chevronsRight: '<path d="m6 17 5-5-5-5M13 17l5-5-5-5"/>',
  open: '<path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  callout: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M8 9h8M8 13h5"/>',
  highlight: '<path d="m9 11-6 6v3h9l3-3"/><path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"/>',
  textAa: '<path d="M3 18 8 6l5 12M4.8 14h6.4M15 13.5a2.7 2.7 0 1 1 0 3 2.7 2.7 0 0 1 0-3zM20.5 12v6"/>',
  hash: '<path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18"/>',
  select: '<circle cx="12" cy="12" r="9"/><path d="m8.5 11 3.5 3.5 3.5-3.5"/>',
  multi: '<path d="M4 6h10M4 12h10M4 18h7M17 16l2 2 3-4"/>',
  status: '<path d="M12 3a9 9 0 1 0 9 9"/><path d="M12 8a4 4 0 1 0 4 4"/>',
  person: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  people: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8"/><path d="M18 14.2a6.5 6.5 0 0 1 3.5 5.8"/>',
  checkbox: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="m8.5 12 2.5 2.5 4.5-5"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  filter: '<path d="M4 5h16M7 12h10M10 19h4"/>',
  sort: '<path d="M7 4v16M3 16l4 4 4-4M17 20V4M13 8l4-4 4 4"/>',
  sortAsc: '<path d="M7 20V4M3 8l4-4 4 4M14 8h7M14 13h5M14 18h3"/>',
  sortDesc: '<path d="M7 4v16M3 16l4 4 4-4M14 6h3M14 11h5M14 16h7"/>',
  eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M3 3l18 18M10.6 5.1A10.5 10.5 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 4.2M6.6 6.6A17 17 0 0 0 2 12s3.6 7 10 7a9.7 9.7 0 0 0 5.4-1.6M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
  kanban: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16M15 4v16M5.5 8h1M11.5 8h1M17.5 8h1"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13"/><rect x="3" y="4.5" width="3" height="3" rx=".6"/><rect x="3" y="10.5" width="3" height="3" rx=".6"/><rect x="3" y="16.5" width="3" height="3" rx=".6"/>',
  gallery: '<rect x="3" y="3" width="8" height="8" rx="1.5"/><rect x="13" y="3" width="8" height="8" rx="1.5"/><rect x="3" y="13" width="8" height="8" rx="1.5"/><rect x="13" y="13" width="8" height="8" rx="1.5"/>',
  pointer: '<path d="M4 3l7 17 2.5-7.5L21 10z"/>',
  hand: '<path d="M8 13V5.5a1.5 1.5 0 0 1 3 0V12M11 11.5V4a1.5 1.5 0 0 1 3 0v7.5M14 11V5.5a1.5 1.5 0 0 1 3 0V13"/><path d="M17 11.5a1.5 1.5 0 0 1 3 0V15a6 6 0 0 1-6 6h-2a7 7 0 0 1-5.7-3L3.5 14a1.5 1.5 0 0 1 2.5-1.7L8 15"/>',
  note: '<path d="M4 4h16v11l-5 5H4z"/><path d="M15 20v-5h5"/>',
  shapeRect: '<rect x="4" y="5" width="16" height="14" rx="1"/>',
  shapeRound: '<rect x="4" y="5" width="16" height="14" rx="4.5"/>',
  shapeEllipse: '<ellipse cx="12" cy="12" rx="8.5" ry="7"/>',
  shapeDiamond: '<path d="M12 3.5 20.5 12 12 20.5 3.5 12z"/>',
  shapeTriangle: '<path d="M12 4 21 20H3z"/>',
  textT: '<path d="M5 5h14M12 5v14M9 19h6"/>',
  pen: '<path d="M4 20c2.5-.5 4.5-2 6-4l9.5-9.5a2.1 2.1 0 0 0-3-3L7 13c-2 1.5-3.5 3.5-4 6z"/><path d="m14.5 5.5 3 3"/>',
  eraser: '<path d="m7 21-4.3-4.3a1.5 1.5 0 0 1 0-2.1L13.6 3.7a1.5 1.5 0 0 1 2.1 0l4.6 4.6a1.5 1.5 0 0 1 0 2.1L10 21z"/><path d="M22 21H7M5 12l7 7"/>',
  connector: '<path d="M5 19 19 5M13 5h6v6"/>',
  curve: '<path d="M4 19c8 0 8-14 16-14"/><path d="M15 5h5v5"/>',
  front: '<rect x="8" y="8" width="12" height="12" rx="1.5"/><path d="M4 16V5a1 1 0 0 1 1-1h11"/>',
  back: '<rect x="4" y="4" width="12" height="12" rx="1.5"/><path d="M20 8v11a1 1 0 0 1-1 1H8"/>',
  minus: '<path d="M5 12h14"/>',
  fit: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  folderOpen: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v1"/><path d="M3 17V9h16.5a1.5 1.5 0 0 1 1.4 2l-2.2 6.3a2 2 0 0 1-1.9 1.4H5a2 2 0 0 1-2-2z"/>',
  move: '<path d="M5 9l-3 3 3 3M9 5l3-3 3 3M15 19l-3 3-3-3M19 9l3 3-3 3M2 12h20M12 2v20"/>',
  book: '<path d="M2 4h6a4 4 0 0 1 4 4v13a3 3 0 0 0-3-3H2zM22 4h-6a4 4 0 0 0-4 4v13a3 3 0 0 1 3-3h7z"/>',
  cloud: '<path d="M17.5 19H9a7 7 0 1 1 6.7-9h1.8a4.5 4.5 0 1 1 0 9z"/>',
  cloudOff: '<path d="m2 2 20 20M5.8 5.8A7 7 0 0 0 9 19h8.5a4.5 4.5 0 0 0 1.3-.2M21.5 16.5a4.5 4.5 0 0 0-4-6.5h-1.8A7 7 0 0 0 10 5.1"/>',
  refresh: '<path d="M3 12a9 9 0 0 1 15.7-6L21 8M21 3v5h-5M21 12a9 9 0 0 1-15.7 6L3 16M8 16H3v5"/>',
  vault: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="12" cy="12" r="3"/><path d="M12 9V7M12 17v-2M9 12H7M17 12h-2M7 21v1M17 21v1"/>',
  chevronsUpDown: '<path d="m7 15 5 5 5-5M7 9l5-5 5 5"/>',
  finder: '<rect x="3" y="3" width="18" height="18" rx="4"/><path d="M12 3c-1.5 3-2 6-2 9h2.5c0 3 .3 6 1 9M8 8v1.5M16 8v1.5M7.5 15.5c2.8 1.8 6.2 1.8 9 0"/>',
}

export function icon(name, size = 20) {
  return `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || ''}</svg>`
}

// Remplit tous les [data-icon] du HTML statique
export function hydrateIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach((node) => {
    node.insertAdjacentHTML('afterbegin', icon(node.dataset.icon, Number(node.dataset.iconSize) || 20))
  })
}

// Emoji choisi par l'utilisateur, sinon picto selon le type de page.
// '📄' etait l'ancien defaut serveur : traite comme "pas d'icone".
const escapeHTML = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

export function pageIconHTML(entry, size = 20) {
  const emoji = entry.icon && entry.icon !== '📄' ? entry.icon : null
  // Choisie par un collaborateur : toujours échappée
  if (emoji) return `<span class="emoji-icon" style="font-size:${Math.round(size * 0.8)}px">${escapeHTML(emoji)}</span>`
  const name = entry.type === 'board' ? 'board' : entry.type === 'database' ? 'database' : entry.type === 'folder' ? 'folder' : 'page'
  return icon(name, size)
}
