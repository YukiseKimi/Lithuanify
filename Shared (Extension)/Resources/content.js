// Lithuanify content script.
// Walks the page's visible text and renders English meanings in small letters
// above recognised Lithuanian words — like Japanese furigana.
//
// Translation is hybrid:
//   1. A bundled offline dictionary handles common words instantly & privately.
//   2. Unknown words are translated via the background script (cloud fallback),
//      and the result is cached so each word is only ever fetched once.

// --- Offline dictionary -----------------------------------------------------
// Keys are lowercase Lithuanian words (accented and plain variants are both
// listed). This is the fast, private layer; the cloud fallback covers the rest.
const DICTIONARY = {
    // Greetings & social
    "labas": "hello", "sveiki": "hello", "sveikas": "hello",
    "ačiū": "thanks", "aciu": "thanks", "prašom": "please", "prašau": "please",
    "atsiprašau": "sorry", "atsiprašome": "sorry", "viso": "all", "gero": "good",
    "iki": "bye", "sudie": "goodbye", "taip": "yes", "ne": "no", "gerai": "okay",

    // Pronouns
    "aš": "I", "as": "I", "tu": "you", "jis": "he", "ji": "she", "jie": "they",
    "jos": "they", "mes": "we", "jūs": "you", "jus": "you", "tai": "this",
    "tas": "that", "ta": "that", "šis": "this", "sis": "this", "ši": "this",
    "kas": "who", "ką": "what", "ka": "what", "kuris": "which", "savo": "one's",
    "mano": "my", "tavo": "your", "jo": "his", "jūsų": "your", "mūsų": "our",
    "musų": "our",

    // Question words
    "kodėl": "why", "kodel": "why", "kaip": "how", "kur": "where",
    "kada": "when", "kiek": "how much",

    // Common verbs
    "yra": "is", "buvo": "was", "būti": "to be", "buti": "to be", "turi": "has",
    "turėti": "to have", "tureti": "to have", "noriu": "I want", "nori": "wants",
    "norėti": "to want", "noreti": "to want", "galiu": "I can", "gali": "can",
    "galėti": "to be able", "žinau": "I know", "zinau": "I know", "žino": "knows",
    "žinoti": "to know", "matau": "I see", "matyti": "to see", "eiti": "to go",
    "eina": "goes", "ateiti": "to come", "daryti": "to do", "daro": "does",
    "sakyti": "to say", "sako": "says", "kalbėti": "to speak", "kalba": "speaks",
    "skaityti": "to read", "rašyti": "to write", "dirbti": "to work",
    "dirba": "works", "gyventi": "to live", "gyvena": "lives", "mylėti": "to love",
    "myliu": "I love", "valgyti": "to eat", "gerti": "to drink",
    "miegoti": "to sleep", "duoti": "to give", "imti": "to take",
    "pirkti": "to buy", "mokėti": "to pay", "klausti": "to ask",
    "atsakyti": "to answer", "padėti": "to help", "reikia": "need",
    "reikės": "will need",

    // Time
    "diena": "day", "dieną": "day", "naktis": "night", "rytas": "morning",
    "vakaras": "evening", "savaitė": "week", "savaite": "week", "mėnuo": "month",
    "metai": "year", "metų": "years", "valanda": "hour", "minutė": "minute",
    "laikas": "time", "šiandien": "today", "siandien": "today", "rytoj": "tomorrow",
    "vakar": "yesterday", "dabar": "now", "visada": "always", "niekada": "never",

    // Days
    "pirmadienis": "Monday", "antradienis": "Tuesday", "trečiadienis": "Wednesday",
    "ketvirtadienis": "Thursday", "penktadienis": "Friday", "šeštadienis": "Saturday",
    "sekmadienis": "Sunday",

    // Numbers
    "vienas": "one", "viena": "one", "du": "two", "dvi": "two", "trys": "three",
    "keturi": "four", "penki": "five", "šeši": "six", "sesi": "six",
    "septyni": "seven", "aštuoni": "eight", "devyni": "nine", "dešimt": "ten",
    "šimtas": "hundred", "tūkstantis": "thousand",

    // People & family
    "žmogus": "person", "zmogus": "person", "žmonės": "people", "vyras": "man",
    "moteris": "woman", "vaikas": "child", "vaikai": "children",
    "berniukas": "boy", "mergaitė": "girl", "mama": "mom", "motina": "mother",
    "tėtis": "dad", "tėvas": "father", "tevas": "father", "tėvai": "parents",
    "brolis": "brother", "sesuo": "sister", "draugas": "friend",
    "draugė": "friend", "šeima": "family", "seima": "family",

    // Places
    "namas": "house", "namai": "home", "namie": "at home", "namų": "home",
    "miestas": "city", "kaimas": "village", "šalis": "country", "salis": "country",
    "gatvė": "street", "kelias": "road", "mokykla": "school", "darbas": "work",
    "darbą": "work", "parduotuvė": "shop", "ligoninė": "hospital",
    "bažnyčia": "church", "pasaulis": "world", "vieta": "place",

    // Nature
    "vanduo": "water", "ugnis": "fire", "oras": "air", "žemė": "earth",
    "zeme": "earth", "dangus": "sky", "saulė": "sun", "saule": "sun",
    "mėnulis": "moon", "žvaigždė": "star", "jūra": "sea", "jura": "sea",
    "upė": "river", "ežeras": "lake", "miškas": "forest", "miskas": "forest",
    "medis": "tree", "gėlė": "flower", "gele": "flower", "akmuo": "stone",
    "kalnas": "mountain", "lietus": "rain", "sniegas": "snow", "vėjas": "wind",
    "vejas": "wind", "gyvūnas": "animal", "šuo": "dog", "suo": "dog",
    "katė": "cat", "kate": "cat", "paukštis": "bird", "žuvis": "fish",

    // Food
    "maistas": "food", "duona": "bread", "pienas": "milk", "sūris": "cheese",
    "mėsa": "meat", "mesa": "meat", "vaisius": "fruit", "daržovė": "vegetable",
    "obuolys": "apple", "kava": "coffee", "arbata": "tea", "vynas": "wine",
    "alus": "beer", "cukrus": "sugar", "druska": "salt",

    // Body
    "galva": "head", "akis": "eye", "akys": "eyes", "ausis": "ear",
    "nosis": "nose", "burna": "mouth", "ranka": "hand", "koja": "leg",
    "širdis": "heart", "sirdis": "heart", "kūnas": "body",

    // Adjectives
    "geras": "good", "blogas": "bad", "didelis": "big", "mažas": "small",
    "mazas": "small", "naujas": "new", "senas": "old", "jaunas": "young",
    "gražus": "beautiful", "grazus": "beautiful", "ilgas": "long",
    "trumpas": "short", "aukštas": "tall", "greitas": "fast", "lėtas": "slow",
    "letas": "slow", "karštas": "hot", "karstas": "hot", "šaltas": "cold",
    "saltas": "cold", "laimingas": "happy", "liūdnas": "sad", "lengvas": "easy",
    "sunkus": "hard", "svarbus": "important", "tikras": "real", "pilnas": "full",
    "tuščias": "empty", "švarus": "clean", "stiprus": "strong", "silpnas": "weak",
    "baltas": "white", "juodas": "black", "raudonas": "red", "mėlynas": "blue",
    "žalias": "green", "geltonas": "yellow",

    // Connectors & common words
    "ir": "and", "bet": "but", "arba": "or", "nes": "because", "jei": "if",
    "jeigu": "if", "kad": "that", "su": "with", "be": "without", "į": "into",
    "i": "into", "iš": "from", "is": "from", "ant": "on", "po": "after",
    "prie": "near", "už": "behind", "uz": "behind", "per": "through",
    "apie": "about", "tarp": "between", "labai": "very", "daug": "many",
    "mažai": "few", "visi": "all", "viskas": "everything", "niekas": "nothing",
    "kažkas": "something", "vėl": "again", "vel": "again", "jau": "already",
    "dar": "still", "tik": "only", "gal": "maybe", "tikrai": "really",
    "čia": "here", "cia": "here", "ten": "there",

    // Misc nouns
    "knyga": "book", "knygą": "book", "žodis": "word", "zodis": "word",
    "vardas": "name", "pinigai": "money", "klausimas": "question",
    "atsakymas": "answer", "problema": "problem", "istorija": "story",
    "gyvenimas": "life", "meilė": "love", "meile": "love", "laimė": "happiness",
    "muzika": "music", "menas": "art", "mokslas": "science", "sveikata": "health",
    "lietuva": "Lithuania", "lietuvių": "Lithuanian", "lietuviškai": "in Lithuanian"
};

