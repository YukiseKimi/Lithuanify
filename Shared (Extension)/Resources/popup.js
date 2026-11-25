// Popup controller: reflects/toggles the on/off and on-device-AI states, and
// shows whether the on-device model is available.

const toggle = document.getElementById("toggle");
const stateLabel = document.getElementById("state-label");
const smart = document.getElementById("smart");
const modelStatus = document.getElementById("model-status");
const mode = document.getElementById("mode");
const hideCommon = document.getElementById("hide-common");
const google = document.getElementById("google");
const googleDetails = document.getElementById("google-details");
const googleKey = document.getElementById("google-key");
const googleNeedsAi = document.getElementById("google-needs-ai");
const googleOffline = document.getElementById("google-offline");
const googleOfflineNote = document.getElementById("google-offline-note");
let modelReady = null;  // the on-device model's availability, once the background answers

const t = (key, fallback) => browser.i18n.getMessage(key) || fallback;

document.querySelectorAll("[data-i18n]").forEach((el) => {
    el.textContent = t(el.dataset.i18n, el.textContent);
});

function renderEnabled(enabled) {
    toggle.checked = enabled;
    stateLabel.textContent = enabled ? t("popup_on", "On") : t("popup_off", "Off");
    smart.disabled = !enabled;
    mode.disabled = !enabled;
    hideCommon.disabled = !enabled;
    renderGoogle();
}

// Google Translate only gives the on-device AI an English sentence to read,
// so it works only while that AI is on and available. Otherwise its switch
// is greyed out and says why; its own setting stays as the reader left it.
function renderGoogle() {
    const aiOn = smart.checked && modelReady !== false;
    google.disabled = !toggle.checked || !aiOn;
    googleNeedsAi.hidden = aiOn;
    googleDetails.hidden = !(google.checked && aiOn);
    googleOfflineNote.hidden = navigator.onLine;
}

// Google Translate needs the internet. Offline (navigator.onLine is false
// only when there is surely no connection), turning it on says so; the
// setting is still kept, and the note under the key stays while offline.
window.addEventListener("online", renderGoogle);
window.addEventListener("offline", renderGoogle);

browser.storage.local.get(["enabled", "smart", "mode", "hideCommon", "google", "googleKey"]).then((result) => {
    google.checked = result.google === true;
    googleKey.value = typeof result.googleKey === "string" ? result.googleKey : "";
    smart.checked = result.smart !== false;
    renderEnabled(result.enabled !== false);
    mode.value = result.mode || "page";
    hideCommon.value = String(Number(result.hideCommon) || 0);
});

// Show on-device model availability.
browser.runtime.sendMessage({ command: "modelStatus" }).then((res) => {
    modelReady = !!(res && res.available);
    renderGoogle();
    if (modelReady) {
        modelStatus.textContent = t("popup_ai_available", "On-device AI: available");
        modelStatus.classList.add("ok");
    } else {
        modelStatus.textContent = t("popup_ai_unavailable", "On-device AI unavailable — using the offline dictionary");
        modelStatus.classList.add("warn");
    }
}).catch(() => { /* leave blank */ });

// Settings go to storage.local only; every open tab listens for the change.
toggle.addEventListener("change", () => {
    renderEnabled(toggle.checked);
    browser.storage.local.set({ enabled: toggle.checked });
});

mode.addEventListener("change", () => {
    browser.storage.local.set({ mode: mode.value });
});

hideCommon.addEventListener("change", () => {
    browser.storage.local.set({ hideCommon: Number(hideCommon.value) || 0 });
});

// Google Translate is off until the reader turns it on; the key stays in
// this extension's storage.local and goes only to Google, in a header.
google.addEventListener("change", () => {
    renderGoogle();
    browser.storage.local.set({ google: google.checked });
    if (google.checked && !navigator.onLine) googleOffline.showModal();
});

googleKey.addEventListener("change", () => {
    browser.storage.local.set({ googleKey: googleKey.value.trim() });
});

smart.addEventListener("change", () => {
    renderGoogle();
    browser.storage.local.set({ smart: smart.checked });
});

// The Saved words page, with the number of saved words (one "saved:" key each).
const savedLink = document.getElementById("saved-link");

browser.storage.local.get(null).then((stored) => {
    const n = Object.keys(stored).filter((key) => key.startsWith("saved:") && stored[key]).length;
    savedLink.textContent = `${t("popup_saved", "Saved words")} (${n})`;
}).catch(() => { /* keep the plain label */ });

savedLink.addEventListener("click", (event) => {
    event.preventDefault();
    browser.tabs.create({ url: browser.runtime.getURL("saved.html") });
    window.close();
});
