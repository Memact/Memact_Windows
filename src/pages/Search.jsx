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
  if (search.loading) return 'Finding cited evidence...'
  if (search.error) return search.error
  if (submittedQuery && search.results.length) return `${search.results.length} cited source candidates`
  if (submittedQuery) return 'No strong citation match yet'
  if (extension?.requiresBridge) return 'Connect Capture for evidence-backed suggestions'
  return 'Ready'
}

function buildAnswerText(query, answerMeta, results) {
  const answer = normalize(answerMeta?.answer)
  const summary = normalize(answerMeta?.summary || answerMeta?.overview)

  if (summary) return summary
  if (answer) return answer

  if (!results.length) {
    return 'Memact did not find strong enough evidence to cite for this thought yet.'
  }

  const primary = results[0]
  const secondary = results[1]
  const primaryTitle = primary?.title || domainFromResult(primary)
  const secondaryTitle = secondary?.title || domainFromResult(secondary)

  if (secondary) {
    return `The strongest citation candidate is ${primaryTitle} [1]. A related source also appears in ${secondaryTitle} [2].`
  }

  return `The strongest citation candidate is ${primaryTitle} [1].`
}

function buildActivitySuggestions(search) {
  return search.suggestions
}

function buildEmptySuggestionMessage(extension) {
  if (extension?.requiresBridge) {
    return 'No thought suggestions yet. Connect Capture to generate suggestions from your evidence trail.'
  }

  return 'No thought suggestions yet. Once there is enough evidence, suggestions will appear here.'
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
      <h3>{result?.title || 'Evidence source'}</h3>
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
            Memact cites the thoughts you enter with evidence from what you have read, watched,
            searched, and revisited. Suggestions and citations stay grounded in local evidence when
            Capture is connected.
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
          placeholder="Enter a thought to cite"
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
                No source was strong enough to cite for this thought.
              </div>
            )}
          </section>
        </section>
      ) : null}
    </main>
  )
}
