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
async function loadPopup(stored, { modelAvailable = true } = {}) {
  const dom = new JSDOM(html, { runScripts: 'dangerously' })
  const { window } = dom
  open.add(window)
  const created = []
  window.close = () => {}
  window.browser = {
    i18n: { getMessage: () => '' },
    storage: { local: { get: async () => JSON.parse(JSON.stringify(stored)), set: async (values) => { Object.assign(stored, values) } } },
    runtime: {
      sendMessage: async () => ({ available: modelAvailable }),
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

test('turning on Google Translate shows the key field, and the key is saved as typed', async () => {
  const stored = { mode: 'page' }
  const popup = await loadPopup(stored)
  const google = popup.document.getElementById('google')
  const details = popup.document.getElementById('google-details')
  assert.equal(google.checked, false)
  assert.equal(details.hidden, true)

  google.checked = true
  google.dispatchEvent(new popup.window.Event('change'))
  assert.equal(details.hidden, false)
  assert.equal(stored.google, true)

  const key = popup.document.getElementById('google-key')
  key.value = '  my-key  '
  key.dispatchEvent(new popup.window.Event('change'))
  assert.equal(stored.googleKey, 'my-key')
})

test('the popup shows Google Translate as it was left, with its key', async () => {
  const popup = await loadPopup({ google: true, googleKey: 'saved-key' })
  assert.equal(popup.document.getElementById('google').checked, true)
  assert.equal(popup.document.getElementById('google-details').hidden, false)
  assert.equal(popup.document.getElementById('google-key').value, 'saved-key')
})

test('Google Translate needs the on-device AI: off or unavailable, the switch is greyed out and says why', async () => {
  const popup = await loadPopup({ google: true, googleKey: 'k' })
  const google = popup.document.getElementById('google')
  const needs = popup.document.getElementById('google-needs-ai')
  assert.equal(google.disabled, false)
  assert.equal(needs.hidden, true)

  const smart = popup.document.getElementById('smart')
  smart.checked = false
  smart.dispatchEvent(new popup.window.Event('change'))
  assert.equal(google.disabled, true)
  assert.equal(needs.hidden, false)
  assert.equal(popup.document.getElementById('google-details').hidden, true)

  const noModel = await loadPopup({ google: true, googleKey: 'k' }, { modelAvailable: false })
  assert.equal(noModel.document.getElementById('google').disabled, true)
  assert.equal(noModel.document.getElementById('google-needs-ai').hidden, false)
})
