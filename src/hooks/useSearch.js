import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { requestCloudExplanation } from '../lib/cloudExplanation'

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

function toTitleCase(value) {
  return String(value || '')
    .replace(/[_-]+/g, ' ')
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
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
    derivativeItems: Array.isArray(item?.derivative_items || item?.derivativeItems)
      ? (item?.derivative_items || item?.derivativeItems)
          .map((entry) => ({
            kind: normalize(entry?.kind),
            label: normalize(entry?.label),
            text: normalizeRichText(entry?.text),
          }))
          .filter((entry) => entry.text)
      : [],
    graphSummary: normalize(item?.graph_summary || item?.graphSummary),
    connectedEvents: Array.isArray(item?.connected_events || item?.connectedEvents)
      ? (item?.connected_events || item?.connectedEvents)
          .map((entry) => ({
            id: normalize(entry?.event_id || entry?.id),
            title: normalize(entry?.title),
            url: normalize(entry?.url),
            domain: normalize(entry?.domain),
            application: normalize(entry?.application),
            occurred_at: normalize(entry?.occurred_at),
            pageType: normalize(entry?.page_type || entry?.pageType),
            relationshipType: normalize(entry?.relationship_type || entry?.relationshipType),
            relationshipLabel:
              normalize(entry?.relationship_label || entry?.relationshipLabel) ||
              normalize(entry?.relationship_type || entry?.relationshipType),
            relationshipScore: Number(entry?.relationship_score ?? entry?.relationshipScore ?? 0),
            relationshipReason:
              normalize(entry?.relationship_reason || entry?.relationshipReason),
            direction: normalize(entry?.direction),
          }))
          .filter((entry) => entry.title)
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

function pushSuggestionItem(items, seen, entry) {
  const normalized = normalizeSuggestion(entry, items.length)
  if (!normalized) {
    return
  }

  const key = normalized.completion.toLowerCase()
  if (seen.has(key)) {
    return
  }

  seen.add(key)
  items.push(normalized)
}

function buildSearchDrivenSuggestions(query, answerMeta, results, limit = SUGGESTION_LIMIT) {
  const items = []
  const seen = new Set()
  const normalizedQuery = normalize(query)
  const primary = results?.[0]

  for (const value of answerMeta?.relatedQueries || []) {
    pushSuggestionItem(items, seen, {
      id: `related-${value}`,
      category: 'Related query',
      title: value,
      subtitle: primary?.title
        ? `Based on ${primary.title}`
        : 'Based on strong local matches.',
      completion: value,
    })
  }

  for (const value of answerMeta?.sessionPrompts || []) {
    pushSuggestionItem(items, seen, {
      id: `session-${value}`,
      category: 'Connected evidence',
      title: value,
      subtitle: primary?.graphSummary || 'Connected local evidence.',
      completion: value,
    })
  }

  if (primary?.domain) {
    pushSuggestionItem(items, seen, {
      id: `domain-${primary.domain}`,
      category: 'Matched site',
      title: `Show sources from ${primary.domain}`,
      subtitle: primary.title || 'Related evidence.',
      completion: `Show sources from ${primary.domain}`,
    })
  }

  if (primary?.application) {
    const app = toTitleCase(primary.application)
    pushSuggestionItem(items, seen, {
      id: `app-${primary.application}`,
      category: 'Matched app',
      title: `What was I doing in ${app}?`,
      subtitle: primary.domain || primary.title || 'Related evidence.',
      completion: `What was I doing in ${app}?`,
    })
  }

  if (primary?.contextSubject && primary.contextSubject.toLowerCase() !== normalizedQuery.toLowerCase()) {
    pushSuggestionItem(items, seen, {
      id: `subject-${primary.contextSubject}`,
      category: 'Matched topic',
      title: `What did I read about "${primary.contextSubject}"?`,
      subtitle: primary.pageTypeLabel || primary.domain || 'Related evidence.',
      completion: `What did I read about "${primary.contextSubject}"?`,
    })
  }

  if (primary?.title && primary.title.toLowerCase() !== normalizedQuery.toLowerCase()) {
    pushSuggestionItem(items, seen, {
      id: `title-${primary.title}`,
      category: 'Matched page',
      title: `Where did I see "${primary.title}"?`,
      subtitle: primary.domain || primary.pageTypeLabel || 'Related evidence.',
      completion: `Where did I see "${primary.title}"?`,
    })
  }

  return items.slice(0, limit)
}

function mergeSuggestionCollections(collections = [], limit = SUGGESTION_LIMIT) {
  const items = []
  const seen = new Set()

  for (const collection of collections) {
    for (const entry of Array.isArray(collection) ? collection : []) {
      pushSuggestionItem(items, seen, entry)
      if (items.length >= limit) {
        return items
      }
    }
  }

  return items
}

function suggestionMatches(item, query) {
  const normalizedQuery = normalize(query).toLowerCase()
  if (!normalizedQuery) {
    return true
  }

  const haystack = [
    item?.title,
    item?.subtitle,
    item?.completion,
    item?.category,
  ]
    .map((value) => normalize(value).toLowerCase())
    .join(' ')

  return normalizedQuery
    .split(/\s+/)
    .filter(Boolean)
    .every((token) => haystack.includes(token))
}

function filterSuggestions(items, query, limit = SUGGESTION_LIMIT) {
  return items.filter((item) => suggestionMatches(item, query)).slice(0, limit)
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
  const latestSearchRef = useRef(0)
  const suggestionCacheRef = useRef(new Map())
  const suggestionRequestRef = useRef(0)
  const broadSuggestionsRef = useRef([])
  const resultCacheRef = useRef(new Map())

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
      const knowledgeSuggestions = Array.isArray(extension?.knowledge?.suggestionSeed)
        ? extension.knowledge.suggestionSeed.map(normalizeSuggestion).filter(Boolean)
        : []
      setSuggestions(knowledgeSuggestions.slice(0, SUGGESTION_LIMIT))
      return undefined
    }

    let cancelled = false
    const normalizedQuery = normalize(query)
    const cacheKey = `${activeTimeFilter || 'all'}::${normalizedQuery.toLowerCase()}`
    const broadKey = `${activeTimeFilter || 'all'}::`
    const cachedItems = suggestionCacheRef.current.get(cacheKey)
    const broadItems =
      suggestionCacheRef.current.get(broadKey) ||
      broadSuggestionsRef.current ||
      []

    if (cachedItems?.length) {
      setSuggestions(cachedItems)
    } else if (normalizedQuery && broadItems.length) {
      setSuggestions(filterSuggestions(broadItems, normalizedQuery))
    } else if (!normalizedQuery && broadItems.length) {
      setSuggestions(broadItems)
    } else {
      setSuggestions([])
    }

    const requestId = suggestionRequestRef.current + 1
    suggestionRequestRef.current = requestId

    const timer = window.setTimeout(async () => {
      const tasks = [
        Promise.resolve(
          extension.getSuggestions(query, activeTimeFilter, SUGGESTION_LIMIT)
        ).catch(() => null),
      ]

      if (normalizedQuery.length >= 2 && typeof extension.search === 'function') {
        tasks.push(Promise.resolve(extension.search(normalizedQuery, 8)).catch(() => null))
      }

      const [suggestionResponse, searchResponse] = await Promise.all(tasks)
      if (cancelled || suggestionRequestRef.current !== requestId) {
        return
      }

      const rawSuggestionItems = Array.isArray(suggestionResponse)
        ? suggestionResponse
        : Array.isArray(suggestionResponse?.results)
          ? suggestionResponse.results
          : []
      const normalizedItems = rawSuggestionItems.map(normalizeSuggestion).filter(Boolean)

      let searchDrivenItems = []
      if (searchResponse && !searchResponse.error) {
        const resultItems = Array.isArray(searchResponse?.results)
          ? searchResponse.results.map(normalizeResult)
          : Array.isArray(searchResponse)
            ? searchResponse.map(normalizeResult)
            : []
        const deterministicAnalysis = normalizedQuery
          ? extension?.analyzeThought?.(normalizedQuery)
          : null
        const answer =
          normalizeAnswerMeta(deterministicAnalysis?.answer) ||
          normalizeAnswerMeta(searchResponse?.answer)
        searchDrivenItems = buildSearchDrivenSuggestions(
          normalizedQuery,
          answer,
          resultItems,
          SUGGESTION_LIMIT
        )

        if (resultItems.length || answer) {
          resultCacheRef.current.set(cacheKey, {
            results: resultItems,
            answerMeta: answer,
          })
        }
      }

      const mergedItems = []
      const seen = new Set()
      for (const item of [...searchDrivenItems, ...normalizedItems]) {
        pushSuggestionItem(mergedItems, seen, item)
      }

      const knowledgeItems = Array.isArray(extension?.knowledge?.suggestionSeed)
        ? extension.knowledge.suggestionSeed.map(normalizeSuggestion).filter(Boolean)
        : []
      const mergedCollections = mergeSuggestionCollections(
        [mergedItems, knowledgeItems],
        SUGGESTION_LIMIT
      )
      const finalItems = normalizedQuery
        ? filterSuggestions(mergedCollections, normalizedQuery)
        : mergedCollections.slice(0, SUGGESTION_LIMIT)

      suggestionCacheRef.current.set(cacheKey, finalItems)

      if (!normalizedQuery) {
        suggestionCacheRef.current.set(broadKey, finalItems)
        broadSuggestionsRef.current = finalItems
      } else if (finalItems.length > broadSuggestionsRef.current.length) {
        broadSuggestionsRef.current = finalItems
      }

      setSuggestions(finalItems)
    }, normalizedQuery.length >= 2 ? 70 : 0)

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
      const cacheKey = `${activeTimeFilter || 'all'}::${normalized.toLowerCase()}`
      const searchId = latestSearchRef.current + 1
      latestSearchRef.current = searchId
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

      const cached = resultCacheRef.current.get(cacheKey)
      if (cached) {
        setResults(cached.results)
        setAnswerMeta(cached.answerMeta)
      }

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
        const normalizedAnswerMeta = normalizeAnswerMeta(response?.answer)
        const deterministicAnalysis = extension?.analyzeThought?.(normalized)
        const deterministicAnswerMeta = normalizeAnswerMeta(deterministicAnalysis?.answer)
        resultCacheRef.current.set(cacheKey, {
          results: normalizedResults,
          answerMeta: deterministicAnswerMeta || normalizedAnswerMeta,
        })
        setAnswerMeta(deterministicAnswerMeta || normalizedAnswerMeta)
        setResults(normalizedResults)

        if (deterministicAnswerMeta || normalizedAnswerMeta) {
          void requestCloudExplanation({
            query: normalized,
            explanation: deterministicAnalysis?.explanation,
            answerMeta: deterministicAnswerMeta || normalizedAnswerMeta,
            results: normalizedResults,
          }).then((structured) => {
            if (
              !structured ||
              latestSearchRef.current !== searchId
            ) {
              return
            }

            setAnswerMeta((current) => {
              if (!current) {
                return current
              }

              return {
                ...current,
                overview: structured.overview || current.overview,
                answer: structured.answer || current.answer,
                summary: structured.summary || current.summary,
                answeredByCloudModel: Boolean(structured.applied),
                cloudProvider: structured.provider,
                cloudModel: structured.model,
              }
            })
          })
        }

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
    [activeTimeFilter, extension, persistSearch]
  )

  const restoreSearchState = useCallback((snapshot = {}) => {
    latestSearchRef.current += 1
    setLoading(false)
    setError('')
    setQuery(normalize(snapshot.query || snapshot.lastSubmittedQuery))
    setResults(Array.isArray(snapshot.results) ? snapshot.results : [])
    setAnswerMeta(snapshot.answerMeta || null)
  }, [])

  const clearResults = useCallback(() => {
    latestSearchRef.current += 1
    setLoading(false)
    setError('')
    setResults([])
    setAnswerMeta(null)
  }, [])

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
    restoreSearchState,
    removeHistoryQuery,
    clearHistory,
    clearResults,
  }
}
