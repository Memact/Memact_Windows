import {
  appendEvent,
  clearAllData,
  cosineSimilarity,
  getEventCount,
  getRecentEvents,
  getSessionCount,
  getStats,
  initDB,
} from "./db.js";
import {
  buildSuggestionQueries,
  extractContextProfile,
  shouldSkipCaptureProfile,
} from "./context-pipeline.js";
import { classifyLocalPage } from "./page-intelligence.js";
import { extractKeyphrases } from "./keywords.js";
import { answerLocalQuery } from "./query-engine.js";

const EXTENSION_VERSION = chrome.runtime.getManifest().version;
const MEMACT_SITE_URL = "https://www.memact.com";
const SNIPPET_MAX_LEN = 280;
const FULL_TEXT_MAX_LEN = 8000;
const EMBED_WORKER_URL = chrome.runtime.getURL("embed-worker.js");

let embedWorker = null;
let embedWorkerReady = false;
let embedPending = new Map();
let snapshotTimer = null;
const SNAPSHOT_DEBOUNCE_MS = 450;

function normalizeHostname(hostname) {
  return String(hostname || "")
    .toLowerCase()
    .replace(/^\[/, "")
    .replace(/\]$/, "");
}

function isAllowedMemactOrigin(origin) {
  try {
    const url = new URL(origin);
    const hostname = normalizeHostname(url.hostname);
    if (/^https?:$/i.test(url.protocol) === false) {
      return false;
    }
    if (/(^|\.)memact\.com$/i.test(hostname)) {
      return true;
    }
    return (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "0.0.0.0" ||
      hostname === "::1"
    );
  } catch {
    return false;
  }
}

function detectBrowserKey() {
  const userAgent = navigator.userAgent || "";
  if (userAgent.includes("Edg/")) return "edge";
  if (userAgent.includes("OPR/")) return "opera";
  if (userAgent.includes("Vivaldi/")) return "vivaldi";
  if (userAgent.includes("Brave/")) return "brave";
  return "chrome";
}