// --- Furigana styling (injected so no separate stylesheet file is needed) ---
const FURIGANA_CSS = `
ruby.lithuanify-ruby {
    ruby-position: over;
    ruby-align: center;
    margin: 0 0.12em;
}
ruby.lithuanify-ruby > rt {
    /* Scale with the text, but never shrink below a readable floor. */
    font-size: max(0.78em, 12px);
    line-height: 1.25;
    color: #1559c4;
    font-weight: 600;
    font-family: system-ui, -apple-system, sans-serif;
    letter-spacing: 0.01em;
    user-select: none;
    padding-bottom: 1px;
}
@media (prefers-color-scheme: dark) {
    ruby.lithuanify-ruby > rt { color: #9cc1ff; }
}`;

function injectStyles() {
    if (document.getElementById("lithuanify-style")) return;
    const style = document.createElement("style");
    style.id = "lithuanify-style";
    style.textContent = FURIGANA_CSS;
    (document.head || document.documentElement).appendChild(style);
}

// --- Configuration ----------------------------------------------------------
const SKIPPED_TAGS = new Set([
    "SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "INPUT", "SELECT",
    "OPTION", "CODE", "PRE", "KBD", "SAMP", "RUBY"
]);
const ANNOTATION_CLASS = "lithuanify-ruby";
const WORD_RE = /[\p{L}]+/u;
const TOKEN_RE = /[\p{L}]+|[^\p{L}]+/gu;

