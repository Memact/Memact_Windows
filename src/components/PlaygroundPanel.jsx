import React, { useMemo, useState } from "react"

const FEATURES = [
  {
    id: "adaptive-article-overview",
    name: "Adaptive Article Overview",
    type: "Reading",
    summary: "Helps article apps choose the overview style a user is more likely to read.",
    details: "Uses reading memory the user allowed, such as scroll depth, finish rate, repeated topics, skipped topics, and summary style.",
    inputs: ["article content", "reading memory", "recent reading events"],
    output: "quick brief, key points, deep dive, or simple explainer",
    status: "Available"
  }
]

export function PlaygroundPanel({
  apps = [],
  apiKeys = [],
  featureConnections = [],
  selectedAppId,
  setSelectedAppId,
  onUseFeature,
  onDisconnectFeature
}) {
  const [query, setQuery] = useState("")
  const selectedApp = apps.find((app) => app.id === selectedAppId) || apps[0] || null
  const filteredFeatures = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return FEATURES
    return FEATURES.filter((feature) =>
      [feature.name, feature.type, feature.summary, feature.details].some((value) => value.toLowerCase().includes(needle))
    )
  }, [query])

  return (
    <section className="dashboard playground-page">
      <section className="panel playground-hero-panel">
        <p className="eyebrow">Playground</p>
        <h2>Memact Playground</h2>
        <p className="muted">A place for real Memact features. Connect a feature to an app key, use it, and disconnect it later.</p>
      </section>

      <section className="panel playground-store-panel">
        <div className="playground-toolbar">
          <label className="playground-search">
            Search features
            <input
              value={query}
              type="search"
              placeholder="Search reading, shopping, research..."
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <label className="playground-app-select">
            Connect for app
            <select value={selectedApp?.id || ""} onChange={(event) => setSelectedAppId(event.target.value)} disabled={!apps.length}>
              {!apps.length ? <option value="">Create an app first</option> : null}
              {apps.map((app) => <option key={app.id} value={app.id}>{app.name}</option>)}
            </select>
          </label>
        </div>

        <div className="feature-store-grid">
          {filteredFeatures.map((feature) => (
            <FeatureCard
              key={feature.id}
              feature={feature}
              app={selectedApp}
              apiKeys={apiKeys}
              connection={featureConnections.find((item) =>
                item.feature_id === feature.id
                && item.app_id === selectedApp?.id
                && !item.disconnected_at
              )}
              onUseFeature={onUseFeature}
              onDisconnectFeature={onDisconnectFeature}
            />
          ))}
          {!filteredFeatures.length ? <p className="muted">No features match that search yet.</p> : null}
        </div>
      </section>
    </section>
  )
}

function FeatureCard({ feature, app, apiKeys, connection, onUseFeature, onDisconnectFeature }) {
  const activeKey = app ? apiKeys.find((key) => key.app_id === app.id && !key.revoked_at) : null
  const canUse = Boolean(app?.id && activeKey?.id)
  return (
    <article className="feature-store-card">
      <div className="feature-card-top">
        <span className="feature-icon" aria-hidden="true">
          <span className="feature-icon-lines" />
        </span>
        <div>
          <p className="eyebrow">{feature.type}</p>
          <h3>{feature.name}</h3>
          <p className="muted">{feature.summary}</p>
        </div>
        <span className="badge badge-success">{feature.status}</span>
      </div>

      <div className="feature-card-body">
        <p>{feature.details}</p>
        <div className="feature-meta-grid">
          <div>
            <span>Uses</span>
            <strong>{feature.inputs.join(", ")}</strong>
          </div>
          <div>
            <span>Returns</span>
            <strong>{feature.output}</strong>
          </div>
        </div>
      </div>

      <div className="feature-card-actions">
        {connection ? (
          <>
            <span className="feature-connected">Connected to {app?.name}</span>
            <button type="button" className="ghost" onClick={() => onDisconnectFeature(connection.id)}>Disconnect</button>
          </>
        ) : (
          <>
            <span className="feature-connected muted">{canUse ? `Uses ${app.name}'s default key` : "Create an app and API key first"}</span>
            <button type="button" disabled={!canUse} onClick={() => onUseFeature(feature.id, app.id, activeKey.id)}>Use</button>
          </>
        )}
      </div>
    </article>
  )
}
