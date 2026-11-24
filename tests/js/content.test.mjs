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
  assert.equal(page.lookups.length, 1)
  assert.deepEqual(page.lookups[0].filter((w) => !w.includes(' ')), ['aš', 'skaitau', 'knygoje', 'gaisras'])
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
  await page.settle()
})

test('a batch whose lookup failed waits and asks again before it renders', async () => {
  const page = await loadContent(lt('<p>Aš skaitau knygą.</p>'), { modelAvailable: false, lookupFailures: 1 })
  await page.settle()
  assert.equal(page.lookups.length, 2)
  assert.deepEqual(page.glosses(), [['Aš', 'I'], ['knygą', 'book']])
})

test('the page keeps at most 20000 looked-up words', async () => {
  const word = (n) => 'w' + [...n.toString(26).padStart(4, '0')].map((d) => String.fromCharCode(97 + parseInt(d, 26))).join('')
  const words = Array.from({ length: 20050 }, (_, i) => word(i))
  const html = Array.from({ length: 401 }, (_, p) => `<p>${words.slice(p * 50, p * 50 + 50).join(' ')}</p>`).join('')
  const page = await loadContent(lt(html), { modelAvailable: false })
  await page.settle()
  assert.equal(new Set(words).size, 20050)
  assert.ok(page.state('meanings.size') <= 20000)
})

test('a word with several meanings shows the first, and the model may replace it', async () => {
  let answer
  const reply = new Promise((resolve) => { answer = resolve })
  const page = await loadContent(lt('<p>Kasa uždaryta.</p>'), {
    dictionary: { kasa: ['cash register', 'braid'] }, gloss: () => reply
  })
  await waitFor(() => page.glossCalls() === 1)
  assert.deepEqual(page.glosses(), [['Kasa', 'cash register']])
  assert.deepEqual(page.sent[0], [{
    text: 'Kasa uždaryta.', words: ['kasa', 'uždaryta'],
    hints: [{ lemma: null, options: ['cash register', 'braid'] }, null]
  }])
  answer([{ kasa: 'braid', uždaryta: 'G:uždaryta' }])
  await page.settle()
  assert.deepEqual(page.glosses(), [['Kasa', 'braid'], ['uždaryta', 'G:uždaryta']])
})

test('with the AI off, a word with several meanings keeps its first meaning', async () => {
  const page = await loadContent(lt('<p>Kasa uždaryta.</p>'), {
    dictionary: { kasa: ['cash register', 'braid'] }, modelAvailable: false
  })
  await page.settle()
  assert.deepEqual(page.glosses(), [['Kasa', 'cash register']])
  assert.equal(page.glossCalls(), 0)
})

test('a capitalised unknown word inside a sentence is taken as a name and not sent', async () => {
  const page = await loadContent(lt('<p>Vilniaus senamiestis. Vakar sutikau Joną ir NATO.</p>'))
  await page.settle()
  assert.deepEqual(page.sent.flat().map((b) => b.words), [['vilniaus', 'senamiestis', 'vakar', 'sutikau', 'ir']])
})

test('a known phrase shows one meaning over the whole phrase, and its words are not sent', async () => {
  const page = await loadContent(lt('<p>Aš vis dėlto skaitau.</p>'), {
    dictionary: { aš: 'I', 'vis dėlto': 'nevertheless' }
  })
  await page.settle()
  assert.deepEqual(page.glosses(), [['Aš', 'I'], ['vis dėlto', 'nevertheless'], ['skaitau', 'G:skaitau']])
  assert.deepEqual(page.sent.flat().map((b) => b.words), [['skaitau']])
  assert.ok(page.lookups[0].includes('vis dėlto'))
})

test('a paused reply keeps the dictionary meanings and asks again after the pause, without using the retry', async () => {
  let calls = 0
  const page = await loadContent(lt('<p>Aš skaitau knygą.</p>'), {
    reply: (blocks) => {
      calls += 1
      return calls <= 2
        ? { available: true, paused: true, retryInMs: 50, results: blocks.map(() => null) }
        : { available: true, results: blocks.map((b) => Object.fromEntries(b.words.map((w) => [w, 'G:' + w]))) }
    }
  })
  await waitFor(() => calls === 1)
  assert.deepEqual(page.glosses(), [['Aš', 'I'], ['knygą', 'book']])
  await waitFor(() => page.glosses().length === 3)
  assert.equal(calls, 3)
})

test('a paragraph far below the screen gets dictionary meanings but waits for the model until it scrolls into view', async () => {
  const page = await loadContent(lt('<p id="top">Aš skaitau.</p><p id="far">Aš rašau knygą.</p>'), { offscreen: '#far' })
  await page.settle()
  assert.deepEqual(page.sent.flat().map((b) => b.text), ['Aš skaitau.'])
  assert.deepEqual(page.glosses(), [['Aš', 'I'], ['skaitau', 'G:skaitau'], ['Aš', 'I'], ['knygą', 'book']])

  page.scrollTo('#far')
  await waitFor(() => page.glosses().length === 5)
  assert.deepEqual(page.sent.flat().map((b) => b.text), ['Aš skaitau.', 'Aš rašau knygą.'])
})

