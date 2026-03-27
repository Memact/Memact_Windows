import { useCallback, useEffect, useMemo, useState } from 'react'

const RECENT_SEARCHES_KEY = 'memact.recent-searches'
const MAX_RECENTS = 10
const SUGGESTION_LIMIT = 12

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

function toHistoryEntry(entry) {
  if (typeof entry === 'string') {
    const query = normalize(entry)
    return query ? { query, timestamp: '' } : null
  }

  if (!entry || typeof entry !== 'object') {
    return null
  }

  const query = normalize(entry.query)
  if (!query) {
    return null
  }

  const timestamp = normalize(entry.timestamp)
  return { query, timestamp }
}

function readRecentSearches() {
  try {
    const raw = window.localStorage.getItem(RECENT_SEARCHES_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    if (!Array.isArray(parsed)) {
      return []
    }
    return parsed
      .map(toHistoryEntry)
      .filter(Boolean)
      .slice(0, MAX_RECENTS)
  } catch {
    return []
  }
}

function writeRecentSearches(items) {
  try {
    window.localStorage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(items.slice(0, MAX_RECENTS)))
  } catch {
    // Ignore storage failures.
  }
}

function formatDomain(url, fallback = '') {
  try {
    return url ? new URL(url).hostname.replace(/^www\./, '') : fallback
  } catch {
    return fallback
  }
}

function formatMetaValue(label, value) {
  const normalizedLabel = normalize(label).toLowerCase()
  const normalizedValue = normalize(value)
  if (!normalizedValue) {
    return ''
  }

  if (['captured', 'started', 'ended', 'last seen'].includes(normalizedLabel)) {
    const timestamp = Date.parse(normalizedValue)
    if (Number.isFinite(timestamp)) {
      try {
        return new Intl.DateTimeFormat(undefined, {
          month: 'short',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
        })
          .format(new Date(timestamp))
          .replace(',', ' \u2022')
      } catch {
        return normalizedValue
      }
    }
  }

  return normalizedValue
}

function normalizeResult(item, index = 0) {
  const url = normalize(item?.url)
  const domain = formatDomain(url, normalize(item?.domain || item?.application))
  const title =
    normalize(item?.window_title || item?.title || item?.pageTitle || item?.name) ||
    domain ||
    'Memory'

  const rawFullText = normalizeRichText(item?.raw_full_text || item?.rawFullText || item?.full_text || item?.fullText)
  const displayFullText = normalizeRichText(
    item?.display_full_text || item?.displayFullText || rawFullText
  )
  const snippet = normalize(
    item?.content_text ||
      item?.snippet ||
      item?.summary_snippet ||
      displayFullText ||
      item?.searchable_text
  )

  const keyphrases = (() => {
    const raw = item?.keyphrases_json || item?.keyphrases || '[]'
    if (Array.isArray(raw)) return raw.filter(Boolean)
    try {
      const parsed = JSON.parse(raw)
      return Array.isArray(parsed) ? parsed.filter(Boolean) : []
    } catch {
      return []
    }
  })()

  return {
    id: item?.id || `${index}-${title}`,
    title,
    url,
    displayUrl: normalize(item?.display_url || item?.displayUrl || url),
    domain,
    application: normalize(item?.application) || 'Browser',
    occurred_at: item?.occurred_at || item?.captured_at || '',
    snippet,
    fullText: displayFullText,
    rawFullText,
    keyphrases,
    similarity: Number(item?.similarity || item?.score || 0),
    session: item?.session || item?.episode || null,
    source: item?.source || item?.source_type || 'extension',
    interactionType: item?.interaction_type || '',
    duplicateCount: Math.max(1, Number(item?.duplicate_count || item?.duplicateCount || 1)),
    beforeContext: normalize(item?.before_context || item?.beforeContext),
    afterContext: normalize(item?.after_context || item?.afterContext),
    momentSummary: normalize(item?.moment_summary || item?.momentSummary),
    pageType: normalize(item?.page_type || item?.pageType),
    pageTypeLabel: normalize(item?.page_type_label || item?.pageTypeLabel),
    structuredSummary: normalize(item?.structured_summary || item?.structuredSummary),
    displayExcerpt: normalize(item?.display_excerpt || item?.displayExcerpt),
    contextSubject: normalize(item?.context_subject || item?.contextSubject),
    contextEntities: Array.isArray(item?.context_entities || item?.contextEntities)
      ? (item?.context_entities || item?.contextEntities).map((value) => normalize(value)).filter(Boolean)
      : [],
    contextTopics: Array.isArray(item?.context_topics || item?.contextTopics)
      ? (item?.context_topics || item?.contextTopics).map((value) => normalize(value)).filter(Boolean)
      : [],
    factItems: Array.isArray(item?.fact_items || item?.factItems)
      ? (item?.fact_items || item?.factItems)
          .map((entry) => ({
            label: normalize(entry?.label),
            value: normalize(entry?.value),
          }))
          .filter((entry) => entry.label && entry.value)
      : [],
    searchResults: Array.isArray(item?.search_results || item?.searchResults)
      ? (item?.search_results || item?.searchResults).map((value) => normalize(value)).filter(Boolean)
      : [],
    raw: item || {},
  }
}

