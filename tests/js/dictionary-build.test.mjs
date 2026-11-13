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

test('Wiktionary gives Lithuanian lemmas with their forms, and skips names and other languages', () => {
  const lemmas = readWiktionary(fixture('wiktionary.jsonl').split('\n'))
  assert.deepEqual([...lemmas.keys()], ['knyga', 'skaityti', 'gaisras'])
  assert.equal(lemmas.get('knyga').gloss, 'book')
  assert.deepEqual([...lemmas.get('knyga').forms].sort(), ['knygoje', 'knygos', 'knygą'])
  assert.equal(lemmas.get('gaisras').gloss, 'fire')
})

test('Hunspell rules make each form, with prefixes across suffixes and conditions respected', () => {
  const forms = expandHunspell(fixture('lt.dic'), parseAffixes(fixture('lt.aff')))
  assert.deepEqual([...forms.get('knyga')].sort(), [
    'knyga', 'knygoje', 'knygomis', 'knygos', 'neknyga', 'neknygoje', 'neknygomis', 'neknygos'
  ])
  assert.deepEqual([...forms.get('gaisras')].sort(), ['gaisras', 'gaisro', 'gaisrui'])
  assert.deepEqual([...forms.get('lagas')].sort(), ['lagas', 'lago'])
})

test('the dictionary file has one line per lemma: gloss, lemma, then every other form', () => {
  const lemmas = readWiktionary(fixture('wiktionary.jsonl').split('\n'))
  const forms = expandHunspell(fixture('lt.dic'), parseAffixes(fixture('lt.aff')))
  assert.equal(writeDictionary(lemmas, forms), [
    'fire\tgaisras\tgaisro gaisrui',
    'book\tknyga\tknygoje knygomis knygos knygą neknyga neknygoje neknygomis neknygos',
    'read\tskaityti\t',
    ''
  ].join('\n'))
})
