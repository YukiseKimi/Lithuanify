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

let enabled = true;          // master on/off
let smartEnabled = true;     // use on-device AI for words the dictionary doesn't know
let mode = "page";
let modelAvailable = false;  // on-device model usable on this device
let pageIsLithuanian = false;
let generation = 0;          // bumped on disable, so in-flight work is dropped

// Text nodes Lithuanify split off itself. They are never re-scanned.
let ownNodes = new WeakSet();
let contextOf = new WeakMap();


function isWordToken(token) {
    return WORD_RE.test(token);
}

let meanings = new Map();

function dictLookup(word) {
    return meanings.get(word.toLowerCase()) || null;
}

async function learnWords(items) {
    const words = new Set();
    for (const item of items) {
        for (const node of item.nodes) {
            for (const token of (node.nodeValue || "").match(TOKEN_RE) || []) {
                const lower = token.toLowerCase();
                if (isWordToken(token) && !meanings.has(lower)) words.add(lower);
            }
        }
    }
    if (!words.size) return;
    let found = null;
    try {
        found = await browser.runtime.sendMessage({ command: "lookup", words: [...words] });
    } catch (e) {
        found = null;
    }
    for (const word of words) meanings.set(word, (found && found[word]) || null);
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

    const record = { node, text, context: contextOf.get(node) || text, unknown, parts: null };
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
            await learnWords(items);
            if (gen !== generation) return;
            items.forEach(renderItem);
            pumpRefine();
        }
        if (!renderQueue.length) logTiming("dictionary pass done");
    } finally {
        if (gen === generation) rendering = false;
    }
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
            const blocks = records.map((r) => ({ text: r.context, words: r.unknown }));

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
}

// Heuristic: is this page (mostly) Lithuanian? Non-Lithuanian pages are left
// alone, so English words like "is" or "be" aren't glossed.
const COMMON_WORDS = new Set([
    "ir", "kad", "yra", "su", "iš", "ne", "tai", "bet", "kaip", "jo", "jis", "ji", "buvo",
    "tik", "dar", "nuo", "per", "apie", "kur", "labai", "taip", "jau", "mes", "jie", "arba", "bei"
]);

function detectLithuanian() {
    const lang = (document.documentElement.getAttribute("lang") || "").toLowerCase();
    if (lang.startsWith("lt")) return true;

    const sample = ((document.body && document.body.innerText) || "").slice(0, 4000).toLowerCase();
    const words = sample.match(/[\p{L}]+/gu) || [];
    if (words.length < 5) return false;

    let hits = 0;
    for (const w of words) {
        if (/[ąčęėįšųūž]/.test(w) || COMMON_WORDS.has(w)) {
            hits++;
        }
    }
    return hits / words.length > 0.15;
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
    pageIsLithuanian = detectLithuanian();
    if (!pageIsLithuanian && mode !== "select") return;

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
    stopObserver();
    stopOnDemand();
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
    enqueueSeq = 0;
    removeAnnotations();
}

async function init() {
    try {
        const result = await browser.storage.local.get(["enabled", "smart", "mode"]);
        enabled = result.enabled !== false;
        smartEnabled = result.smart !== false;
        if (["page", "hover", "select"].includes(result.mode)) mode = result.mode;
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
    if (request.command === "setMode") {
        if (["page", "hover", "select"].includes(request.mode)) mode = request.mode;
        if (enabled) {
            disable();
            enable();
        }
        return Promise.resolve({ mode });
    }
    if (request.command === "status") {
        return Promise.resolve({ enabled, smart: smartEnabled, mode, modelAvailable });
    }
});

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
} else {
    init();
}
