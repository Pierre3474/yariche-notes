// Complétion en grisé façon Notion AI : après une pause de frappe en fin de paragraphe,
// l'assistant propose la suite en gris. Tab l'accepte, Échap ou toute autre frappe l'écarte.
import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'

const EMPTY = { pos: null, text: '' }
const MIN_CHARS = 20

export const AiGhost = Extension.create({
  name: 'aiGhost',
  priority: 1000, // avant la touche Tab des listes
  addOptions() {
    return { enabled: () => false, request: async () => '', delay: 900 }
  },
  addProseMirrorPlugins() {
    const opts = this.options
    const key = new PluginKey('aiGhost')
    let timer = null
    let seq = 0
    const clear = (view) => {
      if (key.getState(view.state).text) view.dispatch(view.state.tr.setMeta(key, EMPTY))
    }
    return [
      new Plugin({
        key,
        state: {
          init: () => EMPTY,
          apply(tr, value) {
            const meta = tr.getMeta(key)
            if (meta) return meta
            return tr.docChanged || tr.selectionSet ? EMPTY : value
          },
        },
        props: {
          decorations(state) {
            const v = key.getState(state)
            if (!v.text) return null
            const widget = () => {
              const span = document.createElement('span')
              span.className = 'ai-ghost'
              span.textContent = v.text
              return span
            }
            return DecorationSet.create(state.doc, [Decoration.widget(v.pos, widget, { side: 1, key: 'ai-ghost' })])
          },
          handleKeyDown(view, e) {
            const v = key.getState(view.state)
            if (!v.text) return false
            if (e.key === 'Tab' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
              e.preventDefault()
              view.dispatch(view.state.tr.insertText(v.text, v.pos).scrollIntoView())
              return true
            }
            if (e.key === 'Escape') {
              view.dispatch(view.state.tr.setMeta(key, EMPTY))
              return true
            }
            return false
          },
        },
        view() {
          return {
            update(view, prev) {
              if (prev.doc.eq(view.state.doc) && prev.selection.eq(view.state.selection)) return
              clearTimeout(timer)
              seq++
              if (!opts.enabled() || !view.editable || !view.hasFocus()) return
              const { selection } = view.state
              if (!selection.empty) return
              const { $from } = selection
              const parent = $from.parent
              if (!parent.isTextblock || parent.type.spec.code) return
              if ($from.parentOffset !== parent.content.size || parent.textContent.trim().length < MIN_CHARS) return
              const mine = seq
              const pos = selection.from
              timer = setTimeout(async () => {
                const before = view.state.doc.textBetween(Math.max(0, pos - 3000), pos, '\n\n', ' ')
                let text = ''
                try {
                  text = await opts.request(before)
                } catch {
                  return
                }
                if (mine !== seq || view.isDestroyed) return
                text = String(text || '').replace(/\r/g, '').split('\n')[0].trimEnd().slice(0, 240)
                if (!text.trim()) return
                // Espace de liaison si le texte ne se termine pas par un espace
                if (!/\s$/.test(before) && !/^[\s.,;:!?)\]]/.test(text)) text = ` ${text}`
                view.dispatch(view.state.tr.setMeta(key, { pos, text }))
              }, opts.delay)
            },
            destroy() {
              clearTimeout(timer)
              seq++
            },
          }
        },
      }),
    ]
  },
})
