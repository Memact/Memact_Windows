import { useEffect, useMemo, useRef, useState } from 'react'
import SearchBar from '../components/SearchBar'
import ResultCard from '../components/ResultCard'
import { useSearch } from '../hooks/useSearch'

const TIME_FILTERS = [
  { label: 'Today', value: 'today' },
  { label: 'Yesterday', value: 'yesterday' },
  { label: 'This week', value: 'this week' },
  { label: 'Last week', value: 'last week' },
]

const MEMACT_SITE_URL = 'https://www.memact.com'

function normalize(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
}

function formatHistoryTime(value) {
  if (!value) return ''
  try {
    return new Intl.DateTimeFormat(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    })
      .format(new Date(value))
      .replace(',', ' \u2022')
  } catch {
    return value
  }
}

function toTitleCase(value) {
  return String(value || '')
    .replace(/[_-]+/g, ' ')
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
}

function detectBrowser() {
  if (typeof navigator === 'undefined') {
    return {
      name: 'Google Chrome',
      extensionsUrl: 'chrome://extensions/',
      helpUrl: 'https://support.google.com/chrome_webstore/answer/2664769',
      supported: true,
      isDefault: true,
    }
  }

  const ua = navigator.userAgent
  if (ua.includes('Edg/')) {
    return {
      name: 'Microsoft Edge',
      extensionsUrl: 'edge://extensions/',
      helpUrl:
        'https://learn.microsoft.com/microsoft-edge/extensions-chromium/getting-started/extension-sideloading',
      supported: true,
      isDefault: true,
    }
  }
  if (ua.includes('Firefox/')) {
    return {
      name: 'Mozilla Firefox',
      extensionsUrl: 'about:addons',
      helpUrl:
        'https://support.mozilla.org/kb/find-and-install-add-ons-add-features-to-firefox',
      supported: false,
      isDefault: true,
    }
  }
  if (ua.includes('OPR/') || ua.includes('Opera')) {
    return {
      name: 'Opera',
      extensionsUrl: 'opera://extensions/',
      helpUrl: 'https://help.opera.com/en/extensions/',
      supported: true,
      isDefault: true,
    }
  }
  if (ua.includes('Vivaldi/')) {
    return {
      name: 'Vivaldi',
      extensionsUrl: 'vivaldi://extensions/',
      helpUrl: 'https://help.vivaldi.com/desktop/appearance-customization/extensions/',
      supported: true,
      isDefault: true,
    }
  }
  if (navigator.brave) {
    return {
      name: 'Brave',
      extensionsUrl: 'brave://extensions/',
      helpUrl:
        'https://support.brave.com/hc/en-us/articles/360017909112-How-can-I-add-extensions-to-Brave',
      supported: true,
      isDefault: true,
    }
  }
  return {
    name: 'Google Chrome',
    extensionsUrl: 'chrome://extensions/',
    helpUrl: 'https://support.google.com/chrome_webstore/answer/2664769',
    supported: true,
    isDefault: true,
  }
}

function openExternal(url) {
  if (!url) return
  window.open(url, '_blank', 'noreferrer')
}

function GlassDialog({ title, subtitle, children, footer, onClose }) {
  return (
    <div className="dialog-overlay" role="presentation" onMouseDown={onClose}>
      <div
        className="dialog-shell"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="dialog-panel">
          <div className="dialog-copy">
            <h2 className="dialog-title">{title}</h2>
            {subtitle ? <p className="dialog-body">{subtitle}</p> : null}
          </div>
          {children}
          {footer ? <div className="dialog-footer">{footer}</div> : null}
        </div>
      </div>
    </div>
  )
}

function SearchHistoryDialog({ entries, onSelect, onDelete, onClear, onClose }) {
  return (
    <GlassDialog
      title="Search history"
      subtitle="Your recent searches are stored locally on this device."
      onClose={onClose}
      footer={
        <>
          <button type="button" className="dialog-secondary-button" onClick={onClear}>
            Clear history
          </button>
          <button type="button" className="dialog-primary-button" onClick={onClose}>
            Close
          </button>
        </>
      }
    >
      <div className="history-scroll">
        {entries.length ? (
          <div className="history-list">
            {entries.map((entry) => (
              <div key={`${entry.query}-${entry.timestamp}`} className="history-row">
                <button type="button" className="history-select" onClick={() => onSelect(entry.query)}>
                  <span className="history-copy">
                    <span className="history-query">{entry.query}</span>
                    <span className="history-time">
                      {entry.timestamp ? formatHistoryTime(entry.timestamp) : 'Saved locally'}
                    </span>
                  </span>
                </button>
                <button type="button" className="history-delete" onClick={() => onDelete(entry.query)}>
                  x
                </button>
              </div>
            ))}
          </div>
        ) : (
          <p className="dialog-body">No searches yet.</p>
        )}
      </div>
    </GlassDialog>
  )
}