function normalizeText(value, maxLen) {
  const text = String(value || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "";
  return maxLen && text.length > maxLen ? `${text.slice(0, maxLen - 3)}...` : text;
}

function normalizeRichText(value, maxLen) {
  const text = String(value || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const blocks = text
    .split(/\n{2,}/)
    .map((block) =>
      block
        .split(/\n+/)
        .map((line) => line.replace(/[ \t]+/g, " ").trim())
        .filter(Boolean)
        .join("\n")
    )
    .filter(Boolean);
  const normalized = blocks.join("\n\n").trim();
  if (!normalized) return "";
  return maxLen && normalized.length > maxLen ? normalized.slice(0, maxLen) : normalized;
}

function hostnameFromUrl(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function shouldIgnoreCapturedPage(url, pageTitle = "") {
  try {
    const parsed = new URL(url);
    const hostname = normalizeHostname(parsed.hostname);
    const title = normalizeText(pageTitle, 200).toLowerCase();
    const isLocalHost =
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "0.0.0.0" ||
      hostname === "::1";

    if (/(^|\.)memact\.com$/i.test(hostname)) {
      return true;
    }

    if (isLocalHost && (parsed.port === "5173" || parsed.port === "4173" || title.includes("memact"))) {
      return true;
    }

    return false;
  } catch {
    return false;
  }
}

function buildSearchableText(tabData, contextProfile = null) {
  const active = tabData.activeContext || {};
  return [
    tabData.browser,
    active.pageTitle,
    active.h1,
    active.description,
    active.selection,
    tabData.activeTab?.url || "",
    active.snippet,
    (active.fullText || "").slice(0, 1200),
    contextProfile?.subject || "",
    Array.isArray(contextProfile?.entities) ? contextProfile.entities.join(" ") : "",
    Array.isArray(contextProfile?.topics) ? contextProfile.topics.join(" ") : "",
    Array.isArray(contextProfile?.factItems)
      ? contextProfile.factItems.map((item) => `${item.label} ${item.value}`).join(" ")
      : "",
    contextProfile?.structuredSummary || "",
    contextProfile?.contextText || ""
  ]
    .filter(Boolean)
    .join(" ");
}

function mergeUniqueStrings(values, limit = 24) {
  const seen = new Set();
  const output = [];
  for (const value of values) {
    const normalized = normalizeText(value, 120);
    if (!normalized) {
      continue;
    }
    const key = normalized.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(normalized);
    if (output.length >= limit) {
      break;
    }
  }
  return output;
}

function normalizeVector(vector) {
  let norm = 0;
  for (const value of vector) {
    norm += value * value;
  }
  norm = Math.sqrt(norm) || 1;
  return vector.map((value) => value / norm);
}

async function hashEmbedding(text, dim = 384) {
  const vector = new Array(dim).fill(0);
  const tokens = String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9@#./+-]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);

  for (const token of tokens) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
    const bytes = new Uint8Array(digest);
    for (let i = 0; i < bytes.length; i += 1) {
      const slot = (bytes[i] + i * 17) % dim;
      const sign = bytes[(i + 11) % bytes.length] % 2 === 0 ? 1 : -1;
      vector[slot] += sign * (1 + bytes[i] / 255);
    }
  }

  return normalizeVector(vector);
}

function ensureEmbedWorker() {
  if (embedWorker) {
    return embedWorker;
  }

  try {
    embedWorker = new Worker(EMBED_WORKER_URL);
    embedWorker.addEventListener("message", (event) => {
      const message = event.data || {};
      if (message.type === "loading_progress") {
        embedWorkerReady = false;
        return;
      }
      if (message.type === "status_result") {
        embedWorkerReady = Boolean(message.ready);
        return;
      }
      if (message.type === "embed_result") {
        embedWorkerReady = true;
        const pending = embedPending.get(message.id);
        if (pending) {
          embedPending.delete(message.id);
          pending.resolve(Array.isArray(message.embedding) ? message.embedding : []);
        }
        return;
      }
      if (message.type === "embed_error") {
        const pending = embedPending.get(message.id);
        if (pending) {
          embedPending.delete(message.id);
          pending.reject(new Error(message.error || "embedding failed"));
        }
      }
    });
    embedWorker.addEventListener("error", () => {
      embedWorkerReady = false;
    });
  } catch {
    embedWorker = null;
  }

  return embedWorker;
}

function isAllowedBridgeSender(sender) {
  if (!sender?.url) {
    return true;
  }

  return isAllowedMemactOrigin(sender.url);
}

async function embedText(text) {
  try {
    const worker = ensureEmbedWorker();
    if (!worker) {
      return hashEmbedding(text);
    }

    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const resultPromise = new Promise((resolve, reject) => {
      embedPending.set(id, { resolve, reject });
    });
    worker.postMessage({ type: "embed", text: String(text || ""), id });

    const timeout = new Promise((_, reject) => {
      setTimeout(() => reject(new Error("embedding timeout")), 3000);
    });

    return await Promise.race([resultPromise, timeout]).catch(() => hashEmbedding(text));
  } catch {
    return hashEmbedding(text);
  }
}

async function injectReadability(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["Readability.js"]
    });
    return true;
  } catch {
    return false;
  }
}

