import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { detectClientEnvironment } from '../lib/environment'
import { analyzeThoughtQuery, buildMemactKnowledge } from '../lib/memactPipeline'
import {
  clearWebMemories,
  initializeWebMemoryStore,
  webMemorySearch,
  webMemoryStats,
  webMemoryStatus,
  webMemorySuggestions,
} from '../lib/webMemoryStore'

const BOOTSTRAP_POLL_MS = 650

function supportsWindowMessaging() {
  return typeof window !== 'undefined' && typeof window.postMessage === 'function'
}

function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

function isResponseType(type) {
  return (
    type === 'MEMACT_SEARCH_RESULT' ||
    type === 'MEMACT_SUGGESTIONS_RESULT' ||
    type === 'MEMACT_STATUS_RESULT' ||
    type === 'MEMACT_STATS_RESULT' ||
    type === 'MEMACT_CLEAR_ALL_DATA_RESULT' ||
    type === 'CAPTURE_GET_SNAPSHOT_RESULT' ||
    type === 'CAPTURE_BOOTSTRAP_STATUS_RESULT' ||
    type === 'CAPTURE_BOOTSTRAP_HISTORY_RESULT' ||
    type === 'MEMACT_ERROR'
  )
}

function hasKnowledgeSnapshot(snapshot) {
  return Boolean(snapshot?.events?.length || snapshot?.activities?.length)
}

