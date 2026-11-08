// Lithuanify content script.
// Walks the page's visible text and renders English meanings in small letters
// above recognised Lithuanian words — like Japanese furigana.
//
// Everything runs on the device, in two tiers:
//   1. A bundled offline dictionary renders glosses instantly, in the first frame.
//   2. Words the dictionary doesn't know are sent (batched by viewport) to the
//      on-device model via the background script, and filled in as they arrive.

// --- Offline dictionary -----------------------------------------------------
// Keys are lowercase Lithuanian words (accented and plain variants are both
// listed). This is the instant tier; the on-device model fills in the rest.
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

const RENDER_BUDGET_MS = 8;    // dictionary rendering per frame, so the page stays responsive
const REFINE_MAX_BLOCKS = 12;  // text blocks per on-device model request
const REFINE_MAX_WORDS = 40;   // unknown words per on-device model request

let enabled = true;          // master on/off
let smartEnabled = true;     // use on-device AI for words the dictionary doesn't know
let modelAvailable = false;  // on-device model usable on this device
let pageIsLithuanian = false;
let generation = 0;          // bumped on disable, so in-flight work is dropped

// Text nodes Lithuanify split off itself. They are never re-scanned.
let ownNodes = new WeakSet();

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

function isWordToken(token) {
    return WORD_RE.test(token);
}

// Fold Lithuanian diacritics so a word written without accents (or vice
// versa) still matches the dictionary.
const DIACRITIC_MAP = {
    "ą": "a", "č": "c", "ę": "e", "ė": "e", "į": "i",
    "š": "s", "ų": "u", "ū": "u", "ž": "z"
};
function fold(word) {
    return word.toLowerCase().replace(/[ąčęėįšųūž]/g, (c) => DIACRITIC_MAP[c]);
}

function dictLookup(word) {
    const lower = word.toLowerCase();
    if (hasOwn(DICTIONARY, lower)) return DICTIONARY[lower];
    const folded = fold(lower);
    if (hasOwn(DICTIONARY, folded)) return DICTIONARY[folded];
    return null;
}

function aiActive() {
    return smartEnabled && modelAvailable;
}

// --- Rendering --------------------------------------------------------------

function makeRuby(token, gloss) {
    const ruby = document.createElement("ruby");
    ruby.className = ANNOTATION_CLASS;
    ruby.appendChild(document.createTextNode(token));
    const rt = document.createElement("rt");
    rt.textContent = gloss;
    ruby.appendChild(rt);
    return ruby;
}

// A word the dictionary didn't know and the model may gloss later.
function isCandidate(token, gloss) {
    return !gloss && token.length >= 2 && isWordToken(token);
}

// Replace a text node with ruby elements for the glossed tokens. Unglossed
// words get their own text node so a later gloss can replace just that word;
// other runs of text are merged. Returns those candidate parts.
function splitNode(node, tokens, glosses) {
    const fragment = document.createDocumentFragment();
    const candidates = [];
    let run = "";
    const flushRun = () => {
        if (!run) return;
        const t = document.createTextNode(run);
        ownNodes.add(t);
        fragment.appendChild(t);
        run = "";
    };
    tokens.forEach((token, i) => {
        const gloss = glosses[i];
        if (gloss) {
            flushRun();
            fragment.appendChild(makeRuby(token, gloss));
        } else if (isCandidate(token, gloss)) {
            flushRun();
            const t = document.createTextNode(token);
            ownNodes.add(t);
            fragment.appendChild(t);
            candidates.push({ token, lower: token.toLowerCase(), el: t });
        } else {
            run += token;
        }
    });
    flushRun();
    node.parentNode.replaceChild(fragment, node);
    return candidates;
}

// Render one text node from the dictionary, immediately. Returns a record
// for the AI pass: `unknown` lists the words still missing a gloss, and
// `parts` is null when nothing matched (the original node is left as is).
function renderBlock(node) {
    const text = node.nodeValue;
    const tokens = text.match(TOKEN_RE) || [];
    const glosses = tokens.map((t) => (isWordToken(t) ? dictLookup(t) : null));

    const unknown = [];
    const seen = new Set();
    tokens.forEach((t, i) => {
        if (!isCandidate(t, glosses[i])) return;
        const lower = t.toLowerCase();
        if (!seen.has(lower)) {
            seen.add(lower);
            unknown.push(lower);
        }
    });

    const record = { node, text, unknown, parts: null };
    if (glosses.some(Boolean)) {
        record.parts = splitNode(node, tokens, glosses);
    } else {
        ownNodes.add(node);  // done with it; don't re-scan on later mutations
    }
    return record;
}

// Apply model glosses ({ lowercased word: gloss }) to an already-rendered block.
function applyRefinement(record, glossMap) {
    if (!record.parts) {
        const node = record.node;
        if (!node.parentNode || node.nodeValue !== record.text) return;
        const tokens = record.text.match(TOKEN_RE) || [];
        const glosses = tokens.map((t) =>
            (isWordToken(t) ? (dictLookup(t) || glossMap[t.toLowerCase()] || null) : null));
        if (glosses.some(Boolean)) record.parts = splitNode(node, tokens, glosses);
        return;
    }
    for (const part of record.parts) {
        const gloss = glossMap[part.lower];
        if (!gloss || !part.el.parentNode) continue;
        part.el.parentNode.replaceChild(makeRuby(part.token, gloss), part.el);
    }
}

