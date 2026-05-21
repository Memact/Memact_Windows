import React, { useRef } from "react"

export function DataTransparencyPage({
  app,
  categories,
  scopes,
  requestedCategories = [],
  requestedScopes = [],
  transparency,
  onUpdateSelection,
  onBackToConsent,
  onManageConsent
}) {
  const appName = app?.name || "this app"
  const optionRef = useStableRequestedOptions(app?.id, requestedScopes, requestedCategories)
  const dataUses = normalizeDisclosureList(transparency?.data_uses || transparency?.dataUses)
  const capturedData = normalizeDisclosureList(transparency?.captured_data || transparency?.capturedData || transparency?.data_collected)
  const createdContext = normalizeDisclosureList(transparency?.created_context || transparency?.intent_context || transparency?.intentContext || transparency?.graph_packets || transparency?.graphPackets || transparency?.memory_packets)
  const allowedFeatures = normalizeDisclosureList(transparency?.features || transparency?.allowed_features || transparency?.allowedFeatures)
  const retention = transparency?.retention || transparency?.retention_policy || "The app has not provided a specific retention statement yet."
  const revocation = transparency?.revocation || transparency?.revocation_policy || "After consent is revoked, new Memact access should stop. Previously copied data must follow the app's own deletion policy."
  const safeRequestedScopes = Array.isArray(requestedScopes) ? requestedScopes : []
  const safeRequestedCategories = Array.isArray(requestedCategories) ? requestedCategories : []
  const scopeOptions = optionRef.current.scopes
  const categoryOptions = optionRef.current.categories
  const hasEnoughSelection = safeRequestedScopes.length > 0 && safeRequestedCategories.length > 0
  const toggleScope = (scope) => {
    const nextScopes = safeRequestedScopes.includes(scope)
      ? safeRequestedScopes.filter((item) => item !== scope)
      : [...safeRequestedScopes, scope]
    onUpdateSelection?.({ scopes: nextScopes, categories: safeRequestedCategories })
  }
  const toggleCategory = (category) => {
    const nextCategories = safeRequestedCategories.includes(category)
      ? safeRequestedCategories.filter((item) => item !== category)
      : [...safeRequestedCategories, category]
    onUpdateSelection?.({ scopes: safeRequestedScopes, categories: nextCategories })
  }

  return (
    <section className="panel transparency-panel">
      <div className="transparency-hero">
        <div>
          <p className="eyebrow">Data transparency</p>
          <h2>Control what {appName} can use.</h2>
          <p className="muted">See what this app can use, what Memact creates, and what the app may receive back.</p>
        </div>
      </div>

      <div className="app-identity connect-identity">
        <span className="app-avatar" aria-hidden="true">{appName.slice(0, 1).toUpperCase()}</span>
        <div>
          <strong>{appName}</strong>
          {app?.developer_url ? (
            <a className="muted" href={app.developer_url} target="_blank" rel="noreferrer">{app.developer_url}</a>
          ) : <span className="muted">Developer URL not provided.</span>}
        </div>
      </div>

      <section className="permission-list transparency-controls-panel">
        <div className="transparency-control-head">
          <div>
            <p className="eyebrow">Your controls</p>
            <h3>Choose what is allowed before consent</h3>
          </div>
          <div className="transparency-summary" aria-label="Transparency summary">
            <span><strong>{safeRequestedScopes.length}</strong> Scopes</span>
            <span><strong>{safeRequestedCategories.length}</strong> Categories</span>
          </div>
        </div>
        {!hasEnoughSelection ? (
          <p className="notice" role="status">Select at least one permission and one activity category before returning to consent.</p>
        ) : null}
        <div className="transparency-choice-grid">
          <div className="transparency-choice-group">
            <p className="app-list-label">Allowed permissions</p>
            <div className="transparency-control-list">
              {scopeOptions.map((scope) => (
                <label className="transparency-control" key={scope}>
                  <input
                    type="checkbox"
                    checked={safeRequestedScopes.includes(scope)}
                    onChange={() => toggleScope(scope)}
                  />
                  <span>
                    <strong>{scopes?.[scope]?.label || scope}</strong>
                    <small>{scopes?.[scope]?.description || scope}</small>
                  </span>
                </label>
              ))}
              {!scopeOptions.length ? <p className="muted">No permissions were attached to this transparency link.</p> : null}
            </div>
          </div>
          <div className="transparency-choice-group">
            <p className="app-list-label">Allowed activity</p>
            <div className="transparency-control-list">
              {categoryOptions.map((category) => (
                <label className="transparency-control" key={category}>
                  <input
                    type="checkbox"
                    checked={safeRequestedCategories.includes(category)}
                    onChange={() => toggleCategory(category)}
                  />
                  <span>
                    <strong>{categories?.[category]?.label || category}</strong>
                    <small>{categories?.[category]?.description || category}</small>
                  </span>
                </label>
              ))}
              {!categoryOptions.length ? <p className="muted">No activity categories were attached to this transparency link.</p> : null}
            </div>
          </div>
        </div>
      </section>

      <div className="transparency-grid">
        <section className="permission-list transparency-card">
          <p className="eyebrow">What this app can send</p>
          <h3>Signals and activity fields</h3>
          <DisclosureList
            items={capturedData}
            empty="This app has not listed exact fields yet. It should disclose fields such as URLs, page titles, selected text, transcripts, snippets, or timestamps."
          />
        </section>

        <section className="permission-list transparency-card">
          <p className="eyebrow">What Memact may create</p>
          <h3>Context created from those signals</h3>
          <DisclosureList
            items={createdContext}
            empty="Memact may create useful memory from the categories you allow. The app should explain what it wants to use."
          />
        </section>

        <section className="permission-list transparency-card">
          <p className="eyebrow">Why the app wants it</p>
          <h3>Why it wants access</h3>
          <DisclosureList
            items={dataUses}
            empty={app?.description || "This app has not provided a plain-language reason for what it wants yet."}
          />
        </section>

        <section className="permission-list transparency-card">
          <p className="eyebrow">What this app may use</p>
          <h3>Features and allowed memory</h3>
          <DisclosureList
            items={allowedFeatures}
            empty="No specific feature list was provided. The allowed permissions and categories above still limit what the app can use."
          />
        </section>

        <section className="permission-list transparency-card">
          <p className="eyebrow">How long access lasts</p>
          <h3>How long it keeps data</h3>
          <p className="muted">{retention}</p>
        </section>

        <section className="permission-list transparency-card">
          <p className="eyebrow">Stop future access</p>
          <h3>How to stop future access</h3>
          <p className="muted">{revocation} Removing app access stops future Memact access for this app.</p>
        </section>
      </div>

      <div className="connect-actions">
        <button type="button" onClick={onBackToConsent}>Back to consent</button>
        <button type="button" className="ghost" onClick={onManageConsent}>Open dashboard</button>
      </div>
    </section>
  )
}

