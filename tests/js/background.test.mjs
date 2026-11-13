import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { loadBackground } from './harness.mjs'

const reply = (message) => ({
  available: true,
  results: message.blocks.map((b) => b.words.map((w) => 'G:' + w)),
  ok: message.blocks.map(() => true)
})

const deleteDatabase = () => new Promise((resolve) => {
  const request = indexedDB.deleteDatabase('lithuanify')
  request.onsuccess = request.onerror = request.onblocked = resolve
})

const opened = []

const load = (options) => {
  const bg = loadBackground(options)
  opened.push(bg)
  return bg
}

beforeEach(deleteDatabase)
afterEach(async () => {
  await Promise.all(opened.splice(0).map((bg) => bg.close()))
})

test('a repeated block comes from the cache, not the model', async () => {
  const bg = load({ native: reply })
  const block = { text: 'Aš skaitau.', words: ['skaitau'] }

  const first = await bg.gloss([block])
  const second = await bg.gloss([block])

  assert.deepEqual(first.results, [{ skaitau: 'G:skaitau' }])
  assert.deepEqual(second.results, [{ skaitau: 'G:skaitau' }])
  assert.equal(bg.nativeCalls.length, 1)
})

test('the same text with other words asks the model again', async () => {
  const bg = load({ native: reply })
  await bg.gloss([{ text: 'Vilniaus senamiestis.', words: ['vilniaus'] }])
  const other = await bg.gloss([{ text: 'Vilniaus senamiestis.', words: ['senamiestis'] }])

  assert.deepEqual(other.results, [{ senamiestis: 'G:senamiestis' }])
  assert.equal(bg.nativeCalls.length, 2)
})

test('a block whose model call failed comes back as null and is not cached', async () => {
  const bg = load({
    native: (message, call) => ({
      available: true,
      results: message.blocks.map((b) => b.words.map((w) => 'G:' + w)),
      ok: message.blocks.map((_, i) => !(call === 1 && i === 1))
    })
  })
  const blocks = [{ text: 'Aš skaitau.', words: ['skaitau'] }, { text: 'Karas tęsiasi.', words: ['karas'] }]

  const first = await bg.gloss(blocks)
  assert.deepEqual(first.results, [{ skaitau: 'G:skaitau' }, null])

  const second = await bg.gloss(blocks)
  assert.deepEqual(second.results, [{ skaitau: 'G:skaitau' }, { karas: 'G:karas' }])
  assert.deepEqual(bg.nativeCalls[1].blocks, [{ text: 'Karas tęsiasi.', words: ['karas'] }])
})

test('a lost native reply marks every block as failed', async () => {
  const bg = load({ native: () => { throw new Error('host gone') } })
  const result = await bg.gloss([{ text: 'Aš skaitau.', words: ['skaitau'] }])
  assert.deepEqual(result.results, [null])
})

test('an old open cache version does not hang a request', async () => {
  const old = await new Promise((resolve) => {
    const request = indexedDB.open('lithuanify', 1)
    request.onupgradeneeded = () => request.result.createObjectStore('glosses', { keyPath: 'k' })
    request.onsuccess = () => resolve(request.result)
  })
  try {
    const bg = load({ native: reply })
    const result = await bg.gloss([{ text: 'Labas pasauli.', words: ['pasauli'] }])
    assert.deepEqual(result.results, [{ pasauli: 'G:pasauli' }])
  } finally {
    old.close()
  }
})

test('the model being off is reported to the page', async () => {
  const bg = load({ native: () => ({ available: false, results: [] }) })
  const result = await bg.gloss([{ text: 'Aš skaitau.', words: ['skaitau'] }])
  assert.deepEqual(result, { available: false, results: [] })
})

test('the memory cache stays bounded when site storage is blocked', async () => {
  const blocked = { open() { throw new Error('blocked') } }
  const bg = load({ native: reply, idb: blocked })
  const blocks = Array.from({ length: 5001 }, (_, i) => ({ text: `Sakinys ${i}.`, words: ['sakinys'] }))

  await bg.gloss(blocks)

  assert.equal(bg.state('memCache.size'), 5000)
  assert.equal(bg.state('dirty.size'), 5000)
  assert.equal(bg.state('memCache.has(keyOf({ text: "Sakinys 0.", words: ["sakinys"] }))'), false)
})

test('a save on a closed cache connection keeps its entries for the next save', async () => {
  const bg = load({ native: reply })
  await bg.gloss([{ text: 'Aš skaitau.', words: ['skaitau'] }])
  await bg.state('dbPromise.then((db) => db.close())')

  const result = await bg.gloss([{ text: 'Karas tęsiasi.', words: ['karas'] }])
  assert.deepEqual(result.results, [{ karas: 'G:karas' }])
  await new Promise((resolve) => setTimeout(resolve, 20))
  await bg.state('flushCache()')

  const fresh = load({ native: reply })
  await fresh.gloss([{ text: 'Karas tęsiasi.', words: ['karas'] }])
  assert.equal(fresh.nativeCalls.length, 0)
})
