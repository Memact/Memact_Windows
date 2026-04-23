import { getSettingValue, setSettingValue } from "./db.js";

const OCR_COOLDOWN_MS = 15 * 60 * 1000;
const OCR_IDLE_SECONDS = 45;
const OCR_MAX_CHARS = 3500;
const OCR_MIN_USEFUL_CHARS = 24;
const OCR_WEAK_TEXT_CHARS = 360;
const OCR_WEAK_SNIPPET_CHARS = 90;
const OCR_IMAGE_MAX_EDGE = 1400;

export const LOCAL_OCR_POLICY = Object.freeze({
  enabled: true,
  mode: "idle_weak_text_fallback",
  provider: "browser_local_text_detector",
  uploadsImages: false,
  cooldownMinutes: Math.round(OCR_COOLDOWN_MS / 60000),
  idleSeconds: OCR_IDLE_SECONDS,
});

function normalizeText(value, maxLen = 0) {
  const text = String(value || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split(/\n+/)
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter(Boolean)
    .join("\n")
    .trim();
  if (!text) return "";
  return maxLen && text.length > maxLen ? text.slice(0, maxLen) : text;
}

function canonicalUrl(url) {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    parsed.search = "";
    return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`.toLowerCase();
  } catch {
    return String(url || "").toLowerCase();
  }
}

function isCaptureableWebUrl(url) {
  return /^https?:/i.test(String(url || ""));
}

function hasWeakText(context = {}) {
  const fullText = normalizeText(context.fullText);
  const snippet = normalizeText(context.snippet);
  return fullText.length < OCR_WEAK_TEXT_CHARS || snippet.length < OCR_WEAK_SNIPPET_CHARS;
}

async function queryIdleState() {
  try {
    if (!globalThis.chrome?.idle?.queryState) {
      return "unknown";
    }
    return await chrome.idle.queryState(OCR_IDLE_SECONDS);
  } catch {
    return "unknown";
  }
}

async function readCooldownMap() {
  try {
    const value = await getSettingValue("local_ocr_last_by_url");
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

async function rememberOcrAttempt(url) {
  const map = await readCooldownMap();
  const now = Date.now();
  map[canonicalUrl(url)] = now;
  const cutoff = now - 24 * 60 * 60 * 1000;
  for (const [key, value] of Object.entries(map)) {
    if (Number(value || 0) < cutoff) {
      delete map[key];
    }
  }
  await setSettingValue("local_ocr_last_by_url", map).catch(() => {});
}

async function isCoolingDown(url) {
  const map = await readCooldownMap();
  const last = Number(map[canonicalUrl(url)] || 0);
  return last && Date.now() - last < OCR_COOLDOWN_MS;
}

async function captureVisibleImage(tab) {
  if (!tab?.windowId) {
    return "";
  }
  try {
    return await chrome.tabs.captureVisibleTab(tab.windowId, {
      format: "jpeg",
      quality: 52,
    });
  } catch {
    return "";
  }
}

async function detectTextInPage(tabId, imageDataUrl) {
  if (!tabId || !imageDataUrl) {
    return { available: false, text: "", reason: "missing_image" };
  }

  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      args: [imageDataUrl, OCR_IMAGE_MAX_EDGE, OCR_MAX_CHARS],
      func: async (dataUrl, maxEdge, maxChars) => {
        const normalize = (value) =>
          String(value || "")
            .replace(/\r\n/g, "\n")
            .replace(/\r/g, "\n")
            .split(/\n+/)
            .map((line) => line.replace(/[ \t]+/g, " ").trim())
            .filter(Boolean)
            .join("\n")
            .trim();

        if (typeof TextDetector !== "function") {
          return { available: false, text: "", reason: "text_detector_unavailable" };
        }

        const image = await new Promise((resolve, reject) => {
          const img = new Image();
          img.onload = () => resolve(img);
          img.onerror = () => reject(new Error("image_load_failed"));
          img.src = dataUrl;
        });

        const width = image.naturalWidth || image.width || 0;
        const height = image.naturalHeight || image.height || 0;
        if (!width || !height) {
          return { available: true, text: "", reason: "empty_image" };
        }

        const scale = Math.min(1, maxEdge / Math.max(width, height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(width * scale));
        canvas.height = Math.max(1, Math.round(height * scale));
        const context = canvas.getContext("2d", {
          alpha: false,
          desynchronized: true,
          willReadFrequently: false,
        });
        context.drawImage(image, 0, 0, canvas.width, canvas.height);

        const detector = new TextDetector();
        const regions = await detector.detect(canvas);
        const lines = Array.isArray(regions)
          ? regions
              .map((region) => normalize(region?.rawValue || region?.text || ""))
              .filter(Boolean)
          : [];

        return {
          available: true,
          text: normalize(lines.join("\n")).slice(0, maxChars),
          reason: lines.length ? "ok" : "no_text_detected",
        };
      },
    });

    const payload = result?.result || {};
    return {
      available: Boolean(payload.available),
      text: normalizeText(payload.text, OCR_MAX_CHARS),
      reason: payload.reason || "unknown",
    };
  } catch (error) {
    return {
      available: false,
      text: "",
      reason: String(error?.message || error || "ocr_failed"),
    };
  }
}

export async function maybeExtractLocalOcr(tab, context = {}) {
  const url = tab?.url || "";
  if (!tab?.id || !isCaptureableWebUrl(url)) {
    return { used: false, reason: "unsupported_url", text: "" };
  }

  if (context.typingActive || context.scrollingActive) {
    return { used: false, reason: "user_active", text: "" };
  }

  if (!hasWeakText(context)) {
    return { used: false, reason: "dom_text_sufficient", text: "" };
  }

  const idleState = await queryIdleState();
  if (idleState === "active") {
    return { used: false, reason: "browser_active", text: "" };
  }

  if (await isCoolingDown(url)) {
    return { used: false, reason: "cooldown", text: "" };
  }

  await rememberOcrAttempt(url);

  const imageDataUrl = await captureVisibleImage(tab);
  if (!imageDataUrl) {
    return { used: false, reason: "screenshot_unavailable", text: "" };
  }

  const detection = await detectTextInPage(tab.id, imageDataUrl);
  const text = normalizeText(detection.text, OCR_MAX_CHARS);
  if (!detection.available) {
    return { used: false, reason: detection.reason || "ocr_unavailable", text: "" };
  }
  if (text.length < OCR_MIN_USEFUL_CHARS) {
    return { used: false, reason: detection.reason || "ocr_text_too_short", text: "" };
  }

  return {
    used: true,
    reason: "weak_dom_text",
    method: "local_text_detector",
    text,
    capturedAt: new Date().toISOString(),
  };
}
