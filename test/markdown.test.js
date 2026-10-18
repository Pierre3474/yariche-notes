import test from 'node:test'
import assert from 'node:assert/strict'
import { roundTrip, withEditor } from './markdown-env.js'
import { resizePair } from '../client/callout-blocks.js'

// Un .md ouvert puis réenregistré sans modification doit rester identique
const same = (md) => assert.equal(roundTrip(md).out, md)

test('socle : titres, listes, encadré', () => {
  same('# Titre\n\n#### Titre 4\n\n- a\n- b\n\n> [!note] Titre\n> corps')
})

test('équations : LaTeX conservé tel quel', () => {
  same('$$\n\\frac{a_1}{b_2} * c\n$$')
  same('Masse $E = m*c^2$ et $\\alpha_i$.')
  same('> [!note] Formule\n>\n> $$\n> \\sum_{i=1}^n x_i\n> $$')
  same('$$x^2$$'.replace('$$x^2$$', '$$\nx^2\n$$'))
})

test('équations : les prix ne deviennent pas des formules', () => {
  const { out, json } = roundTrip('Prix 5 $ et 10 $, ou $5 et $10.')
  assert.equal(out, 'Prix 5 $ et 10 $, ou $5 et $10.')
  assert.ok(!JSON.stringify(json).includes('mathInline'))
})

test('équations : nœuds reconnus', () => {
  const { json } = roundTrip('Texte $x^2$ fin\n\n$$\ny\n$$')
  const s = JSON.stringify(json)
  assert.ok(s.includes('"mathInline"') && s.includes('"latex":"x^2"'))
  assert.ok(s.includes('"mathBlock"') && s.includes('"latex":"y"'))
})

test('colonnes : format canonique conservé', () => {
  same('> [!columns]\n>\n> > [!column|40]\n> > Texte A\n>\n> > [!column|60]\n> > Texte B')
  same('> [!columns]\n>\n> > [!column]\n> >\n> > - a\n> > - b\n>\n> > [!column]\n> > ![[photo.png]]')
})

test('blocs dépliants', () => {
  same('> [!toggle]- Résumé\n> caché\n> encore')
  same('> [!toggle]+ Ouvert\n>\n> Paragraphe')
})

test('colonnes : insertion puis frappe', () => {
  const md = withEditor('', (editor) => {
    editor.commands.insertColumns(2)
    editor.view.someProp('handleTextInput', (f) => f(editor.view, editor.state.selection.from, editor.state.selection.from, 'Gauche'))
    return editor.storage.markdown.getMarkdown()
  })
  assert.equal(md, '> [!columns]\n>\n> > [!column]\n> > Gauche\n>\n> > [!column]')
  assert.equal(roundTrip(md).out, md)
})

test('colonnes : redimensionnement par pas', () => {
  // 2 colonnes de 400 px à 50/50, poignée tirée de 100 px : pas de 1/16
  const [l, r] = resizePair({ leftWidth: 400, rightWidth: 400, leftRatio: 0.5, rightRatio: 0.5, diffX: 100, count: 2 })
  assert.equal(l, 0.625)
  assert.ok(Math.abs(l + r - 1) < 1e-9)
  // Jamais sous un pas
  const [l2, r2] = resizePair({ leftWidth: 400, rightWidth: 400, leftRatio: 0.5, rightRatio: 0.5, diffX: -1000, count: 2 })
  assert.equal(l2, 1 / 16)
  assert.ok(Math.abs(r2 - 15 / 16) < 1e-9)
})

test('bloc dépliant : insertion', () => {
  const md = withEditor('', (editor) => {
    editor.commands.insertToggle()
    editor.commands.insertContent('Titre')
    return editor.storage.markdown.getMarkdown()
  })
  assert.equal(md, '> [!toggle]- Titre')
})

test('signets : bloc embed conservé et lu', async () => {
  const { parseEmbed, embedText } = await import('../client/bookmark.js')
  const md = '```embed\ntitle: "Le Monde \\"actu\\""\nimage: "https://a.example/c.png"\ndescription: "Résumé"\nurl: "https://a.example/"\nfavicon: "https://a.example/f.ico"\n```'
  same(md)
  const data = parseEmbed(md.split('\n').slice(1, -1).join('\n'))
  assert.equal(data.title, 'Le Monde "actu"')
  assert.equal(data.url, 'https://a.example/')
  assert.equal(embedText(data), md.split('\n').slice(1, -1).join('\n'))
})
