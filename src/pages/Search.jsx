import { useEffect, useMemo, useRef, useState } from 'react'
import MathRichText from '../components/MathRichText'
import SearchBar from '../components/SearchBar'
import { useSearch } from '../hooks/useSearch'

const INSTALL_PROMPT_DISMISSED_KEY = 'memact.install-prompt-dismissed'
const IMPORT_DECISION_KEY = 'memact.import-decision'
const INFO_AUTOSHOW_KEY = 'memact.info-autoshown'
const EXAMPLE_PLACEHOLDERS = [
  'e.g. I feel like I\'m behind everyone',
  'e.g. startups are better than jobs',
  'e.g. I need to prove myself',
]
const THOUGHT_PROMPTS = [
  'What have you been thinking?',
  'What has been on your mind?',
  'What idea keeps returning lately?',
  'What thought have you been circling around?',
  'What have you been quietly carrying?',
]

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

function readStoredValue(key, fallback = '') {
  if (typeof window === 'undefined') return fallback
  try {
    return window.localStorage.getItem(key) || fallback
  } catch {
    return fallback
  }
}

function writeStoredValue(key, value) {
  if (typeof window === 'undefined') return
  try {
    if (!value) {
      window.localStorage.removeItem(key)
      return
    }
    window.localStorage.setItem(key, value)
  } catch {
    // Ignore storage failures.
  }
}

function buildStatus(extension, search, submittedQuery, voiceState) {
  if (voiceState === 'listening' || voiceState === 'processing') return 'Listening...'
  if (voiceState === 'done') return 'Done.'
  if (voiceState === 'unsupported') return 'Voice input unavailable.'
  if (extension?.bootstrap?.status === 'running') {
    const progress = Math.max(1, Number(extension?.bootstrap?.progress_percent || 0))
    return `Processing... ${progress}%`
  }
  if (search.loading) return 'Finding sources...'
  if (search.error) return search.error
  if (submittedQuery && search.results.length) return `${search.results.length} source candidates`
  if (submittedQuery) return 'No strong source match yet.'
  if (extension?.bootstrap?.status === 'complete' && Number(extension?.bootstrap?.imported_count || 0) > 0) {
    return `${extension.bootstrap.imported_count} early activity sources seeded.`
  }
  if (extension?.requiresBridge) return 'Connect Capture to form suggestions.'
  return 'Ready.'
}