function PrivacyDialog({ onClose }) {
  return (
    <GlassDialog
      title="Privacy Notice"
      subtitle="Memact stores events, embeddings, and answers locally on this device. It does not call cloud APIs or send your activity off-machine."
      onClose={onClose}
      footer={
        <button type="button" className="dialog-primary-button" onClick={onClose}>
          OK
        </button>
      }
    />
  )
}

function ClearMemoriesDialog({ clearing, errorMessage, onConfirm, onClose }) {
  return (
    <GlassDialog
      title="Clear all memories"
      subtitle="This removes all saved browser memories from the local Memact extension on this device. This cannot be undone."
      onClose={clearing ? undefined : onClose}
      footer={
        <>
          <button
            type="button"
            className="dialog-secondary-button"
            onClick={onClose}
            disabled={clearing}
          >
            Cancel
          </button>
          <button
            type="button"
            className="dialog-primary-button dialog-primary-button--danger"
            onClick={onConfirm}
            disabled={clearing}
          >
            {clearing ? 'Clearing...' : 'Clear all memories'}
          </button>
        </>
      }
    >
      <div className="helper-card">
        <span className="helper-title">LOCAL RESET</span>
        <p className="helper-text">
          Memact will wipe the captured events, sessions, embeddings, and saved answers stored by
          the extension. Your browser itself is not uninstalled.
        </p>
      </div>
      {errorMessage ? <p className="dialog-error">{errorMessage}</p> : null}
    </GlassDialog>
  )
}

function BrowserSetupDialog({ browserInfo, extensionDetected, extensionReady, onClose }) {
  const metaText = extensionDetected
    ? extensionReady
      ? 'Connected to this page. Local memory is ready.'
      : 'Connected to this page. Local memory is still preparing.'
    : browserInfo.supported
      ? 'Default browser detected locally. Continue setup on memact.com.'
      : 'Detected locally, but automatic setup is not supported.'

  return (
    <GlassDialog
      title="Connect your browser"
      subtitle="Pick a browser once. Memact will take you to memact.com so you can finish setup there."
      onClose={onClose}
      footer={
        <>
          <button
            type="button"
            className="dialog-secondary-button"
            onClick={() => openExternal(MEMACT_SITE_URL)}
          >
            Open memact.com
          </button>
          <button type="button" className="dialog-primary-button" onClick={onClose}>
            Later
          </button>
        </>
      }
    >
      <div className="helper-card">
        <span className="helper-title">QUICK SETUP</span>
        <p className="helper-text">
          Open memact.com to continue setup, then load the Memact extension in your browser if it
          is not already installed.
        </p>
      </div>

      <div className="browser-tile">
        <div className="browser-copy">
          <div className="browser-title-row">
            <span className="browser-name">{browserInfo.name}</span>
            {browserInfo.isDefault ? <span className="browser-default-badge">Default browser</span> : null}
            {extensionDetected ? (
              <span className="browser-connected-badge">
                {extensionReady ? 'Connected' : 'Detected'}
              </span>
            ) : null}
          </div>
          <p className="browser-meta">{metaText}</p>
          <p className="browser-url">{MEMACT_SITE_URL}</p>
        </div>
        <button
          type="button"
          className="dialog-primary-button"
          disabled={!browserInfo.supported}
          onClick={() => openExternal(MEMACT_SITE_URL)}
        >
          Open setup
        </button>
      </div>
    </GlassDialog>
  )
}

