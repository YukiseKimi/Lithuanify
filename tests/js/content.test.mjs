import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { closeAll, loadContent, waitFor } from './harness.mjs'

afterEach(closeAll)

const lt = (body) => `<!doctype html><html lang="lt"><body>${body}</body></html>`

test('dictionary words show before the model answers, and only unknown words go to it', async () => {
  let answer
  const reply = new Promise((resolve) => { answer = resolve })
  const page = await loadContent(lt('<p id="p">Aš skaitau knygą.</p>'), { gloss: () => reply })

  await waitFor(() => page.glossCalls() === 1)
  assert.deepEqual(page.glosses(), [['Aš', 'I'], ['knygą', 'book']])
  assert.deepEqual(page.sent, [[{ text: 'Aš skaitau knygą.', words: ['skaitau'] }]])

  answer([{ skaitau: 'G:skaitau' }])
  await page.settle()
  assert.deepEqual(page.glosses(), [['Aš', 'I'], ['skaitau', 'G:skaitau'], ['knygą', 'book']])
})

test('a page that is not Lithuanian gets no glosses', async () => {
  const page = await loadContent('<!doctype html><html lang="en"><body><p>This is a book.</p></body></html>')
  await page.settle()
  assert.equal(page.glosses().length, 0)
  assert.equal(page.glossCalls(), 0)
})

test('a selected part of a word glosses only that word, with the whole sentence as context', async () => {
  const page = await loadContent(lt('<p id="p">Vilniaus senamiestis yra gražus.</p>'), { mode: 'select' })
  await page.settle()
  assert.equal(page.glosses().length, 0)

  page.select('#p', 10, 17)
  await waitFor(() => page.glosses().length === 1)
  await page.settle()

  assert.deepEqual(page.glosses(), [['senamiestis', 'G:senamiestis']])
  assert.deepEqual(page.sent, [[{ text: 'Vilniaus senamiestis yra gražus.', words: ['senamiestis'] }]])
  assert.equal(page.plainText('#p'), 'Vilniaus senamiestis yra gražus.')
})

test('a block whose model call failed is asked again once, after a pause', async () => {
  const page = await loadContent(lt('<p id="a">Aš skaitau.</p><p id="b">Vilniaus senamiestis.</p>'), {
    gloss: (blocks, call) => blocks.map((b) =>
      call === 1 && b.text.startsWith('Vilniaus') ? null : Object.fromEntries(b.words.map((w) => [w, 'G:' + w])))
  })
  await waitFor(() => page.glossCalls() === 1)
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.equal(page.glossCalls(), 1)

  await page.settle()
  assert.equal(page.glossCalls(), 2)
  assert.deepEqual(page.sent[1], [{ text: 'Vilniaus senamiestis.', words: ['vilniaus', 'senamiestis'] }])
  assert.deepEqual(page.glosses().map(([word]) => word), ['Aš', 'skaitau', 'Vilniaus', 'senamiestis'])
})

test('a block that keeps failing is retried only once', async () => {
  const page = await loadContent(lt('<p id="b">Vilniaus senamiestis.</p>'), {
    gloss: (blocks) => blocks.map(() => null)
  })
  await page.settle()
  assert.equal(page.glossCalls(), 2)
  assert.equal(page.glosses().length, 0)
})

test('turning Lithuanify off gives back the original text', async () => {
  const page = await loadContent(lt('<p id="p">Aš skaitau knygą apie <a href="#">Lietuvos istoriją</a>.</p>'))
  await page.settle()
  assert.ok(page.glosses().length > 0)

  page.state('disable()')
  assert.equal(page.glosses().length, 0)
  assert.equal(page.document.querySelector('#p').innerHTML, 'Aš skaitau knygą apie <a href="#">Lietuvos istoriją</a>.')
})

test('hover mode glosses a paragraph again after its text changes', async () => {
  const page = await loadContent(lt('<p id="p">Aš skaitau.</p>'), { mode: 'hover' })
  await page.settle()
  const hover = () => page.document.querySelector('#p').dispatchEvent(new page.window.MouseEvent('mouseover', { bubbles: true }))

  hover()
  await waitFor(() => page.glosses().length === 2)
  await page.settle()

  page.document.querySelector('#p').textContent = 'Karas tęsiasi.'
  hover()
  await waitFor(() => page.glosses().length === 2 && page.glosses()[0][0] === 'Karas')
  await page.settle()
  assert.deepEqual(page.glosses(), [['Karas', 'G:karas'], ['tęsiasi', 'G:tęsiasi']])
})

test('an inflected form gets its dictionary meaning from one lookup, and the model gets only the rest', async () => {
  let answer
  const reply = new Promise((resolve) => { answer = resolve })
  const page = await loadContent(lt('<p id="p">Aš skaitau knygoje.</p><p>Knygoje gaisras.</p>'), { gloss: () => reply })

  await waitFor(() => page.glossCalls() === 1)
  assert.deepEqual(page.glosses(), [['Aš', 'I'], ['knygoje', 'book'], ['Knygoje', 'book']])
  assert.deepEqual(page.lookups, [['aš', 'skaitau', 'knygoje', 'gaisras']])
  assert.deepEqual(page.sent[0].map((b) => b.words), [['skaitau'], ['gaisras']])
  answer([{ skaitau: 'G:skaitau' }, { gaisras: 'G:gaisras' }])
  await page.settle()
})

test('a word whose lookup failed is asked again with the next batch', async () => {
  const page = await loadContent(lt('<p>Knygą skaitau.</p>'), { lookupFailures: 1 })
  await page.settle()
  page.document.body.insertAdjacentHTML('beforeend', '<p id="n">Aš turiu knygą.</p>')
  await waitFor(() => page.glosses().some(([word, gloss]) => word === 'knygą' && gloss === 'book'))
  assert.ok(page.lookups.length >= 2)
  assert.ok(page.lookups[1].includes('knygą'))
})
