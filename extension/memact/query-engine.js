import {
  buildSuggestionQueries,
  extractContextProfile,
  shouldSkipCaptureProfile,
} from "./context-pipeline.js";
import { classifyLocalPage } from "./page-intelligence.js";

const SESSION_TIMEOUT_MS = 25 * 60 * 1000;
const SESSION_MAX_GAP_MS = 45 * 60 * 1000;
const SESSION_SEMANTIC_THRESHOLD = 0.18;
const CHAIN_WINDOW_MS = 45 * 60 * 1000;
const CHAIN_THRESHOLD = 0.22;
const TOP_KEYPHRASES = 6;

const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "how", "i", "in",
  "is", "it", "me", "my", "of", "on", "or", "show", "that", "the", "this", "to", "was",
  "what", "when", "where", "why", "with", "you",
]);

const BROWSER_APPS = new Set(["chrome", "edge", "msedge", "brave", "opera", "vivaldi", "firefox"]);
const TERMINAL_APPS = new Set(["terminal", "windows terminal", "powershell", "pwsh", "cmd"]);
const EDITOR_APPS = new Set(["code", "cursor", "codex", "pycharm", "idea", "webstorm"]);
const DOC_DOMAINS = new Set([
  "docs.python.org",
  "developer.mozilla.org",
  "readthedocs.io",
  "learn.microsoft.com",
  "stackoverflow.com",
]);
const AI_DOMAINS = new Set(["chatgpt.com", "claude.ai"]);
const SEARCH_ENGINE_DOMAINS = new Set([
  "google.com",
  "bing.com",
  "duckduckgo.com",
  "search.brave.com",
  "search.yahoo.com",
]);
const SOCIAL_DOMAINS = new Set([
  "twitter.com",
  "x.com",
  "linkedin.com",
  "instagram.com",
  "facebook.com",
  "threads.net",
]);
const COMMERCE_DOMAINS = new Set([
  "amazon.com",
  "flipkart.com",
  "ebay.com",
  "etsy.com",
]);
const PAGE_TYPE_LABELS = {
  article: "Article",
  chat: "Chat",
  discussion: "Discussion",
  docs: "Documentation",
  lyrics: "Lyrics",
  product: "Product page",
  qa: "Q&A",
  repo: "Repository",
  search: "Search results",
  social: "Social page",
  video: "Video",
  web: "Web page",
};

function normalizeText(value, maxLength = 0) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) {
    return "";
  }
  if (maxLength && text.length > maxLength) {
    return `${text.slice(0, maxLength - 3).trim()}...`;
  }
  return text;
}

function compactText(value, maxLength = 220) {
  return normalizeText(value, maxLength);
}

function normalizeRichText(value, maxLength = 0) {
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
  if (!normalized) {
    return "";
  }
  if (maxLength && normalized.length > maxLength) {
    return normalized.slice(0, maxLength);
  }
  return normalized;
}

function cleanAppName(value) {
  const normalized = normalizeText(value).replace(/\.exe$/i, "");
  return normalized || "Browser";
}

