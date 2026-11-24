// Lithuanify background script.
// Bridges the content script to the on-device model (Apple's FoundationModels)
// in the native app extension. Everything runs locally: there is no cloud path.
//
// The content script renders dictionary glosses itself, then sends only the
// words the dictionary didn't know here, batched by viewport. Results are
// cached per text block in IndexedDB so revisits never touch the model.

const NATIVE_APP_ID = "application.id"; // Safari routes this to the native handler.

// --- On-device model status -------------------------------------------------

const RECHECK_MS = 60 * 1000;
let modelAvailable = null;
let checkedAt = 0;

async function checkModel() {
    if (modelAvailable === true) return true;
    if (modelAvailable === false && Date.now() - checkedAt < RECHECK_MS) return false;
    try {
        const resp = await browser.runtime.sendNativeMessage(NATIVE_APP_ID, { command: "modelStatus" });
        modelAvailable = !!(resp && resp.available);
    } catch (e) {
        modelAvailable = false;
    }
    checkedAt = Date.now();
    return modelAvailable;
}

// --- Gloss cache (IndexedDB) ------------------------------------------------

const DB_NAME = "lithuanify";
const DB_VERSION = 5;
const STORE = "glosses";
const CACHE_MAX = 5000;

const memCache = new Map();
const dirty = new Map();
let dbPromise = null;
let openedDb = null;

function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve) => {
        let req;
        try {
            req = indexedDB.open(DB_NAME, DB_VERSION);
        } catch (e) {
            resolve(null);
            return;
        }
        req.onupgradeneeded = () => {
            const db = req.result;
            if (db.objectStoreNames.contains(STORE)) db.deleteObjectStore(STORE);
            const store = db.createObjectStore(STORE, { keyPath: "k" });
            store.createIndex("t", "t");
        };
        req.onsuccess = () => {
            const db = req.result;
            openedDb = db;
            db.onversionchange = () => {
                db.close();
                if (openedDb === db) dbPromise = null;
            };
            dbPromise = Promise.resolve(db);
            resolve(db);
            flushCache();
        };
        req.onblocked = () => resolve(null);
        req.onerror = () => resolve(null); // fall back to memory-only
    });
    return dbPromise;
}

// Look up several keys at once. Returns Map(key -> value) for the hits.
async function cacheGetMany(keys) {
    const hits = new Map();
    const missing = [];
    for (const k of keys) {
        if (memCache.has(k)) hits.set(k, memCache.get(k));
        else missing.push(k);
    }
    if (!missing.length) return hits;

    const db = await openDb();
    if (!db) return hits;
    await transact(db, "readonly", (store) => {
        for (const k of missing) {
            const req = store.get(k);
            req.onsuccess = () => {
                if (req.result) {
                    remember(k, req.result.v);
                    hits.set(k, req.result.v);
                }
            };
        }
    });
    return hits;
}

function transact(db, mode, work) {
    return new Promise((resolve) => {
        let tx;
        try {
            tx = db.transaction(STORE, mode);
            work(tx.objectStore(STORE));
        } catch (e) {
            if (openedDb === db) dbPromise = null;
            resolve(false);
            return;
        }
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
        tx.onabort = () => resolve(false);
    });
}

function remember(key, value) {
    memCache.delete(key);
    memCache.set(key, value);
    while (memCache.size > CACHE_MAX) {
        const oldest = memCache.keys().next().value;
        memCache.delete(oldest);
        dirty.delete(oldest);
    }
}

function cachePut(key, value) {
    dirty.set(key, value);
    remember(key, value);
}

async function flushCache() {
    if (!dirty.size) return;
    const db = await openDb();
    if (!db) return;
    const entries = [...dirty];
    dirty.clear();
    const now = Date.now();
    const saved = await transact(db, "readwrite", (store) => {
        for (const [k, v] of entries) store.put({ k, v, t: now });
    });
    if (!saved) {
        for (const [k, v] of entries) {
            if (!dirty.has(k) && memCache.has(k)) dirty.set(k, v);
        }
        return;
    }
    evictIfNeeded(db);
}

// Drop the oldest entries once the store grows past CACHE_MAX.
function evictIfNeeded(db) {
    transact(db, "readwrite", (store) => {
        const countReq = store.count();
        countReq.onsuccess = () => {
            let excess = countReq.result - CACHE_MAX;
            if (excess <= 0) return;
            store.index("t").openCursor().onsuccess = (event) => {
                const cursor = event.target.result;
                if (!cursor || excess <= 0) return;
                memCache.delete(cursor.value.k);
                cursor.delete();
                excess--;
                cursor.continue();
            };
        };
    });
}

// One-time cleanup of the old storage.local caches (old format, and the
// removed cloud path's word cache).
browser.storage.local.remove(["glossCache", "translationCache"]).catch(() => {});

// --- Gloss requests ---------------------------------------------------------

// blocks: [{ text, words: [lowercased unknown words], hints? }]
// Answers are cached per word and the sentence it is in.
const SENTENCE_RE = /[^.!?;\n]+[.!?;\n]*/g;
const keyOf = (sentence, word) => sentence + "\u0001" + word;

