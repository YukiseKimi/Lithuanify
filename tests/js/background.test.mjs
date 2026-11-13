import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { loadBackground, waitFor } from './harness.mjs'

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
  assert.equal(bg.state('memCache.has(keyOf("Sakinys 0.", "sakinys"))'), false)
})

test('a save on a closed cache connection keeps its entries for the next save', async () => {
  const bg = load({
    native: (message, call) => {
      if (call === 2) bg.state('dbPromise.then((db) => db.close())')
      return reply(message)
    }
  })
  await bg.gloss([{ text: 'Aš skaitau.', words: ['skaitau'] }])

  const result = await bg.gloss([{ text: 'Karas tęsiasi.', words: ['karas'] }])
  assert.deepEqual(result.results, [{ karas: 'G:karas' }])
  await waitFor(() => bg.state('dirty.size === 1 && dbPromise === null'))
  await bg.state('flushCache()')

  const fresh = load({ native: reply })
  await fresh.gloss([{ text: 'Karas tęsiasi.', words: ['karas'] }])
  assert.equal(fresh.nativeCalls.length, 0)
})

const firsts = (found) => Object.fromEntries(Object.entries(found).map(([word, entry]) => [word, entry.m.join('|')]))

const sample = [
  'book\tknyga\tknygoje knygos knygą',
  'read\tskaityti\tskaitau skaito skaičiau\tne',
  'number\tskaičius\tskaičiaus skaičiau',
  'fire\tgaisras\tgaisro',
  'of the book\tknygos\t',
  'news\tžinia\tžinios',
  'common\tbendras\tbendro\tne',
  'cash register\tkasa\tkasos',
  'braid\tkasa\tkasų',
  ''
].join('\n')

test('a lookup finds the meaning of a lemma, an inflected form and a spelling without diacritics', async () => {
  const bg = load({ dictionary: sample })
  const found = firsts(await bg.lookup(['Knygoje', 'skaitau', 'knyga', 'zinios', 'nežinomas']))
  assert.deepEqual(found, { Knygoje: 'book', skaitau: 'read', knyga: 'book', zinios: 'news' })
})

test('a headword wins over the same spelling as a form of another word', async () => {
  const bg = load({ dictionary: sample })
  assert.deepEqual(firsts(await bg.lookup(['knygos'])), { knygos: 'of the book' })
})

test('the dictionary file is read once for many lookups', async () => {
  const bg = load({ dictionary: sample })
  await Promise.all([bg.lookup(['knyga']), bg.lookup(['gaisro'])])
  firsts(await bg.lookup(['skaito']))
  assert.deepEqual(bg.fetches, ['safari-web-extension://lithuanify/dictionary/lt-en.tsv'])
})

test('a missing dictionary file gives no meanings and no error', async () => {
  const bg = load({ dictionary: null })
  assert.deepEqual(firsts(await bg.lookup(['knyga'])), {})
})

test('a negated word gets "not" before the meaning of the word after ne or nebe', async () => {
  const bg = load({ dictionary: sample })
  assert.deepEqual(firsts(await bg.lookup(['neskaitau', 'nebeskaito', 'nesu'])), { neskaitau: 'not read', nebeskaito: 'not read' })
})

test('ne is read as "not" only before a word that Hunspell lets take it', async () => {
  const bg = load({ dictionary: sample })
  assert.deepEqual(firsts(await bg.lookup(['nežinios', 'negaisro'])), {})
})

test('a form of two lemmas gets the meanings of both, for the model to pick', async () => {
  const bg = load({ dictionary: sample })
  assert.deepEqual(firsts(await bg.lookup(['skaičiau', 'skaičiaus', 'skaito'])), { skaičiau: 'read|number', skaičiaus: 'number', skaito: 'read' })
})

test('a dictionary file that failed to load is read again on the next lookup', async () => {
  const bg = load({ dictionary: sample, fetchFailures: 1 })
  assert.deepEqual(firsts(await bg.lookup(['knyga'])), {})
  assert.deepEqual(firsts(await bg.lookup(['knyga'])), { knyga: 'book' })
})

