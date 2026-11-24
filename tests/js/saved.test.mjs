import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'

const resources = fileURLToPath(new URL('../../Shared (Extension)/Resources/', import.meta.url))
const html = readFileSync(resources + 'saved.html', 'utf8').replace(/<script[^>]*><\/script>/g, '')
const script = readFileSync(resources + 'saved.js', 'utf8')
const open = new Set()
afterEach(() => { for (const window of open) window.close(); open.clear() })

const word = (lemma, shown, sentence, savedAt) => ({ word: lemma, lemma, meanings: [shown], shown, sentence, savedAt })

// The Saved words page in jsdom, over a storage.local that holds `stored`.
async function loadSaved(stored) {
  const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true })
  const { window } = dom
  open.add(window)
  const listeners = []
  const copy = (v) => JSON.parse(JSON.stringify(v))
  window.browser = {
    storage: {
      local: {
        get: async (keys) => copy(keys === null ? stored : Object.fromEntries([].concat(keys).filter((k) => k in stored).map((k) => [k, stored[k]]))),
        remove: async (keys) => {
          const changes = {}
          for (const k of [].concat(keys)) { changes[k] = { oldValue: stored[k] }; delete stored[k] }
          listeners.forEach((l) => l(changes, 'local'))
        }
      },
      onChanged: { addListener: (l) => listeners.push(l) }
    }
  }
  const el = window.document.createElement('script')
  el.textContent = script
  window.document.body.append(el)
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
    settle: () => new Promise((resolve) => setTimeout(resolve, 20))
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
