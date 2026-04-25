import http from 'node:http'
import { existsSync, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT_DIR = path.resolve(__dirname, '..')
const DIST_DIR = path.join(ROOT_DIR, 'dist')

function loadEnvFile() {
  const envPath = path.join(ROOT_DIR, '.env')
  if (!existsSync(envPath)) return
  const lines = readFileSync(envPath, 'utf8').split(/\r?\n/)
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue
    const [key, ...rest] = trimmed.split('=')
    const name = key.trim()
    if (!name || process.env[name]) continue
    process.env[name] = rest.join('=').trim().replace(/^["']|["']$/g, '')
  }
}

loadEnvFile()

const PORT = Number(process.env.PORT || process.env.MEMACT_API_PORT || 8787)
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash'
const MAX_OUTPUT_TOKENS = Number(process.env.GEMINI_MAX_OUTPUT_TOKENS || 180)
const TEMPERATURE = Number(process.env.GEMINI_TEMPERATURE || 0.1)
const MAX_REQUEST_BYTES = Number(process.env.MEMACT_GEMINI_MAX_REQUEST_BYTES || 14000)
const ALLOWED_ORIGINS = new Set(
  String(process.env.MEMACT_ALLOWED_ORIGINS || 'http://localhost:5173,https://memact.com,https://www.memact.com')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean)
)

const MIME_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.ico', 'image/x-icon'],
  ['.webmanifest', 'application/manifest+json'],
  ['.zip', 'application/zip'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
  ['.ttf', 'font/ttf'],
])

function sendJson(response, statusCode, body, origin = '') {
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  }
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    headers['access-control-allow-origin'] = origin
    headers.vary = 'origin'
  }
  response.writeHead(statusCode, headers)
  response.end(JSON.stringify(body))
}

function normalize(value, maxLength = 0) {
  const text = String(value || '').replace(/\s+/g, ' ').trim()
  if (!text) return ''
  if (maxLength && text.length > maxLength) {
    return `${text.slice(0, maxLength - 3).trim()}...`
  }
  return text
}

function compactForPrompt(payload = {}) {
  return {
    query: normalize(payload.query, 180),
    request: payload.request || {},
    sources: Array.isArray(payload.sources) ? payload.sources.slice(0, 4) : [],
  }
}

function hasEvidence(payload = {}) {
  const compact = compactForPrompt(payload)
  const evidence = compact.request?.evidence || {}
  return Boolean(
    compact.sources.length ||
      evidence.origin_sources?.length ||
      evidence.schema_signals?.length ||
      evidence.influence_signals?.length
  )
}

function buildGeminiPrompt(payload) {
  return [
    'You are Memact, a short answer engine that explains where a thought may be formed or shaped from.',
    'Use only the compact evidence packet below.',
    'Do not invent sources, links, dates, counts, or causes.',
    'Do not claim certainty. Use neutral wording such as "may", "appears", or "the strongest match".',
    'Return strict JSON only with keys: overview, answer, summary.',
    'overview: max 12 words.',
    'answer: max 18 words.',
    'summary: one or two short sentences, max 45 words total.',
    '',
    JSON.stringify(compactForPrompt(payload)),
  ].join('\n')
}

async function readRequestBody(request) {
  let size = 0
  const chunks = []
  for await (const chunk of request) {
    size += chunk.byteLength
    if (size > MAX_REQUEST_BYTES) {
      throw new Error('request_too_large')
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function extractGeminiText(response) {
  const parts = response?.candidates?.[0]?.content?.parts || []
  return parts.map((part) => part?.text || '').join('').trim()
}

function parseJsonText(text) {
  try {
    return JSON.parse(text)
  } catch {
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start >= 0 && end > start) {
      return JSON.parse(text.slice(start, end + 1))
    }
    throw new Error('invalid_model_json')
  }
}

async function handleGeminiAnswer(request, response, origin) {
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey || /replace/i.test(apiKey)) {
    sendJson(response, 503, { error: 'gemini_api_key_missing' }, origin)
    return
  }

  let payload
  try {
    payload = JSON.parse(await readRequestBody(request))
  } catch (error) {
    sendJson(response, error?.message === 'request_too_large' ? 413 : 400, {
      error: error?.message || 'invalid_json',
    }, origin)
    return
  }

  if (!hasEvidence(payload)) {
    sendJson(response, 200, {
      provider: 'gemini',
      model: GEMINI_MODEL,
      applied: false,
      skipped: true,
      reason: 'no_selected_evidence',
    }, origin)
    return
  }

  const geminiResponse = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [{ text: buildGeminiPrompt(payload) }],
          },
        ],
        generationConfig: {
          temperature: TEMPERATURE,
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          responseMimeType: 'application/json',
        },
      }),
    }
  )

  const geminiJson = await geminiResponse.json().catch(() => ({}))
  if (!geminiResponse.ok) {
    sendJson(response, geminiResponse.status, {
      error: 'gemini_request_failed',
      detail: normalize(geminiJson?.error?.message, 240),
    }, origin)
    return
  }

  const answer = parseJsonText(extractGeminiText(geminiJson))
  sendJson(response, 200, {
    provider: 'gemini',
    model: GEMINI_MODEL,
    applied: true,
    answer: {
      overview: normalize(answer.overview, 140),
      answer: normalize(answer.answer, 180),
      summary: normalize(answer.summary, 360),
    },
  }, origin)
}

async function serveStatic(request, response) {
  const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`)
  const pathname = decodeURIComponent(url.pathname)
  const safePath = pathname === '/' ? '/index.html' : pathname
  const filePath = path.resolve(DIST_DIR, `.${safePath}`)

  if (!filePath.startsWith(DIST_DIR)) {
    response.writeHead(403)
    response.end('Forbidden')
    return
  }

  try {
    const content = await readFile(filePath)
    const extension = path.extname(filePath)
    response.writeHead(200, {
      'content-type': MIME_TYPES.get(extension) || 'application/octet-stream',
      'cache-control': pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
    })
    response.end(content)
  } catch {
    const index = await readFile(path.join(DIST_DIR, 'index.html'))
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-cache',
    })
    response.end(index)
  }
}

const server = http.createServer(async (request, response) => {
  const origin = normalize(request.headers.origin)
  if (request.method === 'OPTIONS') {
    response.writeHead(204, {
      'access-control-allow-origin': ALLOWED_ORIGINS.has(origin) ? origin : '',
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': 'content-type',
      vary: 'origin',
    })
    response.end()
    return
  }

  try {
    if (request.url?.startsWith('/api/gemini-answer') && request.method === 'POST') {
      await handleGeminiAnswer(request, response, origin)
      return
    }

    if (request.method === 'GET' || request.method === 'HEAD') {
      await serveStatic(request, response)
      return
    }

    sendJson(response, 405, { error: 'method_not_allowed' }, origin)
  } catch (error) {
    sendJson(response, 500, { error: normalize(error?.message || error || 'server_error', 180) }, origin)
  }
})

server.listen(PORT, () => {
  console.log(`Memact server listening on http://localhost:${PORT}`)
})
