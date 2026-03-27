function formatDateTime(value) {
  if (!value) return ''
  try {
    const date = new Date(value)
    return new Intl.DateTimeFormat(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }).format(date)
  } catch {
    return value
  }
}

function domainFromUrl(url) {
  if (!url) return ''
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

function pathFromUrl(url) {
  if (!url) return ''
  try {
    const parsed = new URL(url)
    const pathname = parsed.pathname && parsed.pathname !== '/' ? parsed.pathname : ''
    return `${parsed.hostname.replace(/^www\./, '')}${pathname}`
  } catch {
    return ''
  }
}

function compactSnippet(text, maxLength = 300) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim()
  if (!normalized) return ''
  if (normalized.length <= maxLength) return normalized
  return `${normalized.slice(0, maxLength - 3).trim()}...`
}

function toTitleCase(value) {
  return String(value || '')
    .replace(/[_-]+/g, ' ')
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
}

function openLabel(url) {
  if (!url) return 'Open page'
  const label = pathFromUrl(url) || domainFromUrl(url)
  if (!label) return 'Open page'
  return label.length > 64 ? `${label.slice(0, 61)}...` : label
}

export default function ResultCard({ result, onOpen, onSelect }) {
  const domain = result.domain || domainFromUrl(result.url)
  const urlLabel = compactSnippet(result.displayUrl || (result.url ? openLabel(result.url) : domain), 84) || 'Local memory'
  const appLabel = toTitleCase(result.application || 'Browser')
  const capturedLabel = formatDateTime(result.occurred_at)
  const interaction = result.interactionType ? toTitleCase(result.interactionType) : ''
  const summary = result.structuredSummary || compactSnippet(result.snippet || result.fullText)
  const excerpt = compactSnippet(result.displayExcerpt || result.snippet || result.fullText)
  const facts = [
    result.pageTypeLabel ? { label: 'Type', value: result.pageTypeLabel } : null,
    ...(Array.isArray(result.factItems) ? result.factItems.slice(0, 2) : []),
  ].filter(Boolean)
  const meta = [capturedLabel, appLabel, interaction].filter(Boolean)

  return (
    <article
      className={`evidence-card ${onSelect ? 'is-selectable' : ''}`}
      onClick={() => onSelect?.(result)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onSelect?.(result)
        }
      }}
      role={onSelect ? 'button' : undefined}
      tabIndex={onSelect ? 0 : undefined}
    >
      <p className="evidence-url">{urlLabel}</p>
      <h3 className="evidence-title">{result.title || 'Untitled memory'}</h3>
      {meta.length ? <p className="evidence-meta">{meta.join(' - ')}</p> : null}
      {summary ? <p className="evidence-summary">{summary}</p> : null}

      {facts.length ? (
        <div className="evidence-fact-row">
          {facts.map((fact) => (
            <span key={`${fact.label}-${fact.value}`} className="evidence-fact-pill">
              <strong>{fact.label}:</strong> {fact.value}
            </span>
          ))}
        </div>
      ) : null}

      {excerpt && excerpt !== summary ? <p className="evidence-snippet">{excerpt}</p> : null}

      <div className="evidence-footer">
        <span className="evidence-availability">
          {result.fullText ? 'Full extracted memory available' : 'Saved snippet available'}
        </span>
        <div className="evidence-actions">
          {onSelect ? (
            <button
              type="button"
              className="evidence-detail-button"
              onClick={(event) => {
                event.stopPropagation()
                onSelect(result)
              }}
            >
              View full memory
            </button>
          ) : null}
          {result.url ? (
            <button
              type="button"
              className="evidence-link-button"
              onClick={(event) => {
                event.stopPropagation()
                onOpen?.(result)
              }}
            >
              Open page
            </button>
          ) : null}
        </div>
      </div>
    </article>
  )
}
