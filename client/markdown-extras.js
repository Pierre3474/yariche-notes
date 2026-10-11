// Marques markdown supplémentaires, compatibles Obsidian.
import Highlight from '@tiptap/extension-highlight'
import markdownItMark from 'markdown-it-mark'

// ==texte surligné== (syntaxe Obsidian), stocké tel quel dans le .md
export const MarkdownHighlight = Highlight.extend({
  addStorage() {
    return {
      markdown: {
        serialize: { open: '==', close: '==', mixable: true, expelEnclosingWhitespace: true },
        parse: {
          setup(markdownit) {
            markdownit.use(markdownItMark)
          },
        },
      },
    }
  },
})

// Texte : prosemirror-markdown échappe tous les « [ » et « ] », ce qui enregistrait
// les [[liens]] en \[\[liens\]\] (rétroliens cassés, crochets visibles dans Obsidian).
// On protège les wikilinks et le marqueur d'encadré « [!type] » ; le reste est échappé.
import Text from '@tiptap/extension-text'

// Syntaxes Obsidian à écrire telles quelles : [[lien]], ![[intégration]], note de bas de page [^1]
const PROTECTED = /(!?\[\[[^[\]\n]+?\]\]|\[\^[^\]\s]+\])/
const isProtected = (part) => /^(!?\[\[[^[\]\n]+?\]\]|\[\^[^\]\s]+\])$/.test(part)
const CALLOUT_MARKER = /^\[![A-Za-z]+\][+-]?/
const escapeHTML = (value) => value.replace(/</g, '&lt;').replace(/>/g, '&gt;')

export const MarkdownText = Text.extend({
  addStorage() {
    return {
      markdown: {
        serialize(state, node, parent, index) {
          let text = escapeHTML(node.text)
          if (index === 0) {
            const m = text.match(CALLOUT_MARKER)
            if (m) {
              state.write(m[0])
              text = text.slice(m[0].length)
            }
          }
          for (const part of text.split(PROTECTED)) {
            if (!part) continue
            // write() et pas text(…, false) : ce dernier transformerait « ![[ » en « \![[ »
            if (isProtected(part)) state.write(part)
            else state.text(part, true)
          }
        },
        parse: {},
      },
    }
  },
})

// Listes de tâches compactes (« - [ ] a » puis « - [ ] b », sans ligne vide) :
// tiptap-markdown ne gère l'attribut « tight » que pour les listes à puces et numérotées,
// ce qui aérait toutes les checklists d'une note Obsidian à la première ouverture.
import { Extension } from '@tiptap/core'
export const TaskListTight = Extension.create({
  name: 'taskListTight',
  addGlobalAttributes() {
    return [
      {
        types: ['taskList'],
        attributes: {
          tight: {
            default: true,
            parseHTML: (element) => element.getAttribute('data-tight') === 'true' || !element.querySelector('p'),
            renderHTML: (attributes) => ({ 'data-tight': attributes.tight ? 'true' : null }),
          },
        },
      },
    ]
  },
})

// Retours à la ligne simples : Obsidian les affiche comme de vrais sauts de ligne
// (« Strict line breaks » désactivé par défaut). On les lit en saut de ligne
// (markdown-it « breaks ») et on les réécrit tels quels, sans « \\ » ni espaces.
import HardBreak from '@tiptap/extension-hard-break'
export const MarkdownHardBreak = HardBreak.extend({
  // ⇧Entrée dans un bloc de code : une ligne de plus (Tiptap en sortait, comme ⌘Entrée)
  addKeyboardShortcuts() {
    return {
      ...this.parent?.(),
      'Shift-Enter': () =>
        this.editor.isActive('codeBlock') ? this.editor.commands.newlineInCode() : this.editor.commands.setHardBreak(),
    }
  },
  addStorage() {
    return {
      markdown: {
        serialize(state) {
          if (state.inTable) state.write('<br>')
          // text() remet le préfixe du conteneur (« > », indentation de liste) sur la ligne suivante
          else state.text('\n', false)
        },
        parse: {},
      },
    }
  },
})