function sentenceOf(text, word) {
    const lower = word.toLowerCase();
    const sentences = text.match(SENTENCE_RE) || [text];
    const found = sentences.find((sentence) =>
        (sentence.toLowerCase().match(/\p{L}+/gu) || []).includes(lower));
    return (found || text).trim();
}

const PAUSE_MS = 60 * 1000;
let pausedUntil = 0;

const pausedReply = (blocks) => ({
    available: true,
    paused: true,
    retryInMs: Math.max(pausedUntil - Date.now(), 0),
    results: blocks.map(() => null)
});

async function handleGloss(blocks) {
    const valid = blocks.filter((b) =>
        b && typeof b.text === "string" && Array.isArray(b.words) && b.words.length);
    const keysOf = new Map(valid.map((b) => [b, b.words.map((w) => keyOf(sentenceOf(b.text, w), w))]));
    const cached = await cacheGetMany([...new Set([...keysOf.values()].flat())]);

    const need = new Map();
    for (const b of valid) {
        const missing = b.words.map((_, i) => i).filter((i) => !cached.has(keysOf.get(b)[i]));
        if (!missing.length) continue;
        const request = { text: b.text, words: missing.map((i) => b.words[i]) };
        if (Array.isArray(b.hints)) request.hints = missing.map((i) => b.hints[i] || null);
        const signature = JSON.stringify(request);
        const entry = need.get(signature) || { request, keys: missing.map((i) => keysOf.get(b)[i]), blocks: [] };
        entry.blocks.push(b);
        need.set(signature, entry);
    }

    const failed = new Set();
    if (need.size && Date.now() < pausedUntil) return pausedReply(blocks);
    if (need.size) {
        const entries = [...need.values()];
        let resp = null;
        try {
            resp = await browser.runtime.sendNativeMessage(NATIVE_APP_ID, {
                command: "gloss",
                blocks: entries.map((e) => e.request)
            });
        } catch (e) {
            resp = null;
        }

        if (resp && resp.available === false) {
            modelAvailable = false;
            checkedAt = Date.now();
            return { available: false, results: [] };
        }
        if (resp && Array.isArray(resp.results)) {
            const ok = Array.isArray(resp.ok) ? resp.ok : [];
            entries.forEach((e, i) => {
                if (ok[i] === false) {
                    e.blocks.forEach((b) => failed.add(b));
                    return;
                }
                const glosses = Array.isArray(resp.results[i]) ? resp.results[i] : [];
                e.keys.forEach((key, j) => {
                    const value = typeof glosses[j] === "string" ? glosses[j] : "";
                    cachePut(key, value);
                    cached.set(key, value);
                });
            });
            flushCache();
            if (resp.rateLimited) {
                pausedUntil = Date.now() + PAUSE_MS;
                return pausedReply(blocks);
            }
        } else {
            entries.forEach((e) => e.blocks.forEach((b) => failed.add(b)));
        }
    }

    return {
        available: true,
        results: blocks.map((b) => {
            if (!keysOf.has(b)) return {};
            if (failed.has(b)) return null;
            const keys = keysOf.get(b);
            return Object.fromEntries(b.words.map((w, i) => [w, cached.get(keys[i]) ?? ""]));
        })
    };
}

const DIACRITICS = { "ą": "a", "č": "c", "ę": "e", "ė": "e", "į": "i", "š": "s", "ų": "u", "ū": "u", "ž": "z" };
const MARKED = /[ąčęėįšųūž]/;
const foldWord = (word) => word.replace(/[ąčęėįšųūž]/g, (c) => DIACRITICS[c]);
let dictionaryPromise = null;

const MAX_OPTIONS = 4;

function merge(a, b) {
    if (a === b) return a;
    return {
        m: [...new Set([...a.m, ...b.m])].slice(0, MAX_OPTIONS),
        l: a.l === b.l ? a.l : null,
        ne: a.ne && b.ne,
        r: a.r && b.r ? Math.min(a.r, b.r) : a.r || b.r
    };
}

function parseDictionary(text) {
    const byWord = new Map();
    const lemmas = text.split("\n").map((line) => line.split("\t")).filter((cols) => cols.length >= 2)
        .map(([glosses, lemma, forms = "", ne, rank]) => ({
            lemma, forms, entry: { m: glosses.split("|"), l: lemma, ne: ne === "ne", r: Number(rank) || 0 }
        }));
    const add = (word, entry) => {
        const known = byWord.get(word);
        byWord.set(word, known ? merge(known, entry) : entry);
    };
    for (const { lemma, entry } of lemmas) add(lemma, entry);
    const headwords = new Set(byWord.keys());
    for (const { forms, entry } of lemmas) {
        for (const form of forms.split(" ")) {
            if (form && !headwords.has(form)) add(form, entry);
        }
    }
    const unmarked = new Map();
    for (const [word, entry] of byWord) {
        if (!MARKED.test(word)) continue;
        const key = foldWord(word);
        if (byWord.has(key)) continue;
        const known = unmarked.get(key);
        unmarked.set(key, known ? merge(known, entry) : entry);
    }
    return { byWord, unmarked, size: byWord.size };
}

