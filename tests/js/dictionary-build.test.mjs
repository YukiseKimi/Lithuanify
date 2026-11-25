import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { addTranslated, expandHunspell, parseAffixes, readFrequency, readWiktionary, shortGloss, translationsOf, writeDictionary } from '../../scripts/build-dictionary.mjs'

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

test('a lemma takes the best frequency rank of any of its forms', () => {
  const lemmas = readWiktionary(fixture('wiktionary.jsonl').split('\n'))
  const forms = expandHunspell(fixture('lt.dic'), parseAffixes(fixture('lt.aff')))
  const ranks = readFrequency('ir 900\nknygą 500\ngaisras 10\nknyga 3\n')
  assert.deepEqual([...ranks], [['ir', 1], ['knygą', 2], ['gaisras', 3], ['knyga', 4]])
  const lines = writeDictionary(lemmas, forms, new Set(), ranks).split('\n')
  assert.equal(lines[0], 'fire|conflagration|burning\tgaisras\tgaisro gaisrui gaisrą\t\t3')
  assert.equal(lines[1], 'book|volume|ledger\tknyga\tknygoje knygomis knygos knygą\t\t2')
  assert.equal(lines[2], 'read\tskaityti\tskaitau')
})

test('a form with a stressed i keeps its word: the dot Wiktionary puts over a stressed i goes, the dot of ė stays', () => {
  const lemmas = readWiktionary([JSON.stringify({
    word: 'gimti', lang_code: 'lt', pos: 'verb', senses: [{ glosses: ['to be born'] }],
    forms: [{ form: 'gi̇̀msta', tags: ['present', 'third-person'] }, { form: 'gi̇̀mė', tags: ['past', 'third-person'] }]
  })])
  assert.deepEqual([...lemmas.get('gimti').forms].sort(), ['gimsta', 'gimė'])
})

test('an English entry gives its Lithuanian translations, with the English headword as the meaning', () => {
  const entry = {
    word: 'heritage', lang_code: 'en', pos: 'noun',
    translations: [
      { lang_code: 'lt', word: 'pa\u0303veldas', sense: 'property' },
      { lang_code: 'lv', word: 'mantojums' },
      { lang_code: 'lt', word: 'kultūros paveldas' }
    ],
    senses: [{ glosses: ['x'], translations: [{ lang_code: 'lt', word: 'palikimas' }] }]
  }
  assert.deepEqual(translationsOf(entry), [['paveldas', 'heritage'], ['palikimas', 'heritage']])
  assert.deepEqual(translationsOf({ ...entry, lang_code: 'fr' }), [])
  assert.deepEqual(translationsOf({ ...entry, pos: 'name' }), [])
  assert.deepEqual(translationsOf({ ...entry, word: 'a very long English headword' }), [])
})

test('a translation adds a lemma only where Lithuanian Wiktionary has none and Hunspell knows the word', () => {
  const lemmas = new Map([['knyga', { meanings: ['book'], forms: new Set() }]])
  const heads = new Set(['knyga', 'paveldas', 'palikimas'])
  const added = addTranslated(lemmas, [
    ['knyga', 'volume'], ['paveldas', 'legacy'], ['paveldas', 'heritage'], ['paveldas', 'heritage'],
    ['nemokama', 'free'], ['palikimas', 'legacy']
  ], heads)
  assert.equal(added, 2)
  assert.deepEqual(lemmas.get('knyga').meanings, ['book'])
  assert.deepEqual(lemmas.get('paveldas').meanings, ['heritage', 'legacy'])
  assert.deepEqual(lemmas.get('palikimas').meanings, ['legacy'])
  assert.equal(lemmas.has('nemokama'), false)
})
