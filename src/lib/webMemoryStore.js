const WEB_MEMORY_KEY = 'memact.web-memories'
const MAX_WEB_MEMORIES = 180
const STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'did',
  'find',
  'for',
  'from',
  'how',
  'i',
  'in',
  'is',
  'it',
  'me',
  'my',
  'of',
  'on',
  'show',
  'that',
  'the',
  'this',
  'to',
  'was',
  'what',
  'where',
  'with',
  'you',
])

function normalize(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
}

function normalizeRichText(value) {
  const text = String(value || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const blocks = text
    .split(/\n{2,}/)
    .map((block) =>
      block
        .split(/\n+/)
        .map((line) => line.replace(/[ \t]+/g, ' ').trim())
        .filter(Boolean)
        .join('\n')
    )
    .filter(Boolean)
  return blocks.join('\n\n').trim()
}

function titleCase(value) {
  return String(value || '')
    .replace(/[_-]+/g, ' ')
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
}

function safeDate(value) {
  const timestamp = Date.parse(value || '')
  return Number.isFinite(timestamp) ? new Date(timestamp) : new Date()
}

function safeIso(value) {
  return safeDate(value).toISOString()
}

function memoryDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

function displayUrl(url) {
  try {
    const parsed = new URL(url)
    const pathname = parsed.pathname === '/' ? '' : parsed.pathname
    return `${parsed.hostname.replace(/^www\./, '')}${pathname}`
  } catch {
    return normalize(url)
  }
}

function monthKey(value) {
  const date = safeDate(value)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
}

function formatMonthLabel(value) {
  const date = safeDate(`${value}-01T12:00:00Z`)
  return new Intl.DateTimeFormat(undefined, {
    month: 'long',
    year: 'numeric',
  }).format(date)
}

function compactText(value, maxLength = 260) {
  const text = normalize(value)
  if (!text) return ''
  if (text.length <= maxLength) return text
  return `${text.slice(0, maxLength - 3).trim()}...`
}

function tokenize(value) {
  return Array.from(
    new Set(
      normalize(value)
        .toLowerCase()
        .replace(/[^a-z0-9@#./+-]+/g, ' ')
        .split(/\s+/)
        .filter((token) => token.length >= 2 && !STOPWORDS.has(token))
    )
  )
}

function memoryFingerprint(memory) {
  return [
    normalize(memory.url).toLowerCase(),
    normalize(memory.title).toLowerCase(),
    normalize(memory.full_text).slice(0, 220).toLowerCase(),
  ]
    .filter(Boolean)
    .join('|')
}

function readMemories() {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(WEB_MEMORY_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function writeMemories(memories) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(WEB_MEMORY_KEY, JSON.stringify(memories.slice(0, MAX_WEB_MEMORIES)))
  } catch {
    // Ignore storage failures in the fallback store.
  }
}

function readSharePayload(searchParams) {
  const payload = {
    url: normalize(searchParams.get('url') || searchParams.get('target_url')),
    title: normalize(searchParams.get('title')),
    text: normalizeRichText(searchParams.get('text') || searchParams.get('body') || searchParams.get('description')),
  }

  if (!payload.url && !payload.title && !payload.text) {
    return null
  }

  return payload
}

function stripShareParams() {
  if (typeof window === 'undefined') return
  const url = new URL(window.location.href)
  const keys = ['share', 'shared', 'url', 'target_url', 'title', 'text', 'body', 'description']
  let changed = false
  keys.forEach((key) => {
    if (url.searchParams.has(key)) {
      url.searchParams.delete(key)
      changed = true
    }
  })
  if (changed) {
    const next = `${url.pathname}${url.search}${url.hash}`
    window.history.replaceState({}, '', next)
  }
}

function buildMemoryFromShare(payload, environment) {
  const url = payload.url
  const domain = memoryDomain(url)
  const title =
    normalize(payload.title) ||
    (domain ? `${titleCase(domain)} page` : '') ||
    'Shared memory'
  const fullText = normalizeRichText(payload.text) || title
  const snippet = compactText(fullText, 300)
  const occurredAt = new Date().toISOString()
  const browserName = environment?.name || (environment?.mobile ? 'Phone browser' : 'Browser')

  return {
    id: `web-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    url,
    display_url: displayUrl(url),
    domain,
    application: browserName,
    occurred_at: occurredAt,
    interaction_type: environment?.mobile ? 'Share' : 'Save',
    window_title: title,
    title,
    content_text: snippet,
    full_text: fullText,
    raw_full_text: fullText,
    page_type: 'shared',
    page_type_label: 'Shared page',
    structured_summary: domain
      ? `Saved shared page from ${domain}.`
      : 'Saved shared memory on this device.',
    display_excerpt: snippet,
    fact_items: [
      { label: 'Source', value: domain || browserName },
      { label: 'Mode', value: environment?.mobile ? 'Phone browser' : 'Web browser' },
    ],
    context_subject: title,
    context_entities: [],
    context_topics: tokenize(title).slice(0, 4),
    search_results: [],
    source: 'web',
    duplicate_count: 1,
  }
}

function upsertMemory(memories, memory) {
  const next = [...memories]
  const fingerprint = memoryFingerprint(memory)
  const existingIndex = next.findIndex((entry) => memoryFingerprint(entry) === fingerprint)

  if (existingIndex >= 0) {
    const existing = next[existingIndex]
    next[existingIndex] = {
      ...existing,
      ...memory,
      id: existing.id || memory.id,
      duplicate_count: Math.max(1, Number(existing.duplicate_count || 1) + 1),
      occurred_at: memory.occurred_at,
    }
  } else {
    next.unshift(memory)
  }

  return next
    .sort((left, right) => Date.parse(right.occurred_at || '') - Date.parse(left.occurred_at || ''))
    .slice(0, MAX_WEB_MEMORIES)
}

function inTimeFilter(memory, timeFilter) {
  if (!timeFilter) return true
  const time = Date.parse(memory.occurred_at || '')
  if (!Number.isFinite(time)) return true
  const now = Date.now()
  const date = new Date(time)
  const today = new Date(now)

  if (timeFilter === 'today') {
    return (
      date.getFullYear() === today.getFullYear() &&
      date.getMonth() === today.getMonth() &&
      date.getDate() === today.getDate()
    )
  }

  if (timeFilter === 'yesterday') {
    const yesterday = new Date(now - 24 * 60 * 60 * 1000)
    return (
      date.getFullYear() === yesterday.getFullYear() &&
      date.getMonth() === yesterday.getMonth() &&
      date.getDate() === yesterday.getDate()
    )
  }

  const daysSince = (now - time) / (24 * 60 * 60 * 1000)
  if (timeFilter === 'this week') return daysSince <= 7
  if (timeFilter === 'last week') return daysSince > 7 && daysSince <= 14
  return true
}

function parseStructuredQuery(rawQuery) {
  const query = normalize(rawQuery)
  const lowered = query.toLowerCase()
  const domainMatch = lowered.match(/(?:show activity from|activity from|from)\s+("?)([^"]+)\1$/i)
  if (domainMatch?.[2]) {
    return { type: 'domain', value: normalize(domainMatch[2]) }
  }

  const monthMatch = query.match(/show memories from\s+(.+)$/i)
  if (monthMatch?.[1]) {
    return { type: 'month', value: normalize(monthMatch[1]) }
  }

  const topicMatch = query.match(/(?:what did i save about|where did i see|find)\s+("?)([^"]+)\1/i)
  if (topicMatch?.[2]) {
    return { type: 'topic', value: normalize(topicMatch[2]) }
  }

  return { type: 'match', value: query }
}

function recencyScore(value) {
  const time = Date.parse(value || '')
  if (!Number.isFinite(time)) return 0
  const days = Math.max(0, (Date.now() - time) / (24 * 60 * 60 * 1000))
  return 1 / (1 + days / 4)
}

function scoreMemory(memory, parsedQuery) {
  const value = normalize(parsedQuery.value)
  const loweredValue = value.toLowerCase()
  const title = normalize(memory.title).toLowerCase()
  const domain = normalize(memory.domain).toLowerCase()
  const url = normalize(memory.url).toLowerCase()
  const snippet = normalize(memory.content_text).toLowerCase()
  const fullText = normalize(memory.full_text).toLowerCase()
  const tokens = tokenize(value)

  if (parsedQuery.type === 'domain') {
    const exactDomain = domain === loweredValue || domain.includes(loweredValue)
    if (!exactDomain) return 0
    return 0.86 + recencyScore(memory.occurred_at) * 0.14
  }

  if (parsedQuery.type === 'month') {
    const memoryMonth = formatMonthLabel(monthKey(memory.occurred_at)).toLowerCase()
    if (memoryMonth !== loweredValue.toLowerCase()) return 0
    return 0.88 + recencyScore(memory.occurred_at) * 0.12
  }

  let score = 0
  if (title === loweredValue) score += 1
  if (title.includes(loweredValue)) score += 0.5
  if (domain === loweredValue || domain.includes(loweredValue)) score += 0.42
  if (url.includes(loweredValue)) score += 0.3
  if (snippet.includes(loweredValue)) score += 0.26
  if (fullText.includes(loweredValue)) score += 0.18

  if (tokens.length) {
    const titleHits = tokens.filter((token) => title.includes(token)).length / tokens.length
    const snippetHits = tokens.filter((token) => snippet.includes(token)).length / tokens.length
    const fullHits = tokens.filter((token) => fullText.includes(token)).length / tokens.length
    score += titleHits * 0.45 + snippetHits * 0.22 + fullHits * 0.16
  }

  score += recencyScore(memory.occurred_at) * 0.18
  return score
}

function buildAnswer(query, results, modeLabel) {
  const label = query || 'local memories'
  if (!results.length) {
    return {
      overview: `No local matches for "${label}"`,
      answer: '',
      summary:
        modeLabel === 'phone'
          ? 'No saved phone memories matched this search yet.'
          : 'No saved web memories matched this search yet.',
      detailItems: [{ label: 'Matches', value: '0' }],
      signals: [],
      sessionSummary: '',
      sessionPrompts: [],
      relatedQueries: [],
      detailsLabel: 'Matching memories',
    }
  }

  return {
    overview: `${results.length} local matches for "${label}"`,
    answer: results[0].title || label,
    summary:
      'Sorted by exact title, URL, and text match first, then by recency. Click any card to open the full saved memory.',
    detailItems: [
      { label: 'Mode', value: modeLabel === 'phone' ? 'Phone browser' : 'Web browser' },
      { label: 'Matches', value: String(results.length) },
    ],
    signals: [],
    sessionSummary: '',
    sessionPrompts: [],
    relatedQueries: [],
    detailsLabel: 'Matching memories',
  }
}

function suggestionMatch(candidate, query) {
  const loweredQuery = normalize(query).toLowerCase()
  if (!loweredQuery) return true
  return (
    candidate.title.toLowerCase().includes(loweredQuery) ||
    candidate.subtitle.toLowerCase().includes(loweredQuery) ||
    candidate.completion.toLowerCase().includes(loweredQuery)
  )
}

export function initializeWebMemoryStore(environment) {
  if (typeof window === 'undefined') {
    return { imported: false, memoryCount: 0 }
  }

  const url = new URL(window.location.href)
  const isShareRequest = url.searchParams.get('share') === '1' || url.searchParams.get('shared') === '1'
  const payload = readSharePayload(url.searchParams)

  if (!isShareRequest && !payload) {
    return { imported: false, memoryCount: readMemories().length }
  }

  if (!payload) {
    stripShareParams()
    return { imported: false, memoryCount: readMemories().length }
  }

  const memory = buildMemoryFromShare(payload, environment)
  const next = upsertMemory(readMemories(), memory)
  writeMemories(next)
  stripShareParams()
  return { imported: true, memoryCount: next.length }
}

export function webMemoryStatus(environment) {
  const count = readMemories().length
  return {
    ready: true,
    transport: 'web-fallback',
    mode: environment?.mobile ? 'phone' : 'web',
    memoryCount: count,
  }
}

export function webMemoryStats() {
  const memories = readMemories()
  return {
    eventsCount: memories.length,
    sessionsCount: memories.length,
  }
}

export function webMemorySuggestions(query = '', timeFilter = null, limit = 12) {
  const memories = readMemories().filter((memory) => inTimeFilter(memory, timeFilter))
  const counts = new Map()
  const latest = new Map()

  const addSuggestion = (key, suggestion) => {
    counts.set(key, (counts.get(key) || 0) + 1)
    const currentLatest = latest.get(key)
    const nextTime = Date.parse(suggestion.timestamp || '') || 0
    if (!currentLatest || nextTime > (Date.parse(currentLatest.timestamp || '') || 0)) {
      latest.set(key, suggestion)
    }
  }

  memories.forEach((memory) => {
    if (memory.domain) {
      addSuggestion(`domain:${memory.domain}`, {
        id: `domain:${memory.domain}`,
        category: 'Saved site',
        title: `Show activity from ${memory.domain}`,
        subtitle: `${memory.domain} saved locally on this device.`,
        completion: `Show activity from ${memory.domain}`,
        timestamp: memory.occurred_at,
      })
    }

    if (memory.title) {
      addSuggestion(`title:${memory.title}`, {
        id: `title:${memory.title}`,
        category: 'Saved page',
        title: `What did I save about "${compactText(memory.title, 46)}"?`,
        subtitle: compactText(memory.structured_summary || memory.content_text, 72) || 'Saved locally on this device.',
        completion: `What did I save about "${memory.title}"?`,
        timestamp: memory.occurred_at,
      })
    }

    addSuggestion(`month:${monthKey(memory.occurred_at)}`, {
      id: `month:${monthKey(memory.occurred_at)}`,
      category: 'Saved month',
      title: `Show memories from ${formatMonthLabel(monthKey(memory.occurred_at))}`,
      subtitle: `Memories saved in ${formatMonthLabel(monthKey(memory.occurred_at))}.`,
      completion: `Show memories from ${formatMonthLabel(monthKey(memory.occurred_at))}`,
      timestamp: memory.occurred_at,
    })
  })

  return [...latest.entries()]
    .map(([key, suggestion]) => ({
      ...suggestion,
      weight: counts.get(key) || 1,
    }))
    .filter((suggestion) => suggestionMatch(suggestion, query))
    .sort((left, right) => {
      if (right.weight !== left.weight) return right.weight - left.weight
      return (Date.parse(right.timestamp || '') || 0) - (Date.parse(left.timestamp || '') || 0)
    })
    .slice(0, limit)
    .map(({ weight, timestamp, ...rest }) => rest)
}

export function webMemorySearch(query, limit = 20, environment) {
  const parsedQuery = parseStructuredQuery(query)
  const modeLabel = environment?.mobile ? 'phone' : 'web'
  const ranked = readMemories()
    .map((memory) => ({
      ...memory,
      score: scoreMemory(memory, parsedQuery),
    }))
    .filter((memory) => memory.score >= 0.16)
    .sort((left, right) => right.score - left.score || Date.parse(right.occurred_at || '') - Date.parse(left.occurred_at || ''))
    .slice(0, limit)

  return {
    results: ranked,
    answer: buildAnswer(parsedQuery.value, ranked, modeLabel),
  }
}

export function clearWebMemories() {
  if (typeof window === 'undefined') {
    return { ok: true }
  }
  try {
    window.localStorage.removeItem(WEB_MEMORY_KEY)
    return { ok: true }
  } catch (error) {
    return { ok: false, error: String(error?.message || error || 'Could not clear local memories.') }
  }
}