let enabled = true;          // master on/off
let smartEnabled = true;     // use on-device AI glosses when available
let modelAvailable = false;  // on-device model usable on this device
let pageIsLithuanian = false;

// Cloud results: lowercased word -> translation string ("" means "none").
const cloudCache = new Map();
const requested = new Set();  // words already sent to background this session

// On-device AI glosses: text block -> Map(lowercased word -> contextual meaning).
const glossMaps = new Map();

function isWordToken(token) {
    return WORD_RE.test(token);
}

// Fold Lithuanian diacritics so a gloss the model returns without accents (or
// vice-versa) still matches the word on the page.
const DIACRITIC_MAP = {
    "ą": "a", "č": "c", "ę": "e", "ė": "e", "į": "i",
    "š": "s", "ų": "u", "ū": "u", "ž": "z"
};
function fold(word) {
    return word.toLowerCase().replace(/[ąčęėįšųūž]/g, (c) => DIACRITIC_MAP[c]);
}

// Context-aware AI gloss first (if provided), then dictionary, then cloud cache.
// Each source is tried with the exact word and the diacritic-folded form.
function lookup(word, glossMap) {
    const lower = word.toLowerCase();
    const folded = fold(lower);
    if (glossMap) {
        if (glossMap.has(lower)) return glossMap.get(lower) || null;
        if (glossMap.has(folded)) return glossMap.get(folded) || null;
    }
    if (Object.prototype.hasOwnProperty.call(DICTIONARY, lower)) return DICTIONARY[lower];
    if (Object.prototype.hasOwnProperty.call(DICTIONARY, folded)) return DICTIONARY[folded];
    if (cloudCache.has(lower)) return cloudCache.get(lower) || null;
    if (cloudCache.has(folded)) return cloudCache.get(folded) || null;
    return null;
}

// Build replacement nodes for a single text node, or null if nothing matched.
// `glossMap` (optional) supplies context-aware meanings for this text block.
function buildReplacement(text, glossMap) {
    const tokens = text.match(TOKEN_RE);
    if (!tokens) return null;

    let matched = false;
    const nodes = [];

    for (const token of tokens) {
        const translation = isWordToken(token) ? lookup(token, glossMap) : null;
        if (translation) {
            matched = true;
            const ruby = document.createElement("ruby");
            ruby.className = ANNOTATION_CLASS;
            ruby.appendChild(document.createTextNode(token));
            const rt = document.createElement("rt");
            rt.textContent = translation;
            ruby.appendChild(rt);
            nodes.push(ruby);
        } else {
            nodes.push(document.createTextNode(token));
        }
    }

    return matched ? nodes : null;
}

