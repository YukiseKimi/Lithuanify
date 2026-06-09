// Popup controller: reflects/toggles the on/off and on-device-AI states, and
// shows whether the on-device model is available.

const toggle = document.getElementById("toggle");
const stateLabel = document.getElementById("state-label");
const smart = document.getElementById("smart");
const modelStatus = document.getElementById("model-status");

function renderEnabled(enabled) {
    toggle.checked = enabled;
    stateLabel.textContent = enabled ? "On" : "Off";
    smart.disabled = !enabled;
}

// Load saved preferences (both default to on).
browser.storage.local.get(["enabled", "smart"]).then((result) => {
    renderEnabled(result.enabled !== false);
    smart.checked = result.smart !== false;
});

// Show on-device model availability.
browser.runtime.sendMessage({ command: "modelStatus" }).then((res) => {
    if (res && res.available) {
        modelStatus.textContent = "On-device AI: available";
        modelStatus.classList.add("ok");
    } else {
        modelStatus.textContent = "On-device AI unavailable — using dictionary + online";
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

smart.addEventListener("change", async () => {
    const enabled = smart.checked;
    await browser.storage.local.set({ smart: enabled });
    await sendToActiveTab({ command: "setSmart", enabled });
});
