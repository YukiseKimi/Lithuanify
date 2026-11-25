#!/usr/bin/env node
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createInterface } from 'node:readline'
import { createGunzip } from 'node:zlib'
import { fileURLToPath } from 'node:url'

const SOURCES = {
  wiktionary: 'https://kaikki.org/dictionary/Lithuanian/kaikki.org-dictionary-Lithuanian.jsonl',
  english: 'https://kaikki.org/dictionary/English/kaikki.org-dictionary-English.jsonl.gz',
  dic: 'https://raw.githubusercontent.com/LibreOffice/dictionaries/master/lt_LT/lt.dic',
  aff: 'https://raw.githubusercontent.com/LibreOffice/dictionaries/master/lt_LT/lt.aff',
  copying: 'https://raw.githubusercontent.com/LibreOffice/dictionaries/master/lt_LT/COPYING',
  authors: 'https://raw.githubusercontent.com/LibreOffice/dictionaries/master/lt_LT/AUTHORS',
  frequency: 'https://raw.githubusercontent.com/hermitdave/FrequencyWords/master/content/2018/lt/lt_50k.txt',
  frequencyLicense: 'https://raw.githubusercontent.com/hermitdave/FrequencyWords/master/LICENSE'
}
const MAX_GLOSS_WORDS = 3
const MAX_MEANINGS = 3
const MAX_PHRASE_WORDS = 3
const SKIPPED_POS = new Set(['name', 'character', 'symbol', 'abbrev', 'suffix', 'prefix', 'proverb'])

const isWord = (text) => /^[a-ząčęėįšųūž]+$/.test(text)
const isHeadword = (text) => {
  const parts = text.split(' ')
  return parts.length <= MAX_PHRASE_WORDS && parts.every(isWord)
}

const STRESS_MARKS = /[\u0300\u0301\u0303]/g
// Wiktionary writes a stressed i (or \u012f) with a dot above it as well, as in
// "di\u0307\u0300rba". That dot (U+0307) goes; the same mark is part of \u0117, which stays.
const DOT_OVER_I = /([ij]\u0328?)\u0307/g
const withoutStress = (text) => text.normalize('NFD').replace(DOT_OVER_I, '$1').replace(STRESS_MARKS, '').normalize('NFC')

export function shortGloss(text) {
  const first = text
    .replace(/\([^)]*\)/g, ' ')
    .split(/[;,:]/)[0]
    .replace(/^\s*to\s+/i, '')
    .trim()
  return first.split(/\s+/).slice(0, MAX_GLOSS_WORDS).join(' ')
}

export function readWiktionary(lines) {
  const lemmas = new Map()
  const formOf = []
  for (const line of lines) {
    if (!line.trim()) continue
    const entry = JSON.parse(line)
    if (entry.lang_code !== 'lt' || SKIPPED_POS.has(entry.pos)) continue
    const word = withoutStress((entry.word || '').toLowerCase().trim())
    if (!isHeadword(word)) continue
    const glosses = []
    for (const sense of entry.senses || []) {
      if (Array.isArray(sense.form_of) && sense.form_of.length) {
        for (const target of sense.form_of) formOf.push([word, (target.word || '').toLowerCase()])
        continue
      }
      const gloss = shortGloss((sense.glosses || [])[0] || '')
      if (gloss) glosses.push(gloss)
    }
    if (!glosses.length) continue
    const known = lemmas.get(word) || { meanings: [], forms: new Set() }
    for (const gloss of glosses) {
      if (known.meanings.length < MAX_MEANINGS && !known.meanings.includes(gloss)) known.meanings.push(gloss)
    }
    if (isWord(word)) {
      for (const form of entry.forms || []) {
        const text = withoutStress((form.form || '').toLowerCase())
        if (isWord(text) && text !== word) known.forms.add(text)
      }
    }
    lemmas.set(word, known)
  }
  for (const [form, lemma] of formOf) {
    const target = lemmas.get(lemma)
    if (target && form !== lemma) target.forms.add(form)
  }
  return lemmas
}

