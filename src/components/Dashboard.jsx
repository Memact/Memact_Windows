import React, { useState } from "react"
import { CategoryGrid } from "./CategoryGrid.jsx"
import { HelpPanel } from "./HelpPanel.jsx"
import { presetSuggestionsForPolicy } from "../access-policy.js"
import { getAvatarUrl, getInitials, getUserEmail, getUserProvider } from "../user-display.js"

export function Dashboard({
  activeTab,
  user,
  authUser,
  apps,
  apiKeys,
  consents,
  policy,
  scopes,
  categories,
  selectedAppId,
  selectedScopes,
  newAppName,
  newAppDescription,
  newAppDeveloperUrl,
  newAppRedirectUrl,
  newAppCategories,
  oneTimeKey,
  oneTimeKeyScopes,
  oneTimeKeyCategories,
  apiTestResult,
  showAppForm,
  setSelectedAppId,
  setSelectedScopes,
  setNewAppName,
  setNewAppDescription,
  setNewAppDeveloperUrl,
  setNewAppRedirectUrl,
  setNewAppCategories,
  setShowAppForm,
  onCreateApp,
  onDeleteApp,
  onGrantConsent,
  onCreateKey,
  onRevokeKey,
  onCopyKey,
  onTestKey,
  onSignOut,
  authLoading,
  needsPasswordSetup,
  setupPassword,
  setupPasswordConfirm,
  passwordState,
  passwordSuccess,
  setSetupPassword,
  setSetupPasswordConfirm,
  onSetPassword,
  newEmailAddress,
  setNewEmailAddress,
  emailChangeSuccess,
  authFlow,
  onChangeEmail,
  displayName,
  displayNameDraft,
  setDisplayNameDraft,
  displayNameSuccess,
  onUpdateDisplayName,
  inviteEmail,
  setInviteEmail,
  inviteSuccess,
  onInviteUser
}) {
  const hasApps = apps.length > 0
  const isCreatingApp = showAppForm || !hasApps
  const selectedApp = hasApps ? apps.find((app) => app.id === selectedAppId) : null
  const selectedAppCategories = selectedApp?.default_categories || []
  const selectedKeys = apiKeys.filter((key) => key.app_id === selectedAppId)
  const activeKeys = selectedKeys.filter((key) => !key.revoked_at)
  const revokedKeys = selectedKeys.filter((key) => key.revoked_at)
  const usageStats = getUsageStats(selectedApp, selectedKeys, apps)
  const presetSuggestions = presetSuggestionsForPolicy(policy, selectedAppCategories, selectedApp?.description || selectedApp?.name || "")
  const selectedConsent = consents.find((consent) => consent.app_id === selectedAppId && !consent.revoked_at)
  const scopesChanged = selectedConsent ? !sameValues(selectedScopes, selectedConsent.scopes) : true
  const categoriesChanged = selectedConsent ? !sameValues(selectedAppCategories, selectedConsent.categories || []) : true
  const consentChanged = scopesChanged || categoriesChanged
  const canCreateKey = Boolean(selectedAppId && selectedConsent && !consentChanged && selectedScopes.length && selectedAppCategories.length)
  const permissionsHint = !selectedAppId
    ? "Create app first."
    : selectedConsent
      ? consentChanged
        ? "Save permissions first."
        : ""
      : "Save permissions first."
  const createKeyHint = !selectedAppId
    ? "Create app first."
    : !selectedConsent
      ? "Save permissions first."
      : consentChanged
        ? "Save permissions first."
        : ""
  const appHeading = isCreatingApp
    ? hasApps ? "Create a new app." : "Create your first app."
    : selectedApp?.name || "Select an app."
  const appDescription = !isCreatingApp && selectedApp
    ? selectedApp.description || "No description added."
    : "Each app gets its own permissions and API keys."

  const provider = getUserProvider(user, authUser)
  const avatar = getAvatarUrl(user, authUser)
  const displayEmail = getUserEmail(user, authUser)
  const initials = getInitials(displayName, displayEmail)
  const [accountEditor, setAccountEditor] = useState(authFlow === "recovery" || needsPasswordSetup ? "password" : "")
  const [selectedPresetId, setSelectedPresetId] = useState("")
  const [showDashboardTutorial, setShowDashboardTutorial] = useState(false)
  const showDisplayNameEditor = accountEditor === "display-name"
  const showPasswordEditor = accountEditor === "password"
  const showEmailEditor = accountEditor === "email"
  const showInviteEditor = accountEditor === "invite"
  const hasDisplayName = Boolean(displayNameDraft.trim())
  const displayNameAction = hasDisplayName ? "Change name" : "Set display name"
  const changeOptions = [
    { id: "display-name", label: displayNameAction },
    provider === "email" ? { id: "email", label: "Change email" } : null,
    { id: "password", label: needsPasswordSetup ? "Set password" : "Change password" },
    { id: "invite", label: "Invite user" }
  ].filter(Boolean)
  const activeChangeLabel = changeOptions.find((option) => option.id === accountEditor)?.label || "Choose a setting"

  const chooseAccountEditor = (editor) => {
    setAccountEditor(accountEditor === editor ? "" : editor)
  }

  return (
    <section className="dashboard">
      {activeTab === "access" ? (
        <div className="dashboard-head panel slim-panel">
          <div>
            <p className="eyebrow">Dashboard</p>
            <h2>{`Welcome${displayName ? `, ${displayName}` : ""}!`}</h2>
            <button
              type="button"
              className="ghost dashboard-tutorial-button"
              onClick={() => setShowDashboardTutorial((current) => !current)}
              aria-expanded={showDashboardTutorial}
            >
              {showDashboardTutorial ? "Hide tutorial" : "Open quick tutorial"}
            </button>
          </div>
        </div>
      ) : null}

      {activeTab === "access" && showDashboardTutorial ? (
        <section className="panel dashboard-tutorial-panel" aria-label="Dashboard quick tutorial">
          <p className="eyebrow">Quick tutorial</p>
          <div className="dashboard-tutorial-steps">
            <div className="mini-row">
              <strong>1. Create an app</strong>
              <small>Name the app and choose the activity categories it can use.</small>
            </div>
            <div className="mini-row">
              <strong>2. Save permissions</strong>
              <small>Pick the scopes that match what the app should understand.</small>
            </div>
            <div className="mini-row">
              <strong>3. Create a key</strong>
              <small>Copy the key once and keep it on your server.</small>
            </div>
          </div>
        </section>
      ) : null}

      {activeTab === "help" ? (
        <HelpPanel />
      ) : activeTab === "account" ? (
        <section className="panel account-panel">
          <div className="account-panel-head">
            <p className="eyebrow">Account</p>
            <button type="button" className="ghost subtle-danger sign-out-button" onClick={onSignOut}>Sign out</button>
          </div>
          <div className="identity-card">
            {avatar ? <img src={avatar} alt="" /> : <span aria-hidden="true">{initials}</span>}
            <div>
              <h2>{displayName}</h2>
              <p className="identity-meta">
                {displayEmail ? <span>{displayEmail}</span> : null}
              </p>
            </div>
          </div>
          <details className="faq-item settings-details">
            <summary className="faq-trigger settings-trigger">
              <span className="settings-trigger-text">
                <span className="account-change-label">Settings</span>
                <strong>{activeChangeLabel}</strong>
              </span>
              <span className="faq-chevron" aria-hidden="true">v</span>
            </summary>
            <div className="faq-answer settings-menu">
              {changeOptions.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  className={accountEditor === option.id ? "is-active" : ""}
                  onClick={() => chooseAccountEditor(option.id)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </details>
          {showDisplayNameEditor ? (
            <section className="password-panel account-editor-panel display-name-panel">
              <div>
                <p className="eyebrow">Display name</p>
                <h2>{hasDisplayName ? "Change your name." : "Set your display name."}</h2>
                <p className="muted">This is the name shown across your dashboard.</p>
              </div>
              {displayNameSuccess ? <p className="notice notice-success" role="status">{displayNameSuccess}</p> : null}
              <form className="form compact-form" onSubmit={onUpdateDisplayName}>
                <label>
                  Display name
                  <input
                    value={displayNameDraft}
                    type="text"
                    autoComplete="name"
                    placeholder="Example: Sujay"
                    maxLength={80}
                    onChange={(event) => setDisplayNameDraft(event.target.value)}
                    required
                  />
                </label>
                <button type="submit" disabled={authLoading === "display-name"}>
                  {authLoading === "display-name" ? "Saving name..." : "Save name"}
                </button>
              </form>
            </section>
          ) : null}
          {displayEmail && showPasswordEditor ? (
            <section className="password-panel account-editor-panel">
              <div>
                <p className="eyebrow">Password</p>
                <h2>{authFlow === "recovery" ? "Reset your password." : needsPasswordSetup ? "Set a password." : "Update your password."}</h2>
                <p className="muted">
                  {authFlow === "recovery"
                    ? "Your recovery link worked. Choose a new password to finish getting back into Memact."
                    : needsPasswordSetup
                    ? "You are signed in through the email link. Set a strong password now so the next login is faster."
                    : "Keep a strong password on this account so you can sign in without requesting a new link."}
                </p>
              </div>
              {passwordSuccess ? <p className="notice notice-success" role="status">{passwordSuccess}</p> : null}
              <form className="form" onSubmit={onSetPassword}>
                <label>
                  New password
                  <input
                    value={setupPassword}
                    type="password"
                    autoComplete="new-password"
                    placeholder="Create a strong password"
                    onChange={(event) => setSetupPassword(event.target.value)}
                    required
                  />
                </label>
                <label>
                  Confirm password
                  <input
                    value={setupPasswordConfirm}
                    type="password"
                    autoComplete="new-password"
                    placeholder="Repeat the password"
                    onChange={(event) => setSetupPasswordConfirm(event.target.value)}
                    required
                  />
                </label>
                <div className="password-strength" data-strength={passwordState.level}>
                  <div className="password-strength-bar">
                    <span style={{ width: `${passwordState.percent}%` }} />
                  </div>
                  <strong>{passwordState.label}</strong>
                </div>
                <ul className="password-rules" aria-label="Password requirements">
                  {passwordState.checks.map((check) => (
                    <li key={check.label} className={check.ok ? "is-passed" : ""}>{check.label}</li>
                  ))}
                </ul>
                <button type="submit" disabled={!passwordState.canSubmit || authLoading === "set-password"}>
                  {authLoading === "set-password" ? "Saving password..." : authFlow === "recovery" ? "Reset password" : needsPasswordSetup ? "Save password" : "Update password"}
                </button>
              </form>
            </section>
          ) : null}
          {provider === "email" && showEmailEditor ? (
            <section className="password-panel account-editor-panel email-panel">
              <div>
                <p className="eyebrow">Email</p>
                <h2>Change your email.</h2>
                <p className="muted">
                  Supabase will send a Memact-native verification email before this change is saved.
                </p>
              </div>
              {emailChangeSuccess ? <p className="notice notice-success" role="status">{emailChangeSuccess}</p> : null}
              <form className="form compact-form" onSubmit={onChangeEmail}>
                <label>
                  New email address
                  <input
                    value={newEmailAddress}
                    type="email"
                    inputMode="email"
                    autoComplete="email"
                    placeholder="Enter the new email address"
                    onChange={(event) => setNewEmailAddress(event.target.value)}
                    required
                  />
                </label>
                <button type="submit" disabled={authLoading === "change-email"}>
                  {authLoading === "change-email" ? "Sending confirmation..." : "Change email"}
                </button>
              </form>
            </section>
          ) : null}
          {showInviteEditor ? (
            <section className="password-panel account-editor-panel invite-panel">
              <div>
                <p className="eyebrow">Invite</p>
                <h2>Invite someone to Memact.</h2>
                <p className="muted">Send an email invitation so they can create their own Memact account and manage their apps.</p>
              </div>
              {inviteSuccess ? <p className="notice notice-success" role="status">{inviteSuccess}</p> : null}
              <form className="form compact-form" onSubmit={onInviteUser}>
                <label>
                  Email address
                  <input
                    value={inviteEmail}
                    type="email"
                    inputMode="email"
                    autoComplete="email"
                    placeholder="person@example.com"
                    onChange={(event) => setInviteEmail(event.target.value)}
                    required
                  />
                </label>
                <button type="submit" disabled={authLoading === "invite-user"}>
                  {authLoading === "invite-user" ? "Sending invite..." : "Send invite"}
                </button>
              </form>
            </section>
          ) : null}
          <div className="account-grid">
            <div className="metric-card">
              <span>Registered apps</span>
              <strong>{apps.length}</strong>
            </div>
            <div className="metric-card">
              <span>Active API keys</span>
              <strong>{apiKeys.filter((key) => !key.revoked_at).length}</strong>
            </div>
          </div>
        </section>
      ) : (
        <>
          <section id="app-panel" className="panel app-workspace">
            <p className="eyebrow">APPS</p>
            <div className="current-app-block">
              <div>
                <p className="eyebrow">App</p>
                <h2>{appHeading}</h2>
                <p className="muted">{appDescription}</p>
              </div>
            </div>

            {hasApps ? (
              <div className="app-actions" aria-label="App actions">
                <button type="button" className="new-app-button" aria-label={isCreatingApp ? "Cancel app creation" : "Create app"} onClick={() => setShowAppForm((current) => !current)}>
                  {isCreatingApp ? "Cancel" : "New app"}
                </button>
                {!isCreatingApp && selectedApp ? (
                  <button type="button" className="ghost danger app-delete-button" onClick={onDeleteApp}>Delete app</button>
                ) : null}
              </div>
            ) : null}

            {isCreatingApp ? (
              <form className="form app-create-form" onSubmit={onCreateApp}>
                <label>
                  App name
                  <input value={newAppName} placeholder="Example: Reading assistant" onChange={(event) => setNewAppName(event.target.value)} required />
                </label>
                <label>
                  Developer website
                  <input value={newAppDeveloperUrl} type="url" placeholder="Optional: https://example.com" onChange={(event) => setNewAppDeveloperUrl(event.target.value)} />
                </label>
                <label>
                  Connect redirect URL
                  <input value={newAppRedirectUrl} type="url" placeholder="Optional: where users return after connecting" onChange={(event) => setNewAppRedirectUrl(event.target.value)} />
                </label>
                <label>
                  Purpose
                  <textarea value={newAppDescription} placeholder="Optional: What will this app use Memact for?" onChange={(event) => setNewAppDescription(event.target.value)} />
                </label>
                <div>
                  <p className="eyebrow">Activity categories</p>
                  <p className="muted">Pick the kinds of activity this app is allowed to understand. This keeps apps narrow by design.</p>
                  <CategoryGrid
                    categories={categories}
                    selected={newAppCategories}
                    onToggle={(category) => toggleValue(setNewAppCategories, category)}
                  />
                </div>
                <button type="submit">Create app</button>
              </form>
            ) : null}

            {hasApps ? (
              <div className="registered-apps">
                <p className="app-list-label">Registered apps</p>
                <div className="app-switcher" aria-label="Select app">
                  {apps.map((app) => (
                    <button
                      key={app.id}
                      type="button"
                      className={`app-chip ${selectedAppId === app.id ? "is-active" : ""}`}
                      onClick={() => setSelectedAppId(app.id)}
                    >
                      {app.name}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
          </section>

          <div className="access-layout">
            <section id="permissions-panel" className="panel">
              <div className="section-head">
                <div className="section-copy">
                  <p className="eyebrow">Permissions</p>
                  <h2>Choose what this app can ask Memact to understand.</h2>
                  <p className="muted">Permissions are saved for this app. Change scopes any time.</p>
                </div>
                <div className="actions section-actions">
                  <span className="tooltip-wrap" title={permissionsHint || undefined}>
                    <button type="button" className="ghost" disabled={!selectedAppId || !selectedScopes.length || !selectedAppCategories.length} onClick={onGrantConsent}>Save permissions</button>
                  </span>
                  <span className="tooltip-wrap" title={createKeyHint || undefined}>
                    <button type="button" disabled={!canCreateKey} onClick={onCreateKey}>Create API key</button>
                  </span>
                </div>
              </div>
              <div className="scope-grid">
                {Object.entries(scopes).map(([scope, definition]) => {
                  const inputId = `scope-${scope.replace(/[^a-z0-9_-]/gi, "-")}`
                  return (
                    <label key={scope} className="scope-card" htmlFor={inputId}>
                      <input
                        id={inputId}
                        type="checkbox"
                        checked={selectedScopes.includes(scope)}
                        onChange={() => {
                          setSelectedScopes((current) => current.includes(scope)
                            ? current.filter((item) => item !== scope)
                            : [...current, scope])
                        }}
                      />
                      <span>
                        <strong>{scope}</strong>
                        <small>{definition.description}</small>
                      </span>
                    </label>
                  )
                })}
              </div>

              {presetSuggestions.length > 0 ? (
                <div className="presets-section">
                  <p className="eyebrow presets-label">Quick presets</p>
                  <p className="presets-sub">Apply a preset to match common permission patterns. Scopes update immediately. Save to confirm.</p>
                  <div className="presets-inline">
                    {presetSuggestions.map((preset) => (
                      <button
                        key={preset.id}
                        type="button"
                        className={`permission-suggestion-chip ${selectedPresetId === preset.id ? "is-active" : ""}`}
                        disabled={!selectedAppId || !preset.scopes.length}
                        title={preset.description}
                        onClick={() => { setSelectedScopes(preset.scopes); setSelectedPresetId(preset.id) }}
                      >
                        <span>{preset.label}</span>
                        <strong>{preset.scopes.length} selected</strong>
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
            </section>

            <section id="api-keys-panel" className="panel api-keys-panel">
              <p className="eyebrow">API keys</p>
              <div className="stack">
                {selectedAppId ? (
                  <>
                    <section className="usage-overview" aria-label="Usage statistics">
                      <div className="usage-overview-head">
                        <p className="eyebrow">Usage statistics</p>
                        <h3>Key binding and exposure checks</h3>
                      </div>
                      <div className="usage-kpis">
                        <div className="usage-kpi">
                          <p>Apps using this key</p>
                          <strong>{usageStats.appsUsingSameKey}</strong>
                        </div>
                        <div className="usage-kpi">
                          <p>Public exposure</p>
                          <strong>{usageStats.exposureLabel}</strong>
                        </div>
                        <div className="usage-kpi">
                          <p>Last key use</p>
                          <strong>{usageStats.lastUsedLabel}</strong>
                        </div>
                      </div>
                      {usageStats.exposureDetail ? <p className="usage-empty-state muted">{usageStats.exposureDetail}</p> : null}
                    </section>

                    {activeKeys.length ? activeKeys.map((key) => (
                      <div className="list-card api-key-row" key={key.id}>
                        <span>
                          <strong>{key.name}</strong>
                          <small>{key.key_prefix}...</small>
                        </span>
                        <span className="badge badge-success">active</span>
                        <button type="button" className="ghost" onClick={() => onRevokeKey(key.id)}>Revoke</button>
                      </div>
                    )) : null}

                    {revokedKeys.length ? (
                      <details className="revoked-history">
                        <summary>
                          <span>Revoked history ({revokedKeys.length})</span>
                          <span className="faq-chevron revoked-chevron" aria-hidden="true">v</span>
                        </summary>
                        <div className="revoked-history-list">
                          {revokedKeys.map((key) => (
                            <div className="list-card api-key-row revoked-key-row" key={key.id}>
                              <span>
                                <strong>{key.name}</strong>
                                <small>{key.key_prefix}...</small>
                              </span>
                              <span className="badge badge-danger">revoked</span>
                            </div>
                          ))}
                        </div>
                      </details>
                    ) : null}
                  </>
                ) : <p className="muted">Select an app to view API keys.</p>}
              </div>
            </section>
          </div>
        </>
      )}

      {activeTab === "access" && oneTimeKey ? (
        <section id="one-time-key-panel" className="panel key-panel">
          <div className="key-panel-head">
            <p className="eyebrow">Copy now</p>
            <h2>One-time API key</h2>
            <p className="muted key-warning">Memact stores only a hash. This raw key cannot be shown again.</p>
          </div>
          <div className="key-box">
            <code>{oneTimeKey}</code>
            <div className="key-actions">
              <button type="button" className="button" onClick={onCopyKey}>Copy key</button>
              <button type="button" className="ghost" onClick={onTestKey}>Test key</button>
            </div>
          </div>
          {apiTestResult ? <p className="notice notice-success" role="status">{apiTestResult}</p> : null}
          <details className="embed-code">
            <summary>Embed code</summary>
            <pre><code>{buildEmbedCode(oneTimeKey, oneTimeKeyScopes, oneTimeKeyCategories, selectedApp)}</code></pre>
          </details>
        </section>
      ) : null}
    </section>
  )
}

function sameValues(first = [], second = []) {
  const firstList = [...first].sort()
  const secondList = [...second].sort()
  return firstList.length === secondList.length && firstList.every((value, index) => value === secondList[index])
}

function toggleValue(setter, value) {
  setter((current) => current.includes(value)
    ? current.filter((item) => item !== value)
    : [...current, value])
}

function getUsageStats(selectedApp, selectedKeys = [], apps = []) {
  const activeKeys = selectedKeys.filter((key) => !key.revoked_at)
  const keyAppIds = new Set(activeKeys.map((key) => key.app_id).filter(Boolean))
  const reportedAppCounts = activeKeys
    .map((key) => Number(key.app_count || key.client_count || key.using_apps_count || key.application_count))
    .filter((count) => Number.isFinite(count) && count > 0)
  const appsUsingSameKey = reportedAppCounts.length
    ? Math.max(...reportedAppCounts)
    : Math.max(keyAppIds.size || (activeKeys.length ? 1 : 0), 0)
  const exposedKey = activeKeys.find((key) => key.public_exposure_detected || key.exposure_status === "exposed")
  const unknownExposure = activeKeys.length && !activeKeys.some((key) => key.exposure_status || key.public_exposure_detected === false)
  const lastUsedAt = activeKeys
    .map((key) => {
      const lastUsed = String(key.last_used_at || "")
      const created = String(key.created_at || "")
      return lastUsed && lastUsed !== created ? lastUsed : ""
    })
    .filter(Boolean)
    .sort()
    .at(-1)
  const appName = selectedApp?.name || "this app"
  return {
    appsUsingSameKey,
    exposureLabel: exposedKey ? "Review now" : unknownExposure ? "No signal yet" : "Clear",
    exposureDetail: exposedKey
      ? "A public exposure signal was reported for this key. Revoke it and create a replacement after removing the leak."
      : unknownExposure
        ? `Memact can show exposure signals when the access layer reports them. Until then, keep ${appName}'s raw key server-side and out of public code.`
        : "",
    lastUsedLabel: lastUsedAt ? formatDate(lastUsedAt) : "No use yet"
  }
}

function formatDate(value) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "Unknown"
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })
}

function buildEmbedCode(apiKey, scopes = [], categories = [], app = null) {
  const appId = app?.id || "app_id_from_memact_portal"
  const redirectUrl = app?.redirect_urls?.[0] || app?.developer_url || "https://your-app.example.com/memact/callback"
  const connectUrl = buildPortalConnectUrl(appId, scopes, categories, redirectUrl)
  const dataTransparencyUrl = buildPortalDataTransparencyUrl(appId, scopes, categories, redirectUrl)
  const verifyUrl = getDeveloperVerifyUrl()
  return `// 1. Add the Connect Memact button.
const memactConnectUrl = "${connectUrl}";

// 2. Add the Data Transparency link beside consent.
const memactDataTransparencyUrl = "${dataTransparencyUrl}";

// 3. After the user approves, Memact redirects back with ?connected=1&connection_id=...
const memactConnectionId = "connection_id_from_connect_redirect";

// 4. Verify access on your server before requesting context.
// .env on your server:
// MEMACT_API_KEY=${apiKey || "mka_key_shown_once"}
// Optional override only if Memact gives you a different verify host:
// MEMACT_VERIFY_URL=${verifyUrl}
const memactApiKey = process.env.MEMACT_API_KEY;
const memactVerifyUrl = process.env.MEMACT_VERIFY_URL || "${verifyUrl}";
const requiredScopes = ${JSON.stringify(scopes, null, 2)};
const activityCategories = ${JSON.stringify(categories, null, 2)};

if (!memactApiKey) {
  throw new Error("Set MEMACT_API_KEY in your server .env or secret manager.");
}
if (!memactConnectionId) {
  throw new Error("Store the connection_id returned by Memact after user approval.");
}

const response = await fetch(memactVerifyUrl, {
  method: "POST",
  headers: {
    "Authorization": \`Bearer \${memactApiKey}\`,
    "Content-Type": "application/json"
  },
  body: JSON.stringify({
    connection_id: memactConnectionId,
    required_scopes: requiredScopes,
    activity_categories: activityCategories
  })
});

const access = await response.json();
if (!access?.allowed) {
  throw new Error(access?.error?.message || "Memact access denied.");
}

console.log("Memact access granted", {
  app: access.app?.name,
  scopes: access.scopes,
  categories: access.categories,
  understanding_strategy: access.understanding_strategy?.id
});

// 5. Use only approved understanding.
// Follow access.understanding_strategy for this exact scope + category combination.
// Capture: use only the allowed_inputs for the approved activity categories.
// Schema: write only the listed schema_packets.
// Memory: request summaries/evidence/graph objects only when delivery_plan allows them.`
}

function getDeveloperVerifyUrl() {
  const configured = import.meta.env?.VITE_MEMACT_DEVELOPER_API_URL || ""
  return configured.replace(/\/+$/, "") || "https://api.memact.com/v1/access/verify"
}

function buildPortalConnectUrl(appId, scopes = [], categories = [], redirectUrl = "") {
  const origin = typeof window !== "undefined" ? window.location.origin : "https://memact.com"
  const url = new URL("/connect", origin)
  url.searchParams.set("app_id", appId)
  if (scopes.length) url.searchParams.set("scopes", scopes.join(","))
  if (categories.length) url.searchParams.set("categories", categories.join(","))
  if (redirectUrl) url.searchParams.set("redirect_uri", redirectUrl)
  return url.toString()
}

function buildPortalDataTransparencyUrl(appId, scopes = [], categories = [], redirectUrl = "") {
  const origin = typeof window !== "undefined" ? window.location.origin : "https://memact.com"
  const url = new URL("/DataTransparency", origin)
  url.searchParams.set("app_id", appId)
  if (scopes.length) url.searchParams.set("scopes", scopes.join(","))
  if (categories.length) url.searchParams.set("categories", categories.join(","))
  if (redirectUrl) url.searchParams.set("redirect_uri", redirectUrl)
  return url.toString()
}