async function captureActiveTabContext(tab) {
  if (!tab || !tab.id || !tab.url) {
    return null;
  }
  if (!/^https?:|^file:/i.test(tab.url)) {
    return null;
  }

  try {
    const readabilityReady = await injectReadability(tab.id);
    const [injected] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      args: [SNIPPET_MAX_LEN, FULL_TEXT_MAX_LEN, readabilityReady],
      func: async (snippetMaxLen, fullTextMaxLen, canUseReadability) => {
        if (!window.__memactCaptureInstalled) {
          window.__memactCaptureInstalled = true;
          window.__memactLastInputAt = 0;
          window.__memactLastScrollAt = 0;
          window.addEventListener("input", () => {
            window.__memactLastInputAt = Date.now();
          }, true);
          window.addEventListener("scroll", () => {
            window.__memactLastScrollAt = Date.now();
          }, true);
        }

        const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const normalizeVisibleText = (value) =>
          String(value || "")
            .replace(/\s+/g, " ")
            .trim();
        const normalizeStructuredText = (value) =>
          String(value || "")
            .replace(/\r\n/g, "\n")
            .replace(/\r/g, "\n")
            .split(/\n{2,}/)
            .map((block) =>
              block
                .split(/\n+/)
                .map((line) => line.replace(/[ \t]+/g, " ").trim())
                .filter(Boolean)
                .join("\n")
            )
            .filter(Boolean)
            .join("\n\n")
            .trim();
        const isNoiseLineText = (line) => {
          const lower = String(line || "").toLowerCase().trim();
          if (!lower) {
            return true;
          }
          if (/^[\-=*_#|.]{6,}$/.test(lower)) {
            return true;
          }
          if (
            /(click the bell|subscribe|background picture by|contact\/submissions|official site|follow us|stream now|sponsored|advertisement|loading public)/i.test(
              lower
            )
          ) {
            return true;
          }
          if (
            /(this summary was generated by ai|based on sources|learn more about bing search results)/i.test(
              lower
            )
          ) {
            return true;
          }
          if (/https?:\/\/\S+/i.test(line) && String(line).length < 180) {
            return true;
          }
          if (/@/.test(line) && lower.includes("contact")) {
            return true;
          }
          return false;
        };
        const cleanCapturedText = (value) => {
          const normalized = normalizeStructuredText(value);
          if (!normalized) {
            return "";
          }
          const lines = normalized
            .split(/\n+/)
            .map((line) => line.replace(/^lyrics\s*:\s*/i, "").trim())
            .filter((line) => line && !isNoiseLineText(line));
          const deduped = [];
          for (const line of lines) {
            if (deduped[deduped.length - 1]?.toLowerCase() === line.toLowerCase()) {
              continue;
            }
            deduped.push(line);
          }
          return deduped.join("\n").trim();
        };
        const hostname = location.hostname.replace(/^www\./, "");
        const isVisible = (node) => {
          if (!node || !(node instanceof Element)) {
            return false;
          }
          const style = window.getComputedStyle(node);
          if (style.display === "none" || style.visibility === "hidden") {
            return false;
          }
          const rect = node.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        };
        const isNoiseNode = (node) => {
          if (!node || !(node instanceof Element)) {
            return false;
          }
          return Boolean(
            node.closest(
              "nav, header, footer, aside, [role='navigation'], [role='complementary'], [aria-label*='navigation' i], [class*='sidebar' i], [class*='nav' i], [class*='menu' i], [class*='footer' i], [class*='header' i], [class*='ad' i], [id*='ad' i]"
            )
          );
        };
        const collectRoots = () => {
          const roots = [document];
          const queue = [document.documentElement];
          const seen = new Set([document]);
          while (queue.length) {
            const node = queue.shift();
            if (!node || !(node instanceof Element)) {
              continue;
            }
            if (node.shadowRoot && !seen.has(node.shadowRoot)) {
              roots.push(node.shadowRoot);
              seen.add(node.shadowRoot);
              queue.push(node.shadowRoot);
            }
            for (const child of node.children || []) {
              queue.push(child);
            }
          }
          return roots;
        };
        const queryAllDeep = (selectors) => {
          const roots = collectRoots();
          const found = [];
          const seen = new Set();
          for (const root of roots) {
            for (const selector of selectors) {
              let nodes = [];
              try {
                nodes = Array.from(root.querySelectorAll(selector));
              } catch {
                nodes = [];
              }
              for (const node of nodes) {
                if (seen.has(node)) {
                  continue;
                }
                seen.add(node);
                found.push(node);
              }
            }
          }
          return found;
        };
        const scrapeNodeText = (node) => {
          if (!node || !isVisible(node) || isNoiseNode(node)) {
            return "";
          }
          return normalizeStructuredText(node.innerText || node.textContent || "");
        };
        const siteSelectors = [];
        if (hostname.includes("github.com")) siteSelectors.push(".markdown-body");
        if (hostname.includes("youtube.com")) siteSelectors.push("ytd-watch-metadata", "#description-inner");
        if (hostname.includes("twitter.com") || hostname.includes("x.com")) siteSelectors.push("[data-testid='tweetText']");
        if (hostname.includes("reddit.com")) siteSelectors.push("[data-testid='post-content']", ".md.feed-link-description");
        if (hostname.includes("discord.com")) siteSelectors.push("[class*='messageContent']");
        const generalSelectors = [
          "article",
          "main",
          "[role='main']",
          "[role='article']",
          ".content",
          ".post-body",
          ".article-body",
          "[class*='content']",
          "[class*='article']",
          "[class*='post-body']",
          "[class*='messageContent']",
          "[class*='message-content']",
          "[class*='messages']",
          "[class*='thread']",
          "[class*='conversation']",
          "[data-testid*='message']",
          "[data-testid*='conversation']",
          "[aria-live='polite']",
          "[aria-live='assertive']"
        ];
        const pickContentText = () => {
          const candidates = [];
          const seen = new Set();
          for (const node of queryAllDeep([...siteSelectors, ...generalSelectors])) {
            const text = scrapeNodeText(node);
            if (!text || text.length < 100) {
              continue;
            }
            const key = text.slice(0, 800);
            if (seen.has(key)) {
              continue;
            }
            seen.add(key);
            candidates.push(text);
          }
          candidates.sort((left, right) => right.length - left.length);
          return candidates[0] || "";
        };
        const visibleBodyText = () => {
          const text = normalizeStructuredText(document.body?.innerText || "");
          return text.length < 200 ? "" : text.slice(0, 3000);
        };
        const extractReadabilityText = async () => {
          if (!(canUseReadability && typeof Readability === "function")) {
            return "";
          }
          const parseArticle = () => {
            try {
              const articleData = new Readability(document.cloneNode(true)).parse();
              if (articleData?.content) {
                const container = document.createElement("div");
                container.innerHTML = articleData.content;
                const htmlText = normalizeStructuredText(
                  container.innerText || container.textContent || ""
                );
                if (htmlText) {
                  return htmlText;
                }
              }
              return normalizeStructuredText(articleData?.textContent || "");
            } catch {
              return "";
            }
          };
          let articleText = parseArticle();
          if (articleText) {
            return articleText.slice(0, fullTextMaxLen);
          }
          await wait(800);
          articleText = parseArticle();
          return articleText ? articleText.slice(0, fullTextMaxLen) : "";
        };
        const readMeta = (key, attr = "name") => {
          const selector = `meta[${attr}="${key}"]`;
          const el = document.querySelector(selector);
          return el ? el.getAttribute("content") || "" : "";
        };
        const ogTitle = readMeta("og:title", "property");
        const ogDescription = readMeta("og:description", "property");
        const description = readMeta("description") || ogDescription;
        const pageTitle = document.title || ogTitle || "";
        const h1 = document.querySelector("h1")?.innerText || "";
        const selection = window.getSelection()?.toString() || "";
        const pageContent = pickContentText();
        let fullText = await extractReadabilityText();
        if (!fullText || fullText.length < 100) {
          const scraped = pageContent;
          if (scraped && scraped.length >= 100) {
            fullText = scraped.slice(0, fullTextMaxLen);
          }
        }
        if (!fullText || fullText.length < 100) {
          const fallbackText = visibleBodyText();
          if (fallbackText) {
            fullText = fallbackText.slice(0, fullTextMaxLen);
          }
        }
        fullText = cleanCapturedText(fullText).slice(0, fullTextMaxLen);
        const snippetSource = fullText || pageContent || visibleBodyText() || "";
        const snippet = normalizeVisibleText(snippetSource).slice(0, snippetMaxLen);
        const now = Date.now();
        const activeEl = document.activeElement;
        const activeTag = activeEl?.tagName || "";
        const activeType = activeEl?.type || "";
        const isEditable = Boolean(activeEl?.isContentEditable);
        const typingActive =
          window.__memactLastInputAt &&
          now - window.__memactLastInputAt < 5000 &&
          (activeTag === "INPUT" || activeTag === "TEXTAREA" || isEditable);
        const scrollingActive =
          window.__memactLastScrollAt && now - window.__memactLastScrollAt < 4000;
        return {
          pageTitle,
          description,
          h1,
          selection,
          snippet,
          fullText,
          activeTag,
          activeType,
          typingActive,
          scrollingActive
        };
      }
    });

    const result = injected && injected.result ? injected.result : null;
    if (!result) {
      return null;
    }

    return {
      pageTitle: normalizeText(result.pageTitle, 140),
      description: normalizeText(result.description, 200),
      h1: normalizeText(result.h1, 120),
      selection: normalizeText(result.selection, 200),
      snippet: normalizeText(result.snippet, SNIPPET_MAX_LEN),
      fullText: normalizeRichText(result.fullText, FULL_TEXT_MAX_LEN),
      activeTag: normalizeText(result.activeTag, 40),
      activeType: normalizeText(result.activeType, 40),
      typingActive: Boolean(result.typingActive),
      scrollingActive: Boolean(result.scrollingActive)
    };
  } catch {
    return null;
  }
}