function MemoryDetailDialog({ result, onOpen, onClose }) {
  if (!result) {
    return null
  }

  const detailItems = [
    result.occurred_at ? { label: 'Captured', value: formatHistoryTime(result.occurred_at) } : null,
    result.application ? { label: 'App', value: toTitleCase(result.application) } : null,
    result.domain ? { label: 'Site', value: result.domain } : null,
    result.interactionType ? { label: 'Activity', value: toTitleCase(result.interactionType) } : null,
    result.duplicateCount > 1 ? { label: 'Similar captures', value: `${result.duplicateCount}` } : null,
  ].filter(Boolean)
  const factItems = Array.isArray(result.factItems) ? result.factItems : []
  const extractedContext = [
    result.contextSubject ? { label: 'Subject', value: result.contextSubject } : null,
    result.contextEntities.length ? { label: 'Entities', value: result.contextEntities.join(' | ') } : null,
    result.contextTopics.length ? { label: 'Topics', value: result.contextTopics.join(' | ') } : null,
  ].filter(Boolean)
  const showExtractedContext = extractedContext.length && result.pageType !== 'search'

  const sessionLabel =
    result.session?.label ||
    result.raw?.session_label ||
    result.raw?.episode_label ||
    ''

  const fullText = String(result.fullText || result.rawFullText || '').trim()
  const rawFullText = String(result.rawFullText || '').trim()
  const snippetText = String(result.snippet || '').trim()
  const displayUrl = String(result.displayUrl || result.url || '').trim()
  const searchResults = Array.isArray(result.searchResults) ? result.searchResults : []
  const primaryTextHeading = result.pageType === 'search' ? 'CAPTURED PAGE VIEW' : 'FULL EXTRACTED TEXT'
  const showRawCapturedText = rawFullText && rawFullText !== fullText

  return (
    <GlassDialog
      title={result.title || 'Memory'}
      subtitle={sessionLabel ? `From session: ${sessionLabel}` : 'Full saved memory from this capture.'}
      onClose={onClose}
      footer={
        <>
          {result.url ? (
            <button type="button" className="dialog-secondary-button" onClick={() => onOpen?.(result)}>
              Open page
            </button>
          ) : null}
          <button type="button" className="dialog-primary-button" onClick={onClose}>
            Close
          </button>
        </>
      }
    >
      {detailItems.length ? (
        <div className="answer-detail-grid">
          {detailItems.map((item) => (
            <div key={`${item.label}-${item.value}`} className="answer-detail-card">
              <span className="answer-detail-label">{item.label}</span>
              <span className="answer-detail-value">{item.value}</span>
            </div>
          ))}
        </div>
      ) : null}

      {displayUrl ? <p className="browser-url">{displayUrl}</p> : null}

      {result.structuredSummary ? (
        <div className="memory-detail-body">
          <div className="refine-heading">SUMMARY</div>
          <p className="dialog-body">{result.structuredSummary}</p>
        </div>
      ) : null}

      {factItems.length ? (
        <div className="memory-detail-body">
          <div className="refine-heading">FACTS</div>
          <div className="answer-detail-grid">
            {factItems.map((item) => (
              <div key={`${item.label}-${item.value}`} className="answer-detail-card">
                <span className="answer-detail-label">{item.label}</span>
                <span className="answer-detail-value">{item.value}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {showExtractedContext ? (
        <div className="memory-detail-body">
          <div className="refine-heading">EXTRACTED CONTEXT</div>
          <div className="answer-detail-grid">
            {extractedContext.map((item) => (
              <div key={`${item.label}-${item.value}`} className="answer-detail-card">
                <span className="answer-detail-label">{item.label}</span>
                <span className="answer-detail-value">{item.value}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {searchResults.length ? (
        <div className="memory-detail-body">
          <div className="refine-heading">CAPTURED RESULTS</div>
          <div className="memory-result-list">
            {searchResults.map((item, index) => (
              <div key={`${index + 1}-${item}`} className="memory-result-item">
                <span className="memory-result-index">{index + 1}.</span>
                <span className="memory-result-copy">{item}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {snippetText && snippetText !== fullText ? (
        <div className="memory-detail-body">
          <div className="refine-heading">SAVED SNIPPET</div>
          <p className="dialog-body">{snippetText}</p>
        </div>
      ) : null}

      {fullText ? (
        <div className="memory-detail-body">
          <div className="refine-heading">{primaryTextHeading}</div>
          <pre className="memory-detail-text">{fullText}</pre>
        </div>
      ) : (
        <p className="dialog-body">No full extracted text is available for this memory yet.</p>
      )}

      {showRawCapturedText ? (
        <div className="memory-detail-body">
          <div className="refine-heading">RAW CAPTURED TEXT</div>
          <pre className="memory-detail-text">{rawFullText}</pre>
        </div>
      ) : null}
    </GlassDialog>
  )
}


function OverflowMenu({ style, onClose, onAction }) {
  return (
    <div className="menu-surface" style={style} role="menu">
      <button type="button" className="menu-item" onClick={() => onAction('setup')}>
        Install Browser Extension
      </button>
      <button type="button" className="menu-item" onClick={() => onAction('history')}>
        Search History
      </button>
      <button type="button" className="menu-item" onClick={() => onAction('privacy')}>
        Privacy Notice
      </button>
      <div className="menu-separator" aria-hidden="true" />
      <button
        type="button"
        className="menu-item menu-item--danger"
        onClick={() => onAction('clear-memories')}
      >
        Clear all memories
      </button>
    </div>
  )
}

function MenuOrbButton({ label, text, onClick, buttonRef, hidden = false }) {
  return (
    <div className={`menu-orb ${hidden ? 'is-hidden' : ''}`}>
      <button ref={buttonRef} type="button" className="menu-button" aria-label={label} onClick={onClick}>
        {text}
      </button>
    </div>
  )
}

export default function Search({ extension }) {
  const [bootComplete, setBootComplete] = useState(false)
  const [resultsMode, setResultsMode] = useState(false)
  const [selectedResult, setSelectedResult] = useState(null)
  const [activeDialog, setActiveDialog] = useState(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [menuRect, setMenuRect] = useState(null)
  const [activeTimeFilter, setActiveTimeFilter] = useState(null)
  const [dockVisible, setDockVisible] = useState(false)
  const [lastSubmittedQuery, setLastSubmittedQuery] = useState('')
  const [setupPromptShown, setSetupPromptShown] = useState(false)
  const [setupDialogAutoOpened, setSetupDialogAutoOpened] = useState(false)
  const [clearingMemories, setClearingMemories] = useState(false)
  const [clearMemoriesError, setClearMemoriesError] = useState('')
  const search = useSearch(extension, activeTimeFilter)
  const menuButtonRef = useRef(null)
  const menuRef = useRef(null)

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setBootComplete(true)
    }, 1000)
    return () => window.clearTimeout(timer)
  }, [])

  useEffect(() => {
    if (!bootComplete || extension?.detected || setupPromptShown) {
      return
    }

    const timer = window.setTimeout(() => {
      setActiveDialog('setup')
      setSetupPromptShown(true)
      setSetupDialogAutoOpened(true)
    }, 1800)

    return () => window.clearTimeout(timer)
  }, [bootComplete, extension?.detected, setupPromptShown])

  useEffect(() => {
    if (activeDialog === 'setup' && setupDialogAutoOpened && extension?.detected) {
      setActiveDialog(null)
      setSetupDialogAutoOpened(false)
    }
  }, [activeDialog, extension?.detected, setupDialogAutoOpened])

  useEffect(() => {
    if (!menuOpen) {
      return undefined
    }

    const handlePointerDown = (event) => {
      if (
        menuRef.current &&
        !menuRef.current.contains(event.target) &&
        menuButtonRef.current &&
        !menuButtonRef.current.contains(event.target)
      ) {
        setMenuOpen(false)
      }
    }

    const handleResize = () => {
      setMenuOpen(false)
    }

    window.addEventListener('pointerdown', handlePointerDown)
    window.addEventListener('resize', handleResize)

    return () => {
      window.removeEventListener('pointerdown', handlePointerDown)
      window.removeEventListener('resize', handleResize)
    }
  }, [menuOpen])

  const browserInfo = useMemo(() => detectBrowser(), [])

  const suggestionItems = search.suggestions
  const resultCount = search.results.length
  const resultsTitle = lastSubmittedQuery
    ? resultCount
      ? `${resultCount} local matches for "${lastSubmittedQuery}"`
      : `No local matches for "${lastSubmittedQuery}"`
    : 'Local matches'
  const resultsSubtitle = resultCount
    ? 'Sorted by context match and recency. Click any card to open the full saved memory.'
    : 'Try a different phrase, app name, or site.'

  const showBackControls = Boolean(search.query.trim()) || resultsMode
  const showResults = resultsMode && !dockVisible && !search.loading
  const showLoadingBar = !bootComplete || search.loading
  const menuStyle = menuRect
    ? {
        top: `${Math.round(menuRect.bottom + 8)}px`,
        left: `${Math.round(Math.max(12, menuRect.right - 240))}px`,
      }
    : undefined

  const statusText = useMemo(() => {
    if (!bootComplete) {
      return 'Starting your local memory engine...'
    }
    if (search.loading) {
      return 'Searching locally...'
    }
    if (extension?.detected && !extension?.ready) {
      return 'Browser connected. Preparing local memory...'
    }
    if (search.error && !resultsMode) {
      return search.error
    }
    if (showResults) {
      if (search.error) {
        return search.error
      }
      return resultCount ? `${resultCount} local matches ready.` : 'No local matches for that search.'
    }
    return 'Ready.'
  }, [
    bootComplete,
    extension?.detected,
    extension?.ready,
    resultCount,
    resultsMode,
    search.error,
    search.loading,
    showResults,
  ])

  const handleMenuToggle = (event) => {
    const rect = event.currentTarget.getBoundingClientRect()
    setMenuRect(rect)
    setMenuOpen((current) => !current)
  }

  const handleSubmit = async (rawValue) => {
    const query = normalize(rawValue ?? search.query)
    if (!query) {
      setResultsMode(false)
      setSelectedResult(null)
      setLastSubmittedQuery('')
      search.clearResults()
      return
    }

    if (!extension?.detected) {
      setSetupDialogAutoOpened(false)
      setActiveDialog('setup')
      return
    }

    setLastSubmittedQuery(query)
    setSelectedResult(null)
    await search.runSearch(query)
    setResultsMode(true)
  }

  const handleGoHome = (clearQuery = true) => {
    setResultsMode(false)
    setSelectedResult(null)
    setLastSubmittedQuery('')
    setActiveTimeFilter(null)
    search.clearResults()
    if (clearQuery) {
      search.setQuery('')
    }
  }

  const handleReload = async () => {
    const query = normalize(search.query || lastSubmittedQuery)
    if (!query) {
      return
    }
    await handleSubmit(query)
  }

  const handleSuggestion = async (value) => {
    search.setQuery(value)
    await handleSubmit(value)
  }

  const handleMenuAction = (action) => {
    setMenuOpen(false)

    if (action === 'setup') {
      openExternal(MEMACT_SITE_URL)
      return
    }
    if (action === 'history') {
      setActiveDialog('history')
      return
    }
    if (action === 'privacy') {
      setActiveDialog('privacy')
      return
    }
    if (action === 'clear-memories') {
      setClearMemoriesError('')
      setActiveDialog('clear-memories')
    }
  }

  const handleClearMemories = async () => {
    if (clearingMemories) {
      return
    }

    if (!extension?.detected || typeof extension.clearAllData !== 'function') {
      setClearMemoriesError('')
      setActiveDialog('setup')
      return
    }

    setClearingMemories(true)
    setClearMemoriesError('')

    try {
      const response = await extension.clearAllData()
      if (!response || response.error || response.ok === false) {
        throw new Error(response?.error || 'Could not clear local memories.')
      }

      search.clearHistory()
      search.clearResults()
      search.setQuery('')
      setResultsMode(false)
      setSelectedResult(null)
      setLastSubmittedQuery('')
      setActiveTimeFilter(null)
      setActiveDialog(null)
    } catch (error) {
      setClearMemoriesError(String(error?.message || error || 'Could not clear local memories.'))
    } finally {
      setClearingMemories(false)
    }
  }

  return (
    <>
      <main className={`memact-page ${resultsMode ? 'is-results' : 'is-home'}`}>
        <div className="memact-root">
          <header className="top-bar">
            {resultsMode ? (
              <div className="results-header">
                <div className="results-header__left">
                  <div className="compact-brand">m</div>
                  <MenuOrbButton
                    label="Back"
                    text={'\u2190'}
                    onClick={() => handleGoHome(true)}
                    hidden={!showBackControls}
                  />
                  <MenuOrbButton
                    label="Reload"
                    text={'\u21bb'}
                    onClick={handleReload}
                    hidden={!showBackControls}
                  />
                </div>

                <div className={`results-divider-host ${showBackControls ? '' : 'is-hidden'}`}>
                  <div className="results-divider" aria-hidden="true" />
                </div>

                <div className="results-header__center">
                  <SearchBar
                    value={search.query}
                    onChange={(nextValue) => {
                      search.setQuery(nextValue)
                      if (nextValue.trim() && activeTimeFilter) {
                        setActiveTimeFilter(null)
                      }
                    }}
                    onSubmit={handleSubmit}
                    onSuggestionClick={handleSuggestion}
                    loading={search.loading}
                    suggestions={suggestionItems}
                    timeFilters={TIME_FILTERS}
                    activeTimeFilter={activeTimeFilter}
                    onTimeFilter={(value) => {
                      setActiveTimeFilter((current) => (current === value ? null : value))
                    }}
                    onDockVisibilityChange={setDockVisible}
                  />
                </div>

                <div className={`results-divider-host ${showBackControls ? '' : 'is-hidden'}`}>
                  <div className="results-divider" aria-hidden="true" />
                </div>

                <div className="results-header__right">
                  <MenuOrbButton
                    label="Menu"
                    text="..."
                    onClick={handleMenuToggle}
                    buttonRef={menuButtonRef}
                  />
                </div>
              </div>
            ) : (
              <div className="home-menu-slot">
                <MenuOrbButton
                  label="Menu"
                  text="..."
                  onClick={handleMenuToggle}
                  buttonRef={menuButtonRef}
                />
              </div>
            )}
          </header>

          <div className={`results-shadow ${showResults ? 'is-visible' : ''}`} aria-hidden="true" />

          <section className="center-stage">
            {!resultsMode ? (
              <div className="home-hero">
                <h1 className="hero-title">memact</h1>
                <SearchBar
                  value={search.query}
                  onChange={(nextValue) => {
                    search.setQuery(nextValue)
                    if (nextValue.trim() && activeTimeFilter) {
                      setActiveTimeFilter(null)
                    }
                  }}
                  onSubmit={handleSubmit}
                  onSuggestionClick={handleSuggestion}
                  loading={search.loading}
                  suggestions={suggestionItems}
                  timeFilters={TIME_FILTERS}
                  activeTimeFilter={activeTimeFilter}
                  onTimeFilter={(value) => {
                    setActiveTimeFilter((current) => (current === value ? null : value))
                  }}
                  onDockVisibilityChange={setDockVisible}
                />
              </div>
            ) : null}

            {showResults ? (
              <section className="results-panel">
                <div className="results-panel__header">
                  <div className="answer-eyebrow">LOCAL RESULTS</div>
                  <h2 className="results-panel__title">{resultsTitle}</h2>
                  <p className="results-panel__subtitle">{resultsSubtitle}</p>
                </div>

                {resultCount ? (
                  <div className="evidence-scroll evidence-scroll--results">
                    <div className="evidence-stack">
                      {search.results.map((result) => (
                        <ResultCard
                          key={result.id}
                          result={result}
                          onOpen={(item) => openExternal(item.url)}
                          onSelect={setSelectedResult}
                        />
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="results-empty">
                    <p className="results-empty__text">
                      No saved page matched this search closely enough.
                    </p>
                  </div>
                )}
              </section>
            ) : null}
          </section>

          <footer className={`status-text ${dockVisible ? 'is-hidden' : ''}`}>{statusText}</footer>

          <div className={`loading-bar ${showLoadingBar ? 'is-visible' : ''}`}>
            <div className="loading-bar__chunk" />
          </div>
        </div>
      </main>

      {menuOpen ? (
        <div ref={menuRef}>
          <OverflowMenu style={menuStyle} onClose={() => setMenuOpen(false)} onAction={handleMenuAction} />
        </div>
      ) : null}

      {activeDialog === 'history' ? (
        <SearchHistoryDialog
          entries={search.recentEntries}
          onSelect={(query) => {
            setActiveDialog(null)
            search.setQuery(query)
            handleSubmit(query)
          }}
          onDelete={search.removeHistoryQuery}
          onClear={search.clearHistory}
          onClose={() => setActiveDialog(null)}
        />
      ) : null}

      {activeDialog === 'privacy' ? <PrivacyDialog onClose={() => setActiveDialog(null)} /> : null}
      {activeDialog === 'clear-memories' ? (
        <ClearMemoriesDialog
          clearing={clearingMemories}
          errorMessage={clearMemoriesError}
          onConfirm={handleClearMemories}
          onClose={() => {
            if (!clearingMemories) {
              setClearMemoriesError('')
              setActiveDialog(null)
            }
          }}
        />
      ) : null}
      {selectedResult ? (
        <MemoryDetailDialog
          result={selectedResult}
          onOpen={(item) => openExternal(item.url)}
          onClose={() => setSelectedResult(null)}
        />
      ) : null}
      {activeDialog === 'setup' ? (
        <BrowserSetupDialog
          browserInfo={browserInfo}
          extensionDetected={extension?.detected}
          extensionReady={extension?.ready}
          onClose={() => {
            setSetupDialogAutoOpened(false)
            setActiveDialog(null)
          }}
        />
      ) : null}
    </>
  )
}