function buildAnswerText(query, answerMeta, results) {
  const answer = normalize(answerMeta?.answer)
  const summary = normalize(answerMeta?.summary || answerMeta?.overview)

  if (summary) return summary
  if (answer) return answer

  if (!results.length) {
    return 'Memact did not find strong enough sources yet.'
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

function buildEmptySuggestionMessage(extension, importDecision) {
  if (extension?.bootstrap?.status === 'running') {
    return 'Memact is getting your first suggestions ready.'
  }

  if (extension?.requiresBridge) {
    return 'No suggestions formed yet. Connect Capture first.'
  }

  if (importDecision === 'denied') {
    return 'No suggestions formed yet. Memact is waiting for new activity.'
  }

  return 'No suggestions formed yet. Once there is enough evidence, they will appear here.'
}

function formatDuration(seconds) {
  const safeSeconds = Math.max(0, Math.round(Number(seconds) || 0))
  if (safeSeconds <= 8) return 'A few seconds'
  if (safeSeconds < 60) return `About ${Math.ceil(safeSeconds / 10) * 10} sec`

  const minutes = Math.max(1, Math.ceil(safeSeconds / 60))
  return minutes === 1 ? 'About 1 min' : `About ${minutes} min`
}

function estimateBootstrapTime(bootstrapState, isError) {
  if (isError) return 'Paused'

  const explicitSeconds = Number(
    bootstrapState?.estimated_seconds_remaining ??
      bootstrapState?.eta_seconds ??
      bootstrapState?.remaining_seconds
  )
  if (Number.isFinite(explicitSeconds) && explicitSeconds > 0) {
    return formatDuration(explicitSeconds)
  }

  const progress = Number(bootstrapState?.progress_percent || 0)
  if (progress >= 100) return 'Finishing now'
  if (progress < 5) return 'Estimating...'
  if (progress >= 85) return 'A few seconds'
  if (progress >= 55) return 'Under 1 min'
  if (progress >= 25) return 'About 1 min'

  return 'About 2 min'
}

function OnboardingModal({
  title,
  body,
  steps = [],
  progress = null,
  note = '',
  primaryAction = null,
  secondaryAction = null,
}) {
  return (
    <div className="memact-modal-backdrop" role="presentation">
      <section className="memact-modal" role="dialog" aria-modal="true" aria-label={title}>
        <p className="eyebrow">Memact setup</p>
        <h2 className="memact-modal__title">{title}</h2>
        <p className="memact-modal__body">{body}</p>

        {typeof progress === 'number' ? (
          <div className="memact-modal__progress">
            <div className="memact-modal__progress-bar">
              <span style={{ width: `${Math.max(4, Math.min(100, progress))}%` }} />
            </div>
            <div className="memact-modal__progress-copy">
              <span>Processing...</span>
              <span>{Math.max(1, Math.min(100, Math.round(progress)))}%</span>
            </div>
            {note ? <p className="memact-modal__note">{note}</p> : null}
          </div>
        ) : null}

        {steps.length ? (
          <div className="memact-modal__steps">
            {steps.map((step, index) => (
              <p key={`${index + 1}-${step}`} className="memact-modal__step">
                <span>{index + 1}.</span>
                <span>{step}</span>
              </p>
            ))}
          </div>
        ) : null}

        <div className="memact-modal__actions">
          {primaryAction}
          {secondaryAction}
        </div>
      </section>
    </div>
  )
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

function SettingsIcon() {
  return (
    <svg className="control-icon control-icon--round" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5.5 7.5h13" />
      <path d="M5.5 16.5h13" />
      <circle cx="9" cy="7.5" r="1.9" />
      <circle cx="15" cy="16.5" r="1.9" />
    </svg>
  )
}

function CollapseIcon({ expanded = true }) {
  return (
    <svg className="control-icon control-icon--arrow control-icon--collapse" viewBox="0 0 24 24" aria-hidden="true">
      {expanded ? (
        <path d="m7 14.5 5-5 5 5" />
      ) : (
        <path d="m7 9.5 5 5 5-5" />
      )}
    </svg>
  )
}

function DeleteIcon() {
  return (
    <svg className="control-icon control-icon--cross" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M7.5 7.5 16.5 16.5" />
      <path d="M16.5 7.5 7.5 16.5" />
    </svg>
  )
}

function TrashIcon() {
  return (
    <svg className="control-icon control-icon--trash" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="8.1" y="3.2" width="7.8" height="2.4" rx="1.2" />
      <rect x="4.8" y="7.1" width="14.4" height="2.7" rx="1.35" />
      <path d="M6.9 12v5.1c0 1.9 1.35 3.2 3.25 3.2h3.7c1.9 0 3.25-1.3 3.25-3.2V12" />
      <rect x="9.4" y="12.5" width="2.1" height="5.3" rx="1.05" />
      <rect x="12.5" y="12.5" width="2.1" height="5.3" rx="1.05" />
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
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [voiceState, setVoiceState] = useState('idle')
  const [installPromptDismissed, setInstallPromptDismissed] = useState(false)
  const [importDecision, setImportDecision] = useState('')
  const [setupPromptRequested, setSetupPromptRequested] = useState(false)
  const [bootstrapRequested, setBootstrapRequested] = useState(false)
  const [processingPaneCollapsed, setProcessingPaneCollapsed] = useState(false)
  const [thoughtPrompt] = useState(() => THOUGHT_PROMPTS[Math.floor(Math.random() * THOUGHT_PROMPTS.length)])
  const topActionsRef = useRef(null)
  const historyPopoverRef = useRef(null)
  const settingsPopoverRef = useRef(null)

  const suggestions = useMemo(() => buildActivitySuggestions(search), [search])
  const emptySuggestionMessage = buildEmptySuggestionMessage(extension, importDecision)
  const status = buildStatus(extension, search, submittedQuery, voiceState)
  const answerText = buildAnswerText(submittedQuery, search.answerMeta, search.results)
  const bootstrapState = extension?.bootstrap || {}
  const bootstrapStatus = normalize(bootstrapState.status || 'idle').toLowerCase()
  const isBootstrapRunning = bootstrapStatus === 'running'
  const isBootstrapError = bootstrapStatus === 'error'
  const isBootstrapComplete = bootstrapStatus === 'complete'
  const bootstrapProgress = Math.max(
    1,
    Math.min(100, Math.round(Number(bootstrapState.progress_percent || (isBootstrapError ? 100 : 1))))
  )
  const bootstrapEstimate = estimateBootstrapTime(bootstrapState, isBootstrapError)
  const shouldKeepBootstrapPane = bootstrapRequested || isBootstrapRunning || isBootstrapError
  const isBackgroundProcessing = bootstrapRequested || isBootstrapRunning
  const shouldShowStatus = status !== 'Ready.'
  const shouldShowLoader =
    search.loading ||
    isBootstrapRunning ||
    voiceState === 'listening' ||
    voiceState === 'processing'
  const hasSubmitted = Boolean(submittedQuery)
  const canGoBack = navigation.index >= 0
  const canGoForward = navigation.index < navigation.entries.length - 1
  const shouldShowNavigation = hasSubmitted || canGoForward
  const historyItems = search.recentSearches.filter(Boolean).slice(0, 8)
  const captureEventCount = Number(search.stats?.eventCount || extension?.knowledge?.stats?.eventCount || 0)
  const hasBootstrapData =
    bootstrapState.status === 'complete' && Number(bootstrapState.imported_count || 0) > 0
  const shouldAskForImport =
    extension?.bridgeDetected &&
    !extension?.requiresBridge &&
    !hasBootstrapData &&
    captureEventCount < 40 &&
    bootstrapState.status !== 'running' &&
    !importDecision
  const shouldShowInstallModal =
    extension?.requiresBridge &&
    setupPromptRequested &&
    !installPromptDismissed
  const shouldShowImportModal =
    !shouldShowInstallModal &&
    setupPromptRequested &&
    shouldAskForImport
  const shouldShowProcessingPane =
    !shouldShowInstallModal &&
    !shouldShowImportModal &&
    shouldKeepBootstrapPane

  const requestSetupPrompt = () => {
    setSetupPromptRequested(true)
  }

  const requestBootstrapImport = async () => {
    setSetupPromptRequested(true)
    setBootstrapRequested(true)
    setSettingsOpen(false)
    setHistoryOpen(false)
    setInfoOpen(false)
    setImportDecision('allowed')
    writeStoredValue(IMPORT_DECISION_KEY, 'allowed')

    try {
      const state = await extension?.startBootstrapImport?.({
        days: 21,
        limit: 320,
      })

      if (!state || normalize(state.status, 20).toLowerCase() === 'error') {
        setBootstrapRequested(false)
      }
    } catch {
      setBootstrapRequested(false)
    }
  }

  useEffect(() => {
    setInstallPromptDismissed(readStoredValue(INSTALL_PROMPT_DISMISSED_KEY) === '1')
    setImportDecision(readStoredValue(IMPORT_DECISION_KEY))
  }, [])

  useEffect(() => {
    if (extension?.bridgeDetected) {
      setInstallPromptDismissed(false)
      writeStoredValue(INSTALL_PROMPT_DISMISSED_KEY, '')
    }
  }, [extension?.bridgeDetected])

  useEffect(() => {
    if (hasBootstrapData || isBootstrapComplete) {
      setImportDecision('allowed')
      setBootstrapRequested(false)
      writeStoredValue(IMPORT_DECISION_KEY, 'allowed')
    }
  }, [hasBootstrapData, isBootstrapComplete])

  useEffect(() => {
    if (!bootstrapStatus || bootstrapStatus === 'running') {
      return
    }

    if (bootstrapStatus === 'complete' || bootstrapStatus === 'error') {
      setBootstrapRequested(false)
    }
  }, [bootstrapStatus])

  useEffect(() => {
    if (shouldKeepBootstrapPane) {
      setProcessingPaneCollapsed(false)
    }
  }, [shouldKeepBootstrapPane])

  useEffect(() => {
    const canAutoOpenInfo =
      extension?.bridgeDetected &&
      !extension?.requiresBridge &&
      bootstrapState.status !== 'running' &&
      !shouldShowInstallModal &&
      !shouldShowImportModal

    if (!canAutoOpenInfo) {
      return
    }

    if (readStoredValue(INFO_AUTOSHOW_KEY) === '1') {
      return
    }

    setInfoOpen(true)
    writeStoredValue(INFO_AUTOSHOW_KEY, '1')
  }, [
    bootstrapState.status,
    extension?.bridgeDetected,
    extension?.requiresBridge,
    shouldShowImportModal,
    shouldShowInstallModal,
  ])

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
    if ((!infoOpen && !historyOpen && !settingsOpen) || typeof window === 'undefined') {
      return undefined
    }

    const closePanels = () => {
      setInfoOpen(false)
      setHistoryOpen(false)
      setSettingsOpen(false)
    }
    const timer = infoOpen ? window.setTimeout(() => setInfoOpen(false), 30000) : null

    const handlePointerDown = (event) => {
      const target = event.target
      if (
        topActionsRef.current?.contains(target) ||
        historyPopoverRef.current?.contains(target) ||
        settingsPopoverRef.current?.contains(target)
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
  }, [historyOpen, infoOpen, settingsOpen])

  return (
    <main className={`memact-page ${hasSubmitted ? 'has-results' : 'is-home'}`}>
      {shouldShowInstallModal ? (
        <OnboardingModal
          title="Install Capture first."
          body="Memact needs Capture to see your activity. Download the zip, unzip it, and load the folder in your browser."
          steps={[
            'Download the extension zip.',
            'Unzip it into a folder on your machine.',
            'Open chrome://extensions or edge://extensions.',
            'Turn on Developer Mode.',
            'Click Load unpacked and pick that folder.',
          ]}
          primaryAction={
            <a
              className="memact-modal__button memact-modal__button--primary"
              href="/memact-extension.zip"
              download="memact-extension.zip"
            >
              Download extension zip
            </a>
          }
          secondaryAction={
            <button
              className="memact-modal__button"
              type="button"
              onClick={() => {
                setInstallPromptDismissed(true)
                writeStoredValue(INSTALL_PROMPT_DISMISSED_KEY, '1')
              }}
            >
              Continue without Capture
            </button>
          }
        />
      ) : null}

      {shouldShowImportModal ? (
        <OnboardingModal
          title="Import recent activity?"
          body="Memact can look at some recent activity on this device so it does not start empty. If you skip this, it will only use new activity from now on."
          steps={[
            'This stays on this device.',
            'Memact checks what to keep before it saves anything.',
            'If you skip this now, Memact will wait for new activity.',
          ]}
          primaryAction={
            <button
              className="memact-modal__button memact-modal__button--primary"
              type="button"
              onClick={() => {
                requestBootstrapImport()
              }}
            >
              Allow local import
            </button>
          }
          secondaryAction={
            <button
              className="memact-modal__button"
              type="button"
              onClick={() => {
                setImportDecision('denied')
                writeStoredValue(IMPORT_DECISION_KEY, 'denied')
              }}
            >
              Use future activity only
            </button>
          }
        />
      ) : null}

      {shouldShowNavigation ? (
        <nav className="result-controls" aria-label="Result navigation">
          <button
            className="nav-button nav-button--back"
            type="button"
            aria-label="Back"
            data-tooltip="Back"
            aria-disabled={!canGoBack}
            onClick={goBack}
          >
            <BackIcon />
          </button>
          <button
            className="nav-button nav-button--forward"
            type="button"
            aria-label="Forward"
            data-tooltip="Forward"
            aria-disabled={!canGoForward || search.loading}
            onClick={goForward}
          >
            <ForwardIcon />
          </button>
          <button
            className="nav-button nav-button--reload"
            type="button"
            aria-label="Reload"
            data-tooltip="Reload"
            aria-disabled={!hasSubmitted || search.loading}
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
          aria-label="History"
          data-tooltip="History"
          aria-expanded={historyOpen}
          onClick={() => {
            setHistoryOpen((current) => !current)
            setInfoOpen(false)
            setSettingsOpen(false)
          }}
        >
          <HistoryIcon />
        </button>
        <button
          className="top-action-button top-action-button--settings"
          type="button"
          aria-label="Settings"
          data-tooltip="Settings"
          aria-expanded={settingsOpen}
          onClick={() => {
            setSettingsOpen((current) => !current)
            setHistoryOpen(false)
            setInfoOpen(false)
          }}
        >
          <SettingsIcon />
        </button>
        <button
          className="top-action-button top-action-button--info"
          type="button"
          aria-label="About Memact"
          data-tooltip="Info"
          aria-expanded={infoOpen}
          onClick={() => {
            setInfoOpen((current) => !current)
            setHistoryOpen(false)
            setSettingsOpen(false)
          }}
        >
          <InfoIcon />
        </button>
      </div>

      {infoOpen ? (
        <aside className="info-popover" role="dialog" aria-label="About Memact" onClick={() => setInfoOpen(false)}>
          <p>
            Memact helps you see where your thoughts may be coming from.
            It looks at what you read, watch, search, and revisit, then shows links that may have shaped a thought.
            {extension?.bootstrap?.imported_count
              ? ` It has already added ${extension.bootstrap.imported_count} early activity items from this device.`
              : ''}
          </p>
        </aside>
      ) : null}

      {settingsOpen ? (
        <aside ref={settingsPopoverRef} className="settings-popover" role="dialog" aria-label="Settings">
          <div className="settings-popover__section">
            <p className="settings-title">Settings</p>
            <p className="settings-copy">
              Keep Capture connected so Memact can use your activity here.
            </p>
            <a
              className="settings-button"
              href="/memact-extension.zip"
              download="memact-extension.zip"
            >
              Install local extension
            </a>
          </div>

          {!extension?.requiresBridge ? (
            <div className="settings-popover__section">
              <p className="settings-label">Capture status</p>
              <p className="settings-helper">
                {extension?.bridgeDetected ? 'Capture is connected.' : 'Waiting for Capture.'}
              </p>
            </div>
          ) : null}

          {importDecision === 'denied' && !hasBootstrapData && bootstrapState.status !== 'running' && !bootstrapRequested ? (
            <div className="settings-popover__section">
              <p className="settings-label">Local import</p>
              <label className="settings-checkbox-row">
                <input
                  type="checkbox"
                  onChange={() => {
                    requestBootstrapImport()
                  }}
                />
                <span>Allow local import</span>
              </label>
              <p className="settings-helper">
                Let Memact use some recent activity on this device to get started faster.
              </p>
            </div>
          ) : null}

          {(bootstrapRequested || bootstrapState.status === 'running') ? (
            <div className="settings-popover__section">
              <p className="settings-label">Local import</p>
              <p className="settings-helper">
                Memact is bringing in recent activity now.
              </p>
            </div>
          ) : null}
        </aside>
      ) : null}

      {historyOpen ? (
        <aside ref={historyPopoverRef} className="history-popover" role="dialog" aria-label="History">
          <div className="history-popover__top">
            <p className="history-title">History</p>
            {historyItems.length ? (
              <button
                className="history-clear-button"
                type="button"
                aria-label="Clear all history"
                data-tooltip="Clear all"
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
                    data-tooltip="Delete"
                    onClick={() => search.removeHistoryQuery(item)}
                  >
                    <DeleteIcon />
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <p className="history-empty">No history yet.</p>
          )}
        </aside>
      ) : null}

      <section className="search-home" aria-label="Memact input">
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
          <p className="thought-prompt">{thoughtPrompt}</p>
        ) : null}
        <SearchBar
          value={search.query}
          onChange={search.setQuery}
          onSubmit={runQuery}
          onSuggestionClick={runQuery}
          onInteraction={requestSetupPrompt}
          onVoiceStateChange={setVoiceState}
          placeholder={EXAMPLE_PLACEHOLDERS}
          loading={search.loading}
          disabled={isBackgroundProcessing}
          suggestions={suggestions}
          emptySuggestionMessage={emptySuggestionMessage}
        />
        {shouldShowStatus ? (
          <div className={`search-status-wrap ${shouldShowLoader ? 'is-loading' : ''}`}>
            {shouldShowLoader ? (
              <span className="memact-inline-loader" aria-hidden="true">
                <span />
                <span />
                <span />
              </span>
            ) : null}
            <p className="search-status">{status}</p>
          </div>
        ) : null}
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
                No source was strong enough yet.
              </div>
            )}
          </section>
        </section>
      ) : null}

      {shouldShowProcessingPane ? (
        <aside
          className={`processing-pane ${processingPaneCollapsed ? 'is-collapsed' : 'is-expanded'} ${isBootstrapError ? 'is-error' : ''}`}
          role="status"
          aria-live="polite"
          aria-label="Memact setup progress"
        >
          {!processingPaneCollapsed ? (
            <div className="processing-pane__copy">
              <p className="processing-pane__eyebrow">Memact setup</p>
              <p className="processing-pane__title">
                {isBootstrapError ? 'Import needs attention.' : 'Working in the background.'}
              </p>
              <p className="processing-pane__text">
                {isBootstrapError
                  ? normalize(bootstrapState.error || 'Memact could not finish the local import.')
                  : 'Memact is going through recent activity and getting your first suggestions ready. Search will open when this finishes.'}
              </p>
              {!isBootstrapError ? (
                <div className="processing-pane__detail-grid">
                  <p className="processing-pane__detail">
                    <span>Stage</span>
                    <strong>{normalize(bootstrapState.stage || (bootstrapRequested ? 'starting' : 'processing'))}</strong>
                  </p>
                  <p className="processing-pane__detail">
                    <span>Imported</span>
                    <strong>{Number(bootstrapState.imported_count || 0)}</strong>
                  </p>
                  <p className="processing-pane__detail">
                    <span>Checked</span>
                    <strong>{Number(bootstrapState.scanned_count || bootstrapState.processed_count || 0)}</strong>
                  </p>
                  <p className="processing-pane__detail">
                    <span>Window</span>
                    <strong>{Number(bootstrapState.history_days || 0)} days</strong>
                  </p>
                  <p className="processing-pane__detail">
                    <span>Time left</span>
                    <strong>{bootstrapEstimate}</strong>
                  </p>
                </div>
              ) : null}
            </div>
          ) : null}
          <div className="processing-pane__meta">
            <div className="processing-pane__progress">
              <div className="processing-pane__progress-bar">
                <span style={{ width: `${Math.max(4, bootstrapProgress)}%` }} />
              </div>
              {!processingPaneCollapsed ? (
                <p className="processing-pane__note">
                  {bootstrapState.note ||
                    (isBootstrapError
                      ? 'You can try local import again from Settings.'
                      : `Checking what to keep. ${bootstrapEstimate}`)}
                </p>
              ) : null}
            </div>
            <p className="processing-pane__percent">
              {bootstrapProgress}%
            </p>
            <button
              className="processing-pane__toggle"
              type="button"
              aria-label={processingPaneCollapsed ? 'Expand processing pane' : 'Shrink processing pane'}
              onClick={() => setProcessingPaneCollapsed((current) => !current)}
            >
              <CollapseIcon expanded={!processingPaneCollapsed} />
            </button>
          </div>
        </aside>
      ) : null}

    </main>
  )
}
