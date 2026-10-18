// Éditeur Tiptap sans navigateur (happy-dom) : mêmes extensions Markdown que l'app,
// pour vérifier qu'un .md ouvert puis réenregistré reste identique.
import { Window } from 'happy-dom'

const window = new Window({ url: 'http://localhost/' })
// KaTeX vérifie le mode standard du document
Object.defineProperty(window.document, 'compatMode', { value: 'CSS1Compat' })
for (const key of ['window', 'document', 'navigator', 'Node', 'HTMLElement', 'Element', 'DOMParser', 'getComputedStyle',
  'MutationObserver', 'localStorage', 'requestAnimationFrame', 'cancelAnimationFrame', 'DocumentFragment', 'Text',
  'ClipboardEvent', 'DragEvent', 'KeyboardEvent', 'MouseEvent', 'Event', 'CustomEvent', 'Range', 'Selection',
  'HTMLDivElement', 'HTMLSpanElement', 'HTMLImageElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLButtonElement']) {
  if (!(key in globalThis) || key === 'window' || key === 'document' || key === 'navigator') {
    try {
      Object.defineProperty(globalThis, key, { value: window[key], configurable: true, writable: true })
    } catch {
      /* propriété en lecture seule dans Node */
    }
  }
}

const { Editor } = await import('@tiptap/core')
const { markdownEditorExtensions } = await import('../client/editor-extensions.js')

export function roundTrip(markdown) {
  const element = document.createElement('div')
  document.body.appendChild(element)
  const editor = new Editor({ element, extensions: markdownEditorExtensions(), content: markdown })
  const out = editor.storage.markdown.getMarkdown()
  const json = editor.getJSON()
  editor.destroy()
  element.remove()
  return { out, json }
}

export function withEditor(markdown, fn) {
  const element = document.createElement('div')
  document.body.appendChild(element)
  const editor = new Editor({ element, extensions: markdownEditorExtensions(), content: markdown })
  try {
    return fn(editor)
  } finally {
    editor.destroy()
    element.remove()
  }
}
