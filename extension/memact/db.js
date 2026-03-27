const DB_NAME = "memact-browser-memory";
const DB_VERSION = 1;

let dbPromise = null;

function openRequest(request) {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error));
  });
}

function txDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve());
    transaction.addEventListener("error", () => reject(transaction.error));
    transaction.addEventListener("abort", () => reject(transaction.error));
  });
}

export async function initDB() {
  if (dbPromise) {
    return dbPromise;
  }

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.addEventListener("upgradeneeded", () => {
      const db = request.result;

      if (!db.objectStoreNames.contains("events")) {
        const events = db.createObjectStore("events", {
          keyPath: "id",
          autoIncrement: true
        });
        events.createIndex("occurred_at", "occurred_at", { unique: false });
        events.createIndex("url", "url", { unique: false });
        events.createIndex("application", "application", { unique: false });
      }

      if (!db.objectStoreNames.contains("sessions")) {
        const sessions = db.createObjectStore("sessions", {
          keyPath: "id",
          autoIncrement: true
        });
        sessions.createIndex("label", "label", { unique: false });
        sessions.createIndex("started_at", "started_at", { unique: false });
        sessions.createIndex("updated_at", "updated_at", { unique: false });
      }

      if (!db.objectStoreNames.contains("settings")) {
        db.createObjectStore("settings", { keyPath: "key" });
      }
    });

    request.addEventListener("success", () => {
      const db = request.result;
      db.addEventListener("versionchange", () => {
        db.close();
      });
      resolve(db);
    });

    request.addEventListener("error", () => {
      reject(request.error);
    });
  });

  return dbPromise;
}

async function getDb() {
  return initDB();
}

function normalizeString(value) {
  return String(value || "").trim();
}

function toDateMs(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function averageVectors(vectors) {
  if (!vectors.length) {
    return [];
  }
  const dim = vectors[0].length || 0;
  if (!dim) {
    return [];
  }
  const output = new Array(dim).fill(0);
  for (const vector of vectors) {
    for (let i = 0; i < dim; i += 1) {
      output[i] += Number(vector[i] || 0);
    }
  }
  for (let i = 0; i < dim; i += 1) {
    output[i] /= vectors.length;
  }
  return output;
}

export function cosineSimilarity(a, b) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const length = Math.min(a?.length || 0, b?.length || 0);
  for (let i = 0; i < length; i += 1) {
    const av = Number(a[i] || 0);
    const bv = Number(b[i] || 0);
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB) || 1);
}

async function getSettingValue(key) {
  const db = await getDb();
  const tx = db.transaction("settings", "readonly");
  const store = tx.objectStore("settings");
  const request = store.get(key);
  const record = await openRequest(request);
  await txDone(tx).catch(() => {});
  return record ? record.value : undefined;
}

async function setSettingValue(key, value) {
  const db = await getDb();
  const tx = db.transaction("settings", "readwrite");
  tx.objectStore("settings").put({ key, value });
  await txDone(tx);
}

function deriveHostname(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function buildSessionLabel(event) {
  const application = normalizeString(event.application) || "browser";
  const host = deriveHostname(event.url);
  const hourBucket = new Date(event.occurred_at || Date.now()).toISOString().slice(0, 13);
  const labelBase = [application, host].filter(Boolean).join(" · ");
  return `${labelBase || application} · ${hourBucket}h`;
}

function buildSessionLabelText(event) {
  const application = normalizeString(event.application) || "browser";
  const host = deriveHostname(event.url);
  const hourBucket = new Date(event.occurred_at || Date.now()).toISOString().slice(0, 13);
  const labelBase = [application, host].filter(Boolean).join(" - ");
  return `${labelBase || application} - ${hourBucket}h`;
}

async function upsertSessionFromEvent(event) {
  const db = await getDb();
  const label = buildSessionLabelText(event);
  const keyphrases = JSON.parse(event.keyphrases_json || "[]");
  const embedding = JSON.parse(event.embedding_json || "[]");

  const tx = db.transaction(["sessions"], "readwrite");
  const store = tx.objectStore("sessions");
  const labelIndex = store.index("label");
  const existing = await openRequest(labelIndex.getAll(label));
  const now = normalizeString(event.occurred_at) || new Date().toISOString();

  if (existing.length) {
    const session = existing[0];
    const previousEmbedding = JSON.parse(session.embedding_json || "[]");
    const previousKeyphrases = JSON.parse(session.keyphrases_json || "[]");
    const mergedKeyphrases = Array.from(
      new Set([...previousKeyphrases, ...keyphrases].filter(Boolean))
    ).slice(0, 24);
    const count = Number(session.event_count || 0) + 1;
    const totalScore = Number(session.total_score || 0) + Math.min(1, (keyphrases.length || 0) / 12);
    const mergedEmbedding = previousEmbedding.length
      ? averageVectors([previousEmbedding, embedding])
      : embedding;
    store.put({
      ...session,
      label,
      ended_at: now,
      event_count: count,
      embedding_json: JSON.stringify(mergedEmbedding),
      keyphrases_json: JSON.stringify(mergedKeyphrases),
      total_score: totalScore,
      updated_at: now
    });
    await txDone(tx);
    return;
  }

  store.add({
    label,
    started_at: now,
    ended_at: now,
    event_count: 1,
    embedding_json: JSON.stringify(embedding),
    keyphrases_json: JSON.stringify(keyphrases.slice(0, 24)),
    total_score: Math.min(1, (keyphrases.length || 0) / 12),
    updated_at: now
  });
  await txDone(tx);
}

async function shouldSkipDuplicate(url, occurredAt) {
  if (!url) {
    return false;
  }
  const map = (await getSettingValue("last_capture_by_url")) || {};
  const last = Number(map[url] || 0);
  const now = toDateMs(occurredAt);
  return last && now && now - last < 60000;
}

async function rememberCapture(url, occurredAt) {
  if (!url) {
    return;
  }
  const map = (await getSettingValue("last_capture_by_url")) || {};
  map[url] = toDateMs(occurredAt) || Date.now();
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const [key, value] of Object.entries(map)) {
    if (Number(value || 0) < cutoff) {
      delete map[key];
    }
  }
  await setSettingValue("last_capture_by_url", map);
}

