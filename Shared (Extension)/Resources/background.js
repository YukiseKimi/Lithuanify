// Lithuanify background script.
// Bridges the content script to the on-device model (Apple's FoundationModels)
// in the native app extension. Everything runs locally: there is no cloud path.
//
// The content script renders dictionary glosses itself, then sends only the
// words the dictionary didn't know here, batched by viewport. Results are
// cached per text block in IndexedDB so revisits never touch the model.

const NATIVE_APP_ID = "application.id"; // Safari routes this to the native handler.

// --- On-device model status -------------------------------------------------

let modelAvailable = null; // null = unknown, then cached boolean

async function checkModel() {
    if (modelAvailable !== null) return modelAvailable;
    try {
        const resp = await browser.runtime.sendNativeMessage(NATIVE_APP_ID, { command: "modelStatus" });
        modelAvailable = !!(resp && resp.available);
    } catch (e) {
        modelAvailable = false;
    }
    return modelAvailable;
}

// --- Gloss cache (IndexedDB) ------------------------------------------------
// Key: the text block. Value: { word: gloss } for the words that were asked
// about ("" means the model had no meaning, so it isn't asked again).
// A hot in-memory Map sits in front; writes are batched and debounced, and
// only new entries are written.

const DB_NAME = "lithuanify";
const DB_VERSION = 1;
const STORE = "glosses";
const CACHE_MAX = 5000;
const FLUSH_DELAY_MS = 1000;

const memCache = new Map();
const dirty = new Map();
let flushTimer = null;
let dbPromise = null;

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
            const store = req.result.createObjectStore(STORE, { keyPath: "k" });
            store.createIndex("t", "t");
        };
        req.onsuccess = () => resolve(req.result);
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
    await new Promise((resolve) => {
        const tx = db.transaction(STORE, "readonly");
        const store = tx.objectStore(STORE);
        for (const k of missing) {
            const req = store.get(k);
            req.onsuccess = () => {
                if (req.result) {
                    memCache.set(k, req.result.v);
                    hits.set(k, req.result.v);
                }
            };
        }
        tx.oncomplete = resolve;
        tx.onerror = resolve;
        tx.onabort = resolve;
    });
    return hits;
}

function cachePut(key, value) {
    memCache.set(key, value);
    dirty.set(key, value);
    if (!flushTimer) flushTimer = setTimeout(flushCache, FLUSH_DELAY_MS);
}

async function flushCache() {
    flushTimer = null;
    if (!dirty.size) return;
    const entries = [...dirty];
    dirty.clear();

    const db = await openDb();
    if (!db) return;
    const now = Date.now();
    await new Promise((resolve) => {
        const tx = db.transaction(STORE, "readwrite");
        const store = tx.objectStore(STORE);
        for (const [k, v] of entries) store.put({ k, v, t: now });
        tx.oncomplete = resolve;
        tx.onerror = resolve;
        tx.onabort = resolve;
    });
    evictIfNeeded(db);
}

// Drop the oldest entries once the store grows past CACHE_MAX.
function evictIfNeeded(db) {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
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
}

// One-time cleanup of the old storage.local caches (old format, and the
// removed cloud path's word cache).
browser.storage.local.remove(["glossCache", "translationCache"]).catch(() => {});

// --- Gloss requests ---------------------------------------------------------

// blocks: [{ text, words: [lowercased unknown words] }]
// Returns { available, results: [{ word: gloss }] } aligned with `blocks`.
async function handleGloss(blocks) {
    const valid = blocks.filter((b) =>
        b && typeof b.text === "string" && Array.isArray(b.words) && b.words.length);
    const cached = await cacheGetMany([...new Set(valid.map((b) => b.text))]);

    // Unique uncached blocks to send to the model.
    const need = new Map();
    for (const b of valid) {
        if (!cached.has(b.text) && !need.has(b.text)) need.set(b.text, b);
    }

    if (need.size) {
        const sent = [...need.values()].map((b) => ({ text: b.text, words: b.words }));
        let resp = null;
        try {
            resp = await browser.runtime.sendNativeMessage(NATIVE_APP_ID, {
                command: "gloss",
                blocks: sent
            });
        } catch (e) {
            resp = null;
        }

        if (resp && resp.available === false) {
            modelAvailable = false;
            return { available: false, results: [] };
        }
        if (resp && Array.isArray(resp.results)) {
            sent.forEach((b, i) => {
                const glosses = Array.isArray(resp.results[i]) ? resp.results[i] : [];
                const value = {};
                b.words.forEach((w, j) => {
                    value[w] = typeof glosses[j] === "string" ? glosses[j] : "";
                });
                cachePut(b.text, value);
                cached.set(b.text, value);
            });
        }
        // On a transport error nothing is cached, so it can be retried later.
    }

    return {
        available: true,
        results: blocks.map((b) => (b && cached.get(b.text)) || {})
    };
}

// --- Message routing --------------------------------------------------------

browser.runtime.onMessage.addListener((request) => {
    if (!request) return;
    if (request.command === "modelStatus") {
        return checkModel().then((available) => ({ available }));
    }
    if (request.command === "gloss" && Array.isArray(request.blocks)) {
        return handleGloss(request.blocks);
    }
});
