const BRIDGE_URL = "http://127.0.0.1:38453/session";

function detectBrowserKey() {
  const userAgent = navigator.userAgent || "";
  if (userAgent.includes("Edg/")) {
    return "edge";
  }
  if (userAgent.includes("OPR/")) {
    return "opera";
  }
  if (userAgent.includes("Vivaldi/")) {
    return "vivaldi";
  }
  if (userAgent.includes("Brave/")) {
    return "brave";
  }
  return "chrome";
}

async function snapshotFocusedWindow() {
  try {
    const currentWindow = await chrome.windows.getLastFocused({ populate: true });
    if (!currentWindow || !Array.isArray(currentWindow.tabs)) {
      return;
    }

    const browser = detectBrowserKey();
    const tabs = currentWindow.tabs
      .filter((tab) => tab && tab.url)
      .map((tab) => ({
        id: tab.id,
        title: tab.title || "",
        url: tab.url || "",
        active: Boolean(tab.active)
      }));

    await fetch(BRIDGE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        browser,
        windowId: currentWindow.id,
        tabs
      })
    });
  } catch (error) {
    // Keep the extension silent when MemAct is not running.
  }
}

let snapshotTimer = null;

function queueSnapshot() {
  clearTimeout(snapshotTimer);
  snapshotTimer = setTimeout(() => {
    snapshotFocusedWindow();
  }, 250);
}

chrome.runtime.onInstalled.addListener(queueSnapshot);
chrome.runtime.onStartup.addListener(queueSnapshot);
chrome.tabs.onActivated.addListener(queueSnapshot);
chrome.tabs.onUpdated.addListener(queueSnapshot);
chrome.tabs.onCreated.addListener(queueSnapshot);
chrome.tabs.onRemoved.addListener(queueSnapshot);
chrome.windows.onFocusChanged.addListener(queueSnapshot);