async function processAndStore(tabData) {
  const active = tabData.activeContext || {};
  const fullText = active.fullText || "";
  const snippet = active.snippet || "";
  const pageTitle = active.pageTitle || tabData.activeTab?.title || "";
  if (shouldIgnoreCapturedPage(tabData.activeTab?.url || "", pageTitle)) {
    return null;
  }
  const baseKeyphrases = extractKeyphrases(fullText || snippet);
  const initialProfile = extractContextProfile({
    url: tabData.activeTab?.url || "",
    application: tabData.browser,
    pageTitle,
    description: active.description,
    h1: active.h1,
    selection: active.selection,
    snippet,
    fullText,
    keyphrases: baseKeyphrases,
  });
  const keyphrases = mergeUniqueStrings([
    ...baseKeyphrases,
    initialProfile.subject,
    ...(initialProfile.entities || []),
    ...(initialProfile.topics || []),
  ]);
  const contextProfile = extractContextProfile({
    url: tabData.activeTab?.url || "",
    application: tabData.browser,
    pageTitle,
    description: active.description,
    h1: active.h1,
    selection: active.selection,
    snippet,
    fullText,
    keyphrases,
    contextProfile: initialProfile,
  });
  const localJudge = await classifyLocalPage(contextProfile, {
    embedText,
    cosineSimilarity,
  });
  contextProfile.localJudge = localJudge;
  if (shouldSkipCaptureProfile(contextProfile)) {
    return null;
  }
  const searchableText = buildSearchableText(tabData, contextProfile);
  const embedding = await embedText(`${searchableText} ${keyphrases.join(" ")}`.trim());
  const persistedContextProfile = {
    version: contextProfile.version,
    title: contextProfile.title,
    description: contextProfile.description,
    h1: contextProfile.h1,
    selection: contextProfile.selection,
    url: contextProfile.url,
    domain: contextProfile.domain,
    application: contextProfile.application,
    keyphrases: contextProfile.keyphrases,
    pageType: contextProfile.pageType,
    pageTypeLabel: contextProfile.pageTypeLabel,
    entities: contextProfile.entities,
    topics: contextProfile.topics,
    subject: contextProfile.subject,
    factItems: contextProfile.factItems,
    structuredSummary: contextProfile.structuredSummary,
    displayExcerpt: contextProfile.displayExcerpt,
    contextText: contextProfile.contextText,
    localJudge: contextProfile.localJudge,
  };

  const event = {
    occurred_at: new Date().toISOString(),
    application: tabData.browser,
    window_title: pageTitle,
    url: tabData.activeTab?.url || "",
    interaction_type: active.typingActive
      ? "type"
      : active.scrollingActive
        ? "scroll"
        : "navigate",
    content_text: snippet,
    full_text: fullText,
    keyphrases_json: JSON.stringify(keyphrases),
    searchable_text: searchableText,
    embedding_json: JSON.stringify(embedding),
    context_profile_json: JSON.stringify(persistedContextProfile),
    source: "extension"
  };

  return appendEvent(event);
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
    const activeTab = currentWindow.tabs.find((tab) => tab && tab.active);
    const activeContext = activeTab ? await captureActiveTabContext(activeTab) : null;

    if (activeTab) {
      await processAndStore({
        browser,
        activeTab,
        activeContext,
        tabs,
        windowId: currentWindow.id
      });
    }
  } catch {
    // Keep the extension silent when Memact is not running or the page is inaccessible.
  }
}

