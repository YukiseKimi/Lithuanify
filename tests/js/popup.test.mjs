import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'

const resources = fileURLToPath(new URL('../../Shared (Extension)/Resources/', import.meta.url))
const html = readFileSync(resources + 'popup.html', 'utf8').replace(/<script[^>]*><\/script>/g, '')
const script = readFileSync(resources + 'popup.js', 'utf8')
const open = new Set()
afterEach(() => { for (const window of open) window.close(); open.clear() })

// The toolbar popup in jsdom, over a storage.local that holds `stored`.
async function loadPopup(stored) {
  const dom = new JSDOM(html, { runScripts: 'dangerously' })
  const { window } = dom
  open.add(window)
  const created = []
  window.close = () => {}
  window.browser = {
    i18n: { getMessage: () => '' },
    storage: { local: { get: async () => JSON.parse(JSON.stringify(stored)), set: async () => {} } },
    runtime: {
      sendMessage: async () => ({ available: false }),
      getURL: (path) => 'safari-web-extension://lithuanify/' + path
    },
    tabs: { create: async (options) => { created.push(JSON.parse(JSON.stringify(options))) } }
  }
  const el = window.document.createElement('script')
  el.textContent = script
  window.document.body.append(el)
  await new Promise((resolve) => setTimeout(resolve, 20))
  return { window, document: window.document, created }
}

test('the popup links to the Saved words page with the number of saved words', async () => {
  const popup = await loadPopup({
    mode: 'page',
    'saved:šalis': { word: 'šalies', lemma: 'šalis', meanings: ['country'], shown: 'country', sentence: 'x', savedAt: 1 },
    'saved:kurti': { word: 'kuria', lemma: 'kurti', meanings: ['create'], shown: 'create', sentence: 'y', savedAt: 2 }
  })
  const link = popup.document.getElementById('saved-link')
  assert.equal(link.textContent, 'Saved words (2)')

  link.dispatchEvent(new popup.window.MouseEvent('click', { bubbles: true, cancelable: true }))
  assert.deepEqual(popup.created, [{ url: 'safari-web-extension://lithuanify/saved.html' }])
})
