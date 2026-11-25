import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { closeAll, fakeBrowser, openWindow, runScript, settled, waitFor } from './harness.mjs'

const resources = fileURLToPath(new URL('../../Shared (Extension)/Resources/', import.meta.url))
const html = readFileSync(resources + 'saved.html', 'utf8').replace(/<script[^>]*><\/script>/g, '')
const script = readFileSync(resources + 'saved.js', 'utf8')
afterEach(closeAll)

const word = (lemma, shown, sentence, savedAt) => ({ word: lemma, lemma, meanings: [shown], shown, sentence, savedAt })

// The Saved words page in jsdom, over a storage.local that holds `stored`.
async function loadSaved(stored, { touch = false, share = null } = {}) {
  const window = openWindow(html, { pretendToBeVisual: true })
  // What the page hands the reader: a shared file, a download, or the clipboard.
  const handed = []
  window.matchMedia = (query) => ({ matches: touch && query === '(pointer: coarse)' })
  window.URL.createObjectURL = (blob) => { handed.push({ via: 'download', blob }); return 'blob:csv' }
  window.URL.revokeObjectURL = () => {}
  window.HTMLAnchorElement.prototype.click = function () { handed[handed.length - 1].name = this.download }
  if (touch) {
    window.navigator.canShare = () => true
    window.navigator.share = share || (async ({ files }) => { handed.push({ via: 'share', blob: files[0], name: files[0].name }) })
  }
  Object.defineProperty(window.navigator, 'clipboard', {
    value: { writeText: async (text) => { handed.push({ via: 'clipboard', text }) } }
  })
  const fake = fakeBrowser(stored)
  window.browser = fake.browser
  runScript(window, script)
  const exportButton = () => window.document.getElementById('export')
  const page = {
    window,
    document: window.document,
    rows: () => [...window.document.querySelectorAll('#list li')].map((li) => ({
      lemma: li.querySelector('.lemma').textContent,
      meaning: li.querySelector('.meaning').textContent,
      sentence: li.querySelector('.sentence').textContent
    })),
    count: () => window.document.getElementById('count').textContent,
    empty: () => !window.document.getElementById('empty').hidden,
    handed,
    exportLabel: () => exportButton().textContent,
    // Presses Export CSV and waits until the button says how it went.
    pressExport: async () => {
      exportButton().click()
      await waitFor(() => exportButton().textContent !== 'Export CSV' || handed.length > 0)
      await new Promise((resolve) => setTimeout(resolve, 0))
    },
    exportCsv: async () => {
      await page.pressExport()
      const last = handed[handed.length - 1]
      // jsdom's Blob has no text(); read the bytes, and keep the BOM.
      const bytes = await new Promise((resolve) => {
        const reader = new window.FileReader()
        reader.onload = () => resolve(reader.result)
        reader.readAsArrayBuffer(last.blob)
      })
      return { via: last.via, name: last.name, text: new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes) }
    },
    settle: () => settled(fake)
  }
  await page.settle()
  return page
}

test('the Saved words page lists each saved word, newest first, and skips the settings', async () => {
  const page = await loadSaved({
    mode: 'page',
    'saved:šalis': word('šalis', 'country', '… ir didžiausias šalies miestas.', 100),
    'saved:išvažiuoti': word('išvažiuoti', 'go by vehicle', 'Mano brolis rytoj išvažiuoja į Kauną.', 300)
  })
  assert.deepEqual(page.rows(), [
    { lemma: 'išvažiuoti', meaning: 'go by vehicle', sentence: 'Mano brolis rytoj išvažiuoja į Kauną.' },
    { lemma: 'šalis', meaning: 'country', sentence: '… ir didžiausias šalies miestas.' }
  ])
  assert.equal(page.count(), '2')
  assert.equal(page.empty(), false)
})

test('with nothing saved, the page says how to save a word', async () => {
  const page = await loadSaved({ mode: 'page' })
  assert.deepEqual(page.rows(), [])
  assert.equal(page.empty(), true)
  assert.equal(page.count(), '0')
})