function queueSnapshot() {
  clearTimeout(snapshotTimer);
  snapshotTimer = setTimeout(() => {
    snapshotFocusedWindow();
  }, SNAPSHOT_DEBOUNCE_MS);
}

async function openMemactSite() {
  const matchingTabs = await chrome.tabs.query({
    url: ["https://www.memact.com/*", "https://www.memact.com/"]
  });

  const existingTab = matchingTabs[0];
  if (existingTab?.id) {
    if (existingTab.windowId) {
      await chrome.windows.update(existingTab.windowId, { focused: true }).catch(() => {});
    }
    await chrome.tabs.update(existingTab.id, { active: true, url: MEMACT_SITE_URL }).catch(() => {});
    return;
  }

  await chrome.tabs.create({ url: MEMACT_SITE_URL });
}

function lexicalOverlapScore(query, event) {
  const tokens = String(query || "")
    .toLowerCase()
    .replace(/[^a-z0-9@#./+-]+/g, " ")
    .split(/\s+/)
    .filter((token) => token.length >= 3);
  if (!tokens.length) {
    return 0;
  }
  const haystack = [
    event.window_title,
    event.url,
    event.searchable_text,
    JSON.parse(event.keyphrases_json || "[]").join(" ")
  ]
    .join(" ")
    .toLowerCase();
  let hits = 0;
  for (const token of new Set(tokens)) {
    if (haystack.includes(token)) {
      hits += 1;
    }
  }
  return hits / Math.max(1, new Set(tokens).size);
}

function parseKeyphrases(event) {
  try {
    const parsed = JSON.parse(event.keyphrases_json || "[]");
    return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
  } catch {
    return [];
  }
}

function parseContextProfile(event) {
  return extractContextProfile({
    url: event.url,
    application: event.application,
    pageTitle: event.window_title,
    snippet: event.content_text,
    fullText: event.full_text,
    keyphrases: parseKeyphrases(event),
    context_profile_json: event.context_profile_json,
  });
}

function suggestionTimeLabel(occurredAt) {
  if (!occurredAt) {
    return "";
  }
  try {
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit"
    })
      .format(new Date(occurredAt))
      .replace(",", " |");
  } catch {
    return "";
  }
}

