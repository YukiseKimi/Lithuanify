// Lithuanify content script.
// Walks the page's visible text and renders English meanings in small letters
// above recognised Lithuanian words — like Japanese furigana.
//
// Everything runs on the device, in two tiers:
//   1. The dictionary in the background page renders glosses in the first frame.
//   2. Words the dictionary doesn't know are sent (batched by viewport) to the
//      on-device model via the background script, and filled in as they arrive.

// --- Furigana styling (injected so no separate stylesheet file is needed) ---
const FURIGANA_CSS = `
ruby.lithuanify-ruby {
    ruby-position: over;
    ruby-align: center;
    margin: 0 0.1em;
}
ruby.lithuanify-ruby > rt {
    font-size: max(0.6em, 10px);
    line-height: 1.2;
    color: inherit;
    opacity: 0.75;
    font-weight: 500;
    font-family: system-ui, -apple-system, sans-serif;
    letter-spacing: 0;
    padding: 0 0.2em 1px;
    user-select: none;
    cursor: pointer;  /* also lets iOS Safari send a tap on it to the page's click listener */
}
@supports (color: color-mix(in srgb, red, blue)) {
    ruby.lithuanify-ruby > rt {
        color: color-mix(in srgb, currentColor 65%, #3b82f6);
        opacity: 1;
    }
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

const RENDER_BATCH = 25;
const REFINE_MAX_BLOCKS = 12;  // text blocks per on-device model request
const REFINE_MAX_WORDS = 40;   // unknown words per on-device model request

let enabled = false;         // running on this page
let smartEnabled = true;     // use on-device AI for words the dictionary doesn't know
let mode = "page";
let hideCommon = 0;          // hide the glosses of words ranked this common or more
let modelAvailable = false;  // on-device model usable on this device
let pageIsLithuanian = false;
let generation = 0;          // bumped on disable, so in-flight work is dropped

// Text nodes Lithuanify split off itself. They are never re-scanned.
let ownNodes = new WeakSet();
let contextOf = new WeakMap();
// What the word card shows for each gloss: ruby -> GlossInfo (see glossInfoFor).
let glossInfo = new WeakMap();


function isWordToken(token) {
    return WORD_RE.test(token);
}

const MEANINGS_MAX = 20000;
let meanings = new Map();

function entryFor(word) {
    return meanings.get(phraseKey(word)) || null;
}

function isHidden(word) {
    const entry = entryFor(word);
    return !!entry && entry.r > 0 && entry.r <= hideCommon;
}

function dictLookup(word) {
    const entry = entryFor(word);
    return entry ? entry.m[0] : null;
}

// The model picks among several meanings, and confirms or replaces an
// approximate one (the plain verb's meaning for a prefixed verb).
function needsPick(word) {
    const entry = entryFor(word);
    return !!entry && (entry.m.length > 1 || !!entry.approx) && aiActive();
}

const MAX_PHRASE_WORDS = 3;
const SPACE_RE = /^[^\S\n]+$/;

function phraseAt(tokens, i, n) {
    const end = i + 2 * (n - 1);
    if (end >= tokens.length) return null;
    for (let j = i; j <= end; j += 2) if (!isWordToken(tokens[j])) return null;
    for (let j = i + 1; j < end; j += 2) if (!SPACE_RE.test(tokens[j])) return null;
    return { text: tokens.slice(i, end + 1).join(""), end };
}

const phraseKey = (text) => text.toLowerCase().replace(/\s+/g, " ");

function mergePhrases(tokens) {
    const out = [];
    for (let i = 0; i < tokens.length; i++) {
        let phrase = null;
        for (let n = MAX_PHRASE_WORDS; n >= 2 && !phrase; n--) {
            const found = phraseAt(tokens, i, n);
            if (found && entryFor(phraseKey(found.text))) phrase = found;
        }
        if (phrase) {
            out.push(phrase.text);
            i = phrase.end;
        } else {
            out.push(tokens[i]);
        }
    }
    return out;
}

async function learnWords(items) {
    const words = new Set();
    const ask = (key) => {
        if (!meanings.has(key)) words.add(key);
    };
    for (const item of items) {
        for (const node of item.nodes) {
            const tokens = (node.nodeValue || "").match(TOKEN_RE) || [];
            tokens.forEach((token, i) => {
                if (!isWordToken(token)) return;
                ask(token.toLowerCase());
                for (let n = 2; n <= MAX_PHRASE_WORDS; n++) {
                    const phrase = phraseAt(tokens, i, n);
                    if (phrase) ask(phraseKey(phrase.text));
                }
            });
        }
    }
    if (!words.size) return true;
    let found;
    try {
        found = await browser.runtime.sendMessage({ command: "lookup", words: [...words] });
    } catch (e) {
        return false;
    }
    if (!found) return false;
    if (meanings.size + words.size > MEANINGS_MAX) meanings.clear();
    for (const word of words) meanings.set(word, found[word] || null);
    return true;
}

function aiActive() {
    return smartEnabled && modelAvailable;
}

// --- Rendering --------------------------------------------------------------

// The facts behind one gloss. `source` says where the gloss's meaning came
// from: the dictionary's first meaning, an approximate one (a prefixed verb
// read as its plain verb), or the on-device model.
function glossInfoFor(token, gloss, context) {
    const entry = entryFor(token);
    const fromDictionary = !!entry && entry.m[0] === gloss;
    return {
        word: token,
        lower: token.toLowerCase(),
        entry,
        context,
        source: fromDictionary ? (entry.approx ? "approximate" : "dictionary") : "model"
    };
}

function makeRuby(token, gloss, info) {
    const ruby = document.createElement("ruby");
    ruby.className = ANNOTATION_CLASS;
    ruby.appendChild(document.createTextNode(token));
    const rt = document.createElement("rt");
    rt.textContent = gloss;
    ruby.appendChild(rt);
    glossInfo.set(ruby, info);
    return ruby;
}

// A word the dictionary didn't know and the model may gloss later.
function isCandidate(token, gloss) {
    return !gloss && token.length >= 2 && isWordToken(token);
}

function isName(tokens, i) {
    const token = tokens[i];
    if (token === token.toLowerCase() || i < 2) return false;
    return !/[.!?…:]/.test(tokens[i - 1]);
}

// Replace a text node with ruby elements for the glossed tokens. Unglossed
// words get their own text node so a later gloss can replace just that word;
// other runs of text are merged. Returns those candidate parts.
function splitNode(node, tokens, glosses, picks = new Set()) {
    const fragment = document.createDocumentFragment();
    const candidates = [];
    const context = contextOf.get(node) || node.nodeValue;
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
            const ruby = makeRuby(token, gloss, glossInfoFor(token, gloss, context));
            fragment.appendChild(ruby);
            if (picks.has(token.toLowerCase())) candidates.push({ token, lower: token.toLowerCase(), el: ruby, context });
        } else if (isCandidate(token, gloss)) {
            flushRun();
            const t = document.createTextNode(token);
            ownNodes.add(t);
            fragment.appendChild(t);
            candidates.push({ token, lower: token.toLowerCase(), el: t, context });
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
    const tokens = mergePhrases(text.match(TOKEN_RE) || []);
    const hidden = tokens.map((t) => isWordToken(t) && isHidden(t));
    const glosses = tokens.map((t, i) => (isWordToken(t) && !hidden[i] ? dictLookup(t) : null));

    const unknown = [];
    const picks = new Set();
    const seen = new Set();
    tokens.forEach((t, i) => {
        const pick = glosses[i] && needsPick(t);
        if (hidden[i]) return;
        if (!pick && (!isCandidate(t, glosses[i]) || isName(tokens, i))) return;
        const lower = t.toLowerCase();
        if (pick) picks.add(lower);
        if (!seen.has(lower)) {
            seen.add(lower);
            unknown.push(lower);
        }
    });
    const hints = unknown.map((w) => (picks.has(w) ? { lemma: entryFor(w).l, options: entryFor(w).m } : null));

    const record = { node, text, context: contextOf.get(node) || text, unknown, parts: null };
    if (picks.size) record.hints = hints;
    if (glosses.some(Boolean)) {
        record.parts = splitNode(node, tokens, glosses, picks);
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
            (isWordToken(t) && !isHidden(t) ? (dictLookup(t) || glossMap[t.toLowerCase()] || null) : null));
        if (glosses.some(Boolean)) record.parts = splitNode(node, tokens, glosses);
        return;
    }
    for (const part of record.parts) {
        const gloss = glossMap[part.lower];
        if (!gloss || !part.el.parentNode) continue;
        if (part.el.nodeName === "RUBY") {
            part.el.lastChild.textContent = gloss;
            glossInfo.set(part.el, { ...glossInfo.get(part.el), source: "model" });
        } else {
            part.el.parentNode.replaceChild(
                makeRuby(part.token, gloss, { ...glossInfoFor(part.token, gloss, part.context), source: "model" }), part.el);
        }
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
//   1. Render: dictionary glosses, 25 blocks at a time, after one lookup
//      message to the background page for the batch's new words.
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
let onDemandCount = 0;
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
function scheduleTextNodes(textNodes, onDemand = false) {
    if (!textNodes.length) return;
    ensureViewportObserver();
    const demandSeq = onDemand ? -(++onDemandCount) : 0;
    for (const node of textNodes) {
        const el = node.parentElement;
        if (!el) continue;
        let item = pendingByElement.get(el);
        if (!item) {
            item = {
                el,
                priority: onDemand ? -1 : priorityFor(el),
                seq: onDemand ? demandSeq : enqueueSeq++,
                visible: onDemand || isInViewport(el),
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

async function pumpRender() {
    if (rendering) return;
    rendering = true;
    const gen = generation;
    try {
        while (enabled && isVisible() && renderQueue.length) {
            const items = renderQueue.splice(0, RENDER_BATCH);
            const learned = await learnWords(items);
            if (gen !== generation) return;
            if (!learned && items.some((item) => !item.lookupRetried)) {
                items.forEach((item) => { item.lookupRetried = true; });
                renderQueue.unshift(...items);
                await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
                if (gen !== generation) return;
                continue;
            }
            items.forEach(renderItem);
            pumpRefine();
        }
        if (!renderQueue.length) logTiming("dictionary pass done");
    } finally {
        if (gen === generation) rendering = false;
    }
}

// Take the next batch for the model: visible blocks from the front of the
// queue, staying within the size limits. Blocks off screen wait for the
// viewport observer.
function takeRefineBatch() {
    const batch = [];
    let blocks = 0;
    let words = 0;
    while (refineQueue.length) {
        const item = refineQueue[0];
        if (!item.visible) break;
        const n = item.records.length;
        const w = item.records.reduce((sum, r) => sum + r.unknown.length, 0);
        if (batch.length && (blocks + n > REFINE_MAX_BLOCKS || words + w > REFINE_MAX_WORDS)) break;
        batch.push(refineQueue.shift());
        blocks += n;
        words += w;
    }
    return batch;
}

const RETRY_DELAY_MS = 1000;
let retryTimers = new Set();

function retryLater(item) {
    const timer = setTimeout(() => {
        retryTimers.delete(timer);
        if (!aiActive()) {
            finishItem(item);
            return;
        }
        item.seq = enqueueSeq++;
        refineQueue.push(item);
        pumpRefine();
    }, RETRY_DELAY_MS);
    retryTimers.add(timer);
}

let pauseTimer = null;

function pauseRefine(ms) {
    clearTimeout(pauseTimer);
    pauseTimer = setTimeout(() => {
        pauseTimer = null;
        pumpRefine();
    }, Math.max(Number(ms) || 0, 0));
}

// Stage 2: on-device model for the words the dictionary didn't know.
async function pumpRefine() {
    if (refining || pauseTimer || !aiActive() || !refineQueue.length) return;
    refining = true;
    const gen = generation;
    try {
        while (enabled && isVisible() && aiActive() && refineQueue.length) {
            sortQueue(refineQueue);
            const batch = takeRefineBatch();
            if (!batch.length) break;
            const records = batch.flatMap((item) => item.records);
            const blocks = records.map((r) => (r.hints
                ? { text: r.context, words: r.unknown, hints: r.hints }
                : { text: r.context, words: r.unknown }));

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
            if (res && res.paused) {
                const results = Array.isArray(res.results) ? res.results : [];
                records.forEach((record, i) => {
                    if (results[i]) applyRefinement(record, results[i]);
                });
                refineQueue.unshift(...batch);
                pauseRefine(res.retryInMs);
                break;
            }
            const results = (res && Array.isArray(res.results)) ? res.results : null;
            const failed = new Set();
            records.forEach((record, i) => {
                const glosses = results ? results[i] : null;
                if (glosses) applyRefinement(record, glosses);
                else failed.add(record);
            });
            for (const item of batch) {
                const left = item.records.filter((r) => failed.has(r));
                if (left.length && !item.retried) {
                    item.retried = true;
                    item.records = left;
                    retryLater(item);
                } else {
                    finishItem(item);
                }
            }
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
    contextOf = new WeakMap();
    glossInfo = new WeakMap();
}

// --- Word card --------------------------------------------------------------
// A tap on a gloss opens a card with the word, its lemma and every meaning.
// The card lives in a shadow root on <html>: the page's CSS cannot reach it,
// and the MutationObserver on <body> does not see it.

const CARD_CSS = `
:host { all: initial; position: fixed; z-index: 2147483647; }
:host([hidden]) { display: none; }
.card {
    --bg: #ffffff; --fg: #1c1b19; --muted: #77726a; --line: #e6e1d6; --accent: #2f62c8; --foot: #f8f6f1;
    width: max-content; min-width: 180px; max-width: min(300px, calc(100vw - 16px));
    font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    color: var(--fg); background: var(--bg);
    border: 1px solid var(--line); border-radius: 10px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.16);
}
@media (prefers-color-scheme: dark) {
    .card { --bg: #26282c; --fg: #ecebe8; --muted: #a29e96; --line: #3a3d42; --accent: #8fb1ff; --foot: #2c2f34; }
}
.head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 8px; padding: 9px 12px 7px; border-bottom: 1px solid var(--line); }
.word { font-weight: 650; font-size: 15px; }
.form { color: var(--muted); }
.rank { margin-left: auto; font-size: 11px; color: var(--muted); border: 1px solid var(--line); border-radius: 999px; padding: 0 7px; }
.meanings { margin: 0; padding: 8px 12px 8px 30px; }
.meanings li.shown { font-weight: 650; color: var(--accent); }
.foot { display: flex; justify-content: space-between; gap: 12px; padding: 7px 12px; border-top: 1px solid var(--line); background: var(--foot); border-radius: 0 0 10px 10px; color: var(--muted); font-size: 11px; }
.foot:empty { display: none; }
.foot a { color: var(--accent); text-decoration: none; }`;

const CARD_GAP = 6;
const CARD_MARGIN = 8;
let cardHost = null;

function cardElement() {
    if (!cardHost) {
        cardHost = document.createElement("div");
        cardHost.id = "lithuanify-card";
        const root = cardHost.attachShadow({ mode: "open" });
        const style = document.createElement("style");
        style.textContent = CARD_CSS;
        const card = document.createElement("div");
        card.className = "card";
        root.append(style, card);
    }
    if (!cardHost.isConnected) document.documentElement.appendChild(cardHost);
    return cardHost.shadowRoot.querySelector(".card");
}

function element(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
}

// The badge for a word among the 500 or 2,000 most common (the popup's steps).
function rankLabel(entry) {
    if (!entry || !entry.r) return null;
    if (entry.r <= 500) return "Top 500";
    if (entry.r <= 2000) return "Top 2,000";
    return null;
}

// Where the meaning in the gloss came from, in the words the card shows.
function sourceLine(info, shown) {
    const entry = info.entry;
    if (info.source === "model") {
        const n = entry ? entry.m.indexOf(shown) + 1 : 0;
        return n ? `On-device AI picked meaning ${n}` : "On-device AI meaning";
    }
    if (info.source === "approximate") {
        return entry && entry.from ? `Approximate: the meaning of ${entry.from}` : "Approximate meaning";
    }
    return "Dictionary";
}

function openCard(ruby, info) {
    const shown = ruby.lastChild.textContent;
    const entry = info.entry;
    const card = cardElement();

    const head = element("div", "head");
    head.append(element("span", "word", info.word));
    if (entry && entry.l && entry.l !== info.lower) head.append(element("span", "form", `form of ${entry.l}`));
    const rank = rankLabel(entry);
    if (rank) head.append(element("span", "rank", rank));

    const meanings = entry ? [...entry.m] : [];
    if (!meanings.includes(shown)) meanings.unshift(shown);
    const list = element("ol", "meanings");
    for (const meaning of meanings) list.append(element("li", meaning === shown ? "shown" : "", meaning));

    const foot = element("div", "foot");
    foot.append(element("span", "source", sourceLine(info, shown)));

    card.replaceChildren(head, list, foot);
    cardHost.hidden = false;
    placeCard(ruby.lastChild);
    document.addEventListener("keydown", onCardKey, true);
    document.addEventListener("scroll", closeCard, true);
}

// One card at most is open. It is placed for one spot on the screen, so any
// scroll, anywhere on the page, closes it.
function closeCard() {
    document.removeEventListener("keydown", onCardKey, true);
    document.removeEventListener("scroll", closeCard, true);
    if (cardHost) cardHost.hidden = true;
}

function onCardKey(event) {
    if (event.key === "Escape") closeCard();
}

const isCardOpen = () => !!cardHost && cardHost.isConnected && !cardHost.hidden;

// Below the gloss, or above it when there is no room below; always on screen.
function placeCard(anchor) {
    const at = anchor.getBoundingClientRect();
    const box = cardHost.shadowRoot.querySelector(".card").getBoundingClientRect();
    const width = window.innerWidth || document.documentElement.clientWidth;
    const height = window.innerHeight || document.documentElement.clientHeight;
    const left = Math.max(CARD_MARGIN, Math.min(at.left, width - box.width - CARD_MARGIN));
    let top = at.bottom + CARD_GAP;
    if (top + box.height > height - CARD_MARGIN && at.top - CARD_GAP - box.height >= CARD_MARGIN) {
        top = at.top - CARD_GAP - box.height;
    }
    cardHost.style.left = `${Math.round(left)}px`;
    cardHost.style.top = `${Math.round(top)}px`;
}

function onGlossTap(event) {
    const rt = event.target instanceof Element ? event.target.closest(`ruby.${ANNOTATION_CLASS} > rt`) : null;
    const info = rt && glossInfo.get(rt.parentElement);
    if (!info) {
        // A tap anywhere but on the card or a gloss closes the card.
        if (isCardOpen() && !event.composedPath().includes(cardHost)) closeCard();
        return;
    }
    // The gloss opens its card; a gloss inside a link does not follow the link.
    event.preventDefault();
    event.stopPropagation();
    openCard(rt.parentElement, info);
}

// Heuristic: is this page (mostly) Lithuanian? Non-Lithuanian pages are left
// alone, so English words like "is" or "be" aren't glossed.
const COMMON_WORDS = new Set([
    "ir", "kad", "yra", "su", "iš", "ne", "tai", "bet", "kaip", "jo", "jis", "ji", "buvo",
    "tik", "dar", "nuo", "per", "apie", "kur", "labai", "taip", "jau", "mes", "jie", "arba", "bei"
]);

// Below this many words a page that doesn't look Lithuanian may still be
// loading its text, so the answer is "unsure" rather than "other".
const DETECT_MIN_WORDS = 40;
const REDETECT_DELAY_MS = 500;

// "lt", "other", or "unsure" (too little text yet to tell).
function detectLanguage() {
    const lang = (document.documentElement.getAttribute("lang") || "").toLowerCase();
    if (lang.startsWith("lt")) return "lt";

    const sample = ((document.body && document.body.innerText) || "").slice(0, 4000).toLowerCase();
    const words = sample.match(/[\p{L}]+/gu) || [];
    if (words.length < 5) return "unsure";

    let hits = 0;
    for (const w of words) {
        if (/[ąčęėįšųūž]/.test(w) || COMMON_WORDS.has(w)) {
            hits++;
        }
    }
    if (hits / words.length > 0.15) return "lt";
    return words.length < DETECT_MIN_WORDS ? "unsure" : "other";
}

// While the language is unsure, look again each time the page settles after
// a change, until it is decided either way.
let languageWatcher = null;
let redetectTimer = null;

function watchLanguage() {
    if (languageWatcher || !document.documentElement) return;
    languageWatcher = new MutationObserver(() => {
        clearTimeout(redetectTimer);
        redetectTimer = setTimeout(redetect, REDETECT_DELAY_MS);
    });
    languageWatcher.observe(document.documentElement, {
        childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["lang"]
    });
}

function stopWatchingLanguage() {
    clearTimeout(redetectTimer);
    redetectTimer = null;
    if (languageWatcher) {
        languageWatcher.disconnect();
        languageWatcher = null;
    }
}

function redetect() {
    const verdict = detectLanguage();
    if (verdict === "unsure") return;
    stopWatchingLanguage();
    if (verdict === "lt" && enabled && !pageIsLithuanian) {
        pageIsLithuanian = true;
        start();
    }
}

const HOVER_DELAY_MS = 300;
const SELECT_DELAY_MS = 500;
let displayOf = new WeakMap();
let hoverTimer = null;
let selectTimer = null;
let pointerDown = false;

function isInlineDisplay(el) {
    let display = displayOf.get(el);
    if (display === undefined) {
        display = getComputedStyle(el).display;
        displayOf.set(el, display);
    }
    return display === "inline" || display === "contents" || display.startsWith("ruby");
}

function blockFor(node) {
    let el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    while (el && el !== document.body && el !== document.documentElement) {
        if (!isInlineDisplay(el)) return el;
        el = el.parentElement;
    }
    return null;
}

function glossBlock(block) {
    if (!enabled || !block) return;
    const nodes = [];
    collectTextNodes(block, nodes);
    scheduleTextNodes(nodes.filter((n) => blockFor(n) === block), true);
}

function onMouseOver(event) {
    clearTimeout(hoverTimer);
    const target = event.target;
    hoverTimer = setTimeout(() => glossBlock(blockFor(target)), HOVER_DELAY_MS);
}

function onMouseOut(event) {
    if (!event.relatedTarget) clearTimeout(hoverTimer);
}

const isLetter = (ch) => WORD_RE.test(ch);

function cutSelected(node, range) {
    const text = node.nodeValue;
    let start = node === range.startContainer ? range.startOffset : 0;
    let end = node === range.endContainer ? range.endOffset : text.length;
    while (start > 0 && isLetter(text[start - 1]) && isLetter(text[start])) start--;
    while (end < text.length && end > 0 && isLetter(text[end - 1]) && isLetter(text[end])) end++;
    if (!WORD_RE.test(text.slice(start, end))) return null;

    const context = contextOf.get(node) || text;
    const piece = start > 0 ? node.splitText(start) : node;
    if (end - start < piece.nodeValue.length) piece.splitText(end - start);
    contextOf.set(piece, context);
    return piece;
}

function glossSelection() {
    const sel = document.getSelection();
    if (!enabled || !sel || sel.isCollapsed) return;
    const pieces = [];
    for (let i = 0; i < sel.rangeCount; i++) {
        const range = sel.getRangeAt(i);
        const root = range.commonAncestorContainer;
        const nodes = [];
        if (root.nodeType === Node.TEXT_NODE) {
            if (isProcessable(root)) nodes.push(root);
        } else {
            collectTextNodes(root, nodes);
        }
        for (const n of nodes) {
            if (!range.intersectsNode(n)) continue;
            const piece = cutSelected(n, range);
            if (piece) pieces.push(piece);
        }
    }
    scheduleTextNodes(pieces, true);
}

function onPointerDown() {
    pointerDown = true;
    clearTimeout(selectTimer);
}

function onPointerUp() {
    pointerDown = false;
    clearTimeout(selectTimer);
    selectTimer = setTimeout(glossSelection, 50);
}

function onSelectionChange() {
    if (pointerDown) return;
    clearTimeout(selectTimer);
    selectTimer = setTimeout(glossSelection, SELECT_DELAY_MS);
}

function startOnDemand() {
    if (mode === "hover") {
        document.addEventListener("mouseover", onMouseOver, true);
        document.addEventListener("mouseout", onMouseOut, true);
    } else if (mode === "select") {
        document.addEventListener("mousedown", onPointerDown, true);
        document.addEventListener("mouseup", onPointerUp, true);
        document.addEventListener("selectionchange", onSelectionChange);
    }
}

function stopOnDemand() {
    clearTimeout(hoverTimer);
    clearTimeout(selectTimer);
    pointerDown = false;
    document.removeEventListener("mouseover", onMouseOver, true);
    document.removeEventListener("mouseout", onMouseOut, true);
    document.removeEventListener("mousedown", onPointerDown, true);
    document.removeEventListener("mouseup", onPointerUp, true);
    document.removeEventListener("selectionchange", onSelectionChange);
    displayOf = new WeakMap();
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
    const verdict = detectLanguage();
    pageIsLithuanian = verdict === "lt";
    // Selected text is glossed on any page; the other modes wait for Lithuanian.
    if (!pageIsLithuanian && mode !== "select") {
        if (verdict === "unsure") watchLanguage();
        return;
    }
    await start();
}

async function start() {
    injectStyles();
    document.addEventListener("click", onGlossTap, true);
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
    if (mode === "page") {
        annotateRoots([document.body]);
        startObserver();
    } else {
        startOnDemand();
    }
}

function disable() {
    enabled = false;
    generation++;
    rendering = false;
    refining = false;
    stopWatchingLanguage();
    stopObserver();
    stopOnDemand();
    document.removeEventListener("click", onGlossTap, true);
    closeCard();
    if (viewportObserver) {
        viewportObserver.disconnect();
        viewportObserver = null;
    }
    pending = [];
    pendingByElement.clear();
    itemsByElement.clear();
    renderQueue.length = 0;
    refineQueue.length = 0;
    retryTimers.forEach(clearTimeout);
    retryTimers.clear();
    clearTimeout(pauseTimer);
    pauseTimer = null;
    enqueueSeq = 0;
    removeAnnotations();
}

// --- Settings ---------------------------------------------------------------
// The popup writes the settings to storage.local; every open tab follows them.

const SETTING_KEYS = ["enabled", "smart", "mode", "hideCommon"];
const MODES = ["page", "hover", "select"];

function settingsFrom(stored) {
    return {
        enabled: stored.enabled !== false,
        smart: stored.smart !== false,
        mode: MODES.includes(stored.mode) ? stored.mode : "page",
        hideCommon: Number(stored.hideCommon) || 0
    };
}

async function readSettings() {
    try {
        return settingsFrom(await browser.storage.local.get(SETTING_KEYS));
    } catch (e) {
        return settingsFrom({});
    }
}

async function applySettings(next) {
    const changed = next.smart !== smartEnabled || next.mode !== mode || next.hideCommon !== hideCommon;
    smartEnabled = next.smart;
    mode = next.mode;
    hideCommon = next.hideCommon;
    // A changed setting re-scans from scratch so it applies to the whole page.
    if (enabled && (!next.enabled || changed)) disable();
    if (next.enabled && !enabled) await enable();
}

browser.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !SETTING_KEYS.some((key) => key in changes)) return;
    readSettings().then(applySettings);
});

async function init() {
    await applySettings(await readSettings());
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
} else {
    init();
}
