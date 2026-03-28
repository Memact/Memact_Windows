import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { detectClientEnvironment } from '../lib/environment'
import {
  clearWebMemories,
  initializeWebMemoryStore,
  webMemorySearch,
  webMemoryStats,
  webMemoryStatus,
  webMemorySuggestions,
} from '../lib/webMemoryStore'

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
    type === 'MEMACT_ERROR'
  )
}

export function useExtension() {
  const environment = useMemo(() => detectClientEnvironment(), [])
  const supportsBridge = environment.extensionCapable
  const useWebFallback = environment.mobile || !supportsBridge
  const [ready, setReady] = useState(useWebFallback)
  const [detected, setDetected] = useState(useWebFallback)
  const [bridgeDetected, setBridgeDetected] = useState(false)
  const [webMemoryCount, setWebMemoryCount] = useState(0)
  const pending = useRef(new Map())

  useEffect(() => {
    const init = initializeWebMemoryStore(environment)
    setWebMemoryCount(Number(init.memoryCount || 0))
    if (useWebFallback) {
      setReady(true)
      setDetected(true)
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
      return Promise.resolve(webMemorySearch(query, limit, environment))
    }
    return sendToExtension('MEMACT_SEARCH', { query, limit })
  }, [bridgeDetected, environment, sendToExtension, useWebFallback])

  const getSuggestions = useCallback((query = '', timeFilter = null, limit = 6) => {
    if (useWebFallback && !bridgeDetected) {
      return Promise.resolve(webMemorySuggestions(query, timeFilter, limit))
    }
    return sendToExtension('MEMACT_SUGGESTIONS', { query, timeFilter, limit })
  }, [bridgeDetected, sendToExtension, useWebFallback])

  const getStatus = useCallback(() => {
    if (useWebFallback && !bridgeDetected) {
      return Promise.resolve(webMemoryStatus(environment))
    }
    return sendToExtension('MEMACT_STATUS', {})
  }, [bridgeDetected, environment, sendToExtension, useWebFallback])

  const getStats = useCallback(() => {
    if (useWebFallback && !bridgeDetected) {
      return Promise.resolve(webMemoryStats())
    }
    return sendToExtension('MEMACT_STATS', {})
  }, [bridgeDetected, sendToExtension, useWebFallback])

  const clearAllData = useCallback(() => {
    if (useWebFallback && !bridgeDetected) {
      const response = clearWebMemories()
      if (response?.ok) {
        setWebMemoryCount(0)
      }
      return Promise.resolve(response)
    }
    return sendToExtension('MEMACT_CLEAR_ALL_DATA', {})
  }, [bridgeDetected, sendToExtension, useWebFallback])

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
      search,
      getSuggestions,
      getStatus,
      getStats,
      clearAllData,
      sendToExtension,
    }),
    [
      bridgeDetected,
      clearAllData,
      detected,
      environment,
      getStatus,
      getStats,
      getSuggestions,
      mode,
      ready,
      requiresBridge,
      search,
      sendToExtension,
      webMemoryCount,
    ]
  )
}