function startOfDay() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function startOfWeek(offsetWeeks = 0) {
  const today = startOfDay();
  const day = today.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  const monday = new Date(today);
  monday.setDate(today.getDate() + diff + offsetWeeks * 7);
  return monday;
}

function matchesTimeFilter(event, timeFilter) {
  if (!timeFilter) {
    return true;
  }

  const eventAt = new Date(event.occurred_at || 0);
  if (Number.isNaN(eventAt.getTime())) {
    return true;
  }

  const today = startOfDay();
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const thisWeek = startOfWeek(0);
  const nextWeek = startOfWeek(1);
  const lastWeek = startOfWeek(-1);

  switch (String(timeFilter || "").toLowerCase()) {
    case "today":
      return eventAt >= today && eventAt < tomorrow;
    case "yesterday":
      return eventAt >= yesterday && eventAt < today;
    case "this week":
      return eventAt >= thisWeek && eventAt < nextWeek;
    case "last week":
      return eventAt >= lastWeek && eventAt < thisWeek;
    default:
      return true;
  }
}

function buildSuggestionSubtitle(event) {
  const app = normalizeText(event.application, 48);
  const domain = hostnameFromUrl(event.url);
  const when = suggestionTimeLabel(event.occurred_at);
  return [app, domain, when].filter(Boolean).join("  |  ");
}

function createQuerySuggestion(event, completion, category) {
  const text = normalizeText(completion, 180);
  if (!text) {
    return null;
  }

  return {
    id: `${event.id || "event"}-${category}-${text.toLowerCase()}`,
    category,
    title: text,
    subtitle: buildSuggestionSubtitle(event),
    completion: text
  };
}

async function handleSuggestions(query, timeFilter, limit = 6) {
  const normalizedQuery = normalizeText(query, 240).toLowerCase();
  const recentEvents = await getRecentEvents(320);
  const filteredEvents = recentEvents.filter(
    (event) =>
      matchesTimeFilter(event, timeFilter) &&
      !shouldIgnoreCapturedPage(event.url, event.window_title)
  );
  const suggestions = [];
  const seen = new Set();

  const pushSuggestion = (event, completion, category) => {
    const suggestion = createQuerySuggestion(event, completion, category);
    if (!suggestion) {
      return;
    }

    const key = suggestion.completion.toLowerCase();
    if (seen.has(key)) {
      return;
    }

    seen.add(key);
    suggestions.push(suggestion);
  };

  for (const event of filteredEvents) {
    if (suggestions.length >= limit) {
      break;
    }

    const profile = parseContextProfile(event);
    const title = normalizeText(profile.title || event.window_title, 96);
    const app = normalizeText(event.application, 40);
    const domain = profile.domain || hostnameFromUrl(event.url);
    const keyphrases = mergeUniqueStrings(
      [...(profile.keyphrases || []), ...(profile.entities || []), ...(profile.topics || [])],
      4
    );
    const haystack = [
      title,
      event.url,
      event.searchable_text,
      keyphrases.join(" "),
      domain,
      app,
      profile.subject || "",
      profile.structuredSummary || "",
      profile.contextText || "",
    ]
      .join(" ")
      .toLowerCase();

    if (normalizedQuery) {
      const tokens = normalizedQuery.split(/\s+/).filter((token) => token.length >= 2);
      const tokenHit = tokens.some((token) => haystack.includes(token));
      if (!tokenHit) {
        continue;
      }
    }

    const queryFrames = buildSuggestionQueries(profile, { limit: 6 });
    for (const suggestion of queryFrames) {
      pushSuggestion(
        event,
        suggestion.query,
        normalizedQuery ? "Matching memory" : suggestion.category || "Recent activity"
      );
      if (suggestions.length >= limit) {
        break;
      }
    }
  }

  return suggestions.slice(0, limit);
}

