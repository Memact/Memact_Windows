import React, { useRef, useState } from "react"

const WIKI_CATEGORIES = [
  "Reading",
  "Shopping",
  "Learning",
  "Work",
  "Collaboration",
  "Dietary restrictions",
  "Creator profile",
  "Project context",
  "Personal preferences",
  "Other"
]

export function WikiPage({
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
  const createdMemory = normalizeDisclosureList(transparency?.created_context || transparency?.intent_context || transparency?.intentContext || transparency?.graph_packets || transparency?.graphPackets || transparency?.memory_packets)
  const allowedFeatures = normalizeDisclosureList(transparency?.features || transparency?.allowed_features || transparency?.allowedFeatures)
  const proposedEntries = normalizeWikiEntries(transparency?.wiki_entries || transparency?.proposed_entries || transparency?.proposedEntries, appName)
  const retention = transparency?.retention || transparency?.retention_policy || "The app has not provided a specific retention statement yet."
  const revocation = transparency?.revocation || transparency?.revocation_policy || "After consent is revoked, new Memact access should stop. Previously copied data must follow the app's own deletion policy."
  const safeRequestedScopes = Array.isArray(requestedScopes) ? requestedScopes : []
  const safeRequestedCategories = Array.isArray(requestedCategories) ? requestedCategories : []
  const scopeOptions = optionRef.current.scopes
  const categoryOptions = optionRef.current.categories
  const hasEnoughSelection = safeRequestedScopes.length > 0 && safeRequestedCategories.length > 0
  const [manualEntries, setManualEntries] = useState([])
  const [draft, setDraft] = useState(defaultDraft())
  const [showAddContext, setShowAddContext] = useState(false)
  const [acceptedProposals, setAcceptedProposals] = useState([])
  const [rejectedProposals, setRejectedProposals] = useState([])

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
  const submitManualEntry = (event) => {
    event.preventDefault()
    const entry = {
      id: `local-${Date.now()}`,
      title: draft.title.trim(),
      category: draft.category,
      value: draft.value.trim(),
      visibility: draft.visibility,
      expires_at: draft.expires_at,
      source_note: draft.source_note.trim(),
      source_type: "user",
      source_label: "Added by you",
      source_detail: "Source: User-added",
      status: "accepted",
      user_verified: true,
      confidence: "User verified",
      competing_interpretations: [],
      contradictions: []
    }
    if (!entry.title || !entry.value) return
    setManualEntries((current) => [entry, ...current])
    setDraft(defaultDraft())
    setShowAddContext(false)
  }
  const updateDraft = (key, value) => setDraft((current) => ({ ...current, [key]: value }))
  const changeEntryVisibility = (id, visibility) => {
    setManualEntries((current) => current.map((entry) => entry.id === id ? { ...entry, visibility } : entry))
  }
  const deleteEntry = (id) => {
    setManualEntries((current) => current.filter((entry) => entry.id !== id))
  }
  const acceptProposal = (entry) => {
    setAcceptedProposals((current) => [{ ...entry, status: "accepted", user_verified: true }, ...current])
    setRejectedProposals((current) => current.filter((id) => id !== entry.id))
  }
  const rejectProposal = (id) => {
    setRejectedProposals((current) => Array.from(new Set([...current, id])))
    setAcceptedProposals((current) => current.filter((entry) => entry.id !== id))
  }
  const visibleProposals = proposedEntries.filter((entry) => !rejectedProposals.includes(entry.id) && !acceptedProposals.some((item) => item.id === entry.id))
  const visibleEntries = [...manualEntries, ...acceptedProposals]

  return (
    <section className="panel transparency-panel wiki-panel">
      <div className="transparency-hero wiki-hero">
        <div>
          <p className="eyebrow">Wiki</p>
          <h2>{app?.id ? `${appName}'s Memact Wiki` : "Your Memact Wiki"}</h2>
          <p className="muted">A private memory surface you can inspect, edit, and share only when you choose.</p>
        </div>
        <button type="button" className="button wiki-add-button" onClick={() => setShowAddContext((value) => !value)}>
          Add context
        </button>
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

      {showAddContext ? (
        <form className="permission-list wiki-add-form" onSubmit={submitManualEntry}>
          <div>
            <p className="eyebrow">Manual memory</p>
            <h3>Add context yourself</h3>
            <p className="muted">User-added memory starts private, accepted, and verified by you.</p>
          </div>
          <div className="wiki-form-grid">
            <label>
              Title
              <input value={draft.title} placeholder="I prefer concise summaries" onChange={(event) => updateDraft("title", event.target.value)} required />
            </label>
            <label>
              Category
              <select value={draft.category} onChange={(event) => updateDraft("category", event.target.value)}>
                {WIKI_CATEGORIES.map((category) => <option key={category} value={category}>{category}</option>)}
              </select>
            </label>
            <label className="wiki-form-wide">
              Value / note
              <textarea value={draft.value} placeholder="Write what apps should remember." onChange={(event) => updateDraft("value", event.target.value)} required />
            </label>
            <label>
              Visibility
              <select value={draft.visibility} onChange={(event) => updateDraft("visibility", event.target.value)}>
                <option value="private">Private</option>
                <option value="shareable">Shareable</option>
                <option value="public">Public</option>
              </select>
            </label>
            <label>
              Optional expiry date
              <input value={draft.expires_at} type="date" onChange={(event) => updateDraft("expires_at", event.target.value)} />
            </label>
            <label className="wiki-form-wide">
              Optional source note
              <input value={draft.source_note} placeholder="Why are you adding this?" onChange={(event) => updateDraft("source_note", event.target.value)} />
            </label>
          </div>
          <div className="connect-actions">
            <button type="button" className="ghost" onClick={() => setShowAddContext(false)}>Cancel</button>
            <button type="submit">Save context</button>
          </div>
        </form>
      ) : null}

      <section className="permission-list transparency-controls-panel">
        <div className="transparency-control-head">
          <div>
            <p className="eyebrow">Controls</p>
            <h3>Choose what this app can use</h3>
          </div>
          <div className="transparency-summary" aria-label="Wiki selection summary">
            <span><strong>{safeRequestedScopes.length}</strong> Actions</span>
            <span><strong>{safeRequestedCategories.length}</strong> Activity types</span>
          </div>
        </div>
        {!hasEnoughSelection ? (
          <p className="notice" role="status">Select at least one action and one activity type before returning to consent.</p>
        ) : null}
        <div className="transparency-choice-grid">
          <div className="transparency-choice-group">
            <p className="app-list-label">Allowed actions</p>
            <div className="transparency-control-list">
              {scopeOptions.map((scope) => (
                <label className="transparency-control" key={scope}>
                  <input type="checkbox" checked={safeRequestedScopes.includes(scope)} onChange={() => toggleScope(scope)} />
                  <span>
                    <strong>{scopes?.[scope]?.label || scope}</strong>
                    <small>{scopes?.[scope]?.description || scope}</small>
                  </span>
                </label>
              ))}
              {!scopeOptions.length ? <p className="muted">No actions were attached to this Wiki link.</p> : null}
            </div>
          </div>
          <div className="transparency-choice-group">
            <p className="app-list-label">Allowed activity</p>
            <div className="transparency-control-list">
              {categoryOptions.map((category) => (
                <label className="transparency-control" key={category}>
                  <input type="checkbox" checked={safeRequestedCategories.includes(category)} onChange={() => toggleCategory(category)} />
                  <span>
                    <strong>{categories?.[category]?.label || category}</strong>
                    <small>{categories?.[category]?.description || category}</small>
                  </span>
                </label>
              ))}
              {!categoryOptions.length ? <p className="muted">No activity types were attached to this Wiki link.</p> : null}
            </div>
          </div>
        </div>
      </section>

      <section className="permission-list wiki-entry-panel">
        <div className="wiki-section-head">
          <div>
            <p className="eyebrow">Memory</p>
            <h3>Accepted Wiki entries</h3>
          </div>
          <span className="badge">{visibleEntries.length}</span>
        </div>
        <div className="wiki-entry-list">
          {visibleEntries.map((entry) => (
            <WikiEntryCard
              key={entry.id}
              entry={entry}
              onDelete={() => deleteEntry(entry.id)}
              onVisibility={(visibility) => changeEntryVisibility(entry.id, visibility)}
            />
          ))}
          {!visibleEntries.length ? <p className="muted">No accepted Wiki entries yet. Add context yourself or approve a proposed memory when one appears.</p> : null}
        </div>
      </section>

      <section className="permission-list wiki-entry-panel">
        <div className="wiki-section-head">
          <div>
            <p className="eyebrow">Proposed writes</p>
            <h3>Important writes need your approval</h3>
          </div>
          <span className="badge">{visibleProposals.length}</span>
        </div>
        <div className="wiki-entry-list">
          {visibleProposals.map((entry) => (
            <WikiProposalCard
              key={entry.id}
              entry={entry}
              onAccept={() => acceptProposal(entry)}
              onReject={() => rejectProposal(entry.id)}
              onEdit={() => acceptProposal({ ...entry, source_label: "Edited and accepted by you" })}
            />
          ))}
          {!visibleProposals.length ? <p className="muted">No app, Memact, or Playground proposals are waiting right now.</p> : null}
        </div>
      </section>

      <div className="transparency-grid">
        <WikiDisclosure title="What this app can send" eyebrow="App can add" items={capturedData} empty="This app has not listed exact fields yet." />
        <WikiDisclosure title="What Memact may create" eyebrow="Wiki may contain" items={createdMemory} empty="Memact may create useful memory from what you allow." />
        <WikiDisclosure title="Why it wants access" eyebrow="Why" items={dataUses} empty={app?.description || "This app has not provided a plain-language reason yet."} />
        <WikiDisclosure title="What this app may use" eyebrow="Features" items={allowedFeatures} empty="No feature list was provided." />
        <section className="permission-list transparency-card">
          <p className="eyebrow">Access</p>
          <h3>How long access lasts</h3>
          <p className="muted">{retention}</p>
        </section>
        <section className="permission-list transparency-card">
          <p className="eyebrow">Disconnect</p>
          <h3>Stop future access</h3>
          <p className="muted">{revocation} Removing app access stops future Memact access for this app.</p>
        </section>
      </div>

      <div className="connect-actions">
        <button type="button" onClick={onBackToConsent}>Back to consent</button>
        <button type="button" className="ghost" onClick={onManageConsent}>Open dashboard</button>
      </div>

      <section className="permission-list wiki-share-card">
        <p className="eyebrow">Sharing</p>
        <h3>Private unless you create a share link.</h3>
        <p className="muted">A username page should only show entries you explicitly make shareable or public.</p>
      </section>
    </section>
  )
}

function WikiEntryCard({ entry, onDelete, onVisibility }) {
  return (
    <article className={`wiki-entry-card wiki-entry-${entry.source_type}`}>
      <div className="wiki-entry-main">
        <div>
          <p className="eyebrow">{entry.category}</p>
          <h4>{entry.title}</h4>
          <p className="muted">{typeof entry.value === "string" ? entry.value : entry.value?.note || JSON.stringify(entry.value)}</p>
        </div>
        <span className="badge">{entry.visibility}</span>
      </div>
      <div className="wiki-entry-meta">
        <span>{entry.source_label}</span>
        <span>{entry.source_detail}</span>
        <span>User verified: {entry.user_verified ? "true" : "false"}</span>
        <span>Confidence: {entry.confidence}</span>
      </div>
      <WikiSignals entry={entry} />
      <div className="wiki-entry-actions">
        <button type="button" className="ghost">Edit</button>
        <select value={entry.visibility} onChange={(event) => onVisibility(event.target.value)} aria-label={`Change visibility for ${entry.title}`}>
          <option value="private">Private</option>
          <option value="shareable">Shareable</option>
          <option value="public">Public</option>
        </select>
        <button type="button" className="ghost danger" onClick={onDelete}>Delete</button>
      </div>
    </article>
  )
}

function WikiProposalCard({ entry, onAccept, onEdit, onReject }) {
  return (
    <article className={`wiki-entry-card wiki-proposal-card wiki-entry-${entry.source_type}`}>
      <div className="wiki-entry-main">
        <div>
          <p className="eyebrow">{entry.source_label}</p>
          <h4>This app wants to remember: {entry.title}</h4>
          <p className="muted">{typeof entry.value === "string" ? entry.value : entry.value?.note || entry.reason || "Review before this becomes accepted memory."}</p>
        </div>
        <span className="badge">{entry.status}</span>
      </div>
      <WikiSignals entry={entry} />
      <div className="wiki-entry-actions">
        <button type="button" onClick={onAccept}>Accept</button>
        <button type="button" className="ghost" onClick={onEdit}>Edit</button>
        <button type="button" className="ghost danger" onClick={onReject}>Reject</button>
      </div>
    </article>
  )
}

function WikiSignals({ entry }) {
  return (
    <div className="wiki-signal-grid">
      <section>
        <strong>This may also mean...</strong>
        {entry.competing_interpretations?.length ? (
          entry.competing_interpretations.map((item) => <p className="muted" key={item.title}>{item.title}</p>)
        ) : <p className="muted">No competing interpretations yet.</p>}
      </section>
      <section>
        <strong>Another source disagrees.</strong>
        {entry.contradictions?.length ? (
          entry.contradictions.map((item) => <p className="muted" key={item.title}>{item.title}</p>)
        ) : <p className="muted">No contradictions yet.</p>}
      </section>
      <section className="wiki-form-wide">
        <strong>You can keep, edit, or reject this memory.</strong>
        <p className="muted">Use the controls above when a memory needs correction.</p>
      </section>
    </div>
  )
}

function WikiDisclosure({ eyebrow, title, items, empty }) {
  return (
    <section className="permission-list transparency-card">
      <p className="eyebrow">{eyebrow}</p>
      <h3>{title}</h3>
      <DisclosureList items={items} empty={empty} />
    </section>
  )
}

function defaultDraft() {
  return {
    title: "",
    category: "Reading",
    value: "",
    visibility: "private",
    expires_at: "",
    source_note: ""
  }
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
  if (!items.length) return <p className="muted">{empty}</p>
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

function normalizeWikiEntries(value, appName) {
  if (!Array.isArray(value)) return []
  return value.map((entry, index) => ({
    id: String(entry.entry_id || entry.id || `proposal-${index}`),
    title: String(entry.title || "New memory").trim(),
    category: String(entry.category || "Memory").trim(),
    value: entry.value || { note: String(entry.note || entry.description || "").trim() },
    reason: String(entry.reason || "").trim(),
    source_type: normalizeSourceType(entry.source_type),
    source_label: sourceLabel(entry.source_type, appName),
    source_detail: sourceDetail(entry.source_type),
    status: String(entry.status || "pending"),
    visibility: String(entry.visibility || "private"),
    user_verified: Boolean(entry.user_verified),
    confidence: entry.confidence ?? "Needs review",
    competing_interpretations: Array.isArray(entry.competing_interpretations) ? entry.competing_interpretations : [],
    contradictions: Array.isArray(entry.contradictions) ? entry.contradictions : []
  }))
}

function normalizeSourceType(value) {
  return ["user", "app", "memact", "playground_feature"].includes(value) ? value : "app"
}

function sourceLabel(sourceType, appName) {
  if (sourceType === "user") return "Added by you"
  if (sourceType === "memact") return "Created by Memact"
  if (sourceType === "playground_feature") return "Proposed by Playground feature"
  return `Proposed by ${appName}`
}

function sourceDetail(sourceType) {
  if (sourceType === "user") return "Source: User-added"
  if (sourceType === "memact") return "Source: Memact-created"
  if (sourceType === "playground_feature") return "Source: Playground feature"
  return "Source: App-proposed"
}