test('a word that starts with nebe but negates with ne still gets "not"', async () => {
  const bg = load({ dictionary: sample })
  assert.deepEqual(firsts(await bg.lookup(['nebendras'])), { nebendras: 'not common' })
})

test('a word with diacritics never takes the meaning of another word spelled without them', async () => {
  const bg = load({ dictionary: sample })
  assert.deepEqual(firsts(await bg.lookup(['gaisrą', 'kąsa'])), {})
  assert.deepEqual(firsts(await bg.lookup(['gaisro', 'zinia'])), { gaisro: 'fire', zinia: 'news' })
})

test('two lemmas with the same headword give it both meanings', async () => {
  const bg = load({ dictionary: sample })
  assert.deepEqual(firsts(await bg.lookup(['kasa', 'kasos', 'kasų'])), { kasa: 'cash register|braid', kasos: 'cash register', kasų: 'braid' })
})

test('a lookup gives every meaning of a word and its lemma', async () => {
  const bg = load({ dictionary: 'braid|pancreas|cash register\tkasa\tkasos\n' })
  assert.deepEqual(await bg.lookup(['kasos']), { kasos: { m: ['braid', 'pancreas', 'cash register'], l: 'kasa' } })
})

test('answers cached before the model could pick are not reused', async () => {
  const old = await new Promise((resolve) => {
    const request = indexedDB.open('lithuanify', 3)
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore('glosses', { keyPath: 'k' })
      store.createIndex('t', 't')
      store.put({ k: 'Kasa uždaryta.\u0001kasa', v: { kasa: 'old free answer' }, t: 1 })
    }
    request.onsuccess = () => resolve(request.result)
  })
  old.close()
  const bg = load({ native: reply })
  const result = await bg.gloss([{ text: 'Kasa uždaryta.', words: ['kasa'] }])
  assert.deepEqual(result.results, [{ kasa: 'G:kasa' }])
})

test('a paragraph that gains a sentence asks the model only for the new sentence', async () => {
  const bg = load({ native: reply })
  await bg.gloss([{ text: 'Aš skaitau.', words: ['skaitau'] }])
  const result = await bg.gloss([{ text: 'Aš skaitau. Karas tęsiasi.', words: ['skaitau', 'karas'] }])
  assert.deepEqual(result.results, [{ skaitau: 'G:skaitau', karas: 'G:karas' }])
  assert.deepEqual(bg.nativeCalls[1].blocks, [{ text: 'Aš skaitau. Karas tęsiasi.', words: ['karas'] }])
})

test('the same sentence in another paragraph comes from the cache', async () => {
  const bg = load({ native: reply })
  await bg.gloss([{ text: 'Labas. Aš skaitau.', words: ['skaitau'] }])
  const result = await bg.gloss([{ text: 'Aš skaitau. Viso gero.', words: ['skaitau'] }])
  assert.deepEqual(result.results, [{ skaitau: 'G:skaitau' }])
  assert.equal(bg.nativeCalls.length, 1)
})

test('after a rate limit the model is not asked for a minute, and the page is told to wait', async () => {
  const bg = load({
    native: (message, call) => (call === 1
      ? { available: true, rateLimited: true, results: message.blocks.map(() => []), ok: message.blocks.map(() => false) }
      : reply(message))
  })
  const first = await bg.gloss([{ text: 'Aš skaitau.', words: ['skaitau'] }])
  assert.equal(first.paused, true)
  const second = await bg.gloss([{ text: 'Karas tęsiasi.', words: ['karas'] }])
  assert.equal(second.paused, true)
  assert.equal(bg.nativeCalls.length, 1)

  bg.state('pausedUntil = 0')
  const third = await bg.gloss([{ text: 'Karas tęsiasi.', words: ['karas'] }])
  assert.deepEqual(third.results, [{ karas: 'G:karas' }])
})
