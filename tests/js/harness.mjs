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

export async function loadContent(html, { mode = 'page', modelAvailable = true, gloss = glossAll } = {}) {
  const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true })
  const { window } = dom
  open.add(window)
  const sent = []
  let glossCalls = 0

  window.IntersectionObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  window.browser = {
    storage: { local: { get: async () => ({ mode }), set: async () => {} } },
    runtime: {
      onMessage: { addListener() {} },
      sendMessage: async (message) => {
        if (message.command === 'modelStatus') return { available: modelAvailable }
        if (message.command === 'gloss') {
          glossCalls += 1
          sent.push(plain(message.blocks))
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
    glossCalls: () => glossCalls,
    state: (expression) => window.eval(expression),
    idle: () => window.eval('!rendering && !refining && renderQueue.length === 0 && refineQueue.length === 0 && (typeof retryTimers === "undefined" || retryTimers.size === 0)'),
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

export function loadBackground({ native, idb = indexedDB }) {
  const nativeCalls = []
  const context = vm.createContext({
    indexedDB: idb,
    IDBKeyRange,
    console,
    setTimeout,
    clearTimeout,
    browser: {
      storage: { local: { remove: async () => {} } },
      runtime: {
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
    nativeCalls,
    close,
    state: (expression) => vm.runInContext(expression, context)
  }
}
