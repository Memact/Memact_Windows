import { useMemo, useState } from 'react'
import MathRichText from '../components/MathRichText'
import SearchBar from '../components/SearchBar'
import { useSearch } from '../hooks/useSearch'
import memactLogo from '../../assets/logos/memact-text-logo.png'

function normalize(value) {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

function openExternal(url) {
  if (!url || typeof window === 'undefined') return
  window.open(url, '_blank', 'noreferrer')
}

function domainFromResult(result) {
  if (result?.domain) return result.domain
  if (!result?.url) return 'captured memory'

  try {
    return new URL(result.url).hostname.replace(/^www\./, '')
  } catch {
    return 'captured memory'
  }
}

function compactText(value, maxLength = 190) {
  const text = normalize(value)
  if (!text) return ''
  if (text.length <= maxLength) return text
  return `${text.slice(0, maxLength - 3).trim()}...`
}

function buildStatus(extension, search, submittedQuery) {
  if (search.loading) return 'Searching captured activity...'
  if (search.error) return search.error
  if (submittedQuery && search.results.length) return `${search.results.length} cited source candidates`
  if (submittedQuery) return 'No strong captured match yet'
  if (extension?.requiresBridge) return 'Connect Capture for real activity suggestions'
  return 'Ready'
}

function buildAnswerText(query, answerMeta, results) {
  const answer = normalize(answerMeta?.answer)
  const summary = normalize(answerMeta?.summary || answerMeta?.overview)

  if (summary) return summary
  if (answer) return answer

  if (!results.length) {
    return 'Memact did not find a strong enough captured source to cite for this query yet.'
  }

  const primary = results[0]
  const secondary = results[1]
  const primaryTitle = primary?.title || domainFromResult(primary)
  const secondaryTitle = secondary?.title || domainFromResult(secondary)

  if (secondary) {
    return `The strongest captured match is ${primaryTitle} [1]. A related source also appears in ${secondaryTitle} [2].`
  }

  return `The strongest captured match is ${primaryTitle} [1].`
}

function buildActivitySuggestions(search) {
  return search.suggestions
}

function buildEmptySuggestionMessage(extension) {
  if (extension?.requiresBridge) {
    return 'No activity suggestions yet. Connect the Capture extension to generate suggestions from your browsing.'
  }

  return 'No activity suggestions yet. Once Capture has saved activity, suggestions will appear here.'
}

function CitationCard({ result, index }) {
  const domain = domainFromResult(result)
  const text = compactText(
    result?.structuredSummary ||
      result?.snippet ||
      result?.displayExcerpt ||
      result?.fullText,
    220
  )

  return (
    <article className="citation-card">
      <div className="citation-card__top">
        <span className="citation-card__rank">[{index + 1}] {index === 0 ? 'Strong match' : 'Related source'}</span>
        {result?.url ? (
          <button type="button" onClick={() => openExternal(result.url)}>
            Open link
          </button>
        ) : null}
      </div>
      <h3>{result?.title || 'Captured activity'}</h3>
      <p className="citation-card__domain">{domain}</p>
      {text ? (
        <div className="citation-card__text">
          <MathRichText text={text} />
        </div>
      ) : null}
    </article>
  )
}

export default function Search({ extension }) {
  const search = useSearch(extension, null)
  const [submittedQuery, setSubmittedQuery] = useState('')
  const [infoOpen, setInfoOpen] = useState(false)

  const suggestions = useMemo(() => buildActivitySuggestions(search), [search])
  const emptySuggestionMessage = buildEmptySuggestionMessage(extension)
  const status = buildStatus(extension, search, submittedQuery)
  const answerText = buildAnswerText(submittedQuery, search.answerMeta, search.results)
  const hasSubmitted = Boolean(submittedQuery)

  const runQuery = async (value = search.query) => {
    const query = normalize(value)
    if (!query) return
    search.setQuery(query)
    setSubmittedQuery(query)
    await search.runSearch(query)
  }

  return (
    <main className={`memact-page ${hasSubmitted ? 'has-results' : 'is-home'}`}>
      <button
        type="button"
        className="info-button"
        aria-label="About Memact"
        onClick={() => setInfoOpen((current) => !current)}
      >
        i
      </button>

      {infoOpen ? (
        <aside className="info-popover" role="dialog" aria-label="About Memact">
          <p>
            Memact searches captured activity and returns answers with citations. Suggestions and
            cited results come from local activity evidence when Capture is connected.
          </p>
        </aside>
      ) : null}

      <section className="search-home" aria-label="Memact search">
        <h1 className="memact-logo">
          <img src={memactLogo} alt="memact" />
        </h1>
        <SearchBar
          value={search.query}
          onChange={search.setQuery}
          onSubmit={runQuery}
          onSuggestionClick={runQuery}
          placeholder="Search your captured activity"
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

          <section className="citation-panel" aria-label="Citations">
            <p className="eyebrow">Citations</p>
            {search.results.length ? (
              <div className="citation-list">
                {search.results.slice(0, 4).map((result, index) => (
                  <CitationCard key={result.id} result={result} index={index} />
                ))}
              </div>
            ) : (
              <div className="empty-citations">
                No captured source was strong enough to cite for this query.
              </div>
            )}
          </section>
        </section>
      ) : null}
    </main>
  )
}
