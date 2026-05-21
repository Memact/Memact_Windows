export const DEFAULT_SCOPES = [
  "capture:webpage",
  "schema:write",
  "graph:write",
  "memory:write",
  "memory:read_summary"
]

export const DEFAULT_CATEGORIES = [
  "web:news",
  "web:research",
  "media:video",
  "ai:assistant",
  "dev:code"
]

export function availablePolicyScopes(policy) {
  return Object.keys(policy?.scopes || {})
}

export function availablePolicyCategories(policy) {
  return Object.keys(policy?.activity_categories || {})
}

export function defaultScopesForPolicy(policy) {
  const availableScopes = availablePolicyScopes(policy)
  if (!availableScopes.length) return DEFAULT_SCOPES

  const policyDefaults = DEFAULT_SCOPES.filter((scope) => availableScopes.includes(scope))
  return policyDefaults.length ? policyDefaults : availableScopes
}

export function suggestedScopesForCategories(policy, categories = []) {
  const availableScopes = availablePolicyScopes(policy)
  const allowed = new Set(availableScopes.length ? availableScopes : DEFAULT_SCOPES)
  const selectedCategories = new Set(Array.isArray(categories) ? categories : [])
  const matrix = policy?.category_permission_matrix || {}
  const suggested = new Set()

  for (const category of selectedCategories) {
    const row = matrix[category] || {}
    for (const [scope, status] of Object.entries(row)) {
      if (status === "recommended") suggested.add(scope)
    }
  }

  if (suggested.size) {
    return [...suggested].filter((scope) => allowed.has(scope))
  }

  if (selectedCategories.size) {
    suggested.add("capture:webpage")
    suggested.add("schema:write")
    suggested.add("memory:read_summary")
    suggested.add("feature:list")
  }

  if (selectedCategories.has("web:news") || selectedCategories.has("web:social") || selectedCategories.has("web:research")) {
    suggested.add("graph:write")
    suggested.add("memory:write")
  }
  if (selectedCategories.has("media:video") || selectedCategories.has("media:audio")) {
    suggested.add("capture:media")
  }
  if (selectedCategories.has("dev:code") || selectedCategories.has("ai:assistant") || selectedCategories.has("work:docs")) {
    suggested.add("memory:write")
  }
  if (selectedCategories.has("web:social") || selectedCategories.has("dev:code")) {
    suggested.add("memory:read_evidence")
  }

  return [...suggested].filter((scope) => allowed.has(scope))
}

export function permissionSuggestionForCategories(policy, categories = []) {
  const selectedCategories = normalizeSelectedCategories(categories, policy)
  const scopes = suggestedScopesForCategories(policy, selectedCategories)
  return {
    label: selectedCategories.includes("web:news") ? "Article personalization preset" : "Suggested preset",
    description: "Selected from this app's activity categories. You can still adjust it.",
    scopes: normalizeSelectedScopes(scopes, policy),
    categories: selectedCategories
  }
}

export function presetSuggestionsForPolicy(policy, categories = [], appPurpose = "") {
  const selectedCategories = normalizeSelectedCategories(categories, policy)
  const primary = permissionSuggestionForCategories(policy, selectedCategories)
  const leanScopes = normalizeSelectedScopes(["capture:webpage", selectedCategories.some((category) => category.startsWith("media:")) ? "capture:media" : "", "schema:write", "memory:read_summary", "feature:list"], policy)
  const explainableScopes = normalizeSelectedScopes([...primary.scopes, "memory:read_evidence"], policy)
  const purpose = String(appPurpose || "").toLowerCase()
  const purposeBoostedScopes = /debug|audit|source|citation|evidence|explain|why/.test(purpose)
    ? explainableScopes
    : primary.scopes

  return [
    {
      ...primary,
      label: selectedCategories.includes("web:news") ? "Article personalization preset" : primary.label,
      scopes: purposeBoostedScopes
    },
    {
      id: `lean-${leanScopes.join("-")}`,
      label: "Lean memory preset",
      description: "Smallest useful set for scoped personalization.",
      scopes: leanScopes,
      categories: selectedCategories
    },
    {
      id: `explain-${explainableScopes.join("-")}`,
      label: "Explainable preset",
      description: "Adds evidence cards so users can see why a feature returned something.",
      scopes: explainableScopes,
      categories: selectedCategories
    }
  ].filter((preset, index, presets) => preset.scopes.length && presets.findIndex((item) => item.scopes.join("|") === preset.scopes.join("|")) === index)
}

export function defaultCategoriesForPolicy(policy) {
  const availableCategories = availablePolicyCategories(policy)
  if (!availableCategories.length) return DEFAULT_CATEGORIES

  const policyDefaults = (policy?.default_app_categories || DEFAULT_CATEGORIES)
    .filter((category) => availableCategories.includes(category))
  return policyDefaults.length ? policyDefaults : availableCategories
}

export function normalizeSelectedScopes(scopes, policy) {
  const selectedScopes = Array.isArray(scopes) ? scopes : []
  const dedupedScopes = [...new Set(selectedScopes)]
  const availableScopes = availablePolicyScopes(policy)
  if (!availableScopes.length) return dedupedScopes

  return dedupedScopes.filter((scope) => availableScopes.includes(scope))
}

export function normalizeSelectedCategories(categories, policy) {
  const selectedCategories = Array.isArray(categories) ? categories : []
  const dedupedCategories = [...new Set(selectedCategories)]
  const availableCategories = availablePolicyCategories(policy)
  if (!availableCategories.length) return dedupedCategories

  return dedupedCategories.filter((category) => availableCategories.includes(category))
}