test('hiding common words leaves a common word bare and does not send it to the model', async () => {
  const page = await loadContent(lt('<p>Aš skaitau knygą.</p>'), {
    hideCommon: 500,
    dictionary: { aš: { m: ['I'], r: 2 }, skaitau: { m: ['read'], r: 300 }, knygą: { m: ['book'], r: 900 } }
  })
  await page.settle()
  assert.deepEqual(page.glosses(), [['knygą', 'book']])
  assert.equal(page.glossCalls(), 0)
})

test('turning Lithuanify off in the popup gives back the original text in every open tab', async () => {
  const page = await loadContent(lt('<p id="p">Aš skaitau knygą.</p>'))
  await page.settle()
  assert.ok(page.glosses().length > 0)

  page.changeSettings({ enabled: false })
  await waitFor(() => page.glosses().length === 0)
  assert.equal(page.document.querySelector('#p').innerHTML, 'Aš skaitau knygą.')

  page.changeSettings({ enabled: true })
  await waitFor(() => page.glosses().length > 0)
  await page.settle()
})

test('a new translate mode from the popup reaches a tab that is already open', async () => {
  const page = await loadContent(lt('<p id="p">Aš skaitau knygą.</p>'))
  await page.settle()
  assert.ok(page.glosses().length > 0)

  page.changeSettings({ mode: 'select' })
  await waitFor(() => page.glosses().length === 0)
  await page.settle()
  assert.equal(page.state('mode'), 'select')
})

test('a page whose Lithuanian text arrives after load still gets glosses', async () => {
  const page = await loadContent('<!doctype html><html><body><div id="app">Loading…</div></body></html>')
  await page.settle()
  assert.equal(page.glosses().length, 0)

  page.document.querySelector('#app').innerHTML =
    '<p>Aš skaitau knygą apie Lietuvos istoriją ir labai ją mėgstu.</p>'
  await waitFor(() => page.glosses().some(([word]) => word === 'knygą'))
  await page.settle()
})

test('a page with plenty of English text is left alone even when more text arrives', async () => {
  const english = 'This is a long English article about books and history. '.repeat(10)
  const page = await loadContent(`<!doctype html><html><body><p>${english}</p></body></html>`)
  await page.settle()
  page.document.body.insertAdjacentHTML('beforeend', '<p>Aš skaitau knygą ir labai ją mėgstu.</p>')
  await new Promise((resolve) => setTimeout(resolve, 800))
  assert.equal(page.glosses().length, 0)
})

test('an approximate meaning shows at once and goes to the model with its lemma to confirm or replace', async () => {
  let answer
  const reply = new Promise((resolve) => { answer = resolve })
  const page = await loadContent(lt('<p>Jis išvažiuoja.</p>'), {
    dictionary: { išvažiuoja: { m: ['go by vehicle'], l: 'išvažiuoti', approx: true } }, gloss: () => reply
  })
  await waitFor(() => page.glossCalls() === 1)
  assert.deepEqual(page.glosses(), [['išvažiuoja', 'go by vehicle']])
  assert.deepEqual(page.sent[0], [{
    text: 'Jis išvažiuoja.', words: ['jis', 'išvažiuoja'],
    hints: [null, { lemma: 'išvažiuoti', options: ['go by vehicle'] }]
  }])
  answer([{ jis: 'he', išvažiuoja: 'leaves' }])
  await page.settle()
  assert.deepEqual(page.glosses(), [['Jis', 'he'], ['išvažiuoja', 'leaves']])
})

test('a tap on a gloss opens a card with the word, its lemma and every meaning, the shown one marked', async () => {
  const page = await loadContent(lt('<p>Lietuvos šalies miestas.</p>'), {
    dictionary: { šalies: { m: ['land', 'country', 'aside'], l: 'šalis' } }, modelAvailable: false
  })
  await page.settle()
  assert.equal(page.card(), null)

  page.tapGloss('šalies')
  const card = page.card()
  assert.equal(card.word, 'šalies')
  assert.equal(card.form, 'form of šalis')
  assert.deepEqual(card.meanings, ['land', 'country', 'aside'])
  assert.equal(card.shown, 'land')
})

test('a tap on a gloss inside a link opens the card and does not follow the link', async () => {
  const page = await loadContent(lt('<p><a href="https://example.lt/knyga">Aš skaitau knygą</a></p>'), { modelAvailable: false })
  await page.settle()
  const event = page.tapGloss('knygą')
  assert.equal(event.defaultPrevented, true)
  assert.equal(page.card().word, 'knygą')
})

test('the card of a common word shows how common it is', async () => {
  const page = await loadContent(lt('<p>Aš skaitau knygą.</p>'), {
    dictionary: { aš: { m: ['I'], r: 3 }, knygą: { m: ['book'], l: 'knyga', r: 1200 } }, modelAvailable: false
  })
  await page.settle()
  page.tapGloss('Aš')
  assert.equal(page.card().rank, 'Top 500')
  page.tapGloss('knygą')
  assert.equal(page.card().rank, 'Top 2,000')
})

test('a word the dictionary does not know shows the meaning in its gloss on its card', async () => {
  const page = await loadContent(lt('<p>Aš skaitau.</p>'))
  await page.settle()
  page.tapGloss('skaitau')
  const card = page.card()
  assert.equal(card.word, 'skaitau')
  assert.equal(card.form, null)
  assert.deepEqual(card.meanings, ['G:skaitau'])
  assert.equal(card.shown, 'G:skaitau')
})
