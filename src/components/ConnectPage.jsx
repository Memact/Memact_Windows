import React from "react"

export function ConnectPage({ connectRequest, connectDetails, loading, notice, selectedScopes = [], selectedCategories = [], onToggleScope, onToggleCategory, onApprove, onCancel, onLearnMore, onWiki }) {
  const app = connectDetails?.app
  const scopes = connectDetails?.scopes || {}
  const categories = connectDetails?.activity_categories || {}
  const requestedScopes = connectDetails?.requested_scopes || connectRequest?.scopes || []
  const requestedCategories = connectDetails?.requested_categories || connectRequest?.categories || []
  const allowedScopes = selectedScopes.length ? selectedScopes : []
  const allowedCategories = selectedCategories.length ? selectedCategories : []
  const appName = app?.name || "this app"
  const canApprove = Boolean(app?.id && allowedScopes.length && allowedCategories.length && loading !== "approve")

  return (
    <section className="connect-shell">
      <article className="panel connect-card">
        <div className="connect-hero">
          <div>
            <p className="eyebrow">Connect app</p>
            <h2>{appName} wants to connect.</h2>
            <p className="muted">Choose what this app can use before you connect it.</p>
          </div>
        </div>

        <div className="app-identity connect-identity">
          <span className="app-avatar" aria-hidden="true"><span /></span>
          <div>
            <strong>{appName}</strong>
            {app?.developer_url ? (
              <a className="muted" href={app.developer_url} target="_blank" rel="noreferrer">{app.developer_url}</a>
            ) : <span className="muted">Developer URL not provided.</span>}
          </div>
        </div>

        {loading === "loading" ? <p className="status-line">Loading app details.</p> : null}
        {notice ? <p className="notice notice-success" role="status">{notice}</p> : null}

        <section className="permission-list consent-summary-card">
          <div>
            <p className="eyebrow">Before you approve</p>
            <h3>What this connection allows</h3>
          </div>
          <div className="consent-points">
            <div className="mini-row">
              <strong>Approval is optional and scoped.</strong>
              <small>Permissions and categories limit what this app can use.</small>
            </div>
            <div className="mini-row">
              <strong>Wiki explains the details.</strong>
              <small>It shows what the app can add, what Memact may create, and what the app may receive.</small>
            </div>
            <div className="mini-row">
              <strong>You can disconnect later.</strong>
              <small>Removing access stops future Memact access for this app.</small>
            </div>
          </div>
          <div className="connect-link-row">
            <button type="button" className="learn-more-link connect-learn-more" onClick={onLearnMore}>Learn more</button>
            <button type="button" className="button connect-learn-more" onClick={onWiki}>Wiki</button>
          </div>
        </section>

        <div className="connect-grid">
          <section className="permission-list">
            <p className="eyebrow">Permissions</p>
            {requestedScopes.length ? requestedScopes.map((scope) => (
              <label className="scope-card consent-choice-card" key={scope}>
                <input
                  type="checkbox"
                  checked={allowedScopes.includes(scope)}
                  onChange={() => onToggleScope?.(scope)}
                />
                <span>
                  <strong>{scopeLabel(scopes, scope)}</strong>
                  <small>{scopes[scope]?.description || scope}</small>
                </span>
              </label>
            )) : <p className="muted">No permissions requested.</p>}
          </section>
          <section className="permission-list">
            <p className="eyebrow">Activity categories</p>
            {requestedCategories.length ? requestedCategories.map((category) => (
              <label className="scope-card consent-choice-card" key={category}>
                <input
                  type="checkbox"
                  checked={allowedCategories.includes(category)}
                  onChange={() => onToggleCategory?.(category)}
                />
                <span>
                  <strong>{categoryLabel(categories, category)}</strong>
                  <small>{categories[category]?.description || category}</small>
                </span>
              </label>
            )) : <p className="muted">No categories requested.</p>}
          </section>
        </div>

        <div className="connect-actions">
          <button type="button" onClick={onApprove} disabled={!canApprove}>
            {loading === "approve" ? "Connecting..." : "Approve connection"}
          </button>
          <button type="button" className="ghost" onClick={onCancel}>Cancel</button>
        </div>
      </article>
    </section>
  )
}

function scopeLabel(scopes, scope) {
  return scopes?.[scope]?.label || scope
}

function categoryLabel(categories, category) {
  return categories?.[category]?.label || category
}
