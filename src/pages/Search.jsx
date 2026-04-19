import { useState } from 'react'
import MathRichText from '../components/MathRichText'
import { useSearch } from '../hooks/useSearch'

const SAMPLE_THOUGHT = 'I feel like I need to build something real before applying anywhere.'

const PIPELINE = ['Capture', 'Inference', 'Schema', 'Query', 'Origin', 'Influence']

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

function formatStatus(extension, search, resultCount, tracedThought) {
  if (search.loading) return 'Tracing captured evidence...'
  if (extension?.requiresBridge) return 'Capture extension needed to trace real activity.'
  if (extension?.ready || extension?.bridgeDetected) return tracedThought ? `${resultCount} evidence candidates found.` : 'Capture connected.'
  if (extension?.mode === 'web-fallback') return tracedThought ? `${resultCount} local candidates found.` : 'Local memory mode.'
  return 'Ready.'
}

function EvidenceCard({ result }) {
  const domain = domainFromResult(result)
  const text = result?.structuredSummary || result?.snippet || result?.displayExcerpt || result?.fullText || ''

  return (
    <article className="evidence-card">
      <div className="evidence-card__meta">{domain}</div>
      <h3 className="evidence-card__title">{result?.title || 'Captured activity'}</h3>
      {text ? (
        <div className="evidence-card__text">
          <MathRichText text={text} />
        </div>
      ) : null}
      {result?.url ? (
        <button type="button" className="evidence-card__link" onClick={() => openExternal(result.url)}>
          Open source
        </button>
      ) : null}
    </article>
  )
}

export default function Search({ extension }) {
  const search = useSearch(extension, null)
  const [thought, setThought] = useState('')
  const [tracedThought, setTracedThought] = useState('')

  const resultCount = search.results.length
  const status = formatStatus(extension, search, resultCount, tracedThought)

  const traceThought = async (event) => {
    event?.preventDefault()
    const query = normalize(thought)
    if (!query) return

    setTracedThought(query)
    await search.runSearch(query)
  }

  const useSample = () => {
    setThought(SAMPLE_THOUGHT)
    search.setQuery(SAMPLE_THOUGHT)
  }

  return (
    <main className="memact-page">
      <section className="thought-shell" aria-labelledby="memact-title">
        <header className="thought-header">
          <div className="brand-row">
            <span className="brand-mark">memact</span>
            <span className="version-pill">v0.0</span>
          </div>
          <h1 id="memact-title">Citation, but for your thoughts.</h1>
          <p>
            Enter a thought. Memact looks through captured activity and surfaces evidence that may
            have introduced it or shaped it over time.
          </p>
        </header>

        <form className="thought-form" onSubmit={traceThought}>
          <label className="thought-label" htmlFor="thought-input">
            Thought
          </label>
          <textarea
            id="thought-input"
            value={thought}
            onChange={(event) => {
              setThought(event.target.value)
              search.setQuery(event.target.value)
            }}
            placeholder="What thought do you want to trace?"
            rows={5}
          />
          <div className="form-actions">
            <button type="submit" className="primary-action" disabled={!normalize(thought) || search.loading}>
              Trace thought
            </button>
            <button type="button" className="secondary-action" onClick={useSample}>
              Try example
            </button>
          </div>
        </form>

        <section className="trace-panel" aria-live="polite">
          <div className="trace-panel__top">
            <span className="trace-label">Thought Trace</span>
            <span className="trace-status">{status}</span>
          </div>

          {tracedThought ? (
            <>
              <blockquote>{tracedThought}</blockquote>
              <div className="claim-grid">
                <div>
                  <span>Origin</span>
                  <p>Specific source candidates require strong wording or phrase overlap.</p>
                </div>
                <div>
                  <span>Influence</span>
                  <p>Repeated exposure and schema patterns can shape the thought over time.</p>
                </div>
              </div>
            </>
          ) : (
            <p className="empty-copy">No trace yet. The interface stays quiet until you ask.</p>
          )}
        </section>

        {tracedThought ? (
          <section className="evidence-section">
            <div className="section-heading">
              <h2>Evidence candidates</h2>
              <p>These are retrieved memories, not final conclusions.</p>
            </div>

            {resultCount ? (
              <div className="evidence-list">
                {search.results.slice(0, 5).map((result) => (
                  <EvidenceCard key={result.id} result={result} />
                ))}
              </div>
            ) : (
              <div className="empty-evidence">
                No captured evidence matched this thought closely enough yet.
              </div>
            )}
          </section>
        ) : null}

        <footer className="pipeline-row" aria-label="Memact pipeline">
          {PIPELINE.map((item) => (
            <span key={item}>{item}</span>
          ))}
        </footer>
      </section>
    </main>
  )
}