test('Find filters by lemma or meaning, with or without diacritics', async () => {
  const page = await loadSaved({
    'saved:šalis': word('šalis', 'country', 'a', 100),
    'saved:išvažiuoti': word('išvažiuoti', 'go by vehicle', 'b', 300)
  })
  const find = page.document.getElementById('find')
  const search = (text) => { find.value = text; find.dispatchEvent(new page.window.Event('input', { bubbles: true })) }

  search('sali')
  assert.deepEqual(page.rows().map((r) => r.lemma), ['šalis'])
  search('VEHICLE')
  assert.deepEqual(page.rows().map((r) => r.lemma), ['išvažiuoti'])
  search('')
  assert.deepEqual(page.rows().map((r) => r.lemma), ['išvažiuoti', 'šalis'])
  assert.equal(page.count(), '2')
})

test('× removes one saved word from storage and from the list', async () => {
  const stored = {
    'saved:šalis': word('šalis', 'country', 'a', 100),
    'saved:išvažiuoti': word('išvažiuoti', 'go by vehicle', 'b', 300)
  }
  const page = await loadSaved(stored)
  page.document.querySelector('#list li:last-child button.remove').click()
  await page.settle()
  assert.equal('saved:šalis' in stored, false)
  assert.deepEqual(page.rows().map((r) => r.lemma), ['išvažiuoti'])
  assert.equal(page.count(), '1')
})

test('Export CSV gives a file of lemma, meaning and sentence, quoted for Anki', async () => {
  const page = await loadSaved({
    'saved:šalis': word('šalis', 'country', 'Lietuvos šalies miestas, "Vilnius".', 100),
    'saved:išvažiuoti': word('išvažiuoti', 'go by vehicle', 'Brolis išvažiuoja.', 300)
  })
  const file = await page.exportCsv()
  assert.equal(file.via, 'download')
  assert.equal(file.name, 'lithuanify-saved-words.csv')
  assert.equal(file.text, '\uFEFFlemma,meaning,sentence\r\n' +
    '"išvažiuoti","go by vehicle","Brolis išvažiuoja."\r\n' +
    '"šalis","country","Lietuvos šalies miestas, ""Vilnius""."\r\n')
})

test('on a touch screen, Export CSV hands the file to the share sheet', async () => {
  const page = await loadSaved({ 'saved:šalis': word('šalis', 'country', 'a', 100) }, { touch: true })
  const file = await page.exportCsv()
  assert.equal(file.via, 'share')
  assert.equal(file.name, 'lithuanify-saved-words.csv')
})

test('the page lists known words, and × forgets one', async () => {
  const stored = {
    'known:knyga': { word: 'knygą', lemma: 'knyga', knownAt: 1 },
    'known:aš': { word: 'aš', lemma: null, knownAt: 2 },
    'saved:šalis': word('šalis', 'country', 'a', 100)
  }
  const page = await loadSaved(stored)
  const known = () => [...page.document.querySelectorAll('#known-list li .lemma')].map((el) => el.textContent)
  assert.deepEqual(known(), ['aš', 'knyga'])
  assert.equal(page.document.getElementById('known-count').textContent, '2')
  assert.deepEqual(page.rows().map((r) => r.lemma), ['šalis'])

  page.document.querySelector('#known-list li:last-child button.remove').click()
  await page.settle()
  assert.equal('known:knyga' in stored, false)
  assert.deepEqual(known(), ['aš'])
})

test('when the share sheet fails, Export CSV copies the file to the clipboard instead', async () => {
  const share = async () => { throw Object.assign(new Error('not allowed'), { name: 'NotAllowedError' }) }
  const page = await loadSaved({ 'saved:šalis': word('šalis', 'country', 'a', 100) }, { touch: true, share })
  await page.pressExport()
  assert.deepEqual(page.handed, [{ via: 'clipboard', text: '﻿lemma,meaning,sentence\r\n"šalis","country","a"\r\n' }])
  assert.equal(page.exportLabel(), 'Copied as CSV')
})

test('closing the share sheet exports nothing and copies nothing', async () => {
  const share = async () => { throw Object.assign(new Error('closed'), { name: 'AbortError' }) }
  const page = await loadSaved({ 'saved:šalis': word('šalis', 'country', 'a', 100) }, { touch: true, share })
  page.document.getElementById('export').click()
  // The rejected share settles in microtasks; one turn of the event loop covers it.
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(page.handed, [])
  assert.equal(page.exportLabel(), 'Export CSV')
})
