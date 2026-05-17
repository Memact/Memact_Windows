import assert from "node:assert/strict"
import test from "node:test"
import { isProtectedPage, normalizePortalPath, pageFromLocation, routeForPage } from "../portal-routes.js"

test("portal routes map clean URL pages", () => {
  assert.equal(pageFromLocation({ pathname: "/" }), "home")
  assert.equal(pageFromLocation({ pathname: "/Dashboard" }), "access")
  assert.equal(pageFromLocation({ pathname: "/Access" }), "access")
  assert.equal(pageFromLocation({ pathname: "/access" }), "access")
  assert.equal(pageFromLocation({ pathname: "/Account" }), "account")
  assert.equal(pageFromLocation({ pathname: "/DataTransparency" }), "data")
  assert.equal(pageFromLocation({ pathname: "/Help" }), "help")
  assert.equal(pageFromLocation({ pathname: "/connect" }), "connect")
})

test("legacy dashboard and login paths normalize to current routes", () => {
  assert.equal(normalizePortalPath("/dashboard"), "/Dashboard")
  assert.equal(normalizePortalPath("/Access"), "/Dashboard")
  assert.equal(normalizePortalPath("/login"), "/#sign-in")
  assert.equal(normalizePortalPath("/access"), "/Dashboard")
  assert.equal(normalizePortalPath("/account"), "/")
  assert.equal(normalizePortalPath("/data-transparency"), "/DataTransparency")
})

test("route metadata keeps help public and account/data protected", () => {
  assert.equal(isProtectedPage("help"), false)
  assert.equal(isProtectedPage("account"), true)
  assert.equal(isProtectedPage("data"), true)
  assert.equal(routeForPage("access"), "/Dashboard")
  assert.equal(routeForPage("help"), "/Help")
  assert.equal(routeForPage("data"), "/DataTransparency")
})