// Decide whether a text node is eligible for annotation.
function isProcessable(node) {
    if (!node.nodeValue || !node.nodeValue.trim()) return false;
    const parent = node.parentElement;
    if (!parent) return false;
    if (parent.isContentEditable) return false;
    if (SKIPPED_TAGS.has(parent.tagName)) return false;
    if (parent.closest(`.${ANNOTATION_CLASS}`)) return false;
    return true;
}

// Collect eligible text nodes under an element into `out`.
function collectTextNodes(root, out) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
            return isProcessable(node)
                ? NodeFilter.FILTER_ACCEPT
                : NodeFilter.FILTER_REJECT;
        }
    });
    let current;
    while ((current = walker.nextNode())) {
        out.push(current);
    }
}

// Gather words from the given text nodes that we don't yet have a meaning for.
function collectUnknownWords(textNodes) {
    const set = new Set();
    for (const node of textNodes) {
        const tokens = node.nodeValue.match(TOKEN_RE);
        if (!tokens) continue;
        for (const token of tokens) {
            if (!isWordToken(token) || token.length < 2) continue;
            const lower = token.toLowerCase();
            if (Object.prototype.hasOwnProperty.call(DICTIONARY, lower)) continue;
            if (cloudCache.has(lower) || requested.has(lower)) continue;
            set.add(lower);
        }
    }
    return [...set];
}

// Ask the background script to translate unknown words, then store results.
async function fetchCloud(words) {
    if (!words.length) return;
    words.forEach((w) => requested.add(w));
    try {
        const result = await browser.runtime.sendMessage({ command: "translate", words });
        if (result) {
            for (const w of words) {
                cloudCache.set(w, result[w] || "");
            }
        }
    } catch (e) {
        // Mark as empty so we don't keep retrying this session.
        for (const w of words) {
            if (!cloudCache.has(w)) cloudCache.set(w, "");
        }
    }
}

// Render a single text node using the given (optional) gloss map.
function renderNode(node, glossMap) {
    if (!node.parentNode) return;
    const replacement = buildReplacement(node.nodeValue, glossMap);
    if (replacement) {
        const fragment = document.createDocumentFragment();
        replacement.forEach((n) => fragment.appendChild(n));
        node.parentNode.replaceChild(fragment, node);
    }
}

// Ask the background script for on-device AI glosses of the given text blocks.
// Returns a map: text -> array of { w, g }.
async function requestGloss(texts) {
    try {
        return await browser.runtime.sendMessage({ command: "gloss", texts }) || {};
    } catch (e) {
        return {};
    }
}

// Gloss + render a small set of text nodes (all share the work backend).
async function processNodes(nodes) {
    const live = nodes.filter((n) => n.parentNode && isProcessable(n));
    if (!live.length) return;

    // Preferred path: on-device AI with sentence context.
    if (smartEnabled && modelAvailable && pageIsLithuanian) {
        const uncached = [...new Set(live.map((n) => n.nodeValue))]
            .filter((t) => !glossMaps.has(t));
        if (uncached.length) {
            const res = await requestGloss(uncached);
            for (const text of uncached) {
                const arr = Array.isArray(res[text]) ? res[text] : [];
                const map = new Map();
                for (const item of arr) {
                    if (!item || !item.w || !item.g) continue;
                    // Key on letters only, and also store a diacritic-folded key,
                    // so matching survives punctuation/case/accent differences.
                    const key = String(item.w).toLowerCase().replace(/[^\p{L}]/gu, "");
                    if (!key) continue;
                    map.set(key, item.g);
                    const folded = fold(key);
                    if (folded !== key && !map.has(folded)) map.set(folded, item.g);
                }
                glossMaps.set(text, map);
            }
        }

        // Gap-fill: any word the model didn't gloss (and isn't in the offline
        // dictionary) is translated via the cached word endpoint, so nothing is
        // left bare.
        const gaps = new Set();
        for (const node of live) {
            const gm = glossMaps.get(node.nodeValue) || null;
            const tokens = node.nodeValue.match(TOKEN_RE) || [];
            for (const token of tokens) {
                if (!isWordToken(token) || token.length < 2) continue;
                if (lookup(token, gm)) continue;
                const lower = token.toLowerCase();
                if (requested.has(lower)) continue;
                gaps.add(lower);
            }
        }
        if (gaps.size) await fetchCloud([...gaps]);

        for (const node of live) {
            renderNode(node, glossMaps.get(node.nodeValue) || null);
        }
        return;
    }

    // Fallback path: offline dictionary, plus the cloud word endpoint.
    if (pageIsLithuanian) {
        const unknown = collectUnknownWords(live);
        if (unknown.length) await fetchCloud(unknown);
    }
    for (const node of live) {
        renderNode(node, null);
    }
}

