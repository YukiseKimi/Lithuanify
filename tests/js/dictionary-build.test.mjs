import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { expandHunspell, parseAffixes, readWiktionary, shortGloss, writeDictionary } from '../../scripts/build-dictionary.mjs'

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')

test('a gloss keeps its first short meaning', () => {
  assert.equal(shortGloss('book (written work)'), 'book')
  assert.equal(shortGloss('to read; to count'), 'read')
  assert.equal(shortGloss('fire, blaze'), 'fire')
  assert.equal(shortGloss('a very long meaning of many words'), 'a very long')
})

test('Wiktionary gives lemmas and 2-3 word phrases with up to 3 meanings and their forms, and skips names and other languages', () => {
  const lemmas = readWiktionary(fixture('wiktionary.jsonl').split('\n'))
  assert.deepEqual([...lemmas.keys()], ['knyga', 'skaityti', 'gaisras', 'vis dėlto'])
  assert.deepEqual(lemmas.get('knyga').meanings, ['book', 'volume', 'ledger'])
  assert.deepEqual(lemmas.get('vis dėlto').meanings, ['nevertheless'])
  assert.deepEqual([...lemmas.get('knyga').forms].sort(), ['knygoje', 'knygos', 'knygą'])
  assert.deepEqual([...lemmas.get('skaityti').forms], ['skaitau'])
  assert.deepEqual(lemmas.get('gaisras').meanings, ['fire', 'conflagration', 'burning'])
  assert.ok(lemmas.get('gaisras').forms.has('gaisrą'))
})

test('Hunspell suffix rules make each form, respect conditions, and add no prefixed forms', () => {
  const negatable = new Set()
  const forms = expandHunspell(fixture('lt.dic'), parseAffixes(fixture('lt.aff')), negatable)
  assert.deepEqual([...negatable], ['knyga'])
  assert.deepEqual([...forms.get('knyga')].sort(), [
    'knyga', 'knygoje', 'knygomis', 'knygos'
  ])
  assert.deepEqual([...forms.get('gaisras')].sort(), ['gaisras', 'gaisro', 'gaisrui'])
  assert.deepEqual([...forms.get('lagas')].sort(), ['lagas', 'lago'])
})

test('the dictionary file has one line per lemma: gloss, lemma, every other form, and ne when it takes ne-', () => {
  const lemmas = readWiktionary(fixture('wiktionary.jsonl').split('\n'))
  const negatable = new Set()
  const forms = expandHunspell(fixture('lt.dic'), parseAffixes(fixture('lt.aff')), negatable)
  assert.equal(writeDictionary(lemmas, forms, negatable), [
    'fire|conflagration|burning\tgaisras\tgaisro gaisrui gaisrą',
    'book|volume|ledger\tknyga\tknygoje knygomis knygos knygą\tne',
    'read\tskaityti\tskaitau',
    'nevertheless\tvis dėlto\t',
    ''
  ].join('\n'))
})
