export const ROUTES = {
  home: "/",
  access: "/Dashboard",
  playground: "/Playground",
  wiki: "/Wiki",
  account: "/Account",
  data: "/Wiki",
  help: "/Help",
  learn: "/Learn",
  connect: "/connect"
}

const LEGACY_ROUTES = new Map([
  ["/dashboard", ROUTES.access],
  ["/Dashboard", ROUTES.access],
  ["/playground", ROUTES.playground],
  ["/Playground", ROUTES.playground],
  ["/wiki", ROUTES.wiki],
  ["/Wiki", ROUTES.wiki],
  ["/login", `${ROUTES.home}#sign-in`],
  ["/access", ROUTES.access],
  ["/Access", ROUTES.access],
  ["/account", ROUTES.home],
  ["/learn", ROUTES.learn],
  ["/learn/", ROUTES.learn],
  ["/Learn/", ROUTES.learn],
  ["/data", ROUTES.wiki],
  ["/DataTransparency", ROUTES.wiki],
  ["/transparency", ROUTES.wiki],
  ["/data-transparency", ROUTES.wiki]
])

export function normalizePortalPath(pathname = "/") {
  return LEGACY_ROUTES.get(pathname) || pathname || ROUTES.home
}

export function pageFromLocation(locationLike = globalThis.window?.location) {
  const pathname = normalizePortalPath(locationLike?.pathname || ROUTES.home)
  if (pathname === ROUTES.access) return "access"
  if (pathname === ROUTES.playground) return "playground"
  if (pathname === ROUTES.wiki) return "wiki"
  if (pathname === ROUTES.account) return "account"
  if (pathname === ROUTES.help) return "help"
  if (pathname === ROUTES.learn) return "learn"
  if (pathname === ROUTES.connect) return "connect"
  return "home"
}

export function routeForPage(page = "home") {
  return ROUTES[page] || ROUTES.home
}

export function isProtectedPage(page = "home") {
  return page === "access" || page === "playground" || page === "wiki" || page === "account" || page === "data" || page === "connect"
}

export function isConnectPage(page = "home") {
  return page === "connect"
}
