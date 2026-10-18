import { Extension } from '@tiptap/core'
import Suggestion from '@tiptap/suggestion'
import { PluginKey } from '@tiptap/pm/state'
import { SuggestMenu, suggestionRenderer, notInCode } from './suggest-menu.js'
import { lastCodeLanguage } from './code-block.js'

const today = () => new Date().toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' })

// Groupes et libellés calqués sur le menu « / » d'AFFiNE et de Notion.
// run(editor, range, options) : options = actions fournies par l'app (image, sous-pages…)
const ITEMS = [
  { group: 'IA', title: "Demander à l'IA", subtitle: 'Écrire, continuer ou reformuler avec l’assistant.', icon: 'sparkle', keywords: 'ia ai assistant gpt llm ecrire continuer',
    run: (e, r, o) => {
      e.chain().focus().deleteRange(r).run()
      o.openAi?.()
    } },
  { group: 'Basique', title: 'Texte', subtitle: 'Commencer à écrire du texte simple.', glyph: 'T', keywords: 'paragraphe text',
    run: (e, r) => e.chain().focus().deleteRange(r).setParagraph().run() },
  { group: 'Basique', title: 'Titre 1', subtitle: 'Titre dans la plus grande taille.', glyph: 'H1', keywords: 'h1 heading',
    run: (e, r) => e.chain().focus().deleteRange(r).setNode('heading', { level: 1 }).run() },
  { group: 'Basique', title: 'Titre 2', subtitle: 'Titre de taille moyenne.', glyph: 'H2', keywords: 'h2 heading',
    run: (e, r) => e.chain().focus().deleteRange(r).setNode('heading', { level: 2 }).run() },
  { group: 'Basique', title: 'Titre 3', subtitle: 'Petit titre de section.', glyph: 'H3', keywords: 'h3 heading',
    run: (e, r) => e.chain().focus().deleteRange(r).setNode('heading', { level: 3 }).run() },
  { group: 'Basique', title: 'Titre 4', subtitle: 'Titre de plus petite taille.', glyph: 'H4', keywords: 'h4 heading',
    run: (e, r) => e.chain().focus().deleteRange(r).setNode('heading', { level: 4 }).run() },
  { group: 'Basique', title: 'Page', subtitle: 'Sous-page liée à celle-ci.', icon: 'page', keywords: 'page sous-page subpage',
    run: (e, r, o) => o.createSubpage?.(e, r, 'doc') },
  { group: 'Basique', title: 'Citation', subtitle: 'Mettre un passage en exergue.', icon: 'quote', keywords: 'quote blockquote',
    run: (e, r) => e.chain().focus().deleteRange(r).toggleBlockquote().run() },
  { group: 'Basique', title: 'Encadré', subtitle: 'Faire ressortir une information (callout).', icon: 'callout', keywords: 'callout encadre note info',
    run: (e, r) => e.chain().focus().deleteRange(r).setParagraph().toggleBlockquote().insertContent('[!note] ').run() },
  { group: 'Basique', title: 'Bloc dépliant', subtitle: 'Masquer du contenu sous un titre (toggle).', icon: 'chevron', keywords: 'toggle depliant replier masquer details',
    run: (e, r) => e.chain().focus().deleteRange(r).insertToggle().run() },
  { group: 'Basique', title: 'Bloc de code', subtitle: 'Extrait de code avec police à chasse fixe.', icon: 'code', keywords: 'code pre',
    run: (e, r) => e.chain().focus().deleteRange(r).toggleCodeBlock({ language: lastCodeLanguage() }).run() },
  { group: 'Listes', title: 'Liste à puces', subtitle: 'Liste simple non ordonnée.', icon: 'bullets', keywords: 'bullet ul',
    run: (e, r) => e.chain().focus().deleteRange(r).toggleBulletList().run() },
  { group: 'Listes', title: 'Liste numérotée', subtitle: 'Liste ordonnée.', icon: 'numbers', keywords: 'ordered ol numero',
    run: (e, r) => e.chain().focus().deleteRange(r).toggleOrderedList().run() },
  { group: 'Listes', title: 'Liste de tâches', subtitle: 'Suivre des tâches avec des cases à cocher.', icon: 'todo', keywords: 'todo task checkbox tache',
    run: (e, r) => e.chain().focus().deleteRange(r).toggleTaskList().run() },
  { group: 'Style', title: 'Surligné', subtitle: 'Surligner du texte (==texte==).', icon: 'highlight', keywords: 'highlight surligner mark',
    run: (e, r) => e.chain().focus().deleteRange(r).toggleHighlight().run() },
  { group: 'Contenu', title: 'Image ou PDF', subtitle: 'Importer une image ou un PDF depuis ton ordinateur.', icon: 'image', keywords: 'image photo upload pdf fichier document',
    run: (e, r, o) => {
      e.chain().focus().deleteRange(r).run()
      o.insertImage?.(e)
    } },
  { group: 'Contenu', title: 'Fichier', subtitle: 'Joindre un document, une archive… (25 Mo max).', icon: 'attach', keywords: 'fichier file piece jointe document upload telecharger',
    run: (e, r, o) => {
      e.chain().focus().deleteRange(r).run()
      o.insertFile?.(e)
    } },
  { group: 'Contenu', title: 'Signet', subtitle: 'Aperçu d’un lien web (titre, image, description).', icon: 'bookmark', keywords: 'bookmark signet lien url apercu web embed',
    run: (e, r, o) => {
      e.chain().focus().deleteRange(r).run()
      o.insertBookmark?.(e)
    } },
  { group: 'Contenu', title: 'Équation', subtitle: 'Formule mathématique en bloc (LaTeX, KaTeX).', icon: 'math', keywords: 'equation math latex katex formule tex',
    run: (e, r) => e.chain().focus().deleteRange(r).insertMathBlock().run() },
  { group: 'Contenu', title: 'Équation en ligne', subtitle: 'Formule dans la phrase ($x^2$).', icon: 'math', keywords: 'equation inline math latex formule ligne',
    run: (e, r) => e.chain().focus().deleteRange(r).insertMathInline().run() },
  { group: 'Mise en page', title: '2 colonnes', subtitle: 'Deux colonnes côte à côte.', icon: 'columns', keywords: 'colonnes columns cote layout mise en page 2',
    run: (e, r) => e.chain().focus().deleteRange(r).insertColumns(2).run() },
  { group: 'Mise en page', title: '3 colonnes', subtitle: 'Trois colonnes côte à côte.', icon: 'columns', keywords: 'colonnes columns layout 3',
    run: (e, r) => e.chain().focus().deleteRange(r).insertColumns(3).run() },
  { group: 'Mise en page', title: '4 colonnes', subtitle: 'Quatre colonnes côte à côte.', icon: 'columns', keywords: 'colonnes columns layout 4',
    run: (e, r) => e.chain().focus().deleteRange(r).insertColumns(4).run() },
  { group: 'Contenu', title: 'Tableau', subtitle: 'Tableau markdown 3 × 3.', icon: 'table', keywords: 'table tableau grid',
    run: (e, r) => e.chain().focus().deleteRange(r).insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run() },
  { group: 'Contenu', title: 'Séparateur', subtitle: 'Ligne de séparation horizontale.', icon: 'divider', keywords: 'divider hr ligne',
    run: (e, r) => e.chain().focus().deleteRange(r).setHorizontalRule().run() },
  { group: 'Contenu', title: 'Lien vers une page', subtitle: 'Lien interne [[Page]] avec rétrolien.', icon: 'link', keywords: 'link page wikilink',
    run: (e, r) => e.chain().focus().deleteRange(r).insertContent('[[').run() },
  { group: 'Contenu', title: 'Mentionner une personne', subtitle: 'La personne est notifiée.', icon: 'at', keywords: 'mention personne @ user',
    run: (e, r) => e.chain().focus().deleteRange(r).insertContent(' @').run() },
  { group: 'Bases & canevas', title: 'Base de données', subtitle: 'Sous-page base de données (tableau, kanban…).', icon: 'database', keywords: 'database base table kanban board',
    run: (e, r, o) => o.createSubpage?.(e, r, 'database') },
  { group: 'Bases & canevas', title: 'Whiteboard', subtitle: 'Sous-page canevas infini.', icon: 'board', keywords: 'whiteboard canvas edgeless dessin',
    run: (e, r, o) => o.createSubpage?.(e, r, 'board') },
  { group: 'Date', title: "Aujourd'hui", subtitle: 'Insérer la date du jour.', icon: 'calendar', keywords: 'date today jour',
    run: (e, r) => e.chain().focus().deleteRange(r).insertContent(today()).run() },
  { group: 'Date', title: 'Maintenant', subtitle: "Insérer la date et l'heure.", icon: 'calendar', keywords: 'now heure time',
    run: (e, r) =>
      e.chain().focus().deleteRange(r)
        .insertContent(`${today()} ${new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`)
        .run() },
]