function useStableRequestedOptions(appId, requestedScopes, requestedCategories) {
  const safeScopes = Array.isArray(requestedScopes) ? requestedScopes : []
  const safeCategories = Array.isArray(requestedCategories) ? requestedCategories : []
  const ref = useRef({ appId, scopes: safeScopes, categories: safeCategories })
  if (ref.current.appId !== appId) {
    ref.current = { appId, scopes: safeScopes, categories: safeCategories }
  } else {
    ref.current = {
      appId,
      scopes: mergeUnique(ref.current.scopes, safeScopes),
      categories: mergeUnique(ref.current.categories, safeCategories)
    }
  }
  return ref
}

function mergeUnique(first = [], second = []) {
  return Array.from(new Set([...first, ...second].filter(Boolean)))
}

function DisclosureList({ items, empty }) {
  if (!items.length) {
    return <p className="muted">{empty}</p>
  }
  return (
    <div className="stack">
      {items.map((item) => (
        <div className="mini-row" key={item.title}>
          <strong>{item.title}</strong>
          {item.description ? <small>{item.description}</small> : null}
        </div>
      ))}
    </div>
  )
}

function normalizeDisclosureList(value) {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => {
      if (typeof item === "string") return { title: item.trim(), description: "" }
      return {
        title: String(item?.title || item?.name || item?.type || "").trim(),
        description: String(item?.description || item?.details || item?.purpose || "").trim()
      }
    })
    .filter((item) => item.title)
}
