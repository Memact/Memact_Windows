export const ROUTES = {
  home: "/",
  access: "/Dashboard",
  account: "/Account",
  data: "/DataTransparency",
  help: "/Help",
  connect: "/connect"
}

const LEGACY_ROUTES = new Map([
  ["/dashboard", ROUTES.access],
  ["/Dashboard", ROUTES.access],
  ["/login", `${ROUTES.home}#sign-in`],
  ["/access", ROUTES.access],
  ["/Access", ROUTES.access],
  ["/account", ROUTES.home],
  ["/data", ROUTES.data],
  ["/transparency", ROUTES.data],
  ["/data-transparency", ROUTES.data]
])

export function normalizePortalPath(pathname = "/") {
  return LEGACY_ROUTES.get(pathname) || pathname || ROUTES.home
}

export function pageFromLocation(locationLike = globalThis.window?.location) {
  const pathname = normalizePortalPath(locationLike?.pathname || ROUTES.home)
  if (pathname === ROUTES.access) return "access"
  if (pathname === ROUTES.account) return "account"
  if (pathname === ROUTES.data) return "data"
  if (pathname === ROUTES.help) return "help"
  if (pathname === ROUTES.connect) return "connect"
  return "home"
}

export function routeForPage(page = "home") {
  return ROUTES[page] || ROUTES.home
}

export function isProtectedPage(page = "home") {
  return page === "access" || page === "account" || page === "data" || page === "connect"
}

export function isConnectPage(page = "home") {
  return page === "connect"
}