const normalize = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')

function filterItems(query) {
  if (!query) return ITEMS
  const q = normalize(query)
  return ITEMS.filter((i) => normalize(`${i.title} ${i.keywords || ''}`).includes(q))
}

const menu = new SuggestMenu()

export const SlashCommand = Extension.create({
  name: 'slashCommand',

  addOptions() {
    return { insertImage: null, createSubpage: null, openAi: null, aiEnabled: () => false }
  },

  addProseMirrorPlugins() {
    const options = this.options
    return [
      Suggestion({
        pluginKey: new PluginKey('slashSuggestion'),
        editor: this.editor,
        char: '/',
        allowSpaces: false,
        allowedPrefixes: null,
        startOfLine: false,
        allow: notInCode,
        items: ({ query }) => filterItems(query).filter((i) => i.group !== 'IA' || options.aiEnabled?.()),
        command: ({ editor, range, props }) => {
          // « ///code » : seul le dernier « / » ouvre le menu ; les « / » tapés en trop
          // juste avant ne doivent pas rester dans le texte (ni dans le bloc créé)
          const $from = editor.state.doc.resolve(range.from)
          const before = $from.parent.textBetween(0, $from.parentOffset, undefined, '\ufffc')
          const extra = before.match(/\/+$/)?.[0].length || 0
          props.run(editor, { from: range.from - extra, to: range.to }, options)
        },
        // Rien ne correspond (date « 25/09 », URL « http://… ») : le menu disparaît, comme Notion
        render: suggestionRenderer(menu, { hideWhenEmpty: true }),
      }),
    ]
  },
})
