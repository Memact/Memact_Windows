import { isSupabaseConfigured, requireSupabase } from "./supabase-client.js"
import { AccessApiError, HttpAccessClient, LEGACY_ACCESS_URL } from "./legacy-access-http-client.js"
import { SupabaseAccessClient } from "./supabase-access-client.js"
import "./supabase-access-fallbacks.js"

export const ACCESS_MODE = isSupabaseConfigured ? "supabase" : "http"
export const ACCESS_URL = ACCESS_MODE === "supabase" ? "supabase" : LEGACY_ACCESS_URL

export { AccessApiError }

export class AccessClient {
  constructor(baseUrl = LEGACY_ACCESS_URL) {
    this.impl = ACCESS_MODE === "supabase"
      ? new SupabaseAccessClient(requireSupabase())
      : new HttpAccessClient(baseUrl)
  }

  health(...args) {
    return this.impl.health(...args)
  }

  policy(...args) {
    return this.impl.policy(...args)
  }

  signup(...args) {
    return this.impl.signup(...args)
  }

  signin(...args) {
    return this.impl.signin(...args)
  }

  me(...args) {
    return this.impl.me(...args)
  }

  dashboard(...args) {
    return this.impl.dashboard(...args)
  }

  apps(...args) {
    return this.impl.apps(...args)
  }

  createApp(...args) {
    return this.impl.createApp(...args)
  }

  deleteApp(...args) {
    return this.impl.deleteApp(...args)
  }

  apiKeys(...args) {
    return this.impl.apiKeys(...args)
  }

  createApiKey(...args) {
    return this.impl.createApiKey(...args)
  }

  revokeApiKey(...args) {
    return this.impl.revokeApiKey(...args)
  }

  featureConnections(...args) {
    return this.impl.featureConnections(...args)
  }

  connectFeature(...args) {
    return this.impl.connectFeature(...args)
  }

  disconnectFeature(...args) {
    return this.impl.disconnectFeature(...args)
  }

  consents(...args) {
    return this.impl.consents(...args)
  }

  grantConsent(...args) {
    return this.impl.grantConsent(...args)
  }

  getConnectApp(...args) {
    return this.impl.getConnectApp(...args)
  }

  connectApp(...args) {
    return this.impl.connectApp(...args)
  }

  verifyApiKey(...args) {
    return this.impl.verifyApiKey(...args)
  }
}