// Decide whether a text node is eligible for annotation.
function isProcessable(node) {
    if (!node.nodeValue || !node.nodeValue.trim()) return false;
    if (ownNodes.has(node)) return false;
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

// --- Timing (shown in the Web Inspector console) ----------------------------

let t0 = 0;
const timingLogged = new Set();
function logTiming(label) {
    if (timingLogged.has(label)) return;
    timingLogged.add(label);
    console.debug(`[Lithuanify] ${label}: ${Math.round(performance.now() - t0)} ms`);
}

// --- Scheduling -------------------------------------------------------------
// Two stages, both ordered visible-first, then by priority (title h1 → body →
// nav/menus/footers last), then document order:
//   1. Render: dictionary glosses, a few milliseconds per frame. Fast, so the
//      whole page is covered quickly.
//   2. Refine: words the dictionary didn't know go to the on-device model,
//      several blocks per request. One request at a time.
// Work runs only while the tab is in the foreground.

const pendingByElement = new Map();  // Element -> item still collecting text nodes
const itemsByElement = new Map();    // Element -> Set of unfinished items
const renderQueue = [];
const refineQueue = [];
let rendering = false;
let refining = false;
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

function sortQueue(queue) {
    queue.sort((a, b) =>
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
            const items = itemsByElement.get(entry.target);
            if (items) {
                for (const item of items) {
                    if (!item.visible) {
                        item.visible = true;
                        changed = true;
                    }
                }
            }
            viewportObserver.unobserve(entry.target);
        }
        if (changed) {
            sortQueue(renderQueue);
            pumpRender();
            pumpRefine();
        }
    }, { rootMargin: "100px" });
}

function trackItem(item) {
    let set = itemsByElement.get(item.el);
    if (!set) {
        set = new Set();
        itemsByElement.set(item.el, set);
        viewportObserver.observe(item.el);
    }
    set.add(item);
}

function finishItem(item) {
    item.records = null;
    const set = itemsByElement.get(item.el);
    if (!set) return;
    set.delete(item);
    if (!set.size) {
        itemsByElement.delete(item.el);
        if (viewportObserver) viewportObserver.unobserve(item.el);
    }
}

// Register text nodes. Everything is queued immediately; the visible-first
// ordering decides what is done soonest.
function scheduleTextNodes(textNodes) {
    if (!textNodes.length) return;
    ensureViewportObserver();
    for (const node of textNodes) {
        const el = node.parentElement;
        if (!el) continue;
        let item = pendingByElement.get(el);
        if (!item) {
            item = {
                el,
                priority: priorityFor(el),
                seq: enqueueSeq++,
                visible: isInViewport(el),
                nodes: new Set(),
                records: null
            };
            pendingByElement.set(el, item);
            renderQueue.push(item);
            trackItem(item);
        }
        item.nodes.add(node);
    }
    sortQueue(renderQueue);
    pumpRender();
}

// Only the visible (foreground) tab does work; hidden tabs pause and resume
// when shown again.
function isVisible() {
    return document.visibilityState === "visible";
}

function renderItem(item) {
    if (pendingByElement.get(item.el) === item) pendingByElement.delete(item.el);
    const records = [];
    for (const node of item.nodes) {
        if (!node.parentNode || !isProcessable(node)) continue;
        const record = renderBlock(node);
        if (record.parts) logTiming("first gloss");
        if (record.unknown.length) records.push(record);
    }
    if (records.length && aiActive()) {
        item.records = records;
        refineQueue.push(item);
    } else {
        finishItem(item);
    }
}

// Stage 1: dictionary render, in small time slices.
function pumpRender() {
    if (rendering) return;
    rendering = true;
    const gen = generation;
    const step = () => {
        if (gen !== generation) return;  // disabled meanwhile; flags were reset
        if (!enabled || !isVisible()) {
            rendering = false;
            return;
        }
        const start = performance.now();
        while (renderQueue.length && performance.now() - start < RENDER_BUDGET_MS) {
            renderItem(renderQueue.shift());
        }
        pumpRefine();
        if (renderQueue.length) {
            setTimeout(step, 0);
        } else {
            rendering = false;
            logTiming("dictionary pass done");
        }
    };
    step();
}

// Take the next batch for the model: from the front of the queue, staying
// within the size limits. A visible batch holds only visible blocks.
function takeRefineBatch() {
    const batch = [];
    let blocks = 0;
    let words = 0;
    const visibleOnly = refineQueue[0].visible;
    while (refineQueue.length) {
        const item = refineQueue[0];
        if (visibleOnly && !item.visible) break;
        const n = item.records.length;
        const w = item.records.reduce((sum, r) => sum + r.unknown.length, 0);
        if (batch.length && (blocks + n > REFINE_MAX_BLOCKS || words + w > REFINE_MAX_WORDS)) break;
        batch.push(refineQueue.shift());
        blocks += n;
        words += w;
    }
    return batch;
}