function toTitleCase(value) {
  return String(value || "")
    .replace(/[_-]+/g, " ")
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function hostnameFromUrl(url) {
  try {
    return new URL(url).hostname.replace(/^www\./i, "");
  } catch {
    return "";
  }
}

function urlDetails(url) {
  try {
    const parsed = new URL(url);
    return {
      hostname: parsed.hostname.replace(/^www\./i, "").toLowerCase(),
      port: parsed.port || "",
      pathname: parsed.pathname || "/",
    };
  } catch {
    return {
      hostname: "",
      port: "",
      pathname: "/",
    };
  }
}

function canonicalUrl(url) {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    parsed.search = "";
    return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`.toLowerCase();
  } catch {
    return normalizeText(url).toLowerCase();
  }
}

function parseArrayValue(raw) {
  if (Array.isArray(raw)) {
    return raw;
  }
  try {
    const parsed = JSON.parse(raw || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseKeyphrases(rawEvent) {
  return parseArrayValue(rawEvent.keyphrases_json || rawEvent.keyphrases)
    .map((value) => normalizeText(value, 80))
    .filter(Boolean);
}

function parseEmbedding(rawEvent) {
  return parseArrayValue(rawEvent.embedding_json)
    .map((value) => Number(value) || 0)
    .filter((value) => Number.isFinite(value));
}

function meaningfulTokens(text) {
  return Array.from(
    new Set(
      normalizeText(text)
        .toLowerCase()
        .replace(/[^a-z0-9@#./+-]+/g, " ")
        .split(/\s+/)
        .filter((token) => token.length >= 2 && !STOPWORDS.has(token))
    )
  );
}

function averageVector(vectors) {
  if (!vectors.length) {
    return [];
  }
  const maxLength = Math.max(...vectors.map((vector) => vector.length || 0), 0);
  if (!maxLength) {
    return [];
  }
  const total = new Array(maxLength).fill(0);
  for (const vector of vectors) {
    for (let index = 0; index < vector.length; index += 1) {
      total[index] += Number(vector[index] || 0);
    }
  }
  const averaged = total.map((value) => value / Math.max(vectors.length, 1));
  let norm = 0;
  for (const value of averaged) {
    norm += value * value;
  }
  norm = Math.sqrt(norm) || 1;
  return averaged.map((value) => value / norm);
}

function overlapCount(left, right) {
  if (!left?.length || !right?.length) {
    return 0;
  }
  const rightSet = new Set(right.map((value) => String(value).toLowerCase()));
  return left.reduce(
    (total, value) => total + (rightSet.has(String(value).toLowerCase()) ? 1 : 0),
    0
  );
}

function tokenCoverage(tokens, haystackText) {
  if (!tokens.length) {
    return 0;
  }
  const haystack = normalizeText(haystackText).toLowerCase();
  if (!haystack) {
    return 0;
  }
  let hits = 0;
  for (const token of tokens) {
    if (haystack.includes(token)) {
      hits += 1;
    }
  }
  return hits / Math.max(tokens.length, 1);
}

function shortLabel(value, maxLength = 48) {
  const text = normalizeText(value);
  if (!text) {
    return "this session";
  }
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength - 1).trim()}...`;
}

function quoteLabel(value) {
  const text = normalizeText(value, 120).replace(/^["']|["']$/g, "");
  return text ? `"${text}"` : `"this session"`;
}

function pluralize(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function ensureSentence(value) {
  const text = normalizeText(value, 320).replace(/\s+/g, " ").trim();
  if (!text) {
    return "";
  }
  if (/[.!?]$/.test(text)) {
    return text;
  }
  return `${text}.`;
}

function normalizeEvent(rawEvent) {
  const application = cleanAppName(rawEvent.application);
  const domain = hostnameFromUrl(rawEvent.url);
  const title =
    normalizeText(rawEvent.window_title || rawEvent.title || rawEvent.pageTitle, 160) ||
    domain ||
    "Local memory";
  const snippet = compactText(
    rawEvent.content_text || rawEvent.snippet || rawEvent.searchable_text || rawEvent.full_text,
    320
  );
  const fullText = normalizeRichText(rawEvent.full_text, 0);
  const keyphrases = parseKeyphrases(rawEvent);
  const embedding = parseEmbedding(rawEvent);
  const occurredAt = String(rawEvent.occurred_at || "");
  const timestamp = Date.parse(occurredAt);
  const contextProfile = extractContextProfile({
    url: rawEvent.url,
    application,
    pageTitle: title,
    description: rawEvent.description,
    h1: rawEvent.h1,
    selection: rawEvent.selection,
    snippet,
    fullText,
    keyphrases,
    context_profile_json: rawEvent.context_profile_json,
  });

  return {
    ...rawEvent,
    application,
    domain,
    title: contextProfile.title || title,
    snippet: contextProfile.snippet || snippet,
    full_text: contextProfile.fullText || fullText,
    display_url: contextProfile.displayUrl || canonicalUrl(rawEvent.url || ""),
    display_full_text: contextProfile.displayFullText || contextProfile.fullText || fullText,
    raw_full_text: fullText,
    search_results: contextProfile.searchResults || [],
    keyphrases: contextProfile.keyphrases?.length ? contextProfile.keyphrases : keyphrases,
    embedding,
    occurred_at: occurredAt,
    timestamp: Number.isFinite(timestamp) ? timestamp : 0,
    titleTokens: meaningfulTokens(contextProfile.title || title),
    page_type: contextProfile.pageType,
    page_type_label: contextProfile.pageTypeLabel,
    structured_summary: contextProfile.structuredSummary,
    display_excerpt: contextProfile.displayExcerpt,
    fact_items: contextProfile.factItems || [],
    context_subject: contextProfile.subject || "",
    context_entities: contextProfile.entities || [],
    context_topics: contextProfile.topics || [],
    context_text: contextProfile.contextText || "",
    context_profile: contextProfile,
    local_judge: contextProfile.localJudge || null,
    canonicalFingerprint: [
      canonicalUrl(rawEvent.url || ""),
      (contextProfile.title || title).toLowerCase(),
      (contextProfile.displayExcerpt || contextProfile.snippet || snippet).slice(0, 120).toLowerCase(),
    ].filter(Boolean).join("|"),
  };
}

function isInternalMemactEvent(event) {
  const details = urlDetails(event.url || "");
  const title = normalizeText(event.title || event.window_title || "", 200).toLowerCase();
  const isLocalHost =
    details.hostname === "localhost" ||
    details.hostname === "127.0.0.1" ||
    details.hostname === "0.0.0.0" ||
    details.hostname === "::1";

  if (details.hostname === "memact.com") {
    return true;
  }

  if (isLocalHost && (details.port === "5173" || details.port === "4173" || title.includes("memact"))) {
    return true;
  }

  return false;
}

function isSearchResultsPage(event) {
  const domain = String(event.domain || "").toLowerCase();
  if (!SEARCH_ENGINE_DOMAINS.has(domain)) {
    return false;
  }

  const url = String(event.url || "").toLowerCase();
  return (
    url.includes("/search") ||
    url.includes("?q=") ||
    url.includes("&q=") ||
    url.includes("?p=") ||
    url.includes("&p=")
  );
}

function pageTypeLabel(pageType) {
  return PAGE_TYPE_LABELS[pageType] || PAGE_TYPE_LABELS.web;
}

function cleanTopic(value) {
  return normalizeText(value, 140)
    .replace(/\s+/g, " ")
    .replace(/\b(home|official site)\b/gi, "")
    .replace(/\s+\|\s+.*$/, "")
    .trim();
}

function extractQueryFromEvent(event) {
  try {
    const parsed = new URL(event.url || "");
    const candidates = [
      parsed.searchParams.get("q"),
      parsed.searchParams.get("p"),
      parsed.searchParams.get("query"),
      parsed.searchParams.get("text"),
      parsed.searchParams.get("search_query"),
    ]
      .map((value) => normalizeText(value, 120))
      .filter(Boolean);
    return candidates[0] || "";
  } catch {
    return "";
  }
}

function inferPageType(event) {
  const details = urlDetails(event.url || "");
  const titleLower = normalizeText(event.title, 200).toLowerCase();
  const bodyLower = normalizeText(event.full_text, 4000).toLowerCase();

  if (isSearchResultsPage(event)) {
    return "search";
  }
  if (
    titleLower.includes("lyrics") ||
    bodyLower.includes("lyrics:") ||
    bodyLower.includes("official lyrics")
  ) {
    return "lyrics";
  }
  if (
    details.hostname === "youtube.com" ||
    details.hostname === "youtu.be" ||
    details.hostname === "vimeo.com"
  ) {
    return "video";
  }
  if (SOCIAL_DOMAINS.has(details.hostname)) {
    return "social";
  }
  if (
    details.hostname === "stackoverflow.com" ||
    details.hostname.endsWith(".stackexchange.com")
  ) {
    return "qa";
  }
  if (
    details.hostname === "github.com" ||
    details.hostname === "gitlab.com" ||
    details.hostname === "bitbucket.org"
  ) {
    return "repo";
  }
  if (
    details.hostname === "reddit.com" ||
    details.hostname === "news.ycombinator.com" ||
    details.hostname.includes("forum") ||
    details.pathname.includes("/thread") ||
    details.pathname.includes("/discussion") ||
    details.pathname.includes("/comments/")
  ) {
    return "discussion";
  }
  if (
    DOC_DOMAINS.has(details.hostname) ||
    details.hostname.startsWith("docs.") ||
    details.pathname.includes("/docs") ||
    titleLower.includes("documentation") ||
    bodyLower.includes("api reference")
  ) {
    return "docs";
  }
  if (
    AI_DOMAINS.has(details.hostname) ||
    titleLower.includes("chatgpt") ||
    titleLower.includes("claude")
  ) {
    return "chat";
  }
  if (
    COMMERCE_DOMAINS.has(details.hostname) ||
    bodyLower.includes("add to cart") ||
    bodyLower.includes("buy now")
  ) {
    return "product";
  }
  if (event.full_text.length >= 700 || titleLower.includes("how to") || titleLower.includes("guide")) {
    return "article";
  }
  return "web";
}

function parseLyricsFacts(event) {
  const cleanedTitle = normalizeText(event.title, 160)
    .replace(/\((official )?lyrics?\)/gi, "")
    .replace(/\[(official )?lyrics?\]/gi, "")
    .trim();
  const parts = cleanedTitle.split(/\s+-\s+/).map((part) => normalizeText(part, 100)).filter(Boolean);
  const song = parts[0] || "";
  const artist = parts[1] || "";
  return { song, artist };
}

function primaryTopic(event) {
  const title = cleanTopic(event.title);
  if (title && title.length <= 120) {
    return title;
  }
  const phrase = normalizeText(event.keyphrases?.[0], 100);
  if (phrase) {
    return phrase;
  }
  return cleanTopic(event.domain || "");
}

function buildStructuredFacts(event, pageType) {
  const facts = [];

  if (pageType === "lyrics") {
    const { song, artist } = parseLyricsFacts(event);
    if (song) facts.push({ label: "Song", value: song });
    if (artist) facts.push({ label: "Artist", value: artist });
  } else if (pageType === "search") {
    const query = extractQueryFromEvent(event);
    if (query) facts.push({ label: "Query", value: query });
  } else if (pageType === "docs") {
    const topic = primaryTopic(event);
    if (topic) facts.push({ label: "Topic", value: topic });
  } else if (pageType === "qa") {
    const topic = primaryTopic(event);
    if (topic) facts.push({ label: "Question", value: topic });
  } else if (pageType === "discussion") {
    const topic = primaryTopic(event);
    if (topic) facts.push({ label: "Topic", value: topic });
  } else if (pageType === "video") {
    const topic = primaryTopic(event);
    if (topic) facts.push({ label: "Video", value: topic });
  } else if (pageType === "product") {
    const topic = primaryTopic(event);
    if (topic) facts.push({ label: "Product", value: topic });
  } else if (pageType === "chat") {
    const topic = primaryTopic(event);
    if (topic) facts.push({ label: "Topic", value: topic });
  } else {
    const topic = primaryTopic(event);
    if (topic) facts.push({ label: "Topic", value: topic });
  }

  const focus = normalizeText(event.keyphrases?.[0], 80);
  if (focus && !facts.some((fact) => fact.value.toLowerCase() === focus.toLowerCase())) {
    facts.push({ label: "Focus", value: focus });
  }

  return facts.slice(0, 3);
}

function buildStructuredSummary(event, pageType, facts) {
  const site = event.domain || "this site";
  const firstFact = facts[0]?.value || "";

  if (pageType === "lyrics") {
    const song = facts.find((fact) => fact.label === "Song")?.value || firstFact;
    const artist = facts.find((fact) => fact.label === "Artist")?.value || "";
    if (song && artist) {
      return `Lyrics page for "${song}" by ${artist}.`;
    }
    if (song) {
      return `Lyrics page for "${song}".`;
    }
    return `Lyrics page on ${site}.`;
  }

  if (pageType === "search") {
    const query = facts.find((fact) => fact.label === "Query")?.value || "";
    return query ? `Search results page for "${query}".` : `Search results page on ${site}.`;
  }

  if (pageType === "docs") {
    return firstFact ? `Documentation page about ${firstFact}.` : `Documentation page on ${site}.`;
  }

  if (pageType === "qa") {
    return firstFact ? `Question and answer page about ${firstFact}.` : `Question and answer page on ${site}.`;
  }

  if (pageType === "discussion") {
    return firstFact ? `Discussion page about ${firstFact}.` : `Discussion page on ${site}.`;
  }

  if (pageType === "video") {
    return firstFact ? `Video page for ${firstFact}.` : `Video page on ${site}.`;
  }

  if (pageType === "repo") {
    return firstFact ? `Repository page about ${firstFact}.` : `Repository page on ${site}.`;
  }

  if (pageType === "product") {
    return firstFact ? `Product page for ${firstFact}.` : `Product page on ${site}.`;
  }

  if (pageType === "chat") {
    return firstFact ? `Chat page about ${firstFact}.` : `Chat page on ${site}.`;
  }

  if (pageType === "social") {
    return firstFact ? `Social page about ${firstFact}.` : `Social page on ${site}.`;
  }

  return firstFact ? `Saved page about ${firstFact}.` : `Saved page on ${site}.`;
}

function isNoiseLine(line) {
  const lower = line.toLowerCase();
  if (!lower) {
    return true;
  }
  if (/^[\-=*_#|.]{6,}$/.test(line)) {
    return true;
  }
  if (/(click the bell|subscribe|background picture by|contact\/submissions|official site|follow us|stream now|sponsored|advertisement|loading public)/i.test(lower)) {
    return true;
  }
  if (/(this summary was generated by ai|based on sources|learn more about bing search results)/i.test(lower)) {
    return true;
  }
  if (/https?:\/\/\S+/i.test(line) && line.length < 180) {
    return true;
  }
  if (/@/.test(line) && lower.includes("contact")) {
    return true;
  }
  return false;
}

function buildDisplayExcerpt(event, pageType) {
  const sourceText = normalizeRichText(event.full_text || event.snippet, 0);
  if (!sourceText) {
    return "";
  }

  const cleanedLines = [];
  for (const rawLine of sourceText.split(/\n+/)) {
    let line = normalizeText(rawLine, 280);
    if (!line) {
      continue;
    }
    line = line.replace(/^lyrics\s*:\s*/i, "").trim();
    if (!line || isNoiseLine(line)) {
      continue;
    }
    if (cleanedLines[cleanedLines.length - 1]?.toLowerCase() === line.toLowerCase()) {
      continue;
    }
    cleanedLines.push(line);
  }

  if (!cleanedLines.length) {
    return compactText(event.snippet, 320);
  }

  const excerpt = pageType === "lyrics"
    ? cleanedLines.slice(0, 4).join(" ")
    : cleanedLines.slice(0, 3).join(" ");
  return compactText(excerpt, 340);
}

function sessionMode(events) {
  const browserish = events.filter((event) => event.domain).length;
  const codingish = events.filter((event) => EDITOR_APPS.has(event.application.toLowerCase())).length;
  if (codingish >= Math.max(1, Math.floor(events.length / 3))) {
    return "coding";
  }
  if (browserish >= Math.max(1, Math.floor(events.length / 2))) {
    return "reading";
  }
  return "activity";
}

function topKeyphrases(events, limit = TOP_KEYPHRASES) {
  const counts = new Map();
  for (const event of events) {
    for (const phrase of event.keyphrases || []) {
      const normalized = normalizeText(phrase, 80);
      if (!normalized) {
        continue;
      }
      counts.set(normalized, (counts.get(normalized) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, limit)
    .map(([phrase]) => phrase);
}

function buildSessionLabel(events, keyphrases) {
  const mode = sessionMode(events);
  if (keyphrases.length) {
    const lead = keyphrases[0];
    if (mode === "coding") {
      return compactText(`Working on ${lead}`, 64);
    }
    if (mode === "reading") {
      return compactText(`Reading about ${lead}`, 64);
    }
    return compactText(`Exploring ${lead}`, 64);
  }

  const domainCounts = new Map();
  const appCounts = new Map();
  for (const event of events) {
    if (event.domain) {
      domainCounts.set(event.domain, (domainCounts.get(event.domain) || 0) + 1);
    }
    if (event.application) {
      appCounts.set(event.application, (appCounts.get(event.application) || 0) + 1);
    }
  }
  const topDomain = [...domainCounts.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] || "";
  const topApp = [...appCounts.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] || "";

  if (topDomain && mode === "coding") {
    return compactText(`Coding from ${topDomain}`, 64);
  }
  if (topDomain) {
    return compactText(`Research in ${topDomain}`, 64);
  }
  if (topApp) {
    return compactText(`Using ${toTitleCase(topApp)}`, 64);
  }
  return "Local activity session";
}

function sessionContinuity(event, session, cosineSimilarity) {
  const gap = event.timestamp - session.endedTimestamp;
  if (gap < 0 || gap > SESSION_MAX_GAP_MS) {
    return false;
  }
  if (gap <= 8 * 60 * 1000) {
    return true;
  }

  const semantic = event.embedding.length && session.embedding.length
    ? cosineSimilarity(event.embedding, session.embedding)
    : 0;
  const sameDomain = event.domain && session.domains.has(event.domain);
  const sameApp = event.application && session.applications.has(event.application);
  const phraseOverlap = overlapCount(event.keyphrases, session.keyphrases) > 0;
  const titleOverlap = overlapCount(event.titleTokens, [...session.titleTokens]) > 0;

  if (gap > SESSION_TIMEOUT_MS) {
    return sameDomain && phraseOverlap;
  }
  return semantic >= SESSION_SEMANTIC_THRESHOLD || sameDomain || sameApp || phraseOverlap || titleOverlap;
}

function buildSessions(events, cosineSimilarity) {
  const ordered = [...events].sort((left, right) => left.timestamp - right.timestamp || left.id - right.id);
  const sessions = [];
  const eventToSession = new Map();
  let current = null;

  const finalizeCurrent = () => {
    if (!current || !current.events.length) {
      return;
    }
    current.keyphrases = topKeyphrases(current.events);
    current.label = buildSessionLabel(current.events, current.keyphrases);
    current.mode = sessionMode(current.events);
    current.foundationalEvents = [...current.events]
      .sort((left, right) => left.timestamp - right.timestamp)
      .slice(0, Math.min(2, current.events.length));
    sessions.push(current);
  };

  for (const event of ordered) {
    if (!current) {
      current = {
        id: sessions.length + 1,
        events: [event],
        started_at: event.occurred_at,
        ended_at: event.occurred_at,
        startedTimestamp: event.timestamp,
        endedTimestamp: event.timestamp,
        embedding: event.embedding,
        keyphrases: [...event.keyphrases],
        applications: new Set(event.application ? [event.application] : []),
        domains: new Set(event.domain ? [event.domain] : []),
        titleTokens: new Set(event.titleTokens || []),
      };
      eventToSession.set(event.id, current.id);
      continue;
    }

    if (!sessionContinuity(event, current, cosineSimilarity)) {
      finalizeCurrent();
      current = {
        id: sessions.length + 1,
        events: [event],
        started_at: event.occurred_at,
        ended_at: event.occurred_at,
        startedTimestamp: event.timestamp,
        endedTimestamp: event.timestamp,
        embedding: event.embedding,
        keyphrases: [...event.keyphrases],
        applications: new Set(event.application ? [event.application] : []),
        domains: new Set(event.domain ? [event.domain] : []),
        titleTokens: new Set(event.titleTokens || []),
      };
      eventToSession.set(event.id, current.id);
      continue;
    }

    current.events.push(event);
    current.ended_at = event.occurred_at;
    current.endedTimestamp = event.timestamp;
    current.embedding = averageVector(current.events.map((item) => item.embedding));
    current.keyphrases = topKeyphrases(current.events);
    if (event.application) {
      current.applications.add(event.application);
    }
    if (event.domain) {
      current.domains.add(event.domain);
    }
    for (const token of event.titleTokens || []) {
      current.titleTokens.add(token);
    }
    eventToSession.set(event.id, current.id);
  }

  finalizeCurrent();
  return { sessions, eventToSession };
}

function isDocsSession(session) {
  if ([...session.domains].some((domain) => DOC_DOMAINS.has(domain))) {
    return true;
  }
  return [...session.domains].some(
    (domain) => domain.startsWith("docs.") || domain.includes("readthedocs") || domain.startsWith("developer.")
  );
}

function causalBonus(source, target) {
  const sourceApps = [...source.applications].map((value) => value.toLowerCase());
  const sourceDomains = [...source.domains];
  const targetApps = [...target.applications].map((value) => value.toLowerCase());

  if (sourceDomains.some((domain) => AI_DOMAINS.has(domain)) && targetApps.some((app) => EDITOR_APPS.has(app))) {
    return { value: 0.3, type: "causal" };
  }
  if (sourceDomains.includes("github.com") && targetApps.some((app) => EDITOR_APPS.has(app) || TERMINAL_APPS.has(app))) {
    return { value: 0.28, type: "causal" };
  }
  if (sourceApps.some((app) => BROWSER_APPS.has(app)) && targetApps.some((app) => EDITOR_APPS.has(app) || TERMINAL_APPS.has(app))) {
    return { value: 0.22, type: "causal" };
  }
  if (isDocsSession(source) && targetApps.some((app) => EDITOR_APPS.has(app))) {
    return { value: 0.24, type: "causal" };
  }
  return { value: 0, type: "semantic" };
}

function buildSessionGraph(sessions, cosineSimilarity) {
  const ordered = [...sessions].sort((left, right) => left.startedTimestamp - right.startedTimestamp);
  const byId = new Map(ordered.map((session) => [session.id, session]));

  for (const session of ordered) {
    session.upstream = [];
    session.downstream = [];
    session.connected = [];
  }

  for (let index = 0; index < ordered.length; index += 1) {
    const source = ordered[index];
    for (let targetIndex = index + 1; targetIndex < ordered.length; targetIndex += 1) {
      const target = ordered[targetIndex];
      const gap = target.startedTimestamp - source.endedTimestamp;
      if (gap < 0) {
        continue;
      }
      if (gap > CHAIN_WINDOW_MS) {
        break;
      }

      const semantic = source.embedding.length && target.embedding.length
        ? cosineSimilarity(source.embedding, target.embedding)
        : 0;
      const phraseOverlap = overlapCount(source.keyphrases, target.keyphrases);
      const temporalBonus = gap <= 10 * 60 * 1000 && phraseOverlap > 0 ? 0.1 : 0;
      const causal = causalBonus(source, target);
      const strength = Math.min(1, Math.max(0, semantic) + causal.value + temporalBonus + phraseOverlap * 0.04);

      if (!(semantic >= CHAIN_THRESHOLD || causal.value > 0 || temporalBonus > 0)) {
        continue;
      }

      source.downstream.push({
        session_id: target.id,
        label: target.label,
        started_at: target.started_at,
        strength,
        link_type: causal.type,
      });
      target.upstream.push({
        session_id: source.id,
        label: source.label,
        started_at: source.started_at,
        strength,
        link_type: causal.type,
      });
    }
  }

  for (const session of ordered) {
    session.upstream.sort((left, right) => right.strength - left.strength);
    session.downstream.sort((left, right) => right.strength - left.strength);
    session.connected = [...session.upstream, ...session.downstream]
      .sort((left, right) => right.strength - left.strength)
      .slice(0, 6);
  }

  return byId;
}

function detectOperator(query) {
  const text = normalizeText(query).replace(/[?]+$/, "");
  const patterns = [
    { name: "before", regex: /^(?:what led to|what happened before)\s+(.+)$/i },
    { name: "after", regex: /^(?:what happened after|what came after)\s+(.+)$/i },
    { name: "connected", regex: /^(?:show everything connected to|show everything related to)\s+(.+)$/i },
    { name: "domain", regex: /^(?:show activity from|what was i reading on)\s+(.+)$/i },
    { name: "app", regex: /^(?:what was i doing in|what was i working in)\s+(.+)$/i },
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern.regex);
    if (match) {
      return {
        name: pattern.name,
        anchor: normalizeText(match[1]).replace(/^["']|["']$/g, ""),
      };
    }
  }
  return { name: "match", anchor: text };
}

async function rankEvents(text, events, embedText, cosineSimilarity, options = {}) {
  const normalizedText = normalizeText(text, 400);
  if (!normalizedText) {
    return [];
  }

  const queryEmbedding = await embedText(normalizedText);
  const tokens = meaningfulTokens(normalizedText);
  const domainHint = hostnameFromUrl(normalizedText) || "";
  const appHint = normalizeText(options.appHint).toLowerCase();
  const normalizedQueryLower = normalizedText.toLowerCase();
  const now = Date.now();

  const scored = events.map((event) => {
      const semantic = event.embedding.length ? cosineSimilarity(queryEmbedding, event.embedding) : 0;
      const titleLower = String(event.title || "").toLowerCase();
      const snippetLower = String(event.snippet || "").toLowerCase();
      const urlLower = canonicalUrl(event.url || "");
      const fullTextLower = String(event.full_text || "").toLowerCase();
      const contextLower = String(event.context_text || "").toLowerCase();
      const lexical = tokenCoverage(tokens, [
        event.title,
        event.snippet,
        event.full_text,
        event.url,
        event.domain,
        event.application,
        event.keyphrases.join(" "),
        event.context_text,
      ].join(" "));
      const titleBoost = tokenCoverage(tokens, event.title);
      const keyphraseBoost = tokenCoverage(tokens, event.keyphrases.join(" "));
      const fullTextBoost = tokenCoverage(tokens, event.full_text);
      const subjectBoost = tokenCoverage(tokens, event.context_subject);
      const entityBoost = tokenCoverage(tokens, event.context_entities.join(" "));
      const topicBoost = tokenCoverage(tokens, event.context_topics.join(" "));
      const factBoost = tokenCoverage(
        tokens,
        (event.fact_items || []).map((item) => `${item.label} ${item.value}`).join(" ")
      );
      const contextBoost = tokenCoverage(tokens, event.context_text);
      const exactTitleMatch = normalizedQueryLower && titleLower.includes(normalizedQueryLower) ? 1 : 0;
      const exactUrlMatch = normalizedQueryLower && urlLower.includes(normalizedQueryLower) ? 1 : 0;
      const exactSnippetMatch = normalizedQueryLower && snippetLower.includes(normalizedQueryLower) ? 1 : 0;
      const exactBodyMatch = normalizedQueryLower && fullTextLower.includes(normalizedQueryLower) ? 1 : 0;
      const exactSubjectMatch =
        normalizedQueryLower && contextLower.includes(normalizedQueryLower) ? 1 : 0;
      const domainBoost = domainHint && event.domain === domainHint ? 1 : 0;
      const appBoost = appHint && event.application.toLowerCase().includes(appHint) ? 1 : 0;
      const recencyDays = event.timestamp ? (now - event.timestamp) / (1000 * 60 * 60 * 24) : 999;
      const recencyBoost = event.timestamp ? Math.exp((-Math.log(2) * recencyDays) / 3) : 0;
      const searchResultsPenalty = isSearchResultsPage(event) ? 0.34 : 0;
      const score =
        semantic * 0.2 +
        lexical * 0.12 +
        titleBoost * 0.16 +
        keyphraseBoost * 0.05 +
        fullTextBoost * 0.05 +
        subjectBoost * 0.08 +
        entityBoost * 0.06 +
        topicBoost * 0.05 +
        factBoost * 0.05 +
        contextBoost * 0.08 +
        exactTitleMatch * 0.1 +
        exactSubjectMatch * 0.08 +
        exactUrlMatch * 0.04 +
        exactSnippetMatch * 0.03 +
        exactBodyMatch * 0.03 +
        domainBoost * 0.02 +
        appBoost * 0.02 +
        recencyBoost * 0.24 -
        searchResultsPenalty;
      return {
        ...event,
        similarity: semantic,
        lexical_score: lexical,
        recency_score: recencyBoost,
        exact_title_match: exactTitleMatch,
        exact_url_match: exactUrlMatch,
        context_score: contextBoost,
        score,
      };
    });

  const strongestDirectScore = scored.reduce((max, event) => {
    return isSearchResultsPage(event) ? max : Math.max(max, event.score);
  }, 0);

  return scored
    .map((event) => {
      if (!isSearchResultsPage(event)) {
        return event;
      }
      const demotion =
        strongestDirectScore && strongestDirectScore >= event.score - 0.06 ? 0.16 : 0;
      return {
        ...event,
        score: event.score - demotion,
        search_page_demotion: demotion,
      };
    })
    .filter(
      (event) =>
        event.score >= 0.14 ||
        event.lexical_score >= 0.22 ||
        event.exact_title_match > 0 ||
        event.exact_url_match > 0 ||
        event.context_score >= 0.26
    )
    .sort((left, right) => right.score - left.score || right.timestamp - left.timestamp);
}

function rerankWithSessionContext(events) {
  const sessionSignals = new Map();
  for (const event of events) {
    if (!event.session_id) {
      continue;
    }
    const current = sessionSignals.get(event.session_id) || { count: 0, topScore: 0, topRecency: 0 };
    current.count += 1;
    current.topScore = Math.max(current.topScore, event.score);
    current.topRecency = Math.max(current.topRecency, event.recency_score || 0);
    sessionSignals.set(event.session_id, current);
  }

  return events
    .map((event) => {
      const signal = sessionSignals.get(event.session_id);
      if (!signal) {
        return event;
      }
      const sessionBonus = Math.min(
        0.12,
        Math.max(0, signal.count - 1) * 0.028 +
          Math.max(0, signal.topScore - 0.2) * 0.08 +
          signal.topRecency * 0.02
      );
      return {
        ...event,
        session_context_bonus: sessionBonus,
        score: event.score + sessionBonus,
      };
    })
    .sort((left, right) => right.score - left.score || right.timestamp - left.timestamp);
}

async function rerankWithLocalJudge(events, embedText, cosineSimilarity, limit = 48) {
  const leading = events.slice(0, limit);
  const trailing = events.slice(limit);

  const judged = await Promise.all(
    leading.map(async (event) => {
      const localJudge =
        event.local_judge ||
        (await classifyLocalPage(event.context_profile || event, {
          embedText,
          cosineSimilarity,
        }));

      let adjustment = 0;
      if (localJudge?.qualityLabel === "shell") {
        adjustment = -0.34;
      } else if (localJudge?.qualityLabel === "search_results") {
        adjustment = -0.08;
      } else if (localJudge?.qualityLabel === "meaningful") {
        adjustment = 0.05;
      }

      return {
        ...event,
        local_judge: localJudge,
        local_quality_adjustment: adjustment,
        score: event.score + adjustment,
      };
    })
  );

  return [...judged, ...trailing]
    .filter((event) => !event.local_judge?.shouldSkip)
    .sort((left, right) => right.score - left.score || right.timestamp - left.timestamp);
}

function dedupeRankedEvents(events) {
  const buckets = new Map();
  for (const event of events) {
    const key = event.canonicalFingerprint || `${event.domain}|${event.title.toLowerCase()}`;
    const existing = buckets.get(key);
    if (!existing) {
      buckets.set(key, {
        representative: event,
        duplicate_count: 1,
        timestamps: [event.timestamp],
      });
      continue;
    }

    existing.duplicate_count += 1;
    existing.timestamps.push(event.timestamp);
    if (event.score > existing.representative.score) {
      existing.representative = event;
    }
  }

  return [...buckets.values()]
    .map((bucket) => ({
      ...bucket.representative,
      duplicate_count: bucket.duplicate_count,
      first_seen_at: new Date(Math.min(...bucket.timestamps.filter(Boolean))).toISOString(),
      last_seen_at: new Date(Math.max(...bucket.timestamps.filter(Boolean))).toISOString(),
    }))
    .sort((left, right) => right.score - left.score || right.timestamp - left.timestamp);
}

function sessionStory(session) {
  if (!session) {
    return "local activity";
  }
  const domain = [...session.domains][0] || "";
  const app = [...session.applications][0] || "";
  if (session.mode === "coding" && domain) {
    return `working from ${domain}`;
  }
  if (session.mode === "coding") {
    return `working in ${toTitleCase(app)}`;
  }
  if (session.mode === "reading" && domain) {
    return `reading on ${domain}`;
  }
  if (domain) {
    return `using ${domain}`;
  }
  if (app) {
    return `using ${toTitleCase(app)}`;
  }
  return "local activity";
}

function buildSessionSummary(session) {
  if (!session) {
    return "";
  }
  const parts = [`From session: ${session.label}`];
  if (session.events.length) {
    parts.push(`${session.events.length} events`);
  }
  if (session.upstream?.length) {
    parts.push(`${session.upstream.length} before`);
  }
  if (session.downstream?.length) {
    parts.push(`${session.downstream.length} after`);
  }
  if (session.foundationalEvents?.length) {
    parts.push(`${session.foundationalEvents.length} foundational`);
  }
  return parts.join(" - ");
}

function buildSessionPrompts(session) {
  if (!session) {
    return [];
  }
  const label = quoteLabel(shortLabel(session.label));
  const prompts = [];
  if (session.upstream?.length) {
    prompts.push(`What led to ${label}?`);
  }
  if (session.downstream?.length) {
    prompts.push(`What happened after ${label}?`);
  }
  if (!prompts.length) {
    prompts.push(`Show everything connected to ${label}`);
  }
  return prompts.slice(0, 2);
}

function buildRelatedQueries(primaryEvent, primarySession, operator) {
  const queries = buildSuggestionQueries({
    title: primaryEvent?.title,
    url: primaryEvent?.url,
    application: primaryEvent?.application,
    pageType: primaryEvent?.page_type,
    entities: primaryEvent?.context_entities || [],
    topics: primaryEvent?.context_topics || [],
    subject: primaryEvent?.context_subject || "",
    keyphrases: primaryEvent?.keyphrases || [],
  }).map((item) => item.query);
  if (primarySession && operator === "match") {
    queries.push(...buildSessionPrompts(primarySession));
  }
  return Array.from(new Set(queries.map((query) => normalizeText(query)).filter(Boolean))).slice(0, 3);
}

function decorateEvent(event, session) {
  const pageType = event.page_type || inferPageType(event);
  const factItems = Array.isArray(event.fact_items) && event.fact_items.length
    ? event.fact_items
    : buildStructuredFacts(event, pageType);
  return {
    ...event,
    page_type: pageType,
    page_type_label: event.page_type_label || pageTypeLabel(pageType),
    structured_summary: event.structured_summary || buildStructuredSummary(event, pageType, factItems),
    fact_items: factItems,
    display_excerpt: event.display_excerpt || buildDisplayExcerpt(event, pageType),
    display_url: event.display_url || canonicalUrl(event.url || ""),
    display_full_text: event.display_full_text || event.full_text || "",
    raw_full_text: event.raw_full_text || event.full_text || "",
    search_results: Array.isArray(event.search_results) ? event.search_results : [],
    session: session
      ? {
          id: session.id,
          label: session.label,
          event_count: session.events.length,
          started_at: session.started_at,
          ended_at: session.ended_at,
        }
      : null,
    before_context: session?.upstream?.[0]?.label || "",
    after_context: session?.downstream?.[0]?.label || "",
    moment_summary: session ? `${session.label}.` : "",
  };
}

function selectRepresentativeEvents(dedupedEvents, sessionsById, limit = 10) {
  const selected = [];
  const perSession = new Map();

  for (const event of dedupedEvents) {
    const sessionId = event.session_id || 0;
    const sessionCount = perSession.get(sessionId) || 0;
    if (sessionId && sessionCount >= 2) {
      continue;
    }
    selected.push(decorateEvent(event, sessionsById.get(sessionId) || null));
    perSession.set(sessionId, sessionCount + 1);
    if (selected.length >= limit) {
      break;
    }
  }

  return selected.slice(0, limit);
}

function buildMatchAnswer(query, results, primarySession) {
  const primary = results[0];
  if (!primary) {
    return {
      results: [],
      answer: {
        overview: "",
        answer: `No strong local match was found for "${query}".`,
        summary: "Try another phrase, or search by app or site.",
        detailItems: [],
        signals: [],
        sessionSummary: "",
        sessionPrompts: [],
        relatedQueries: [],
        detailsLabel: "",
      },
    };
  }

  const evidenceCount = results.reduce((total, event) => total + Math.max(1, Number(event.duplicate_count || 1)), 0);
  const detailItems = [
    primary.application ? { label: "App", value: toTitleCase(primary.application) } : null,
    primary.domain ? { label: "Site", value: primary.domain } : null,
    primary.occurred_at ? { label: "Captured", value: primary.occurred_at } : null,
    { label: "Evidence", value: `${evidenceCount} matching captures` },
  ].filter(Boolean);

  let summary = ensureSentence(
    primary.structured_summary ||
      (primary.domain ? `Saved page from ${primary.domain}` : "") ||
      "This is a strong local match"
  );
  if (primarySession) {
    summary = `${summary} The most relevant match came from the session ${quoteLabel(primarySession.label)}.`;
  }

  return {
    results,
    answer: {
      overview: `Top local match for "${query}"`,
      answer: primary.title,
      summary: compactText(summary, 280),
      detailItems,
      signals: primary.keyphrases.slice(0, 5),
      sessionSummary: buildSessionSummary(primarySession),
      sessionPrompts: buildSessionPrompts(primarySession),
      relatedQueries: buildRelatedQueries(primary, primarySession, "match"),
      detailsLabel: "Matching memories",
    },
  };
}

function buildSessionResults(sessionIds, sessionsById, rankedEvents, limit) {
  const rankedBySession = new Map();
  for (const event of rankedEvents) {
    if (!rankedBySession.has(event.session_id)) {
      rankedBySession.set(event.session_id, []);
    }
    rankedBySession.get(event.session_id).push(event);
  }

  const selected = [];
  const seenEventIds = new Set();
  for (const sessionId of sessionIds) {
    const session = sessionsById.get(sessionId) || null;
    const best = rankedBySession.get(sessionId)?.[0] || session?.events?.[0];
    if (!best || seenEventIds.has(best.id)) {
      continue;
    }
    selected.push(decorateEvent(best, session));
    seenEventIds.add(best.id);
    if (selected.length >= limit) {
      break;
    }
  }
  return selected;
}

function buildOperatorAnswer(operator, anchorLabel, anchorSession, relatedSessions, rankedEvents, limit) {
  const sessionsById = new Map([
    ...(anchorSession ? [[anchorSession.id, anchorSession]] : []),
    ...relatedSessions.map((session) => [session.id, session]),
  ]);
  const results = buildSessionResults(relatedSessions.map((session) => session.id), sessionsById, rankedEvents, limit);
  const quotedAnchor = quoteLabel(anchorLabel);

  const summaries = {
    before: relatedSessions.length
      ? `Found ${pluralize(relatedSessions.length, "related earlier session")} before ${quotedAnchor}.`
      : `No clear earlier session was found before ${quotedAnchor}.`,
    after: relatedSessions.length
      ? `Found ${pluralize(relatedSessions.length, "related session")} after ${quotedAnchor}.`
      : `No clear follow-up session was found after ${quotedAnchor}.`,
    connected: relatedSessions.length
      ? `Found ${pluralize(relatedSessions.length, "related session")} connected to ${quotedAnchor}.`
      : `No strong connected session was found for ${quotedAnchor}.`,
  };

  return {
    results,
    answer: {
      overview:
        operator === "before"
          ? `What led to ${quotedAnchor}`
          : operator === "after"
            ? `What happened after ${quotedAnchor}`
            : `Everything connected to ${quotedAnchor}`,
      answer: relatedSessions[0]?.label || anchorSession?.label || anchorLabel,
      summary: ensureSentence(summaries[operator]),
      detailItems: [
        { label: "Anchor", value: anchorLabel },
        {
          label: operator === "before" ? "Before" : operator === "after" ? "After" : "Connected",
          value: relatedSessions.length ? `${relatedSessions.length} linked sessions` : "No strong lead",
        },
        anchorSession?.started_at ? { label: "Captured", value: anchorSession.started_at } : null,
      ].filter(Boolean),
      signals: anchorSession?.keyphrases?.slice(0, 5) || [],
      sessionSummary: buildSessionSummary(anchorSession),
      sessionPrompts: buildSessionPrompts(anchorSession),
      relatedQueries: [],
      detailsLabel: "Matching memories",
    },
  };
}

function buildAggregateAnswer(queryLabel, label, sessions, rankedEvents, limit, kind) {
  const sessionsById = new Map(sessions.map((session) => [session.id, session]));
  const results = buildSessionResults(sessions.map((session) => session.id), sessionsById, rankedEvents, limit);
  const primary = sessions[0] || null;
  const totalEvents = sessions.reduce((total, session) => total + session.events.length, 0);

  return {
    results,
    answer: {
      overview: kind === "domain" ? `Activity from "${queryLabel}"` : `What you were doing in "${queryLabel}"`,
      answer: label,
      summary: primary
        ? `Found ${pluralize(sessions.length, "related session")} and ${pluralize(totalEvents, "captured moment")}. The most recent session is ${quoteLabel(primary.label)}.`
        : `Found local activity for ${label}.`,
      detailItems: [
        { label: kind === "domain" ? "Site" : "App", value: label },
        { label: "Sessions", value: `${sessions.length}` },
        { label: "Evidence", value: `${totalEvents} captured moments` },
        primary?.ended_at ? { label: "Last seen", value: primary.ended_at } : null,
      ].filter(Boolean),
      signals: primary?.keyphrases?.slice(0, 5) || [],
      sessionSummary: buildSessionSummary(primary),
      sessionPrompts: buildSessionPrompts(primary),
      relatedQueries: primary && results[0] ? buildRelatedQueries(results[0], primary, "match") : [],
      detailsLabel: "Matching memories",
    },
  };
}

export async function answerLocalQuery({ query, limit = 20, rawEvents, embedText, cosineSimilarity }) {
  const normalizedQuery = normalizeText(query, 400);
  if (!normalizedQuery) {
    return { results: [], answer: null };
  }

  const events = rawEvents
    .map(normalizeEvent)
    .filter(
      (event) =>
        event.timestamp &&
        !isInternalMemactEvent(event) &&
        !shouldSkipCaptureProfile(event.context_profile || event)
    );
  if (!events.length) {
    return { results: [], answer: null };
  }

  const { sessions, eventToSession } = buildSessions(events, cosineSimilarity);
  const sessionsById = buildSessionGraph(sessions, cosineSimilarity);

  for (const event of events) {
    event.session_id = eventToSession.get(event.id) || 0;
  }

  const operator = detectOperator(normalizedQuery);
  const initiallyRankedEvents = rerankWithSessionContext(
    await rankEvents(operator.anchor || normalizedQuery, events, embedText, cosineSimilarity, {
      appHint: operator.name === "app" ? operator.anchor : "",
    })
  );

  const qualityRankedEvents = await rerankWithLocalJudge(
    initiallyRankedEvents,
    embedText,
    cosineSimilarity
  );

  const rankedEventsAll = dedupeRankedEvents(qualityRankedEvents).map((event) => ({
    ...event,
    session_id: event.session_id || eventToSession.get(event.id) || 0,
  }));

  const directEvents = rankedEventsAll.filter((event) => !isSearchResultsPage(event));
  const rankedEvents = directEvents.length ? directEvents : rankedEventsAll;

  if (!rankedEvents.length) {
    return buildMatchAnswer(normalizedQuery, [], null);
  }

  const primaryEvent = rankedEvents[0];
  const primarySession = sessionsById.get(primaryEvent.session_id) || null;

  if (operator.name === "before" || operator.name === "after" || operator.name === "connected") {
    const relatedLinks = operator.name === "before"
      ? primarySession?.upstream || []
      : operator.name === "after"
        ? primarySession?.downstream || []
        : primarySession?.connected || [];
    const relatedSessions = relatedLinks
      .map((link) => sessionsById.get(link.session_id))
      .filter(Boolean);
    return buildOperatorAnswer(
      operator.name,
      shortLabel(primarySession?.label || primaryEvent.title || operator.anchor),
      primarySession,
      relatedSessions,
      rankedEvents,
      Math.min(limit, 10)
    );
  }

  if (operator.name === "domain") {
    const target = normalizeText(operator.anchor).toLowerCase();
    const matchedSessions = sessions
      .filter((session) => [...session.domains].some((domain) => domain.includes(target)))
      .sort((left, right) => right.endedTimestamp - left.endedTimestamp);
    if (matchedSessions.length) {
      return buildAggregateAnswer(operator.anchor, operator.anchor, matchedSessions, rankedEvents, Math.min(limit, 10), "domain");
    }
  }

  if (operator.name === "app") {
    const target = normalizeText(operator.anchor).toLowerCase();
    const matchedSessions = sessions
      .filter((session) => [...session.applications].some((application) => application.toLowerCase().includes(target)))
      .sort((left, right) => right.endedTimestamp - left.endedTimestamp);
    if (matchedSessions.length) {
      return buildAggregateAnswer(operator.anchor, toTitleCase(operator.anchor), matchedSessions, rankedEvents, Math.min(limit, 10), "app");
    }
  }

  const results = selectRepresentativeEvents(rankedEvents, sessionsById, Math.min(limit, 12));
  return buildMatchAnswer(normalizedQuery, results, primarySession);
}
