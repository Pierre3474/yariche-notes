// Extensions qui définissent le schéma et le format Markdown de l'éditeur : partagées par
// l'éditeur de page, ceux des lignes de base et les tests (aller-retour .md identique).
import { StarterKit } from '@tiptap/starter-kit'
import { Markdown } from 'tiptap-markdown'
import { TaskList, TaskItem } from '@tiptap/extension-list'
import { Image } from '@tiptap/extension-image'
import { Link } from '@tiptap/extension-link'
import { Table, TableRow, TableHeader, TableCell } from '@tiptap/extension-table'
import { MarkdownHighlight, MarkdownText, TaskListTight, MarkdownHardBreak } from './markdown-extras.js'
import { CodeBlock } from './code-block.js'
import { MathInline, MathBlock } from './math.js'
import { CalloutBlocks } from './callout-blocks.js'

// Tiptap 3 : l'historique (undoRedo) vient de Yjs ; le lien est configuré à part ; pas de
// souligné (pas de Markdown pour ça) ni de paragraphe final ajouté d'office (le fichier
// ouvert doit rester identique)
export const STARTER_KIT = {
  undoRedo: false,
  text: false,
  codeBlock: false,
  hardBreak: false,
  link: false,
  underline: false,
  trailingNode: false,
}

// Socle : à placer en tête de la liste des extensions
export const baseExtensions = () => [StarterKit.configure(STARTER_KIT), MarkdownText, MarkdownHardBreak]

// Contenu : l'ordre compte, tiptap-markdown se greffe sur les extensions déjà
// enregistrées portant le même nom (image, link, table...)
export function contentMarkdownExtensions({ image = Image, fetchBookmark = null } = {}) {
  return [
    image,
    Link.configure({ openOnClick: false, autolink: true, HTMLAttributes: { rel: 'noopener', target: '_blank' } }),
    Table.configure({ resizable: false }),
    TableRow,
    TableHeader,
    TableCell,
    MarkdownHighlight.configure({ multicolor: false }),
    CodeBlock.configure({ fetchBookmark }),
    Markdown.configure({ html: false, transformPastedText: true, linkify: true, breaks: true }),
    TaskList,
    TaskListTight,
    TaskItem.configure({ nested: true }),
    MathInline,
    MathBlock,
    CalloutBlocks,
  ]
}

export const markdownEditorExtensions = (options) => [...baseExtensions(), ...contentMarkdownExtensions(options)]
