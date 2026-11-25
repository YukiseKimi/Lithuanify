import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { JSDOM } from 'jsdom'
import 'fake-indexeddb/auto'

const resources = fileURLToPath(new URL('../../Shared (Extension)/Resources/', import.meta.url))
const contentSource = readFileSync(resources + 'content.js', 'utf8')
const backgroundSource = readFileSync(resources + 'background.js', 'utf8')

const plain = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)))
const open = new Set()

export function closeAll() {
  for (const close of open) close()
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

// The extension's `browser` API over an in-memory storage.local, as Safari
// gives it: keyed reads, and a change event to every listener after a write.
// `busy()` counts calls still in flight, so a test can wait for a page to
// finish its work without reading the page's own variables.
export function fakeBrowser(stored = {}, { runtime = {}, tabs = {}, i18n = { getMessage: () => '' } } = {}) {
  const listeners = []
  let inFlight = 0
  const track = (fn) => async (...args) => {
    inFlight += 1
    try { return await fn(...args) } finally { inFlight -= 1 }
  }
  const notify = (changes) => listeners.forEach((listener) => listener(plain(changes), 'local'))
  const get = async (keys) => {
    if (keys === null || keys === undefined) return plain(stored)
    const wanted = Array.isArray(keys) ? keys : [keys]
    return plain(Object.fromEntries(wanted.filter((k) => k in stored).map((k) => [k, stored[k]])))
  }
  const set = async (values) => {
    const changes = {}
    for (const [key, newValue] of Object.entries(values)) {
      changes[key] = { oldValue: stored[key], newValue }
      stored[key] = plain(newValue)
    }
    notify(changes)
  }
  const remove = async (keys) => {
    const changes = {}
    for (const key of [].concat(keys)) {
      if (!(key in stored)) continue
      changes[key] = { oldValue: stored[key] }
      delete stored[key]
    }
    notify(changes)
  }
  const wrap = (object) => Object.fromEntries(Object.entries(object).map(([k, v]) => [k, typeof v === 'function' ? track(v) : v]))
  return {
    stored,
    busy: () => inFlight > 0,
    browser: {
      i18n,
      storage: { local: wrap({ get, set, remove }), onChanged: { addListener: (listener) => listeners.push(listener) } },
      runtime: { onMessage: { addListener() {} }, ...wrap(runtime) },
      tabs: wrap(tabs)
    }
  }
}

// A jsdom window for an extension page, closed after each test by closeAll.
export function openWindow(html, options = {}) {
  const { window } = new JSDOM(html, { runScripts: 'dangerously', ...options })
  // Kept before a page stubs window.close (the popup closes itself).
  open.add(window.close.bind(window))
  return window
}

export function runScript(window, source) {
  const el = window.document.createElement('script')
  el.textContent = source
  window.document.body.append(el)
}

// Waits until no call to the fake browser has been in flight for a few turns.
export async function settled(fake) {
  let quiet = 0
  await waitFor(() => { quiet = fake.busy() ? 0 : quiet + 1; return quiet >= 3 }, { every: 5 })
}

// The page's timers. Short ones run on real time; long ones (a retry after a
// failure, the language re-check after the page changes) wait until the test
// moves the clock with advance(), so no test sleeps through them.
const LONG_MS = 500

function installClock(window) {
  let now = 0
  let nextId = 1
  const short = new Map()
  const long = new Map()
  window.setTimeout = (fn, ms = 0, ...args) => {
    const id = nextId++
    const run = () => (typeof fn === 'function' ? fn(...args) : window.eval(fn))
    if (ms >= LONG_MS) {
      long.set(id, { at: now + ms, run })
    } else {
      short.set(id, setTimeout(() => { short.delete(id); run() }, ms))
    }
    return id
  }
  window.clearTimeout = (id) => {
    long.delete(id)
    if (short.has(id)) { clearTimeout(short.get(id)); short.delete(id) }
  }
  return {
    busy: () => short.size > 0,
    advance: (ms) => {
      now += ms
      for (;;) {
        const due = [...long].filter(([, t]) => t.at <= now).sort((a, b) => a[1].at - b[1].at)[0]
        if (!due) return
        long.delete(due[0])
        due[1].run()
      }
    },
    dispose: () => { short.forEach((handle) => clearTimeout(handle)); short.clear(); long.clear() }
  }
}

const sampleDictionary = { aš: 'I', knygą: 'book', knygoje: 'book' }

export async function loadContent(html, { hideCommon = 0, mode = 'page', modelAvailable = true, gloss = glossAll, dictionary = sampleDictionary, lookupFailures = 0, reply = null, offscreen = null, stored: initial = {} } = {}) {
  const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true })
  const { window } = dom
  const clock = installClock(window)
  open.add(() => { clock.dispose(); window.close() })
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
        window.setTimeout(() => {
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
  const fake = fakeBrowser({ mode, hideCommon, ...initial }, {
    runtime: {
      sendMessage: async (message) => {
        if (message.command === 'modelStatus') return { available: modelAvailable }
        if (message.command === 'lookup') {
          lookups.push(plain(message.words))
          if (lookups.length <= lookupFailures) throw new Error('background gone')
          return Object.fromEntries(message.words.filter((w) => w in dictionary)
            .map((w) => [w, {
              m: [].concat(dictionary[w].m || dictionary[w]),
              l: dictionary[w].l || null,
              r: dictionary[w].r || 0,
              ...(dictionary[w].approx ? { approx: true, from: dictionary[w].from || null } : {}),
              ...(dictionary[w].hintOnly ? { hintOnly: true } : {})
            }]))
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
  })
  window.browser = fake.browser
  const local = fake.browser.storage.local

  const script = window.document.createElement('script')
  script.textContent = contentSource
  window.document.head.append(script)

  const busy = () => fake.busy() || clock.busy()
  const card = () => window.document.getElementById('lithuanify-card')
  const press = async (selector) => {
    card().shadowRoot.querySelector(selector).dispatchEvent(new window.MouseEvent('click', { bubbles: true, composed: true }))
    await page.settle()
  }

  const page = {
    window,
    document: window.document,
    sent,
    lookups,
    glossCalls: () => glossCalls,
    // What the popup or another tab does: write to storage.local, which every
    // tab hears. An undefined value removes the key.
    changeSettings: (values) => {
      const gone = Object.keys(values).filter((key) => values[key] === undefined)
      const kept = Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined))
      if (gone.length) local.remove(gone)
      if (Object.keys(kept).length) local.set(kept)
    },
    // Taps the gloss over the n-th ruby whose word is `word`; returns the click event.
    tapGloss: (word, n = 0) => {
      const ruby = [...window.document.querySelectorAll('ruby')].filter((r) => r.firstChild.textContent === word)[n]
      const event = new window.MouseEvent('click', { bubbles: true, cancelable: true })
      ruby.lastChild.dispatchEvent(event)
      return event
    },
    // What the open word card shows, or null when no card is open.
    card: () => {
      const host = card()
      const root = host && host.shadowRoot
      if (!root || host.hidden) return null
      const text = (selector) => { const el = root.querySelector(selector); return el ? el.textContent : null }
      return plain({
        word: text('.word'),
        form: text('.form'),
        rank: text('.rank'),
        meanings: [...root.querySelectorAll('.meanings li')].map((li) => li.textContent),
        shown: text('.meanings li.shown'),
        source: text('.source'),
        save: text('button.save'),
        link: root.querySelector('a.wiki') ? root.querySelector('a.wiki').href : null
      })
    },
    // Presses Save or "Know it" on the open card, and waits for storage to answer.
    pressSave: () => press('button.save'),
    pressKnow: () => press('button.know'),
    stored: (key) => plain(fake.stored[key]),
    scrollTo: (selector) => {
      const el = window.document.querySelector(selector)
      for (const observer of observers) {
        if (observer.targets.has(el)) observer.callback([{ isIntersecting: true, target: el }])
      }
    },
    state: (expression) => window.eval(expression),
    // Waits until the page has no browser call in flight and no short timer
    // pending, twice in a row. Long timers wait for advance().
    settle: async () => {
      let quiet = 0
      await waitFor(() => { quiet = busy() ? 0 : quiet + 1; return quiet >= 3 }, { every: 5 })
    },
    // Moves the page's clock on, fires the long timers that are due, and settles.
    advance: async (ms) => {
      await page.settle()
      clock.advance(ms)
      await page.settle()
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

export function loadBackground({ native = () => ({ available: true, results: [] }), idb = indexedDB, dictionary = null, fetchFailures = 0, settings = {}, google = null } = {}) {
  const nativeCalls = []
  const fetches = []
  const googleCalls = []
  // Date.now() as the background sees it; advance() moves it on.
  let now = Date.now()
  class ClockDate extends Date {
    static now() { return now }
  }
  const { browser } = fakeBrowser(plain(settings), {
    runtime: {
      sendNativeMessage: async (_id, message) => {
        nativeCalls.push(plain(message))
        return native(message, nativeCalls.length)
      }
    }
  })
  browser.runtime.getURL = (path) => 'safari-web-extension://lithuanify/' + path
  const context = vm.createContext({
    indexedDB: idb,
    IDBKeyRange,
    console: { ...console, warn: () => {} },
    Date: ClockDate,
    setTimeout,
    clearTimeout,
    fetch: async (url, init = {}) => {
      if (String(url).startsWith('https://translation.googleapis.com/')) {
        const body = JSON.parse(init.body)
        googleCalls.push({ url: String(url), key: init.headers['X-Goog-Api-Key'], body })
        const reply = google ? google(body) : { status: 500, json: {} }
        if (reply instanceof Error) throw reply
        return { ok: reply.status === 200, status: reply.status, json: async () => reply.json }
      }
      fetches.push(url)
      if (fetches.length <= fetchFailures) throw new Error('not readable yet')
      if (dictionary === null) return { ok: false, status: 404, text: async () => '' }
      return { ok: true, status: 200, text: async () => dictionary }
    },
    browser
  })
  vm.runInContext(backgroundSource, context)
  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    await new Promise((resolve) => setTimeout(resolve, 50))
    await vm.runInContext('dbPromise ? dbPromise.then((db) => db && db.close()) : null', context)
  }
  return {
    gloss: async (blocks) => plain(await context.handleGloss(blocks)),
    lookup: async (words) => plain(await context.handleLookup(words)),
    advance: (ms) => { now += ms },
    fetches,
    googleCalls,
    nativeCalls,
    close,
    state: (expression) => vm.runInContext(expression, context)
  }
}
