import assert from "node:assert/strict"
import test from "node:test"
import { getAuthRedirectUrl, isSupabaseConfigured } from "../supabase-client.js"

test("Supabase is unconfigured without public env vars", () => {
  assert.equal(isSupabaseConfigured, false)
})

test("getAuthRedirectUrl defaults to the current site origin", () => {
  const previousWindow = globalThis.window
  globalThis.window = { location: { origin: "https://preview.memact.com" } }

  try {
    assert.equal(getAuthRedirectUrl(), "https://preview.memact.com/Dashboard")
  } finally {
    if (previousWindow === undefined) {
      delete globalThis.window
    } else {
      globalThis.window = previousWindow
    }
  }
})