// Stage 2: on-device model for the words the dictionary didn't know.
async function pumpRefine() {
    if (refining || !aiActive() || !refineQueue.length) return;
    refining = true;
    const gen = generation;
    try {
        while (enabled && isVisible() && aiActive() && refineQueue.length) {
            sortQueue(refineQueue);
            const batch = takeRefineBatch();
            const records = batch.flatMap((item) => item.records);
            const blocks = records.map((r) => ({ text: r.text, words: r.unknown }));

            let res = null;
            try {
                res = await browser.runtime.sendMessage({ command: "gloss", blocks });
            } catch (e) {
                res = null;
            }
            if (gen !== generation) return;  // disabled meanwhile

            if (res && res.available === false) {
                modelAvailable = false;
                batch.forEach(finishItem);
                refineQueue.splice(0).forEach(finishItem);
                break;
            }
            const results = (res && Array.isArray(res.results)) ? res.results : [];
            records.forEach((record, i) => {
                if (results[i]) applyRefinement(record, results[i]);
            });
            batch.forEach(finishItem);
            logTiming("first AI gloss");
        }
        if (!refineQueue.length && !renderQueue.length) logTiming("AI pass done");
    } finally {
        if (gen === generation) refining = false;
    }
}

// Resume queued work when this tab becomes the foreground tab again.
document.addEventListener("visibilitychange", () => {
    if (enabled && isVisible()) {
        pumpRender();
        pumpRefine();
    }
});

// Collect eligible text nodes under the given roots and schedule them.
function annotateRoots(roots) {
    if (!enabled || !pageIsLithuanian) return;
    const textNodes = [];
    for (const root of roots) {
        if (!root.isConnected) continue;
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
    const parents = new Set();
    document.querySelectorAll(`ruby.${ANNOTATION_CLASS}`).forEach((ruby) => {
        const word = ruby.firstChild ? ruby.firstChild.textContent : "";
        if (ruby.parentNode) parents.add(ruby.parentNode);
        ruby.replaceWith(document.createTextNode(word));
    });
    // Merge the split-up text nodes back together.
    parents.forEach((p) => p.normalize());
    ownNodes = new WeakSet();
}

// Heuristic: is this page (mostly) Lithuanian? Non-Lithuanian pages are left
// alone, so English words like "is" or "be" aren't glossed.
function detectLithuanian() {
    const lang = (document.documentElement.getAttribute("lang") || "").toLowerCase();
    if (lang.startsWith("lt")) return true;

    const sample = ((document.body && document.body.innerText) || "").slice(0, 4000).toLowerCase();
    const words = sample.match(/[\p{L}]+/gu) || [];
    if (words.length < 5) return false;

    let hits = 0;
    for (const w of words) {
        if (/[ąčęėįšųūž]/.test(w) || hasOwn(DICTIONARY, w)) {
            hits++;
        }
    }
    return hits / words.length > 0.15;
}

// Batch dynamic mutations.
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

function flushPending() {
    flushScheduled = false;
    const roots = pending;
    pending = [];
    annotateRoots(roots);
}

function startObserver() {
    if (observer) return;
    observer = new MutationObserver((mutations) => {
        if (!enabled) return;
        for (const mutation of mutations) {
            mutation.addedNodes.forEach((added) => {
                if (added.nodeType === Node.TEXT_NODE) {
                    if (!ownNodes.has(added)) queueRoot(added);
                } else if (added.nodeType === Node.ELEMENT_NODE) {
                    if (!added.classList.contains(ANNOTATION_CLASS)) queueRoot(added);
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
    t0 = performance.now();
    timingLogged.clear();
    pageIsLithuanian = detectLithuanian();
    if (!pageIsLithuanian) return;

    injectStyles();
    const gen = generation;
    if (smartEnabled) {
        try {
            const status = await browser.runtime.sendMessage({ command: "modelStatus" });
            modelAvailable = !!(status && status.available);
        } catch (e) {
            modelAvailable = false;
        }
    }
    if (gen !== generation || !enabled) return;  // disabled while waiting
    annotateRoots([document.body]);
    startObserver();
}

function disable() {
    enabled = false;
    generation++;
    rendering = false;
    refining = false;
    stopObserver();
    if (viewportObserver) {
        viewportObserver.disconnect();
        viewportObserver = null;
    }
    pending = [];
    pendingByElement.clear();
    itemsByElement.clear();
    renderQueue.length = 0;
    refineQueue.length = 0;
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
            if (!enabled) enable();
        } else {
            disable();
        }
        return Promise.resolve({ enabled });
    }
    if (request.command === "setSmart") {
        smartEnabled = request.enabled;
        // Re-scan from scratch so the new setting is applied.
        if (enabled) {
            disable();
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
