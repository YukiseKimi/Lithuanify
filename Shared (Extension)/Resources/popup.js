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

async function sendToActiveTab(message) {
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    if (tabs[0]) {
        browser.tabs.sendMessage(tabs[0].id, message)
            .catch(() => { /* no content script on this page */ });
    }
}

toggle.addEventListener("change", async () => {
    const enabled = toggle.checked;
    renderEnabled(enabled);
    await browser.storage.local.set({ enabled });
    await sendToActiveTab({ command: "toggle", enabled });
});

mode.addEventListener("change", async () => {
    await browser.storage.local.set({ mode: mode.value });
    await sendToActiveTab({ command: "setMode", mode: mode.value });
});

hideCommon.addEventListener("change", async () => {
    const value = Number(hideCommon.value) || 0;
    await browser.storage.local.set({ hideCommon: value });
    await sendToActiveTab({ command: "setHideCommon", hideCommon: value });
});

smart.addEventListener("change", async () => {
    const enabled = smart.checked;
    await browser.storage.local.set({ smart: enabled });
    await sendToActiveTab({ command: "setSmart", enabled });
});
