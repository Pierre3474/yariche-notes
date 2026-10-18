// Decorations pures (pas de noeuds/marks dans le schema) pour [[wikilinks]]
// et #tags. Le texte reste du markdown brut en sortie (round-trip garanti),
// seule l'affichage dans l'editeur est enrichi.
import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { CALLOUT_RE } from './callout-blocks.js'

// [[Page]], [[Page|alias]], [[Page#Titre]] (syntaxes Obsidian)
const WIKILINK_RE = /\[\[([^\]|#]+)(#[^\]|]*)?(\|[^\]]*)?\]\]/g
// Encadrés Obsidian/GitHub : « > [!note] » en début de citation (CALLOUT_RE) ;
// colonnes et blocs dépliants : voir callout-blocks.js
const CALLOUT_KIND = {
  note: 'blue', info: 'blue', todo: 'blue', abstract: 'purple', summary: 'purple', tldr: 'purple',
  tip: 'green', hint: 'green', important: 'purple', success: 'green', check: 'green', done: 'green',
  question: 'orange', help: 'orange', faq: 'orange', warning: 'orange', caution: 'orange', attention: 'orange',
  danger: 'red', error: 'red', failure: 'red', fail: 'red', missing: 'red', bug: 'red',
  example: 'purple', quote: 'gray', cite: 'gray', toggle: 'toggle',
}
const CALLOUT_LABEL = {
  note: 'Note', info: 'Info', todo: 'À faire', abstract: 'Résumé', summary: 'Résumé', tldr: 'Résumé',
  tip: 'Astuce', hint: 'Astuce', important: 'Important', success: 'Succès', check: 'Succès', done: 'Fait',
  question: 'Question', help: 'Aide', faq: 'FAQ', warning: 'Attention', caution: 'Prudence', attention: 'Attention',
  danger: 'Danger', error: 'Erreur', failure: 'Échec', fail: 'Échec', missing: 'Manquant', bug: 'Bug',
  example: 'Exemple', quote: 'Citation', cite: 'Citation', toggle: 'Bloc dépliant',
}
const TAG_RE = /(^|\s)(#[\wàâäéèêëïîôöùûüç-]+)/g
// Image intégrée à la façon d'Obsidian : ![[photo.png]], ![[dossier/photo.png|300]]
const EMBED_RE = /!\[\[([^\]|#]+?\.(?:png|jpe?g|gif|webp|svg|avif|bmp|pdf))(?:\|(\d+)(?:x(\d+))?)?\]\]/gi
const isImageEmbedAt = (text, index) => text[index - 1] === '!' && /\.(png|jpe?g|gif|webp|svg|avif|bmp|pdf)\s*[\]|]/i.test(text.slice(index))

// PDF intégré : carte avec le nom du fichier, ouverte dans le lecteur PDF du navigateur
function pdfWidget(target) {
  const name = target.split('/').pop()
  const params = new URLSearchParams({ name })
  if (target.includes('/')) params.append('path', target)
  const card = document.createElement('a')
  card.className = 'embed-pdf'
  card.href = `/api/vault-file?${params}`
  card.target = '_blank'
  card.rel = 'noopener'
  card.contentEditable = 'false'
  const badge = document.createElement('span')
  badge.className = 'embed-pdf-badge'
  badge.textContent = 'PDF'
  const label = document.createElement('span')
  label.className = 'embed-pdf-name'
  label.textContent = name
  card.append(badge, label)
  return card
}

// Autre pièce jointe : carte avec l'extension, le nom et un lien de téléchargement
// (le serveur l'envoie en pièce jointe, jamais affichée dans l'app)
const FILE_EMBED_RE = /!\[\[([^\]|#\n]+?\.([a-z0-9]{1,12}))\]\]/gi
const NOT_FILE = /^(png|jpe?g|gif|webp|svg|avif|bmp|pdf|md|canvas|base)$/i
function fileWidget(target, ext) {
  const name = target.split('/').pop()
  const params = new URLSearchParams({ name })
  if (target.includes('/')) params.append('path', target)
  const card = document.createElement('a')
  card.className = 'embed-file'
  card.href = `/api/vault-file?${params}`
  card.rel = 'noopener'
  card.setAttribute('download', name)
  card.contentEditable = 'false'
  const badge = document.createElement('span')
  badge.className = 'embed-file-badge'
  badge.textContent = ext.toUpperCase().slice(0, 5)
  const label = document.createElement('span')
  label.className = 'embed-file-name'
  label.textContent = name
  card.append(badge, label)
  return card
}

function embedWidget(target, width) {
  if (/\.pdf$/i.test(target)) return pdfWidget(target)
  const img = document.createElement('img')
  img.className = 'embed-image'
  const name = target.split('/').pop()
  const params = new URLSearchParams({ name })
  if (target.includes('/')) params.append('path', target)
  img.src = `/api/vault-file?${params}`
  img.alt = target
  img.draggable = false
  if (width) img.style.width = `${Math.min(Number(width), 2000)}px`
  img.onerror = () => img.classList.add('missing')
  return img
}

function buildDecorations(doc, { onWikilinkClick, onTagClick }) {
  const decorations = []
  doc.descendants((node, pos) => {
    if (node.type.name === 'blockquote') {
      const first = node.firstChild
      const m = first?.isTextblock ? first.textContent.match(CALLOUT_RE) : null
      if (m && !['columns', 'column'].includes(m[1].toLowerCase())) {
        const kind = m[1].toLowerCase()
        const color = CALLOUT_KIND[kind] || 'blue'
        decorations.push(Decoration.node(pos, pos + node.nodeSize, { class: `callout callout-${color}` }))
        // pos + 1 = entrée dans la citation, + 1 = entrée dans son premier paragraphe
        // Titre personnalisé = reste de la 1re ligne (jusqu'au premier saut de ligne)
        let lineEnd = first.content.size
        let offset = 0
        first.content.forEach((child) => {
          if (child.type.name === 'hardBreak' && lineEnd === first.content.size) lineEnd = offset
          offset += child.nodeSize
        })
        const titleFrom = pos + 2 + m[0].length
        const titleTo = pos + 2 + lineEnd
        const hasTitle = titleTo > titleFrom && first.textBetween(m[0].length, lineEnd).trim().length > 0
        decorations.push(
          Decoration.inline(pos + 2, titleFrom, {
            class: 'callout-marker' + (hasTitle ? ' with-title' : ''),
            'data-kind': kind,
            'data-label': CALLOUT_LABEL[kind] || kind,
          })
        )
        if (hasTitle) decorations.push(Decoration.inline(titleFrom, titleTo, { class: 'callout-title' }))
      }
      return true
    }
    if (!node.isText) return
    const text = node.text

    for (const m of text.matchAll(EMBED_RE)) {
      const from = pos + m.index
      const to = from + m[0].length
      decorations.push(Decoration.inline(from, to, { class: 'embed-source' }))
      decorations.push(
        Decoration.widget(to, () => embedWidget(m[1].trim(), m[2]), { key: `embed:${m[1]}:${m[2] || ''}`, side: 1 })
      )
    }

    const fileEmbeds = []
    for (const m of text.matchAll(FILE_EMBED_RE)) {
      if (NOT_FILE.test(m[2])) continue
      const from = pos + m.index
      const to = from + m[0].length
      fileEmbeds.push(m.index + 1)
      decorations.push(Decoration.inline(from, to, { class: 'embed-source' }))
      decorations.push(Decoration.widget(to, () => fileWidget(m[1].trim(), m[2]), { key: `file:${m[1]}`, side: 1 }))
    }

    for (const m of text.matchAll(WIKILINK_RE)) {
      if (isImageEmbedAt(text, m.index) || fileEmbeds.includes(m.index)) continue // intégration, pas un lien de page
      const from = pos + m.index
      const to = from + m[0].length
      decorations.push(
        Decoration.inline(from, to, {
          class: 'wikilink-decoration',
          'data-page': m[1].trim(),
        })
      )
    }

    for (const m of text.matchAll(TAG_RE)) {
      const tagText = m[2]
      const from = pos + m.index + m[1].length
      const to = from + tagText.length
      decorations.push(
        Decoration.inline(from, to, {
          class: 'tag-decoration',
          'data-tag': tagText.slice(1),
        })
      )
    }
  })
  return DecorationSet.create(doc, decorations)
}

export const LinkDecorations = Extension.create({
  name: 'linkDecorations',

  addOptions() {
    return {
      onWikilinkClick: (page) => console.log('wikilink click', page),
      onTagClick: (tag) => console.log('tag click', tag),
    }
  },

  addProseMirrorPlugins() {
    const options = this.options
    const key = new PluginKey('linkDecorations')
    return [
      new Plugin({
        key,
        state: {
          init: (_, { doc }) => buildDecorations(doc, options),
          apply: (tr, old) => (tr.docChanged ? buildDecorations(tr.doc, options) : old),
        },
        props: {
          decorations(state) {
            return key.getState(state)
          },
          handleClick(view, pos, event) {
            const target = event.target
            if (target?.classList?.contains('wikilink-decoration')) {
              options.onWikilinkClick(target.dataset.page)
              return true
            }
            if (target?.classList?.contains('tag-decoration')) {
              options.onTagClick(target.dataset.tag)
              return true
            }
            return false
          },
        },
      }),
    ]
  },
})