export function useExtension() {
  const environment = useMemo(() => detectClientEnvironment(), [])
  const supportsBridge = environment.extensionCapable
  const useWebFallback = environment.mobile || !supportsBridge
  const [ready, setReady] = useState(useWebFallback)
  const [detected, setDetected] = useState(useWebFallback)
  const [bridgeDetected, setBridgeDetected] = useState(false)
  const [webMemoryCount, setWebMemoryCount] = useState(0)
  const [knowledge, setKnowledge] = useState(null)
  const [bootstrap, setBootstrap] = useState(null)
  const pending = useRef(new Map())
  const knowledgeRefreshInFlight = useRef(null)

  useEffect(() => {
    let cancelled = false

    initializeWebMemoryStore(environment).then((init) => {
      if (cancelled) {
        return
      }
      setWebMemoryCount(Number(init?.memoryCount || 0))
    })

    if (useWebFallback) {
      setReady(true)
      setDetected(true)
    }

    return () => {
      cancelled = true
    }
  }, [environment, useWebFallback])

  const sendToExtension = useCallback((type, payload = {}, timeoutMs = 5000) => {
    if (!supportsWindowMessaging()) {
      return Promise.resolve(null)
    }

    return new Promise((resolve) => {
      const requestId = Math.random().toString(36).slice(2)
      const timer = window.setTimeout(() => {
        pending.current.delete(requestId)
        resolve(null)
      }, timeoutMs)

      pending.current.set(requestId, (value) => {
        window.clearTimeout(timer)
        resolve(value)
      })

      window.postMessage({ type, payload, requestId }, '*')
    })
  }, [])

  const sendWithRetry = useCallback(async (type, payload = {}, options = {}) => {
    const {
      maxRetries = 6,
      initialDelay = 150,
      maxDelay = 1000,
      timeoutMs = 1200,
    } = options

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const response = await sendToExtension(type, payload, timeoutMs)
      if (response && !response.error) {
        return response
      }
      if (attempt === maxRetries) {
        return response
      }
      const delay = Math.min(initialDelay * Math.pow(1.5, attempt), maxDelay)
      await sleep(delay)
    }

    return null
  }, [sendToExtension])

  useEffect(() => {
    if (!supportsWindowMessaging() || !supportsBridge) {
      return undefined
    }

    if (document?.documentElement?.dataset?.memactBridge === 'ready') {
      setDetected(true)
      setBridgeDetected(true)
    }

    const onMessage = (event) => {
      if (event.source !== window) {
        return
      }

      const data = event.data || {}
      if (data.type === 'MEMACT_EXTENSION_READY') {
        setDetected(true)
        setBridgeDetected(true)
        return
      }

      if (!isResponseType(data.type)) {
        return
      }

      setDetected(true)
      setBridgeDetected(true)

      const resolver = pending.current.get(data.requestId)
      if (!resolver) {
        return
      }

      pending.current.delete(data.requestId)

      if (data.type === 'MEMACT_ERROR') {
        resolver({ error: data.error || 'Extension bridge failed.' })
        return
      }

      if (data.type === 'MEMACT_STATUS_RESULT' && data.status) {
        setDetected(true)
        setBridgeDetected(true)
        setReady(Boolean(data.status.ready))
        if (data.status.bootstrap) {
          setBootstrap(data.status.bootstrap)
        }
      }

      resolver(data.results ?? data.status ?? data.stats ?? data.response ?? null)
    }

    window.addEventListener('message', onMessage)

    let cancelled = false
    const probe = async () => {
      while (!cancelled) {
        const status = await sendWithRetry('MEMACT_STATUS', {}, {
          maxRetries: 8,
          initialDelay: 150,
          maxDelay: 1000,
          timeoutMs: 900,
        })
        if (cancelled) {
          return
        }
        if (status && !status.error) {
          setDetected(true)
          setReady(Boolean(status.ready))
          if (status.bootstrap) {
            setBootstrap(status.bootstrap)
          }
          return
        }
        await sleep(1800)
      }
    }
    probe()

    return () => {
      cancelled = true
      window.removeEventListener('message', onMessage)
    }
  }, [sendWithRetry, supportsBridge])

  const search = useCallback((query, limit = 20) => {
    if (useWebFallback && !bridgeDetected) {
      return webMemorySearch(query, limit, environment)
    }
    return sendToExtension('MEMACT_SEARCH', { query, limit })
  }, [bridgeDetected, environment, sendToExtension, useWebFallback])

  const getSuggestions = useCallback((query = '', timeFilter = null, limit = 6) => {
    if (useWebFallback && !bridgeDetected) {
      return webMemorySuggestions(query, timeFilter, limit)
    }
    return sendToExtension('MEMACT_SUGGESTIONS', { query, timeFilter, limit })
  }, [bridgeDetected, sendToExtension, useWebFallback])

  const getStatus = useCallback(() => {
    if (useWebFallback && !bridgeDetected) {
      return webMemoryStatus(environment)
    }
    return sendToExtension('MEMACT_STATUS', {})
  }, [bridgeDetected, environment, sendToExtension, useWebFallback])

  const getStats = useCallback(() => {
    if (useWebFallback && !bridgeDetected) {
      return webMemoryStats()
    }
    return sendToExtension('MEMACT_STATS', {})
  }, [bridgeDetected, sendToExtension, useWebFallback])

  const getSnapshot = useCallback((limit = 3000) => {
    if (useWebFallback && !bridgeDetected) {
      return Promise.resolve(null)
    }
    return sendToExtension('CAPTURE_GET_SNAPSHOT', { limit })
  }, [bridgeDetected, sendToExtension, useWebFallback])

  const getBootstrapStatus = useCallback(() => {
    if (useWebFallback && !bridgeDetected) {
      return Promise.resolve(null)
    }
    return sendToExtension('CAPTURE_BOOTSTRAP_STATUS', {})
  }, [bridgeDetected, sendToExtension, useWebFallback])

  const bootstrapHistory = useCallback((options = {}) => {
    if (useWebFallback && !bridgeDetected) {
      return Promise.resolve({ ok: false, skipped: true })
    }
    return sendToExtension('CAPTURE_BOOTSTRAP_HISTORY', options, 10000)
  }, [bridgeDetected, sendToExtension, useWebFallback])

  const clearAllData = useCallback(async () => {
    if (useWebFallback && !bridgeDetected) {
      const response = await clearWebMemories()
      if (response?.ok) {
        setWebMemoryCount(0)
      }
      return response
    }
    return sendToExtension('MEMACT_CLEAR_ALL_DATA', {})
  }, [bridgeDetected, sendToExtension, useWebFallback])

  const refreshKnowledge = useCallback(async () => {
    if (useWebFallback && !bridgeDetected) {
      return null
    }

    if (knowledgeRefreshInFlight.current) {
      return knowledgeRefreshInFlight.current
    }

    const task = (async () => {
      const [statusResult, bootstrapResult, snapshotResponse] = await Promise.all([
        getStatus().catch(() => null),
        getBootstrapStatus().catch(() => null),
        getSnapshot(3000).catch(() => null),
      ])

      if (statusResult?.bootstrap) {
        setBootstrap(statusResult.bootstrap)
      } else if (bootstrapResult?.bootstrap || bootstrapResult) {
        setBootstrap(bootstrapResult?.bootstrap || bootstrapResult)
      }

      const snapshot = snapshotResponse?.snapshot || snapshotResponse || null
      if (hasKnowledgeSnapshot(snapshot)) {
        const nextKnowledge = buildMemactKnowledge(snapshot)
        setKnowledge(nextKnowledge)
        return nextKnowledge
      }

      setKnowledge(null)
      return null
    })()

    knowledgeRefreshInFlight.current = task

    try {
      return await task
    } finally {
      knowledgeRefreshInFlight.current = null
    }
  }, [bridgeDetected, getBootstrapStatus, getSnapshot, getStatus, useWebFallback])

  useEffect(() => {
    if (!bridgeDetected) {
      return undefined
    }

    refreshKnowledge().catch(() => {})
    return undefined
  }, [bridgeDetected, refreshKnowledge])

  useEffect(() => {
    if (!bridgeDetected || bootstrap?.status !== 'running') {
      return undefined
    }

    let cancelled = false

    const poll = async () => {
      while (!cancelled) {
        const stateResult = await getBootstrapStatus().catch(() => null)
        if (cancelled) {
          return
        }
        const state = stateResult?.bootstrap || stateResult || null
        if (state) {
          setBootstrap(state)
        }
        if (state?.status === 'complete') {
          await refreshKnowledge().catch(() => {})
          return
        }
        if (state?.status === 'error' || state?.status === 'idle') {
          return
        }
        await sleep(BOOTSTRAP_POLL_MS)
      }
    }

    poll()

    return () => {
      cancelled = true
    }
  }, [bootstrap?.status, bridgeDetected, getBootstrapStatus, refreshKnowledge])

  const startBootstrapImport = useCallback(async (options = {}) => {
    const response = await bootstrapHistory(options)
    const state = response?.bootstrap || response || null
    if (state) {
      setBootstrap(state)
    }
    return state
  }, [bootstrapHistory])

  const analyzeThought = useCallback((query) => {
    if (!knowledge) {
      return null
    }
    return analyzeThoughtQuery(query, knowledge)
  }, [knowledge])

  const mode = bridgeDetected ? 'extension' : useWebFallback ? 'web-fallback' : 'bridge-required'
  const requiresBridge = mode === 'bridge-required'

  return useMemo(
    () => ({
      ready,
      detected,
      bridgeDetected,
      mode,
      requiresBridge,
      environment,
      webMemoryCount,
      knowledge,
      bootstrap,
      search,
      getSuggestions,
      getStatus,
      getStats,
      getSnapshot,
      getBootstrapStatus,
      bootstrapHistory,
      startBootstrapImport,
      refreshKnowledge,
      analyzeThought,
      clearAllData,
      sendToExtension,
    }),
    [
      analyzeThought,
      bootstrap,
      bootstrapHistory,
      bridgeDetected,
      clearAllData,
      detected,
      environment,
      getBootstrapStatus,
      getSnapshot,
      getStats,
      getStatus,
      getSuggestions,
      knowledge,
      mode,
      ready,
      refreshKnowledge,
      requiresBridge,
      search,
      sendToExtension,
      startBootstrapImport,
      webMemoryCount,
    ]
  )
}
