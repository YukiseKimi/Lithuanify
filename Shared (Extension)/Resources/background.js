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
const DB_VERSION = 3;
const STORE = "glosses";
const CACHE_MAX = 5000;

const memCache = new Map();
const dirty = new Map();
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
            const db = req.result;
            if (db.objectStoreNames.contains(STORE)) db.deleteObjectStore(STORE);
            const store = db.createObjectStore(STORE, { keyPath: "k" });
            store.createIndex("t", "t");
        };
        req.onsuccess = () => {
            const db = req.result;
            db.onversionchange = () => {
                db.close();
                dbPromise = null;
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
}

async function flushCache() {
    if (!dirty.size) return;
    const db = await openDb();
    if (!db) return;
    const entries = [...dirty];
    dirty.clear();
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
const keyOf = (b) => b.text + "\u0001" + b.words.join(" ");

async function handleGloss(blocks) {
    const valid = blocks.filter((b) =>
        b && typeof b.text === "string" && Array.isArray(b.words) && b.words.length);
    const cached = await cacheGetMany([...new Set(valid.map(keyOf))]);

    // Unique uncached blocks to send to the model.
    const need = new Map();
    for (const b of valid) {
        const key = keyOf(b);
        if (!cached.has(key) && !need.has(key)) need.set(key, b);
    }

    const failed = new Set();
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
            checkedAt = Date.now();
            return { available: false, results: [] };
        }
        if (resp && Array.isArray(resp.results)) {
            const ok = Array.isArray(resp.ok) ? resp.ok : [];
            sent.forEach((b, i) => {
                if (ok[i] === false) {
                    failed.add(keyOf(b));
                    return;
                }
                const glosses = Array.isArray(resp.results[i]) ? resp.results[i] : [];
                const value = {};
                b.words.forEach((w, j) => {
                    value[w] = typeof glosses[j] === "string" ? glosses[j] : "";
                });
                cachePut(keyOf(b), value);
                cached.set(keyOf(b), value);
            });
            flushCache();
        } else {
            for (const b of sent) failed.add(keyOf(b));
        }
    }

    return {
        available: true,
        results: blocks.map((b) => {
            if (!b || !Array.isArray(b.words)) return {};
            if (failed.has(keyOf(b))) return null;
            return cached.get(keyOf(b)) || {};
        })
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
