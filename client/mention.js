// « @ » : mentionner une personne, une page ou une date (comme Notion / AFFiNE).
// « [[ » : sélecteur de page façon Obsidian.
// Rien de spécial dans le schéma : une personne devient un lien markdown
// [@Nom](mailto:email), une page un [[wikilink]], une date du texte.
import { Extension } from '@tiptap/core'
import Suggestion from '@tiptap/suggestion'
import { PluginKey } from '@tiptap/pm/state'
import { SuggestMenu, suggestionRenderer, avatarColor, notInCode } from './suggest-menu.js'
import { pageIconHTML } from './icons.js'

const nameOf = (id) => String(id).slice(String(id).lastIndexOf('/') + 1)
const normalize = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

const fmtDate = (d) => d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' })
const DATES = [
  { title: "Aujourd'hui", keywords: 'today aujourdhui', offset: 0 },
  { title: 'Demain', keywords: 'tomorrow demain', offset: 1 },
  { title: 'Hier', keywords: 'yesterday hier', offset: -1 },
]

export const avatarHTML = (user) =>
  `<span class="avatar-chip" style="background:${avatarColor(user.email)}">${esc((user.name || '?')[0].toUpperCase())}</span>`

const mentionMenu = new SuggestMenu()
const pageMenu = new SuggestMenu()

export const MentionMenu = Extension.create({
  name: 'mentionMenu',

  addOptions() {
    return {
      getUsers: () => [],
      getPages: () => [],
      onMentionUser: null, // (user, editor) => void : notification
    }
  },

  addProseMirrorPlugins() {
    const opts = this.options

    const pageItems = (query, { withDates = false, max = 6 } = {}) => {
      const q = normalize(query)
      // Une page est repérée par son chemin (« R521/Concepts/MIMO ») : on cherche dans le
      // chemin entier, les noms qui correspondent d'abord
      const all = opts.getPages().filter((p) => p.type !== 'folder')
      const rank = (p) => {
        const i = normalize(nameOf(p.room)).indexOf(q)
        return i >= 0 ? i : 1000 + normalize(p.room).indexOf(q)
      }
      const pages = all
        .filter((p) => normalize(p.room).includes(q))
        .sort((a, b) => rank(a) - rank(b) || a.room.length - b.room.length)
        .slice(0, max)
      // Lien par le nom quand il est unique dans le coffre, sinon par le chemin (comme Obsidian)
      const linkText = (p) => {
        const n = normalize(nameOf(p.room))
        return all.some((o) => o.room !== p.room && normalize(nameOf(o.room)) === n) ? p.room : nameOf(p.room)
      }
      const items = pages.map((p) => ({
        group: 'Pages',
        title: nameOf(p.room),
        meta: p.room.includes('/') ? p.room.slice(0, p.room.lastIndexOf('/')) : '',
        iconHTML: pageIconHTML(p, 18),
        // Texte brut (pas du HTML) : un nom de page n'est jamais interprété
        run: (editor, range) =>
          editor.chain().focus().deleteRange(range).insertContent({ type: 'text', text: `[[${linkText(p)}]] ` }).run(),
      }))
      const exact = all.some((p) => normalize(nameOf(p.room)) === q)
      if (query.trim() && !exact && !/[/\\]/.test(query)) {
        items.push({
          group: 'Pages',
          title: `Nouvelle page « ${query.trim()} »`,
          icon: 'plus',
          run: (editor, range) =>
            editor.chain().focus().deleteRange(range).insertContent({ type: 'text', text: `[[${query.trim()}]] ` }).run(),
        })
      }
      if (withDates) {
        for (const d of DATES) {
          if (q && !normalize(`${d.title} ${d.keywords}`).includes(q)) continue
          const date = new Date(Date.now() + d.offset * 86400_000)
          items.push({
            group: 'Dates',
            title: d.title,
            meta: fmtDate(date),
            icon: 'calendar',
            run: (editor, range) => editor.chain().focus().deleteRange(range).insertContent(`${fmtDate(date)} `).run(),
          })
        }
      }
      return items
    }

    return [
      Suggestion({
        pluginKey: new PluginKey('mentionSuggestion'),
        editor: this.editor,
        char: '@',
        allowSpaces: false,
        allow: notInCode,
        items: ({ query }) => {
          const q = normalize(query)
          const people = opts
            .getUsers()
            .filter((u) => normalize(u.name).includes(q) || normalize(u.email).includes(q))
            .slice(0, 5)
            .map((u) => ({
              group: 'Personnes',
              title: u.name,
              subtitle: u.email,
              iconHTML: avatarHTML(u),
              run: (editor, range) => {
                editor
                  .chain()
                  .focus()
                  .deleteRange(range)
                  .insertContent([
                    { type: 'text', text: `@${u.name}`, marks: [{ type: 'link', attrs: { href: `mailto:${u.email}` } }] },
                    { type: 'text', text: ' ' },
                  ])
                  .run()
                opts.onMentionUser?.(u, editor)
              },
            }))
          return [...people, ...pageItems(query, { withDates: true, max: 5 })]
        },
        command: ({ editor, range, props }) => props.run(editor, range),
        render: suggestionRenderer(mentionMenu),
      }),
      Suggestion({
        pluginKey: new PluginKey('wikilinkSuggestion'),
        editor: this.editor,
        char: '[[',
        allowSpaces: true,
        allow: notInCode,
        allowedPrefixes: null,
        startOfLine: false,
        // Si l'utilisateur ferme lui-même le lien, on se retire
        items: ({ query }) => (query.includes(']') ? [] : pageItems(query, { max: 8 })),
        command: ({ editor, range, props }) => {
          // La plage couvre « [[requête » ; on absorbe aussi un « ]] » déjà présent juste après
          const after = editor.state.doc.textBetween(range.to, Math.min(range.to + 2, editor.state.doc.content.size))
          props.run(editor, after === ']]' ? { from: range.from, to: range.to + 2 } : range)
        },
        render: suggestionRenderer(pageMenu, { hideWhenEmpty: true }),
      }),
    ]
  },
})
