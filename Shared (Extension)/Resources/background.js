// Lithuanify background script.
// Bridges the content script to two translation backends:
//   1. On-device AI (Apple's FoundationModels) via the native app extension —
//      context-aware per-word glosses, free and private. Preferred when available.
//   2. A cloud word-translation endpoint, used only as a fallback when the
//      on-device model isn't available. Results are cached so each word is
//      fetched at most once.

const NATIVE_APP_ID = "application.id"; // Safari routes this to the native handler.
const ENDPOINT = "https://translate.googleapis.com/translate_a/single";
const BATCH_SIZE = 50;

// --- On-device model bridge -------------------------------------------------

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

// Persistent cache of text block -> array of {w, g}, so revisits and repeated
// text are instant across page loads. Bounded so storage can't grow forever.
const GLOSS_CACHE_KEY = "glossCache";
const GLOSS_CACHE_MAX = 3000;
const glossCache = new Map();
let glossCacheLoaded = false;

async function loadGlossCache() {
    if (glossCacheLoaded) return;
    try {
        const stored = await browser.storage.local.get(GLOSS_CACHE_KEY);
        const obj = stored[GLOSS_CACHE_KEY];
        if (obj && typeof obj === "object") {
            for (const key of Object.keys(obj)) glossCache.set(key, obj[key]);
        }
    } catch (e) { /* start empty */ }
    glossCacheLoaded = true;
}

async function persistGlossCache() {
    // Evict oldest entries (Maps keep insertion order) to stay within bounds.
    while (glossCache.size > GLOSS_CACHE_MAX) {
        glossCache.delete(glossCache.keys().next().value);
    }
    try {
        const obj = {};
        for (const [key, value] of glossCache) obj[key] = value;
        await browser.storage.local.set({ [GLOSS_CACHE_KEY]: obj });
    } catch (e) { /* ignore */ }
}

async function handleGloss(texts) {
    await loadGlossCache();

    const result = {};
    const need = [];
    for (const text of texts) {
        if (glossCache.has(text)) {
            // Refresh recency so frequently-seen text survives eviction.
            const cached = glossCache.get(text);
            glossCache.delete(text);
            glossCache.set(text, cached);
            result[text] = cached;
        } else {
            need.push(text);
        }
    }

    if (need.length) {
        try {
            const resp = await browser.runtime.sendNativeMessage(NATIVE_APP_ID, {
                command: "gloss",
                texts: need
            });
            if (resp && resp.available && Array.isArray(resp.results)) {
                need.forEach((text, i) => {
                    const arr = Array.isArray(resp.results[i]) ? resp.results[i] : [];
                    glossCache.set(text, arr);
                    result[text] = arr;
                });
                await persistGlossCache();
            } else {
                modelAvailable = false; // model went away; let content fall back
                need.forEach((text) => { result[text] = []; });
            }
        } catch (e) {
            need.forEach((text) => { result[text] = []; });
        }
    }
    return result;
}

// --- Cloud word-translation fallback ---------------------------------------

const cache = {};          // lowercased word -> translation ("" means "none")
let cacheLoaded = false;

async function loadCache() {
    if (cacheLoaded) return;
    try {
        const stored = await browser.storage.local.get("translationCache");
        Object.assign(cache, stored.translationCache || {});
    } catch (e) { /* start empty */ }
    cacheLoaded = true;
}

async function persistCache() {
    try {
        await browser.storage.local.set({ translationCache: cache });
    } catch (e) { /* ignore */ }
}

async function translateBatch(words) {
    const query = words.join("\n");
    const url = `${ENDPOINT}?client=gtx&sl=lt&tl=en&dt=t&q=${encodeURIComponent(query)}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();

    const segments = Array.isArray(data && data[0]) ? data[0] : [];
    const translatedText = segments.map((s) => (s && s[0]) || "").join("");
    const lines = translatedText.split("\n");

    words.forEach((word, i) => {
        const candidate = (lines[i] || "").trim();
        cache[word] = candidate && candidate.toLowerCase() !== word ? candidate : "";
    });
}

async function handleTranslate(words) {
    await loadCache();

    const result = {};
    const need = [];
    for (const word of words) {
        if (Object.prototype.hasOwnProperty.call(cache, word)) {
            result[word] = cache[word];
        } else {
            need.push(word);
        }
    }

    for (let i = 0; i < need.length; i += BATCH_SIZE) {
        const chunk = need.slice(i, i + BATCH_SIZE);
        try {
            await translateBatch(chunk);
        } catch (e) {
            chunk.forEach((w) => {
                if (!Object.prototype.hasOwnProperty.call(cache, w)) cache[w] = "";
            });
        }
    }

    if (need.length) await persistCache();

    for (const word of need) result[word] = cache[word] || "";
    return result;
}

// --- Message routing --------------------------------------------------------

browser.runtime.onMessage.addListener((request) => {
    if (!request) return;
    if (request.command === "modelStatus") {
        return checkModel().then((available) => ({ available }));
    }
    if (request.command === "gloss" && Array.isArray(request.texts)) {
        return handleGloss(request.texts);
    }
    if (request.command === "translate" && Array.isArray(request.words)) {
        return handleTranslate(request.words);
    }
});
