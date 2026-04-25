const MAX_SOURCES = 4
const MAX_SCHEMA_SIGNALS = 3
const MAX_INFLUENCE_SIGNALS = 3

function normalize(value, maxLength = 0) {
  const text = String(value || '')
    .replace(/\s+/g, ' ')
    .trim()

  if (!text) return ''
  if (maxLength && text.length > maxLength) {
    return `${text.slice(0, maxLength - 3).trim()}...`
  }
  return text
}

function compactArray(value, limit) {
  return (Array.isArray(value) ? value : []).slice(0, limit)
}

function cleanAnswerMeta(value) {
  if (!value || typeof value !== 'object') return null
  return {
    overview: normalize(value.overview, 140),
    answer: normalize(value.answer, 180),
    summary: normalize(value.summary, 360),
    signals: compactArray(value.signals, 5).map((item) => normalize(item, 120)).filter(Boolean),
    detailItems: compactArray(value.detailItems, 5)
      .map((item) => ({
        label: normalize(item?.label, 40),
        value: normalize(item?.value, 80),
      }))
      .filter((item) => item.label && item.value),
  }
}

function cleanSource(result) {
  return {
    title: normalize(result?.title, 140),
    domain: normalize(result?.domain, 80),
    url: normalize(result?.url, 260),
    source_type: normalize(result?.source, 40),
    summary:
      normalize(result?.structuredSummary, 240) ||
      normalize(result?.displayExcerpt, 240) ||
      normalize(result?.snippet, 240),
    themes: compactArray(result?.contextTopics, 6).map((item) => normalize(item, 48)).filter(Boolean),
  }
}

function cleanExplanationRequest(explanationRequest = {}) {
  const evidence = explanationRequest.evidence || {}

  return {
    contract: normalize(explanationRequest.contract, 80),
    version: normalize(explanationRequest.version, 24),
    query: normalize(explanationRequest.query, 180),
    policy: {
      ai_role: 'short_answer_from_minimal_schema_packet',
      deterministic_reasoning_done: true,
      cloud_payload_minimized: true,
      must_not_invent_sources: true,
      must_not_claim_causality: true,
      must_preserve_uncertainty: true,
    },
    deterministic_answer: cleanAnswerMeta(explanationRequest.deterministic_answer),
    evidence: {
      origin_sources: compactArray(evidence.origin_sources, MAX_SOURCES).map((item) => ({
        label: normalize(item?.label, 140),
        title: normalize(item?.title, 140),
        domain: normalize(item?.domain, 80),
        url: normalize(item?.url, 260),
        score: Number(item?.score || 0),
        overlapping_terms: compactArray(item?.overlapping_terms, 10)
          .map((term) => normalize(term, 40))
          .filter(Boolean),
        canonical_themes: compactArray(item?.canonical_themes, 8)
          .map((theme) => normalize(theme, 40))
          .filter(Boolean),
      })),
      schema_signals: compactArray(evidence.schema_signals, MAX_SCHEMA_SIGNALS).map((item) => ({
        label: normalize(item?.label, 120),
        state: normalize(item?.state, 60),
        summary: normalize(item?.summary, 220),
        matched_themes: compactArray(item?.matched_themes, 8)
          .map((theme) => normalize(theme, 40))
          .filter(Boolean),
      })),
      influence_signals: compactArray(evidence.influence_signals, MAX_INFLUENCE_SIGNALS).map((chain) => ({
        from: normalize(chain?.from, 80),
        to: normalize(chain?.to, 80),
        count: Number(chain?.count || 0),
        confidence: Number(chain?.confidence || 0),
        summary: normalize(chain?.summary, 220),
      })),
    },
    stats: {
      eventCount: Number(explanationRequest.stats?.eventCount || 0),
      schemaCount: Number(explanationRequest.stats?.schemaCount || 0),
      influenceCount: Number(explanationRequest.stats?.influenceCount || 0),
    },
  }
}

function buildPayload({ query, explanation, answerMeta, results }) {
  const request =
    explanation?.apiExplanationRequest ||
    {
      query,
      deterministic_answer: answerMeta,
      evidence: {},
      stats: {},
    }

  return {
    query: normalize(query, 180),
    request: cleanExplanationRequest(request),
    sources: compactArray(results, MAX_SOURCES).map(cleanSource).filter((source) => source.title || source.url),
  }
}

function normalizeCloudResponse(value) {
  if (!value || typeof value !== 'object') return null
  const answer = value.answer || value

  return {
    overview: normalize(answer.overview, 140),
    answer: normalize(answer.answer, 180),
    summary: normalize(answer.summary, 360),
    provider: normalize(value.provider || 'gemini', 40),
    model: normalize(value.model || 'gemini-2.5-flash', 80),
    applied: Boolean(value.applied ?? answer.summary),
  }
}

export async function requestCloudExplanation({ query, explanation, answerMeta, results }) {
  const endpoint = normalize(import.meta.env.VITE_MEMACT_GEMINI_ENDPOINT)
  if (!endpoint || !answerMeta) {
    return null
  }

  const payload = buildPayload({ query, explanation, answerMeta, results })
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), 9000)

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })

    if (!response.ok) {
      return null
    }

    return normalizeCloudResponse(await response.json())
  } catch {
    return null
  } finally {
    window.clearTimeout(timer)
  }
}