export async function appendEvent(eventData) {
  const db = await getDb();
  const occurredAt = normalizeString(eventData.occurred_at) || new Date().toISOString();
  const url = normalizeString(eventData.url);

  if (await shouldSkipDuplicate(url, occurredAt)) {
    return { skipped: true, reason: "duplicate_url_window" };
  }

  const event = {
    occurred_at: occurredAt,
    application: normalizeString(eventData.application),
    window_title: normalizeString(eventData.window_title),
    url,
    interaction_type: normalizeString(eventData.interaction_type),
    content_text: normalizeString(eventData.content_text),
    full_text: normalizeString(eventData.full_text),
    keyphrases_json: normalizeString(eventData.keyphrases_json) || "[]",
    searchable_text: normalizeString(eventData.searchable_text),
    embedding_json: normalizeString(eventData.embedding_json) || "[]",
    source: normalizeString(eventData.source) || "extension"
  };

  const tx = db.transaction(["events"], "readwrite");
  const store = tx.objectStore("events");
  const id = await openRequest(store.add(event));
  await txDone(tx);

  await rememberCapture(url, occurredAt);
  await upsertSessionFromEvent({ ...event, id }).catch(() => {});

  return { skipped: false, id };
}

export async function getRecentEvents(limit = 400) {
  const db = await getDb();
  const tx = db.transaction("events", "readonly");
  const store = tx.objectStore("events");
  const index = store.index("occurred_at");
  const results = [];

  await new Promise((resolve, reject) => {
    const request = index.openCursor(null, "prev");
    request.addEventListener("success", () => {
      const cursor = request.result;
      if (!cursor || results.length >= limit) {
        resolve();
        return;
      }
      results.push(cursor.value);
      cursor.continue();
    });
    request.addEventListener("error", () => reject(request.error));
  });

  await txDone(tx).catch(() => {});
  return results;
}

export async function getEventsByTimeRange(startAt, endAt, limit = 1200) {
  const db = await getDb();
  const tx = db.transaction("events", "readonly");
  const store = tx.objectStore("events");
  const index = store.index("occurred_at");
  const range = IDBKeyRange.bound(startAt, endAt);
  const results = [];

  await new Promise((resolve, reject) => {
    const request = index.openCursor(range, "prev");
    request.addEventListener("success", () => {
      const cursor = request.result;
      if (!cursor || results.length >= limit) {
        resolve();
        return;
      }
      results.push(cursor.value);
      cursor.continue();
    });
    request.addEventListener("error", () => reject(request.error));
  });

  await txDone(tx).catch(() => {});
  return results;
}

export async function getEventCount() {
  const db = await getDb();
  const tx = db.transaction("events", "readonly");
  const count = await openRequest(tx.objectStore("events").count());
  await txDone(tx).catch(() => {});
  return count || 0;
}

export async function getSessionCount() {
  const db = await getDb();
  const tx = db.transaction("sessions", "readonly");
  const count = await openRequest(tx.objectStore("sessions").count());
  await txDone(tx).catch(() => {});
  return count || 0;
}

export async function searchEventsByEmbedding(queryEmbedding, limit = 50) {
  const db = await getDb();
  const tx = db.transaction("events", "readonly");
  const store = tx.objectStore("events");
  const allEvents = await openRequest(store.getAll());
  await txDone(tx).catch(() => {});

  const scored = [];
  for (const event of allEvents || []) {
    const embedding = JSON.parse(event.embedding_json || "[]");
    if (!Array.isArray(embedding) || !embedding.length) {
      continue;
    }
    const similarity = cosineSimilarity(queryEmbedding, embedding);
    scored.push({ ...event, similarity });
  }
  scored.sort((left, right) => right.similarity - left.similarity);
  return scored.slice(0, limit);
}

export async function clearAllData() {
  const db = await getDb();
  const tx = db.transaction(["events", "sessions", "settings"], "readwrite");
  tx.objectStore("events").clear();
  tx.objectStore("sessions").clear();
  tx.objectStore("settings").clear();
  await txDone(tx);
}

export async function getStats() {
  const [eventCount, sessionCount] = await Promise.all([getEventCount(), getSessionCount()]);
  const recentEvents = await getRecentEvents(1).catch(() => []);
  return {
    eventCount,
    sessionCount,
    lastEventAt: recentEvents[0]?.occurred_at || null
  };
}