function entryOf(meanings, word) {
    const entry = meanings.byWord.get(word);
    if (entry) return entry;
    if (MARKED.test(word)) return null;
    return meanings.unmarked.get(word) || null;
}

function loadDictionary() {
    if (!dictionaryPromise) {
        dictionaryPromise = fetch(browser.runtime.getURL("dictionary/lt-en.tsv"))
            .then((response) => (response.ok ? response.text() : ""))
            .then(parseDictionary)
            .catch(() => parseDictionary(""))
            .then((meanings) => {
                if (meanings.size === 0) dictionaryPromise = null;
                return meanings;
            });
    }
    return dictionaryPromise;
}

const NEGATIONS = ["nebe", "ne"];

// Verb prefixes, longest first (Hunspell lt_LT's PFX flags a–l). Wiktionary
// lacks many prefixed verbs (sukurti, užimti) whose plain verb it has
// (kurti, imti). The plain verb's meaning is close but not exact, so it is
// marked approximate for the model to confirm or replace.
const VERB_PREFIXES = ["api", "ati", "par", "per", "pra", "pri", "ap", "at", "iš", "nu", "pa", "su", "už", "į"];
const MIN_STEM = 3;

// Only a word that Hunspell lets take ne- (a verb or adjective form) is
// split, so a noun that happens to start like a prefix is left alone.
function prefixedMeaning(meanings, word) {
    for (const prefix of VERB_PREFIXES) {
        if (!word.startsWith(prefix) || word.length < prefix.length + MIN_STEM) continue;
        const base = entryOf(meanings, word.slice(prefix.length));
        // `from` names the plain verb, for the word card: "the meaning of važiuoti".
        if (base && base.ne) return { m: base.m, l: base.l && prefix + base.l, r: 0, approx: true, from: base.l };
    }
    return null;
}

// A reflexive verb puts -si- after its prefix or after ne-: pa-si-kalbėti,
// ne-si-jaudink. Its meaning can drift far from the plain verb (susitikti
// "meet", tikti "suit"), so the plain verb's meaning is a hint for the
// model only: `hintOnly` entries never show as a gloss on their own.
const REFLEXIVE_PREFIXES = [...VERB_PREFIXES.filter((p) => p !== "api" && p !== "ati").map((p) => p + "si"), "nesi"];

function reflexiveMeaning(meanings, word) {
    for (const prefix of REFLEXIVE_PREFIXES) {
        if (!word.startsWith(prefix) || word.length < prefix.length + MIN_STEM) continue;
        const base = entryOf(meanings, word.slice(prefix.length));
        if (!base || !base.ne) continue;
        const hint = { m: base.m, r: 0, approx: true, from: base.l, hintOnly: true };
        if (prefix === "nesi") return negated({ ...hint, l: base.l && base.l + "s" });
        return { ...hint, l: base.l && prefix + base.l };
    }
    return null;
}

const negated = (entry) => ({ ...entry, m: entry.m.map((meaning) => "not " + meaning) });

// ne- merges with the forms of būti that start with a vowel: ne + esu is
// nesu, ne + yra is nėra. These come before any other lookup: spelled
// without its marks, nesu would otherwise read as nešu ("I carry").
const NEGATED_BE = { nesu: "esu", nesi: "esi", nesame: "esame", nesate: "esate", nesam: "esam", nesat: "esat", nėra: "yra" };

function meaningOf(meanings, word) {
    if (NEGATED_BE[word]) {
        const be = entryOf(meanings, NEGATED_BE[word]);
        if (be) return negated({ m: be.m, l: be.l || "būti", r: 0 });
    }
    const entry = entryOf(meanings, word);
    if (entry) return { m: entry.m, l: entry.l, r: entry.r };
    for (const prefix of NEGATIONS) {
        if (!word.startsWith(prefix) || word.length <= prefix.length + 2) continue;
        const rest = word.slice(prefix.length);
        const base = entryOf(meanings, rest);
        const prefixed = prefixedMeaning(meanings, rest);
        // Hunspell makes most prefixed verbs (suprasti) from the plain verb, so
        // only the plain verb carries ne; a prefixed verb takes ne all the same.
        if (base && (base.ne || prefixed)) return negated({ m: base.m, l: base.l, r: 0 });
        if (!base && prefixed) return negated(prefixed);
    }
    return prefixedMeaning(meanings, word) || reflexiveMeaning(meanings, word);
}

async function handleLookup(words) {
    const meanings = await loadDictionary();
    const found = {};
    for (const word of words) {
        if (typeof word !== "string") continue;
        const lower = word.toLowerCase();
        const entry = meaningOf(meanings, lower);
        if (entry) found[word] = entry;
    }
    return found;
}

// --- Message routing --------------------------------------------------------

browser.runtime.onMessage.addListener((request) => {
    if (!request) return;
    if (request.command === "modelStatus") {
        return checkModel().then((available) => ({ available }));
    }
    if (request.command === "lookup" && Array.isArray(request.words)) {
        return handleLookup(request.words);
    }
    if (request.command === "gloss" && Array.isArray(request.blocks)) {
        return handleGloss(request.blocks);
    }
});