// --- Priority-ordered scheduling with a visible-first boost ----------------
// All page text is queued up front, so the whole page eventually gets covered.
// Ordering: on-screen blocks first; then by priority (title h1 → body → nav/
// menus/footers last), then document order. An IntersectionObserver marks
// blocks visible (now or after scrolling) and re-prioritises them to the front.
// Work runs one block at a time and only while the tab is in foreground.

const pendingByElement = new Map();  // Element -> Set<TextNode> awaiting work
const itemByElement = new Map();     // Element -> queue item
const workQueue = [];                // { el, priority, seq, visible } to process
let pumping = false;
let enqueueSeq = 0;
let viewportObserver = null;

// Translation priority by where an element sits in the page:
//   0 = page title (h1), 1 = body content, 2 = navigation/side menus/footers.
function priorityFor(el) {
    if (el.closest('nav, aside, footer, menu, [role="navigation"], [role="complementary"], [role="banner"], [role="contentinfo"]')) {
        return 2;
    }
    if (el.closest('h1')) {
        return 0;
    }
    return 1;
}

// Is the element currently within (or close to) the viewport?
function isInViewport(el) {
    const r = el.getBoundingClientRect();
    if (!r.width && !r.height) return false;
    const h = window.innerHeight || document.documentElement.clientHeight;
    const w = window.innerWidth || document.documentElement.clientWidth;
    return r.bottom > 0 && r.right > 0 && r.top < h && r.left < w;
}

// Visible blocks first, then priority, then document order.
function sortQueue() {
    workQueue.sort((a, b) =>
        (a.visible === b.visible ? 0 : (a.visible ? -1 : 1)) ||
        a.priority - b.priority ||
        a.seq - b.seq);
}

function ensureViewportObserver() {
    if (viewportObserver) return;
    viewportObserver = new IntersectionObserver((entries) => {
        let changed = false;
        for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            const item = itemByElement.get(entry.target);
            if (item && !item.visible) {
                item.visible = true;
                changed = true;
            }
            viewportObserver.unobserve(entry.target);
        }
        if (changed) {
            sortQueue();
            pumpQueue();
        }
    }, { rootMargin: "100px" });
}

function enqueueElement(el) {
    const item = { el, priority: priorityFor(el), seq: enqueueSeq++, visible: isInViewport(el) };
    itemByElement.set(el, item);
    workQueue.push(item);
    viewportObserver.observe(el);
}

// Register text nodes for translation. Everything is queued immediately; the
// visible-first ordering decides what gets translated soonest.
function scheduleTextNodes(textNodes) {
    if (!textNodes.length) return;
    ensureViewportObserver();
    for (const node of textNodes) {
        const el = node.parentElement;
        if (!el) continue;
        let set = pendingByElement.get(el);
        if (!set) {
            set = new Set();
            pendingByElement.set(el, set);
            enqueueElement(el);
        }
        set.add(node);
    }
    sortQueue();
    pumpQueue();
}

// Only the visible (foreground) tab should spend the on-device model; hidden
// tabs pause and resume when shown again.
function isVisible() {
    return document.visibilityState === "visible";
}

// Process queued elements one at a time so we never fire overlapping model
// requests (and keep top-to-bottom order). Pauses while the tab is hidden.
async function pumpQueue() {
    if (pumping) return;
    pumping = true;
    try {
        while (enabled && isVisible() && workQueue.length) {
            const { el } = workQueue.shift();
            const set = pendingByElement.get(el);
            pendingByElement.delete(el);
            itemByElement.delete(el);
            if (viewportObserver) viewportObserver.unobserve(el);
            if (set) await processNodes([...set]);
        }
    } finally {
        pumping = false;
    }
}

// Resume queued work when this tab becomes the foreground tab again.
document.addEventListener("visibilitychange", () => {
    if (enabled && isVisible()) pumpQueue();
});

