import { useEffect, useMemo, useRef, useState } from 'react'
import MathRichText from '../components/MathRichText'
import SearchBar from '../components/SearchBar'
import { useSearch } from '../hooks/useSearch'

function normalize(value) {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

function openExternal(url) {
  if (!url || typeof window === 'undefined') return
  window.open(url, '_blank', 'noreferrer')
}

function domainFromResult(result) {
  if (result?.domain) return result.domain
  if (!result?.url) return 'evidence source'

  try {
    return new URL(result.url).hostname.replace(/^www\./, '')
  } catch {
    return 'evidence source'
  }
}

function compactText(value, maxLength = 190) {
  const text = normalize(value)
  if (!text) return ''
  if (text.length <= maxLength) return text
  return `${text.slice(0, maxLength - 3).trim()}...`
}

function buildStatus(extension, search, submittedQuery) {
  if (search.loading) return 'Finding sources...'
  if (search.error) return search.error
  if (submittedQuery && search.results.length) return `${search.results.length} source candidates`
  if (submittedQuery) return 'No strong source match yet'
  if (extension?.requiresBridge) return 'Connect Capture for thought suggestions'
  return 'Ready'
}

function buildAnswerText(query, answerMeta, results) {
  const answer = normalize(answerMeta?.answer)
  const summary = normalize(answerMeta?.summary || answerMeta?.overview)

  if (summary) return summary
  if (answer) return answer

  if (!results.length) {
    return 'Memact did not find strong enough sources for this thought yet.'
  }

  const primary = results[0]
  const secondary = results[1]
  const primaryTitle = primary?.title || domainFromResult(primary)
  const secondaryTitle = secondary?.title || domainFromResult(secondary)

  if (secondary) {
    return `The strongest source candidate is ${primaryTitle} [1]. A related source also appears in ${secondaryTitle} [2].`
  }

  return `The strongest source candidate is ${primaryTitle} [1].`
}

function buildActivitySuggestions(search) {
  return search.suggestions
}

function buildEmptySuggestionMessage(extension) {
  if (extension?.requiresBridge) {
    return 'No thought suggestions yet. Connect Capture to generate suggestions from your digital activity.'
  }

  return 'No thought suggestions yet. Once there is enough evidence, suggestions will appear here.'
}

function BackIcon() {
  return (
    <svg className="control-icon control-icon--arrow" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M18 12H6.5" />
      <path d="M11.5 7 6.5 12l5 5" />
    </svg>
  )
}

function ForwardIcon() {
  return (
    <svg className="control-icon control-icon--arrow" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6 12h11.5" />
      <path d="m12.5 7 5 5-5 5" />
    </svg>
  )
}

function ReloadIcon() {
  return (
    <svg className="control-icon control-icon--reload" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M18 7.2A7.4 7.4 0 1 0 19.3 12" />
      <path d="M18.1 4.8v4.4h-4.4" />
    </svg>
  )
}

function HistoryIcon() {
  return (
    <svg className="control-icon control-icon--round" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="7.4" />
      <path d="M12 8.2V12l3 1.8" />
    </svg>
  )
}

function InfoIcon() {
  return (
    <svg className="control-icon control-icon--round" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="7.4" />
      <path d="M12 11v5" />
      <path d="M12 8h.01" />
    </svg>
  )
}

function DeleteIcon() {
  return (
    <svg className="control-icon control-icon--small" viewBox="0 0 24 24" aria-hidden="true">
      <path d="m7 7 10 10" />
      <path d="m17 7-10 10" />
    </svg>
  )
}

function TrashIcon() {
  return (
    <svg className="control-icon control-icon--small" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M8 8h8" />
      <path d="M10 8V6h4v2" />
      <path d="M9 10v7" />
      <path d="M15 10v7" />
      <path d="M7.5 8.5 8 19h8l.5-10.5" />
    </svg>
  )
}

function SourceCard({ result, index }) {
  const domain = domainFromResult(result)
  const text = compactText(
    result?.structuredSummary ||
      result?.snippet ||
      result?.displayExcerpt ||
      result?.fullText,
    220
  )

  return (
    <article className="source-card">
      <div className="source-card__top">
        <span className="source-card__rank">[{index + 1}] {index === 0 ? 'Strong match' : 'Related source'}</span>
        {result?.url ? (
          <button type="button" onClick={() => openExternal(result.url)}>
            Open link
          </button>
        ) : null}
      </div>
      <h3>{result?.title || 'Evidence source'}</h3>
      <p className="source-card__domain">{domain}</p>
      {text ? (
        <div className="source-card__text">
          <MathRichText text={text} />
        </div>
      ) : null}
    </article>
  )
}

export default function Search({ extension }) {
  const search = useSearch(extension, null)
  const [submittedQuery, setSubmittedQuery] = useState('')
  const [navigation, setNavigation] = useState({ entries: [], index: -1 })
  const [historyOpen, setHistoryOpen] = useState(false)
  const [infoOpen, setInfoOpen] = useState(false)
  const topActionsRef = useRef(null)
  const historyPopoverRef = useRef(null)

  const suggestions = useMemo(() => buildActivitySuggestions(search), [search])
  const emptySuggestionMessage = buildEmptySuggestionMessage(extension)
  const status = buildStatus(extension, search, submittedQuery)
  const answerText = buildAnswerText(submittedQuery, search.answerMeta, search.results)
  const hasSubmitted = Boolean(submittedQuery)
  const canGoBack = navigation.index >= 0
  const canGoForward = navigation.index < navigation.entries.length - 1
  const shouldShowNavigation = hasSubmitted || canGoForward
  const historyItems = search.recentSearches.filter(Boolean).slice(0, 8)

  const runQuery = async (value = search.query, { record = true } = {}) => {
    const query = normalize(value)
    if (!query) return
    setInfoOpen(false)
    setHistoryOpen(false)
    search.setQuery(query)
    setSubmittedQuery(query)
    if (record) {
      setNavigation((current) => {
        const base =
          current.index >= 0
            ? current.entries.slice(0, current.index + 1)
            : []

        if (base[base.length - 1] === query) {
          return { entries: base, index: base.length - 1 }
        }

        const entries = [...base, query]
        return { entries, index: entries.length - 1 }
      })
    }
    await search.runSearch(query)
  }

  const goBack = async () => {
    if (!canGoBack) {
      return
    }

    if (navigation.index === 0) {
      setSubmittedQuery('')
      search.setQuery('')
      search.clearResults()
      setNavigation((current) => ({ ...current, index: -1 }))
      return
    }

    const nextIndex = navigation.index - 1
    const query = navigation.entries[nextIndex]
    if (!query) return
    setNavigation((current) => ({ ...current, index: nextIndex }))
    await runQuery(query, { record: false })
  }

  const goForward = async () => {
    if (!canGoForward) return
    const nextIndex = navigation.index + 1
    const query = navigation.entries[nextIndex]
    if (!query) return
    setNavigation((current) => ({ ...current, index: nextIndex }))
    await runQuery(query, { record: false })
  }

  const reloadCurrent = async () => {
    if (!submittedQuery) return
    await runQuery(submittedQuery, { record: false })
  }

  useEffect(() => {
    if ((!infoOpen && !historyOpen) || typeof window === 'undefined') {
      return undefined
    }

    const closePanels = () => {
      setInfoOpen(false)
      setHistoryOpen(false)
    }
    const timer = infoOpen ? window.setTimeout(() => setInfoOpen(false), 30000) : null

    const handlePointerDown = (event) => {
      const target = event.target
      if (
        topActionsRef.current?.contains(target) ||
        historyPopoverRef.current?.contains(target)
      ) {
        return
      }
      closePanels()
    }

    const handleKeyDown = (event) => {
      if (event.key === 'Enter' || event.key === 'Escape') {
        closePanels()
      }
    }

    window.addEventListener('pointerdown', handlePointerDown, true)
    window.addEventListener('keydown', handleKeyDown, true)

    return () => {
      if (timer) window.clearTimeout(timer)
      window.removeEventListener('pointerdown', handlePointerDown, true)
      window.removeEventListener('keydown', handleKeyDown, true)
    }
  }, [historyOpen, infoOpen])

  return (
    <main className={`memact-page ${hasSubmitted ? 'has-results' : 'is-home'}`}>
      {shouldShowNavigation ? (
        <nav className="result-controls" aria-label="Result navigation">
          <button
            className="nav-button nav-button--back"
            type="button"
            aria-label="Back"
            disabled={!canGoBack}
            onClick={goBack}
          >
            <BackIcon />
          </button>
          <button
            className="nav-button nav-button--forward"
            type="button"
            aria-label="Next thought"
            disabled={!canGoForward || search.loading}
            onClick={goForward}
          >
            <ForwardIcon />
          </button>
          <button
            className="nav-button nav-button--reload"
            type="button"
            aria-label="Reload"
            disabled={search.loading}
            onClick={reloadCurrent}
          >
            <ReloadIcon />
          </button>
        </nav>
      ) : null}

      <div ref={topActionsRef} className="top-actions" aria-label="Memact actions">
        <button
          className="top-action-button top-action-button--history"
          type="button"
          aria-label="Thought history"
          aria-expanded={historyOpen}
          onClick={() => {
            setHistoryOpen((current) => !current)
            setInfoOpen(false)
          }}
        >
          <HistoryIcon />
        </button>
        <button
          className="top-action-button top-action-button--info"
          type="button"
          aria-label="About Memact"
          aria-expanded={infoOpen}
          onClick={() => {
            setInfoOpen((current) => !current)
            setHistoryOpen(false)
          }}
        >
          <InfoIcon />
        </button>
      </div>

      {infoOpen ? (
        <aside className="info-popover" role="dialog" aria-label="About Memact" onClick={() => setInfoOpen(false)}>
          <p>
            See how your thoughts and digital activity are connected. Memact looks at sources from
            what you read, watch, search, and revisit when Capture is connected.
          </p>
        </aside>
      ) : null}

      {historyOpen ? (
        <aside ref={historyPopoverRef} className="history-popover" role="dialog" aria-label="Thought history">
          <div className="history-popover__top">
            <p className="history-title">History</p>
            {historyItems.length ? (
              <button
                className="history-clear-button"
                type="button"
                aria-label="Clear all history"
                onClick={() => search.clearHistory()}
              >
                <TrashIcon />
              </button>
            ) : null}
          </div>
          {historyItems.length ? (
            <div className="history-list">
              {historyItems.map((item) => (
                <div className="history-row" key={item}>
                  <button
                    className="history-query-button"
                    type="button"
                    onClick={() => runQuery(item)}
                  >
                    {item}
                  </button>
                  <button
                    className="history-delete-button"
                    type="button"
                    aria-label={`Delete ${item}`}
                    onClick={() => search.removeHistoryQuery(item)}
                  >
                    <DeleteIcon />
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <p className="history-empty">No thoughts yet.</p>
          )}
        </aside>
      ) : null}

      <section className="search-home" aria-label="Memact thought input">
        <h1 className="memact-logo" aria-label="memact">
          <span aria-hidden="true" className="memact-wordmark">
            <span>m</span>
            <span>e</span>
            <span>m</span>
            <span>a</span>
            <span>c</span>
            <span>t</span>
          </span>
        </h1>
        <div className="brand-divider" aria-hidden="true" />
        {!hasSubmitted ? (
          <p className="thought-prompt">What have you been thinking?</p>
        ) : null}
        <SearchBar
          value={search.query}
          onChange={search.setQuery}
          onSubmit={runQuery}
          onSuggestionClick={runQuery}
          placeholder="Type Here"
          loading={search.loading}
          suggestions={suggestions}
          emptySuggestionMessage={emptySuggestionMessage}
        />
        <p className="search-status">{status}</p>
      </section>

      {hasSubmitted ? (
        <section className="answer-layout" aria-live="polite">
          <article className="answer-card">
            <p className="eyebrow">Answer</p>
            <blockquote>{submittedQuery}</blockquote>
            <div className="answer-copy">
              <MathRichText text={answerText} />
            </div>
          </article>

          <section className="source-panel" aria-label="Sources">
            <p className="eyebrow">Sources</p>
            {search.results.length ? (
              <div className="source-list">
                {search.results.slice(0, 4).map((result, index) => (
                  <SourceCard key={result.id} result={result} index={index} />
                ))}
              </div>
            ) : (
              <div className="empty-sources">
                No source was strong enough for this thought.
              </div>
            )}
          </section>
        </section>
      ) : null}
    </main>
  )
}
