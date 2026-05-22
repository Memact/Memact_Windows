const env = import.meta.env || {}

export const LEGACY_ACCESS_URL = env.VITE_MEMACT_ACCESS_URL || "http://127.0.0.1:8787"

export class AccessApiError extends Error {
  constructor(status, message, code = "request_failed", raw = null) {
    super(message || "Request failed.")
    this.name = "AccessApiError"
    this.status = status
    this.code = code
    this.raw = raw
  }
}

export class HttpAccessClient {
  constructor(baseUrl) {
    this.baseUrl = String(baseUrl || "").replace(/\/$/, "")
  }

  health() {
    return this.get("/health")
  }

  policy() {
    return this.get("/v1/policy")
  }

  signup(body) {
    return this.post("/v1/auth/signup", body)
  }

  signin(body) {
    return this.post("/v1/auth/signin", body)
  }

  me(session) {
    return this.get("/v1/me", session)
  }

  async dashboard(session) {
    const [apps, apiKeys, consents, featureConnections] = await Promise.all([
      this.apps(session),
      this.apiKeys(session),
      this.consents(session),
      this.featureConnections(session)
    ])
    return {
      apps: apps.apps || [],
      api_keys: apiKeys.api_keys || [],
      consents: consents.consents || [],
      feature_connections: featureConnections.feature_connections || []
    }
  }

  apps(session) {
    return this.get("/v1/apps", session)
  }

  createApp(session, body) {
    return this.post("/v1/apps", body, session)
  }

  deleteApp(session, appId) {
    return this.delete(`/v1/apps/${encodeURIComponent(appId)}`, session)
  }

  apiKeys(session) {
    return this.get("/v1/api-keys", session)
  }

  createApiKey(session, body) {
    return this.post("/v1/api-keys", body, session)
  }

  revokeApiKey(session, keyId) {
    return this.post("/v1/api-keys/revoke", { key_id: keyId }, session)
  }

  featureConnections(session) {
    return this.get("/v1/feature-connections", session)
  }

  connectFeature(session, body) {
    return this.post("/v1/feature-connections", body, session)
  }

  disconnectFeature(session, connectionId) {
    return this.post("/v1/feature-connections/disconnect", { connection_id: connectionId }, session)
  }

  consents(session) {
    return this.get("/v1/consents", session)
  }

  grantConsent(session, body) {
    return this.post("/v1/consents", body, session)
  }

  getConnectApp(session, request = {}) {
    const query = new URLSearchParams({
      app_id: request?.app_id || "",
      scopes: (request?.scopes || []).join(","),
      categories: (request?.categories || []).join(",")
    })
    return this.get(`/v1/connect/app?${query.toString()}`, session)
  }

  connectApp(session, body) {
    return this.post("/v1/connect/approve", body, session)
  }

  async verifyApiKey(apiKey, requiredScopes = [], requiredCategories = [], connectionId = "") {
    const result = await this.request("/v1/access/verify", {
      method: "POST",
      apiKey,
      body: {
        required_scopes: requiredScopes,
        activity_categories: requiredCategories,
        connection_id: connectionId || null
      }
    })
    if (!result?.allowed) {
      throw new AccessApiError(403, result?.error?.message || "Access denied.", result?.error?.code || "scope_denied", result)
    }
    return result
  }

  async get(path, session = "") {
    return this.request(path, { method: "GET", session })
  }

  async post(path, body, session = "") {
    return this.request(path, { method: "POST", session, body })
  }

  async delete(path, session = "") {
    return this.request(path, { method: "DELETE", session })
  }

  async request(path, { method, session = "", apiKey = "", body } = {}) {
    const headers = { "Content-Type": "application/json" }
    if (session) headers.Authorization = `Bearer ${session}`
    if (apiKey) headers["X-Memact-API-Key"] = apiKey
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined
    })
    const text = await response.text()
    const data = parseResponseBody(text)
    if (!response.ok) {
      const errorPayload = data && typeof data === "object" ? data.error : null
      throw new AccessApiError(
        response.status,
        errorPayload?.message || response.statusText || "Request failed.",
        errorPayload?.code || "request_failed",
        data
      )
    }
    return data && typeof data === "object" ? data : {}
  }
}

function parseResponseBody(text) {
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}
