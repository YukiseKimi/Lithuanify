// The Saved words page: every word saved from a word card, newest first.
// Each saved word is one storage.local key, "saved:<lemma>" (see content.js).

const SAVED_PREFIX = "saved:";

const list = document.getElementById("list");
const count = document.getElementById("count");
const empty = document.getElementById("empty");
const find = document.getElementById("find");

// Lowercase, without diacritics, as the dictionary matches: "sali" finds šalis.
const fold = (text) => String(text).toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");

function matches(saved, query) {
    const q = fold(query.trim());
    return !q || [saved.lemma || saved.word, ...(saved.meanings || []), saved.shown].some((t) => fold(t).includes(q));
}

let words = [];  // [{ key, word, lemma, meanings, shown, sentence, savedAt }], newest first

async function readSaved() {
    const stored = await browser.storage.local.get(null);
    return Object.entries(stored)
        .filter(([key, value]) => key.startsWith(SAVED_PREFIX) && value)
        .map(([key, value]) => ({ key, ...value }))
        .sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
}

function element(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
}

function row(saved) {
    const li = element("li");
    const head = element("div", "head");
    head.append(element("span", "lemma", saved.lemma || saved.word), element("span", "meaning", saved.shown));
    const remove = element("button", "remove", "×");
    remove.type = "button";
    remove.setAttribute("aria-label", `Remove ${saved.lemma || saved.word}`);
    // storage.onChanged then redraws this page and every open word card.
    remove.addEventListener("click", () => browser.storage.local.remove(saved.key));
    li.append(head, remove, element("p", "sentence", saved.sentence));
    return li;
}

function render() {
    list.replaceChildren(...words.filter((saved) => matches(saved, find.value)).map(row));
    count.textContent = String(words.length);
    empty.hidden = words.length > 0;
}

find.addEventListener("input", render);

async function refresh() {
    words = await readSaved();
    render();
}

// A save or a removal on a page, in any tab, shows here at once.
browser.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && Object.keys(changes).some((key) => key.startsWith(SAVED_PREFIX))) refresh();
});

refresh();