async function handleSearch(query, limit = 20) {
  const normalizedQuery = normalizeText(query, 1000);
  if (!normalizedQuery) {
    return { results: [], answer: null };
  }
  const recentEvents = await getRecentEvents(3000);
  return answerLocalQuery({
    query: normalizedQuery,
    limit,
    rawEvents: recentEvents,
    embedText,
    cosineSimilarity
  });
}

chrome.runtime.onInstalled.addListener(() => {
  initDB().catch(() => {});
  queueSnapshot();
});

chrome.runtime.onStartup.addListener(() => {
  initDB().catch(() => {});
  queueSnapshot();
});

chrome.tabs.onActivated.addListener(queueSnapshot);
chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  if (changeInfo?.status !== "complete") {
    return;
  }
  if (!tab?.url || !/^https?:/i.test(tab.url)) {
    return;
  }
  queueSnapshot();
});
chrome.tabs.onCreated.addListener(queueSnapshot);
chrome.tabs.onRemoved.addListener(queueSnapshot);
chrome.windows.onFocusChanged.addListener(queueSnapshot);
chrome.action.onClicked.addListener(() => {
  openMemactSite().catch(() => {});
});
chrome.webNavigation.onCompleted.addListener(
  ({ frameId, url }) => {
    if (frameId !== 0) {
      return;
    }
    if (!url || !/^https?:/i.test(url)) {
      return;
    }
    queueSnapshot();
  },
  { url: [{ schemes: ["http", "https"] }] }
);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message?.type) {
    return false;
  }

  if (!isAllowedBridgeSender(sender)) {
    sendResponse({
      error: "unauthorized_sender"
    });
    return false;
  }

  if (message.type === "search") {
    handleSearch(message.query, message.limit)
      .then((results) => sendResponse(results))
      .catch((error) =>
        sendResponse({
          error: String(error?.message || error || "search failed"),
          results: []
        })
      );
    return true;
  }

  if (message.type === "suggestions") {
    handleSuggestions(message.query, message.timeFilter, message.limit)
      .then((results) => sendResponse(results))
      .catch((error) =>
        sendResponse({
          error: String(error?.message || error || "suggestions failed"),
          results: []
        })
      );
    return true;
  }

  if (message.type === "status") {
    Promise.all([getEventCount(), getSessionCount()])
      .then(([eventCount, sessionCount]) =>
        sendResponse({
          ready: true,
          eventCount,
          sessionCount,
          modelReady: Boolean(embedWorkerReady),
          extensionVersion: EXTENSION_VERSION
        })
      )
      .catch((error) =>
        sendResponse({
          ready: false,
          eventCount: 0,
          sessionCount: 0,
          modelReady: Boolean(embedWorkerReady),
          error: String(error?.message || error || "status failed")
        })
      );
    return true;
  }

  if (message.type === "stats") {
    getStats()
      .then((stats) => sendResponse(stats))
      .catch((error) =>
        sendResponse({
          error: String(error?.message || error || "stats failed")
        })
      );
    return true;
  }

  if (message.type === "clearAllData") {
    clearAllData()
      .then(() => sendResponse({ ok: true }))
      .catch((error) =>
        sendResponse({
          ok: false,
          error: String(error?.message || error || "clear failed")
        })
      );
    return true;
  }

  return false;
});
