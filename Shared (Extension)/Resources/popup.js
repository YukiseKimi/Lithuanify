// Popup controller: reflects/toggles the on/off and on-device-AI states, and
// shows whether the on-device model is available.

const toggle = document.getElementById("toggle");
const stateLabel = document.getElementById("state-label");
const smart = document.getElementById("smart");
const modelStatus = document.getElementById("model-status");
const mode = document.getElementById("mode");
const hideCommon = document.getElementById("hide-common");

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
}

browser.storage.local.get(["enabled", "smart", "mode", "hideCommon"]).then((result) => {
    renderEnabled(result.enabled !== false);
    smart.checked = result.smart !== false;
    mode.value = result.mode || "page";
    hideCommon.value = String(Number(result.hideCommon) || 0);
});

// Show on-device model availability.
browser.runtime.sendMessage({ command: "modelStatus" }).then((res) => {
    if (res && res.available) {
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

smart.addEventListener("change", () => {
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