// Collect eligible text nodes under the given roots and schedule them lazily.
function annotateRoots(roots) {
    if (!enabled) return;
    const textNodes = [];
    for (const root of roots) {
        if (root.nodeType === Node.TEXT_NODE) {
            if (isProcessable(root)) textNodes.push(root);
        } else if (root.nodeType === Node.ELEMENT_NODE) {
            collectTextNodes(root, textNodes);
        }
    }
    scheduleTextNodes(textNodes);
}

// Remove all annotations, restoring the original text.
function removeAnnotations() {
    document.querySelectorAll(`ruby.${ANNOTATION_CLASS}`).forEach((ruby) => {
        const word = ruby.firstChild ? ruby.firstChild.textContent : "";
        ruby.replaceWith(document.createTextNode(word));
    });
}

// Heuristic: is this page (mostly) Lithuanian? Gates the cloud fallback so we
// don't fire requests on English pages.
function detectLithuanian() {
    const lang = (document.documentElement.getAttribute("lang") || "").toLowerCase();
    if (lang.startsWith("lt")) return true;

    const sample = (document.body.innerText || "").slice(0, 4000).toLowerCase();
    const words = sample.match(/[\p{L}]+/gu) || [];
    if (words.length < 5) return false;

    let hits = 0;
    for (const w of words) {
        if (/[ąčęėįšųūž]/.test(w) || Object.prototype.hasOwnProperty.call(DICTIONARY, w)) {
            hits++;
        }
    }
    return hits / words.length > 0.15;
}

// Batch dynamic mutations so cloud requests are grouped.
let observer = null;
let pending = [];
let flushScheduled = false;

function queueRoot(node) {
    pending.push(node);
    if (!flushScheduled) {
        flushScheduled = true;
        setTimeout(flushPending, 300);
    }
}

async function flushPending() {
    flushScheduled = false;
    const roots = pending;
    pending = [];
    await annotateRoots(roots);
}

function startObserver() {
    if (observer) return;
    observer = new MutationObserver((mutations) => {
        if (!enabled) return;
        for (const mutation of mutations) {
            mutation.addedNodes.forEach((added) => {
                if (added.nodeType === Node.ELEMENT_NODE ||
                    added.nodeType === Node.TEXT_NODE) {
                    queueRoot(added);
                }
            });
        }
    });
    observer.observe(document.body, { childList: true, subtree: true });
}

function stopObserver() {
    if (observer) {
        observer.disconnect();
        observer = null;
    }
}

async function enable() {
    enabled = true;
    injectStyles();
    pageIsLithuanian = detectLithuanian();
    if (smartEnabled && pageIsLithuanian) {
        try {
            const status = await browser.runtime.sendMessage({ command: "modelStatus" });
            modelAvailable = !!(status && status.available);
        } catch (e) {
            modelAvailable = false;
        }
    }
    await annotateRoots([document.body]);
    startObserver();
}

function disable() {
    enabled = false;
    stopObserver();
    if (viewportObserver) {
        viewportObserver.disconnect();
        viewportObserver = null;
    }
    pendingByElement.clear();
    itemByElement.clear();
    workQueue.length = 0;
    enqueueSeq = 0;
    removeAnnotations();
}

// Load preferences (both default to on) and start.
async function init() {
    try {
        const result = await browser.storage.local.get(["enabled", "smart"]);
        enabled = result.enabled !== false;
        smartEnabled = result.smart !== false;
    } catch (e) {
        enabled = true;
        smartEnabled = true;
    }
    if (enabled) await enable();
}

// Popup commands.
browser.runtime.onMessage.addListener((request) => {
    if (!request) return;
    if (request.command === "toggle") {
        if (request.enabled) {
            enable();
        } else {
            disable();
        }
        return Promise.resolve({ enabled });
    }
    if (request.command === "setSmart") {
        smartEnabled = request.enabled;
        // Re-scan from scratch so the new translation source is applied.
        if (enabled) {
            disable();
            glossMaps.clear();
            enable();
        }
        return Promise.resolve({ smart: smartEnabled });
    }
    if (request.command === "status") {
        return Promise.resolve({ enabled, smart: smartEnabled, modelAvailable });
    }
});

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
} else {
    init();
}