// English Wiktionary's translation tables name Lithuanian words that have no
// Lithuanian entry of their own (heritage → paveldas). Each pair is
// [Lithuanian word, English headword]; the English headword is the meaning.
export function translationsOf(entry) {
  if (entry.lang_code !== 'en' || SKIPPED_POS.has(entry.pos)) return []
  const english = (entry.word || '').trim()
  if (!english || english.split(/\s+/).length > MAX_GLOSS_WORDS || !/^[A-Za-z][A-Za-z' -]*$/.test(english)) return []
  const tables = [entry.translations || [], ...(entry.senses || []).map((sense) => sense.translations || [])]
  const pairs = []
  for (const table of tables) {
    for (const t of table) {
      if (t.lang_code !== 'lt' && t.code !== 'lt') continue
      const word = withoutStress((t.word || '').toLowerCase().trim())
      if (isWord(word)) pairs.push([word, english])
    }
  }
  return pairs
}

// Adds a lemma for each translated word that Lithuanian Wiktionary lacks and
// Hunspell lists as a headword (so it is a base form, with forms of its own).
// Its meanings are the English words that name it most often. Returns how
// many lemmas it added.
export function addTranslated(lemmas, pairs, heads) {
  const counts = new Map()
  for (const [word, english] of pairs) {
    if (lemmas.has(word) || !heads.has(word)) continue
    const byEnglish = counts.get(word) || new Map()
    byEnglish.set(english, (byEnglish.get(english) || 0) + 1)
    counts.set(word, byEnglish)
  }
  for (const [word, byEnglish] of counts) {
    const meanings = [...byEnglish]
      .sort(([a, n], [b, m]) => m - n || a.length - b.length || a.localeCompare(b))
      .slice(0, MAX_MEANINGS)
      .map(([english]) => english)
    lemmas.set(word, { meanings, forms: new Set() })
  }
  return counts.size
}

// Streams the gzipped English dump (about 3.4 GB of JSON lines) and parses
// only the lines that hold a Lithuanian translation.
async function readTranslations(path) {
  const pairs = []
  const lines = createInterface({ input: createReadStream(path).pipe(createGunzip()), crlfDelay: Infinity })
  for await (const line of lines) {
    if (!line.includes('"lang_code": "lt"')) continue
    pairs.push(...translationsOf(JSON.parse(line)))
  }
  return pairs
}

function splitFlags(flags, mode) {
  if (!flags) return []
  if (mode === 'long') return flags.match(/../g) || []
  if (mode === 'num') return flags.split(',')
  return [...flags]
}

const NEGATING_PREFIXES = new Set(['ne', 'nebe'])

export function parseAffixes(affText) {
  const rules = new Map()
  const negating = new Set()
  let mode = 'char'
  const lines = affText.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const parts = lines[i].trim().split(/\s+/)
    if (parts[0] === 'FLAG') mode = parts[1] === 'long' ? 'long' : parts[1] === 'num' ? 'num' : 'char'
    if (parts[0] !== 'SFX' && parts[0] !== 'PFX') continue
    if (parts.length !== 4 || !/^\d+$/.test(parts[3])) continue
    const [kind, flag, , count] = parts
    const entries = []
    for (let n = 0; n < Number(count); n++) {
      const rule = (lines[++i] || '').trim().split(/\s+/)
      const strip = rule[2] === '0' ? '' : rule[2]
      const add = (rule[3] || '').split('/')[0]
      const condition = !rule[4] || rule[4] === '.' ? null
        : new RegExp(`${rule[4]}$`, 'u')
      entries.push({ strip, add: add === '0' ? '' : add, condition })
    }
    if (kind === 'SFX') rules.set(flag, entries)
    else if (entries.some((entry) => NEGATING_PREFIXES.has(entry.add))) negating.add(flag)
  }
  return { mode, rules, negating }
}

function applySuffix(word, entry) {
  if (entry.condition && !entry.condition.test(word)) return null
  if (entry.strip && !word.endsWith(entry.strip)) return null
  return word.slice(0, word.length - entry.strip.length) + entry.add
}

export function expandHunspell(dicText, affixes, negatable = new Set()) {
  const forms = new Map()
  const lines = dicText.split(/\r?\n/)
  for (const line of lines.slice(/^\d+\s*$/.test(lines[0] || '') ? 1 : 0)) {
    const [head] = line.split(/\s/)
    if (!head) continue
    const slash = head.indexOf('/')
    const word = (slash < 0 ? head : head.slice(0, slash)).toLowerCase()
    if (!isWord(word)) continue
    const flags = splitFlags(slash < 0 ? '' : head.slice(slash + 1), affixes.mode)
    const out = new Set([word])
    if (flags.some((flag) => affixes.negating.has(flag))) negatable.add(word)
    for (const flag of flags) {
      for (const entry of affixes.rules.get(flag) || []) {
        const form = applySuffix(word, entry)
        if (form && isWord(form)) out.add(form)
      }
    }
    const known = forms.get(word)
    if (known) for (const form of out) known.add(form)
    else forms.set(word, out)
  }
  return forms
}

export function readFrequency(text) {
  const ranks = new Map()
  for (const line of text.split(/\r?\n/)) {
    const word = (line.split(' ')[0] || '').toLowerCase()
    if (isWord(word) && !ranks.has(word)) ranks.set(word, ranks.size + 1)
  }
  return ranks
}

export function writeDictionary(lemmas, hunspellForms, negatable = new Set(), ranks = new Map()) {
  const lines = []
  for (const [lemma, { meanings, forms }] of [...lemmas].sort(([a], [b]) => a.localeCompare(b, 'lt'))) {
    const all = new Set(forms)
    for (const form of hunspellForms.get(lemma) || []) all.add(form)
    all.delete(lemma)
    const rank = Math.min(...[lemma, ...all].map((word) => ranks.get(word) || Infinity))
    const columns = [
      meanings.map((m) => m.replace(/[\s|]+/g, ' ')).join('|'), lemma, [...all].sort().join(' '),
      negatable.has(lemma) ? 'ne' : '', Number.isFinite(rank) ? String(rank) : ''
    ]
    while (columns.length > 3 && !columns[columns.length - 1]) columns.pop()
    lines.push(columns.join('\t'))
  }
  return lines.join('\n') + '\n'
}

async function download(url, path) {
  if (existsSync(path)) return
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`)
  // Streamed to disk (the English dump is 0.5 GB), then renamed, so a broken
  // download never passes for a whole one on the next run.
  await pipeline(Readable.fromWeb(response.body), createWriteStream(path + '.part'))
  renameSync(path + '.part', path)
}

async function readLines(path) {
  const lines = []
  for await (const line of createInterface({ input: createReadStream(path), crlfDelay: Infinity })) lines.push(line)
  return lines
}

async function main() {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const work = root + 'build/dictionary/'
  mkdirSync(work, { recursive: true })
  await download(SOURCES.wiktionary, work + 'lithuanian.jsonl')
  await download(SOURCES.english, work + 'english.jsonl.gz')
  await download(SOURCES.dic, work + 'lt.dic')
  await download(SOURCES.aff, work + 'lt.aff')
  await download(SOURCES.copying, work + 'COPYING')
  await download(SOURCES.authors, work + 'AUTHORS')
  await download(SOURCES.frequency, work + 'lt_50k.txt')
  await download(SOURCES.frequencyLicense, work + 'FrequencyWords-LICENSE')

  const lemmas = readWiktionary(await readLines(work + 'lithuanian.jsonl'))
  const affixes = parseAffixes(readFileSync(work + 'lt.aff', 'utf8'))
  const negatable = new Set()
  const forms = expandHunspell(readFileSync(work + 'lt.dic', 'utf8'), affixes, negatable)
  const ranks = readFrequency(readFileSync(work + 'lt_50k.txt', 'utf8'))
  const translated = addTranslated(lemmas, await readTranslations(work + 'english.jsonl.gz'), new Set(forms.keys()))
  console.log(`${translated} lemmas from English translation tables`)
  const out = writeDictionary(lemmas, forms, negatable, ranks)

  const target = root + 'Shared (Extension)/Resources/dictionary/'
  mkdirSync(target, { recursive: true })
  writeFileSync(target + 'lt-en.tsv', out)
  writeFileSync(target + 'LICENSE-hunspell-lt.txt',
    readFileSync(work + 'AUTHORS', 'utf8') + '\n' + readFileSync(work + 'COPYING', 'utf8'))
  writeFileSync(target + 'LICENSE-frequencywords.txt', [
    'Word frequency ranks: FrequencyWords by Hermit Dave (https://github.com/hermitdave/FrequencyWords),',
    'from OpenSubtitles. Content under CC BY-SA 4.0; the repository licence follows.',
    '',
    readFileSync(work + 'FrequencyWords-LICENSE', 'utf8')
  ].join('\n'))
  writeFileSync(target + 'LICENSE-wiktionary.txt', [
    'English meanings and word forms: Wiktionary (https://en.wiktionary.org),',
    'extracted by Wiktextract (https://kaikki.org/dictionary/Lithuanian/).',
    'Licensed under CC BY-SA 4.0: https://creativecommons.org/licenses/by-sa/4.0/',
    ''
  ].join('\n'))
  console.log(`${lemmas.size} lemmas, ${(out.length / 1e6).toFixed(1)} MB → ${target}lt-en.tsv`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main()
