import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { JSDOM } from 'jsdom'
import 'fake-indexeddb/auto'

const resources = fileURLToPath(new URL('../../Shared (Extension)/Resources/', import.meta.url))
const contentSource = readFileSync(resources + 'content.js', 'utf8')
const backgroundSource = readFileSync(resources + 'background.js', 'utf8')

const plain = (value) => JSON.parse(JSON.stringify(value))
const open = new Set()

export function closeAll() {
  for (const window of open) window.close()
  open.clear()
}

const glossAll = (blocks) => blocks.map((b) => Object.fromEntries(b.words.map((w) => [w, 'G:' + w])))

export async function waitFor(check, { timeout = 3000, every = 10 } = {}) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, every))
  }
  throw new Error(`waitFor timed out after ${timeout} ms`)
}

const sampleDictionary = { aš: 'I', knygą: 'book', knygoje: 'book' }

export async function loadContent(html, { hideCommon = 0, mode = 'page', modelAvailable = true, gloss = glossAll, dictionary = sampleDictionary, lookupFailures = 0, reply = null, offscreen = null } = {}) {
  const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true })
  const { window } = dom
  open.add(window)
  // jsdom has no layout, so no innerText; the text is close enough for language checks.
  if (!('innerText' in window.HTMLElement.prototype)) {
    Object.defineProperty(window.HTMLElement.prototype, 'innerText', { get() { return this.textContent } })
  }
  const sent = []
  const lookups = []
  let glossCalls = 0

  const observers = new Set()
  window.IntersectionObserver = class {
    constructor(callback) {
      this.callback = callback
      this.targets = new Set()
      observers.add(this)
    }
    observe(el) {
      this.targets.add(el)
      if (offscreen && el.matches(offscreen)) return
      if (!this.pending) {
        this.pending = new Set()
        setTimeout(() => {
          const entries = [...this.pending].filter((t) => this.targets.has(t))
            .map((target) => ({ isIntersecting: true, target }))
          this.pending = null
          if (entries.length) this.callback(entries)
        }, 0)
      }
      this.pending.add(el)
    }
    unobserve(el) { this.targets.delete(el) }
    disconnect() { this.targets.clear(); observers.delete(this) }
  }
  const stored = { mode, hideCommon }
  const storageListeners = []
  window.browser = {
    storage: {
      local: { get: async () => ({ ...stored }), set: async () => {} },
      onChanged: { addListener: (listener) => storageListeners.push(listener) }
    },
    runtime: {
      onMessage: { addListener() {} },
      sendMessage: async (message) => {
        if (message.command === 'modelStatus') return { available: modelAvailable }
        if (message.command === 'lookup') {
          lookups.push(plain(message.words))
          if (lookups.length <= lookupFailures) throw new Error('background gone')
          return Object.fromEntries(message.words.filter((w) => w in dictionary)
            .map((w) => [w, { m: [].concat(dictionary[w].m || dictionary[w]), l: null, r: dictionary[w].r || 0 }]))
        }
        if (message.command === 'gloss') {
          glossCalls += 1
          sent.push(plain(message.blocks))
          if (reply) return reply(message.blocks, glossCalls)
          return { available: true, results: await gloss(message.blocks, glossCalls) }
        }
        return undefined
      }
    }
  }

  const script = window.document.createElement('script')
  script.textContent = contentSource
  window.document.head.append(script)

  const page = {
    window,
    document: window.document,
    sent,
    lookups,
    glossCalls: () => glossCalls,
    // What the popup does: write settings to storage.local, which every tab hears.
    changeSettings: (values) => {
      const changes = {}
      for (const [key, newValue] of Object.entries(values)) {
        changes[key] = { oldValue: stored[key], newValue }
        stored[key] = newValue
      }
      storageListeners.forEach((listener) => listener(changes, 'local'))
    },
    scrollTo: (selector) => {
      const el = window.document.querySelector(selector)
      for (const observer of observers) {
        if (observer.targets.has(el)) observer.callback([{ isIntersecting: true, target: el }])
      }
    },
    state: (expression) => window.eval(expression),
    idle: () => window.eval('!rendering && !refining && renderQueue.length === 0 && refineQueue.every((item) => !item.visible) && (typeof retryTimers === "undefined" || retryTimers.size === 0) && (typeof pauseTimer === "undefined" || pauseTimer === null)'),
    settle: async () => {
      await waitFor(() => window.eval('typeof enabled') === 'boolean')
      await new Promise((resolve) => setTimeout(resolve, 20))
      await waitFor(page.idle)
    },
    glosses: () => plain(
      [...window.document.querySelectorAll('ruby')].map((r) => [r.firstChild.textContent, r.lastChild.textContent])
    ),
    plainText: (selector) => {
      const copy = window.document.querySelector(selector).cloneNode(true)
      copy.querySelectorAll('rt').forEach((rt) => rt.remove())
      return copy.textContent
    },
    select: (selector, start, end) => {
      const node = window.document.querySelector(selector).firstChild
      const range = window.document.createRange()
      range.setStart(node, start)
      range.setEnd(node, end)
      window.document.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }))
      window.getSelection().removeAllRanges()
      window.getSelection().addRange(range)
      window.document.dispatchEvent(new window.MouseEvent('mouseup', { bubbles: true }))
    }
  }
  return page
}

export function loadBackground({ native = () => ({ available: true, results: [] }), idb = indexedDB, dictionary = null, fetchFailures = 0 } = {}) {
  const nativeCalls = []
  const fetches = []
  const context = vm.createContext({
    indexedDB: idb,
    IDBKeyRange,
    console,
    setTimeout,
    clearTimeout,
    fetch: async (url) => {
      fetches.push(url)
      if (fetches.length <= fetchFailures) throw new Error('not readable yet')
      if (dictionary === null) return { ok: false, status: 404, text: async () => '' }
      return { ok: true, status: 200, text: async () => dictionary }
    },
    browser: {
      storage: { local: { remove: async () => {} } },
      runtime: {
        getURL: (path) => 'safari-web-extension://lithuanify/' + path,
        onMessage: { addListener() {} },
        sendNativeMessage: async (_id, message) => {
          nativeCalls.push(plain(message))
          return native(message, nativeCalls.length)
        }
      }
    }
  })
  vm.runInContext(backgroundSource, context)
  const close = async () => {
    await new Promise((resolve) => setTimeout(resolve, 50))
    await vm.runInContext('dbPromise ? dbPromise.then((db) => db && db.close()) : null', context)
  }
  return {
    gloss: async (blocks) => plain(await context.handleGloss(blocks)),
    lookup: async (words) => plain(await context.handleLookup(words)),
    fetches,
    nativeCalls,
    close,
    state: (expression) => vm.runInContext(expression, context)
  }
}
