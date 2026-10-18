// Signets façon Notion : carte avec titre, description, image et icône d'un site.
// Enregistrés en bloc ```embed (format du module Obsidian « Link Embed ») : le .md garde
// l'adresse et l'aperçu, lisibles même sans Yariche.
//
//   ```embed
//   title: "Titre de la page"
//   image: "https://site/cover.png"
//   description: "Résumé"
//   url: "https://site/page"
//   favicon: "https://site/favicon.ico"
//   ```
export const EMBED_LANGUAGE = 'embed'
const KEYS = ['title', 'image', 'description', 'url', 'favicon']

export function parseEmbed(text) {
  const data = {}
  for (const line of String(text).split('\n')) {
    const m = line.match(/^\s*([a-zA-Z]+)\s*:\s*(.*)$/)
    if (!m) continue
    let value = m[2].trim()
    if (value.startsWith('"')) {
      try {
        value = JSON.parse(value)
      } catch {
        value = value.replace(/^"|"$/g, '')
      }
    } else if (value.startsWith("'")) value = value.replace(/^'|'$/g, '').replace(/''/g, "'")
    data[m[1].toLowerCase()] = String(value)
  }
  return data
}

// Chaînes YAML entre guillemets doubles : mêmes échappements que JSON
export const embedText = (data) =>
  KEYS.filter((k) => data[k])
    .map((k) => `${k}: ${JSON.stringify(String(data[k]))}`)
    .join('\n')

const safeHttp = (u) => {
  try {
    const url = new URL(u)
    return ['http:', 'https:'].includes(url.protocol) ? url : null
  } catch {
    return null
  }
}
const proxied = (u) => (safeHttp(u) ? `/api/unfurl/image?url=${encodeURIComponent(u)}` : '')

export function renderBookmarkCard(card, data) {
  const url = safeHttp(data.url)
  card.replaceChildren()
  card.classList.toggle('broken', !url)
  const link = document.createElement('a')
  link.className = 'bookmark-link'
  link.target = '_blank'
  link.rel = 'noopener noreferrer'
  if (url) link.href = url.href
  const text = document.createElement('div')
  text.className = 'bookmark-text'
  const title = document.createElement('div')
  title.className = 'bookmark-title'
  title.textContent = data.title || (url ? url.hostname.replace(/^www\./, '') : 'Lien invalide')
  text.appendChild(title)
  if (data.description) {
    const desc = document.createElement('div')
    desc.className = 'bookmark-desc'
    desc.textContent = data.description
    text.appendChild(desc)
  }
  const foot = document.createElement('div')
  foot.className = 'bookmark-url'
  if (data.favicon && proxied(data.favicon)) {
    const fav = document.createElement('img')
    fav.src = proxied(data.favicon)
    fav.alt = ''
    fav.onerror = () => fav.remove()
    foot.appendChild(fav)
  }
  const href = document.createElement('span')
  href.textContent = url ? url.href : data.url || ''
  foot.appendChild(href)
  text.appendChild(foot)
  link.appendChild(text)
  if (data.image && proxied(data.image)) {
    const cover = document.createElement('div')
    cover.className = 'bookmark-cover'
    const img = document.createElement('img')
    img.src = proxied(data.image)
    img.alt = ''
    img.draggable = false
    img.onerror = () => cover.remove()
    cover.appendChild(img)
    link.appendChild(cover)
  }
  card.appendChild(link)
}

// Petite fenêtre « Coller un lien » sous le curseur
export function promptUrl({ anchorRect, value = '', onSubmit }) {
  document.querySelector('.bookmark-prompt')?.remove()
  const pop = document.createElement('div')
  pop.className = 'popover bookmark-prompt'
  pop.innerHTML = `<input type="url" placeholder="Colle un lien…" spellcheck="false" />
    <button class="primary-btn" type="button">Créer le signet</button>
    <div class="bookmark-prompt-error hidden"></div>`
  document.body.appendChild(pop)
  const input = pop.querySelector('input')
  const button = pop.querySelector('button')
  const error = pop.querySelector('.bookmark-prompt-error')
  input.value = value
  const width = Math.min(440, window.innerWidth - 16)
  pop.style.width = `${width}px`
  pop.style.left = `${Math.max(8, Math.min(anchorRect.left, window.innerWidth - width - 8))}px`
  pop.style.top = `${Math.min(anchorRect.bottom + 6, window.innerHeight - 120)}px`
  const close = () => {
    pop.remove()
    document.removeEventListener('mousedown', outside, true)
  }
  const outside = (e) => {
    if (!pop.contains(e.target)) close()
  }
  const submit = async () => {
    let raw = input.value.trim()
    if (!raw) return
    if (!/^[a-z][a-z0-9+.-]*:/i.test(raw)) raw = `https://${raw}`
    if (!safeHttp(raw)) {
      error.textContent = 'Adresse web invalide'
      error.classList.remove('hidden')
      return
    }
    button.disabled = true
    button.textContent = 'Chargement de l’aperçu…'
    try {
      await onSubmit(raw)
      close()
    } catch (err) {
      button.disabled = false
      button.textContent = 'Créer le signet'
      error.textContent = err?.message || 'Échec'
      error.classList.remove('hidden')
    }
  }
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      submit()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      close()
    }
  })
  button.addEventListener('click', submit)
  document.addEventListener('mousedown', outside, true)
  requestAnimationFrame(() => input.focus())
}

// Aperçu demandé au serveur ; sans aperçu (page privée, injoignable), le signet garde l'adresse
export async function fetchBookmark(api, url) {
  try {
    return await api(`/api/unfurl?url=${encodeURIComponent(url)}`)
  } catch {
    return { url, title: safeHttp(url)?.hostname.replace(/^www\./, '') || url }
  }
}

// Insère le bloc ```embed à la place du paragraphe vide courant (ou après le bloc courant)
export function insertBookmarkBlock(editor, data, at = null) {
  const node = editor.schema.nodes.codeBlock.create({ language: EMBED_LANGUAGE }, editor.schema.text(embedText(data)))
  const { state } = editor
  const $from = at === null ? state.selection.$from : state.doc.resolve(Math.min(at, state.doc.content.size))
  const empty = $from.parent.isTextblock && $from.parent.content.size === 0 && $from.depth > 0
  const from = empty ? $from.before() : $from.depth > 0 ? $from.after() : $from.pos
  editor.view.dispatch(state.tr.replaceWith(from, empty ? $from.after() : from, node).scrollIntoView())
}
