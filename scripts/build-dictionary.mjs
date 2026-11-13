#!/usr/bin/env node
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

const SOURCES = {
  wiktionary: 'https://kaikki.org/dictionary/Lithuanian/kaikki.org-dictionary-Lithuanian.jsonl',
  dic: 'https://raw.githubusercontent.com/LibreOffice/dictionaries/master/lt_LT/lt.dic',
  aff: 'https://raw.githubusercontent.com/LibreOffice/dictionaries/master/lt_LT/lt.aff'
}
const MAX_GLOSS_WORDS = 3
const SKIPPED_POS = new Set(['name', 'character', 'symbol', 'abbrev', 'suffix', 'prefix', 'phrase', 'proverb'])

const isWord = (text) => /^\p{L}+$/u.test(text)

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
    const word = (entry.word || '').toLowerCase()
    if (!isWord(word)) continue
    for (const sense of entry.senses || []) {
      if (Array.isArray(sense.form_of) && sense.form_of.length) {
        for (const target of sense.form_of) formOf.push([word, (target.word || '').toLowerCase()])
        continue
      }
      const gloss = shortGloss((sense.glosses || [])[0] || '')
      if (!gloss || lemmas.has(word)) continue
      const forms = new Set()
      for (const form of entry.forms || []) {
        const text = (form.form || '').toLowerCase()
        if (isWord(text) && text !== word) forms.add(text)
      }
      lemmas.set(word, { gloss, forms })
    }
  }
  for (const [form, lemma] of formOf) {
    const target = lemmas.get(lemma)
    if (target && form !== lemma) target.forms.add(form)
  }
  return lemmas
}

function splitFlags(flags, mode) {
  if (!flags) return []
  if (mode === 'long') return flags.match(/../g) || []
  if (mode === 'num') return flags.split(',')
  return [...flags]
}

export function parseAffixes(affText) {
  const rules = new Map()
  let mode = 'char'
  const lines = affText.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const parts = lines[i].trim().split(/\s+/)
    if (parts[0] === 'FLAG') mode = parts[1] === 'long' ? 'long' : parts[1] === 'num' ? 'num' : 'char'
    if (parts[0] !== 'SFX' && parts[0] !== 'PFX') continue
    if (parts.length !== 4 || !/^\d+$/.test(parts[3])) continue
    const [kind, flag, cross, count] = parts
    const entries = []
    for (let n = 0; n < Number(count); n++) {
      const rule = (lines[++i] || '').trim().split(/\s+/)
      const strip = rule[2] === '0' ? '' : rule[2]
      const add = (rule[3] || '').split('/')[0]
      const condition = !rule[4] || rule[4] === '.' ? null
        : new RegExp(kind === 'SFX' ? `${rule[4]}$` : `^${rule[4]}`, 'u')
      entries.push({ strip, add: add === '0' ? '' : add, condition })
    }
    rules.set(flag, { kind, cross: cross === 'Y', entries })
  }
  return { mode, rules }
}

function applyRule(word, rule, entry) {
  if (entry.condition && !entry.condition.test(word)) return null
  if (rule.kind === 'SFX') {
    if (entry.strip && !word.endsWith(entry.strip)) return null
    return word.slice(0, word.length - entry.strip.length) + entry.add
  }
  if (entry.strip && !word.startsWith(entry.strip)) return null
  return entry.add + word.slice(entry.strip.length)
}

export function expandHunspell(dicText, affixes) {
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
    const suffixed = []
    for (const flag of flags) {
      const rule = affixes.rules.get(flag)
      if (!rule || rule.kind !== 'SFX') continue
      for (const entry of rule.entries) {
        const form = applyRule(word, rule, entry)
        if (form && isWord(form)) {
          out.add(form)
          if (rule.cross) suffixed.push(form)
        }
      }
    }
    for (const flag of flags) {
      const rule = affixes.rules.get(flag)
      if (!rule || rule.kind !== 'PFX') continue
      for (const base of rule.cross ? [word, ...suffixed] : [word]) {
        for (const entry of rule.entries) {
          const form = applyRule(base, rule, entry)
          if (form && isWord(form)) out.add(form)
        }
      }
    }
    const known = forms.get(word)
    if (known) for (const form of out) known.add(form)
    else forms.set(word, out)
  }
  return forms
}

export function writeDictionary(lemmas, hunspellForms) {
  const lines = []
  for (const [lemma, { gloss, forms }] of [...lemmas].sort(([a], [b]) => a.localeCompare(b, 'lt'))) {
    const all = new Set(forms)
    for (const form of hunspellForms.get(lemma) || []) all.add(form)
    all.delete(lemma)
    lines.push([gloss.replace(/\s+/g, ' '), lemma, [...all].sort().join(' ')].join('\t'))
  }
  return lines.join('\n') + '\n'
}

async function download(url, path) {
  if (existsSync(path)) return
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`)
  writeFileSync(path, Buffer.from(await response.arrayBuffer()))
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
  await download(SOURCES.dic, work + 'lt.dic')
  await download(SOURCES.aff, work + 'lt.aff')

  const lemmas = readWiktionary(await readLines(work + 'lithuanian.jsonl'))
  const affixes = parseAffixes(readFileSync(work + 'lt.aff', 'utf8'))
  const forms = expandHunspell(readFileSync(work + 'lt.dic', 'utf8'), affixes)
  const out = writeDictionary(lemmas, forms)

  const target = root + 'Shared (Extension)/Resources/dictionary/'
  mkdirSync(target, { recursive: true })
  writeFileSync(target + 'lt-en.tsv', out)
  console.log(`${lemmas.size} lemmas, ${(out.length / 1e6).toFixed(1)} MB → ${target}lt-en.tsv`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main()