function normalizeSuggestion(item, index = 0) {
  const completion = normalize(item?.completion || item?.title || item)
  if (!completion) {
    return null
  }

  return {
    id: normalize(item?.id) || `suggestion-${index}-${completion.toLowerCase()}`,
    category: normalize(item?.category) || 'Recent activity',
    title: normalize(item?.title) || completion,
    subtitle: normalize(item?.subtitle) || 'Activity captured locally on this device.',
    completion,
  }
}

function normalizeAnswerMeta(item) {
  if (!item || typeof item !== 'object') {
    return null
  }

  const detailItems = Array.isArray(item.detailItems)
    ? item.detailItems
        .map((entry) => ({
          label: normalize(entry?.label),
          value: formatMetaValue(entry?.label, entry?.value),
        }))
        .filter((entry) => entry.label && entry.value)
    : []

  const signals = Array.isArray(item.signals)
    ? item.signals.map((value) => normalize(value)).filter(Boolean)
    : []

  const relatedQueries = Array.isArray(item.relatedQueries)
    ? item.relatedQueries.map((value) => normalize(value)).filter(Boolean)
    : []

  const sessionPrompts = Array.isArray(item.sessionPrompts)
    ? item.sessionPrompts.map((value) => normalize(value)).filter(Boolean)
    : []

  return {
    overview: normalize(item.overview),
    answer: normalize(item.answer),
    summary: normalize(item.summary),
    detailsLabel: normalize(item.detailsLabel) || 'Show top matches',
    detailItems,
    signals,
    sessionSummary: normalize(item.sessionSummary),
    sessionPrompts,
    relatedQueries,
  }
}

export function useSearch(extension, activeTimeFilter = null) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [recentEntries, setRecentEntries] = useState([])
  const [stats, setStats] = useState(null)
  const [status, setStatus] = useState(null)
  const [suggestions, setSuggestions] = useState([])
  const [answerMeta, setAnswerMeta] = useState(null)

  useEffect(() => {
    if (typeof window === 'undefined') return
    setRecentEntries(readRecentSearches())
  }, [])

  useEffect(() => {
    if (!extension?.detected) {
      return
    }

    let cancelled = false
    Promise.all([extension.getStatus(), extension.getStats()]).then(([statusResult, statsResult]) => {
      if (cancelled) return
      setStatus(statusResult && !statusResult.error ? statusResult : null)
      setStats(statsResult && !statsResult.error ? statsResult : null)
    })

    return () => {
      cancelled = true
    }
  }, [extension])

  useEffect(() => {
    if (!extension?.detected || typeof extension.getSuggestions !== 'function') {
      setSuggestions([])
      return undefined
    }

    let cancelled = false
    const timer = window.setTimeout(async () => {
      const response = await extension.getSuggestions(query, activeTimeFilter, SUGGESTION_LIMIT)
      if (cancelled) {
        return
      }

      const items = Array.isArray(response)
        ? response
        : Array.isArray(response?.results)
          ? response.results
          : []

      setSuggestions(items.map(normalizeSuggestion).filter(Boolean))
    }, query.trim() ? 140 : 60)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [activeTimeFilter, extension, query])

  const persistSearch = useCallback((value) => {
    const normalized = normalize(value)
    if (!normalized) return

    setRecentEntries((current) => {
      const timestamp = new Date().toISOString()
      const next = [
        { query: normalized, timestamp },
        ...current.filter((entry) => entry.query.toLowerCase() !== normalized.toLowerCase()),
      ].slice(0, MAX_RECENTS)
      writeRecentSearches(next)
      return next
    })
  }, [])

  const removeHistoryQuery = useCallback((value) => {
    const normalized = normalize(value).toLowerCase()
    if (!normalized) return

    setRecentEntries((current) => {
      const next = current.filter((entry) => entry.query.toLowerCase() !== normalized)
      writeRecentSearches(next)
      return next
    })
  }, [])

  const clearHistory = useCallback(() => {
    writeRecentSearches([])
    setRecentEntries([])
  }, [])

  const runSearch = useCallback(
    async (value) => {
      const normalized = normalize(value)
      if (!normalized) {
        setResults([])
        setAnswerMeta(null)
        setError('')
        return []
      }

      if (!extension?.detected) {
        setError('Memact extension is not connected.')
        setResults([])
        setAnswerMeta(null)
        return []
      }

      setLoading(true)
      setError('')
      persistSearch(normalized)

      try {
        const response = await extension.search(normalized, 20)
        if (!response || response.error) {
          throw new Error(response?.error || 'Search failed.')
        }

        const items = Array.isArray(response)
          ? response
          : Array.isArray(response?.results)
            ? response.results
            : []

        const normalizedResults = items.map(normalizeResult)
        setAnswerMeta(normalizeAnswerMeta(response?.answer))
        setResults(normalizedResults)
        return normalizedResults
      } catch (err) {
        setError(err?.message || 'Search failed.')
        setResults([])
        setAnswerMeta(null)
        return []
      } finally {
        setLoading(false)
      }
    },
    [extension, persistSearch]
  )

  const recentSearches = useMemo(
    () => recentEntries.map((entry) => entry.query),
    [recentEntries]
  )

  return {
    query,
    setQuery,
    results,
    loading,
    error,
    status,
    stats,
    suggestions,
    answerMeta,
    recentEntries,
    recentSearches,
    runSearch,
    removeHistoryQuery,
    clearHistory,
    clearResults: () => {
      setResults([])
      setAnswerMeta(null)
    },
  }
}
