import React, { useEffect, useMemo, useRef, useState } from "react"
import { createRoot } from "react-dom/client"
import "./styles.css"
import "./faq-chevron.css"
import {
  AccessClient,
  AccessApiError,
  ACCESS_MODE,
  ACCESS_URL
} from "./memact-access-client.js"
import { getAuthRedirectUrl, isSupabaseConfigured, requireSupabase, supabase } from "./supabase-client.js"
import { hasDuplicateAppName } from "./app-name.js"
import { defaultCategoriesForPolicy, defaultScopesForPolicy, normalizeSelectedCategories, normalizeSelectedScopes, permissionSuggestionForCategories } from "./access-policy.js"
import { ConnectPage } from "./components/ConnectPage.jsx"
import { Chevron } from "./components/Chevron.jsx"
import { DataTransparencyPage } from "./components/DataTransparencyPage.jsx"
import { Dashboard } from "./components/Dashboard.jsx"
import { HelpPanel } from "./components/HelpPanel.jsx"
import { LearnPanel } from "./components/LearnPanel.jsx"
import { Landing } from "./components/Landing.jsx"
import { refreshDashboard, useDashboardState } from "./hooks/useDashboardState.js"
import { isConnectPage, isProtectedPage, normalizePortalPath, pageFromLocation, routeForPage } from "./portal-routes.js"
import { getDisplayName, getUserEmail } from "./user-display.js"

const AUTH_INIT_TIMEOUT_MS = 12000
const AUTH_CODE_EXCHANGE_TIMEOUT_MS = 9000
const AUTH_SESSION_CHECK_TIMEOUT_MS = 9000
const LAST_AUTH_METHOD_KEY = "memact.lastAuthMethod"
const INVITE_FUNCTION_NAME = import.meta.env.VITE_SUPABASE_INVITE_FUNCTION || "invite-user"
const SIGNIN_RISK_FUNCTION_NAME = import.meta.env.VITE_SUPABASE_SIGNIN_RISK_FUNCTION || ""

function App() {
  const client = useMemo(() => new AccessClient(ACCESS_URL), [])
  const initialPage = pageFromLocation()

  useEffect(() => {
    const onScroll = () => {
      document.documentElement.classList.toggle('topbar-scrolled', window.scrollY > 2)
    }
    onScroll()
    window.addEventListener("scroll", onScroll, { passive: true })
    return () => window.removeEventListener("scroll", onScroll)
  }, [])

  useEffect(() => {
    const topbar = document.querySelector(".topbar")
    if (!topbar) return undefined

    const syncTopbarHeight = () => {
      const height = Math.ceil(topbar.getBoundingClientRect().height)
      if (height > 0) {
        document.documentElement.style.setProperty("--topbar-actual-height", `${height}px`)
      }
    }

    syncTopbarHeight()
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(syncTopbarHeight) : null
    observer?.observe(topbar)
    window.addEventListener("resize", syncTopbarHeight)
    return () => {
      observer?.disconnect()
      window.removeEventListener("resize", syncTopbarHeight)
    }
  }, [])

  const [authSession, setAuthSession] = useState(null)
  const [authUser, setAuthUser] = useState(null)
  const [authChecking, setAuthChecking] = useState(true)
  const [currentPage, setCurrentPage] = useState(initialPage)
  const [activeTab, setActiveTab] = useState(initialPage === "home" ? "login" : initialPage)
  const [email, setEmail] = useState("")
  const [signupDisplayName, setSignupDisplayName] = useState("")
  const [password, setPassword] = useState("")
  const [passwordConfirm, setPasswordConfirm] = useState("")
  const [pendingVerificationEmail, setPendingVerificationEmail] = useState("")
  const [verificationCode, setVerificationCode] = useState("")
  const [pendingSignInVerificationEmail, setPendingSignInVerificationEmail] = useState("")
  const [signInVerificationCode, setSignInVerificationCode] = useState("")
  const [authLoading, setAuthLoading] = useState("")
  const [authNotice, setAuthNotice] = useState("")
  const [authFlow, setAuthFlow] = useState(() => detectAuthFlowFromUrl())
  const [authMode, setAuthMode] = useState(() => authModeFromLocation())
  const [lastAuthMethod, setLastAuthMethod] = useState(() => readLastAuthMethod())
  const [dashboard, dashboardActions] = useDashboardState()
  const [policy, setPolicy] = useState(null)
  const [newAppName, setNewAppName] = useState("")
  const [newAppDescription, setNewAppDescription] = useState("")
  const [newAppDeveloperUrl, setNewAppDeveloperUrl] = useState("")
  const [newAppRedirectUrl, setNewAppRedirectUrl] = useState("")
  const [newAppCategories, setNewAppCategories] = useState([])
  const [selectedAppId, setSelectedAppId] = useState("")
  const [selectedScopes, setSelectedScopes] = useState(() => defaultScopesForPolicy(null))
  const [oneTimeKey, setOneTimeKey] = useState("")
  const [oneTimeKeyId, setOneTimeKeyId] = useState("")
  const [oneTimeKeyScopes, setOneTimeKeyScopes] = useState([])
  const [oneTimeKeyCategories, setOneTimeKeyCategories] = useState([])
  const [apiTestResult, setApiTestResult] = useState("")
  const [showAppForm, setShowAppForm] = useState(false)
  const [connectRequest, setConnectRequest] = useState(() => parseConnectRequest())
  const [connectDetails, setConnectDetails] = useState(null)
  const [connectLoading, setConnectLoading] = useState("")
  const [connectNotice, setConnectNotice] = useState("")
  const [setupPassword, setSetupPassword] = useState("")
  const [setupPasswordConfirm, setSetupPasswordConfirm] = useState("")
  const [passwordSuccess, setPasswordSuccess] = useState("")
  const [newEmailAddress, setNewEmailAddress] = useState("")
  const [emailChangeSuccess, setEmailChangeSuccess] = useState("")
  const [displayNameDraft, setDisplayNameDraft] = useState("")
  const [displayNameSuccess, setDisplayNameSuccess] = useState("")
  const [inviteEmail, setInviteEmail] = useState("")
  const [inviteSuccess, setInviteSuccess] = useState("")
  const { user, apps, apiKeys, consents, status, error, canRetryDashboard } = dashboard
  const { setStatus, setError, setCanRetryDashboard } = dashboardActions
  const session = authSession?.access_token || ""
  const passwordState = useMemo(() => getPasswordState(setupPassword, setupPasswordConfirm), [setupPassword, setupPasswordConfirm])
  const signupPasswordState = useMemo(() => getPasswordState(password, passwordConfirm), [password, passwordConfirm])
  const needsPasswordSetup = Boolean(authUser && shouldOfferPasswordSetup(authUser))
  const authEventGuardRef = useRef("")

  function navigateToPage(page, { replace = false, hash = "" } = {}) {
    const nextPath = `${routeForPage(page)}${hash}`
    const historyMethod = replace ? "replaceState" : "pushState"
    window.history[historyMethod]({}, "", nextPath)
    setCurrentPage(page)
    setActiveTab(page === "home" ? "login" : page)
    if (page === "home" && hash) {
      setAuthMode(hash.toLowerCase().includes("sign-in") ? "sign-in" : "sign-up")
    }
  }

  function setLandingAuthMode(mode, { pushHash = true } = {}) {
    const nextMode = mode === "sign-in" ? "sign-in" : "sign-up"
    setAuthMode(nextMode)
    if (pushHash && typeof window !== "undefined") {
      window.history.pushState({}, "", `${routeForPage("home")}#${nextMode}`)
    }
  }

  function applySession(nextSession, detectedFlow = "default") {
    setAuthSession(nextSession)
    setAuthUser(nextSession?.user || null)
    setAuthFlow(detectedFlow)
    const page = pageFromLocation()

    if (nextSession && isConnectPage(page)) {
      setError("")
      setAuthNotice("")
      setCurrentPage("connect")
      setActiveTab("connect")
      return
    }

    if (nextSession) {
      setError("")
      setAuthNotice("")
      setAuthChecking(false)
      navigateToPage(shouldOpenAccountTab(nextSession.user, detectedFlow === "recovery") ? "account" : "access", { replace: true })
      return
    }

    if (isProtectedPage(page)) {
      navigateToPage("home", { replace: true, hash: "#sign-up" })
    }
  }

  function rememberAuthMethod(method) {
    setLastAuthMethod(method)
    writeLastAuthMethod(method)
  }

  async function finishEmailVerification(nextSession) {
    if (nextSession) {
      try {
        await requireSupabase().auth.signOut()
      } catch {
        // The verification is already complete; a local sign-out failure should not block the handoff.
      }
    }
    setAuthSession(null)
    setAuthUser(null)
    setAuthFlow("default")
    setAuthMode("sign-in")
    setPassword("")
    setPasswordConfirm("")
    setPendingVerificationEmail("")
    setVerificationCode("")
    setPendingSignInVerificationEmail("")
    setSignInVerificationCode("")
    setAuthNotice("Email verified. Sign in with your email and password.")
    setStatus("Email verified.")
    navigateToPage("home", { replace: true, hash: "#sign-in" })
  }

  useEffect(() => {
    client.health()
      .then(() => setStatus(ACCESS_MODE === "supabase" ? "Dashboard is running through Supabase." : "Memact is online."))
      .catch(() => setStatus(ACCESS_MODE === "supabase" ? "Apply the Dashboard Supabase migration to use the portal." : "Start Memact locally to use the portal."))
    client.policy().then(setPolicy).catch(() => {})
  }, [client])

  useEffect(() => {
    const normalizedPath = normalizePortalPath(window.location.pathname)
    if (normalizedPath !== window.location.pathname) {
      window.history.replaceState({}, "", `${normalizedPath}${window.location.search}${window.location.hash}`)
      const normalizedPage = pageFromLocation()
      setCurrentPage(normalizedPage)
      setActiveTab(normalizedPage === "home" ? "login" : normalizedPage)
    }

    if (!isSupabaseConfigured || !supabase) {
      setAuthChecking(false)
      setStatus("Supabase env vars are missing.")
      return undefined
    }

    let mounted = true
    const shouldCheckSession = shouldCheckSessionOnLoad()
    let sessionCheckTimeout

    if (!shouldCheckSession) {
      setAuthChecking(false)
    } else {
      sessionCheckTimeout = window.setTimeout(() => {
        if (!mounted) return
        setAuthChecking(false)
        if (isProtectedPage(pageFromLocation())) {
          navigateToPage("home", { replace: true, hash: "#sign-up" })
        }
      }, AUTH_INIT_TIMEOUT_MS)

      resolveInitialSession(supabase)
        .then(async ({ data, error }) => {
          if (!mounted) return
          if (error) {
            if (!data?.session) {
              setError(error.message)
            }
          }
          const nextSession = data?.session || null
          const detectedFlow = detectAuthFlowFromUrl()
          if (detectedFlow === "verified") {
            await finishEmailVerification(nextSession)
            return
          }
          if (nextSession && detectedFlow === "default") {
            const guarded = await beginSignInVerificationIfNeeded(supabase, nextSession)
            if (guarded) return
          }
          if (!nextSession && isProtectedPage(pageFromLocation())) {
            setAuthNotice("")
          }
          applySession(nextSession, detectedFlow)
        })
        .catch((sessionError) => {
          if (!mounted) return
          setError(sessionError?.message || "Could not check login status.")
        })
        .finally(() => {
          if (!mounted) return
          window.clearTimeout(sessionCheckTimeout)
          setAuthChecking(false)
        })
    }

    const { data: subscription } = supabase.auth.onAuthStateChange((event, nextSession) => {
      if (!mounted) return
      setAuthChecking(false)

      if (event === "USER_UPDATED" || event === "TOKEN_REFRESHED") {
        setAuthSession(nextSession)
        setAuthUser(nextSession?.user || null)
        return
      }

      if (event === "PASSWORD_RECOVERY") {
        setAuthFlow("recovery")
      } else if (event === "SIGNED_IN") {
        if (authEventGuardRef.current === "password-login" || authEventGuardRef.current === "signin-code") {
          return
        }
        if (detectAuthFlowFromUrl() === "verified") {
          finishEmailVerification(nextSession)
          return
        }
        setAuthFlow(detectAuthFlowFromUrl())
      } else if (event === "SIGNED_OUT") {
        setAuthFlow("default")
      }
      applySession(nextSession, event === "PASSWORD_RECOVERY" ? "recovery" : detectAuthFlowFromUrl())
      if (!nextSession && event === "SIGNED_OUT") {
        if (isProtectedPage(pageFromLocation())) {
          navigateToPage("home", { replace: true, hash: "#sign-up" })
        }
      }
    })

    return () => {
      mounted = false
      window.clearTimeout(sessionCheckTimeout)
      subscription?.subscription?.unsubscribe()
    }
  }, [])

  useEffect(() => {
    function handlePopState() {
      const page = pageFromLocation()
      setCurrentPage(page)
      setActiveTab(page === "home" ? "login" : page)
      if (page === "home") {
        setAuthMode(authModeFromLocation())
      }
    }

    window.addEventListener("popstate", handlePopState)
    return () => window.removeEventListener("popstate", handlePopState)
  }, [])

  useEffect(() => {
    if (!session) return
    if (authFlow === "recovery") {
      navigateToPage("account", { replace: true })
      setStatus("Reset your password.")
      setAuthNotice("Choose a new password for your Memact account.")
      return
    }
    if (needsPasswordSetup) {
      navigateToPage("account", { replace: true })
      setStatus("Set a password to make your next login faster.")
    }
  }, [authFlow, needsPasswordSetup, session])

  useEffect(() => {
    const tabName = currentPage === "account" ? "Account" : currentPage === "help" ? "Help" : currentPage === "connect" ? "Connect" : currentPage === "data" ? "Data Transparency" : currentPage === "access" ? "Dashboard" : "Login"
    document.title = `Memact | ${tabName}`
  }, [currentPage])

  useEffect(() => {
    if (authChecking || !session) return
    refreshDashboard(client, session, dashboardActions, statusForAccessError)
  }, [authChecking, client, session])

  useEffect(() => {
    if (!isConnectPage(currentPage) && currentPage !== "data") return
    const request = parseConnectRequest()
    setConnectRequest(request)
    setActiveTab(currentPage)
    if (!session || !request.app_id) return

    let cancelled = false
    setConnectLoading("loading")
    setConnectNotice("")
    setStatus("Checking app connection.")
    client.getConnectApp(session, request)
      .then((details) => {
        if (cancelled) return
        setConnectDetails(details)
        setError("")
        setStatus("Review app connection.")
      })
      .catch((connectError) => {
        if (cancelled) return
        setError(connectError.message)
        setStatus("Connect app failed.")
      })
      .finally(() => {
        if (!cancelled) setConnectLoading("")
      })

    return () => {
      cancelled = true
    }
  }, [client, currentPage, session])

  useEffect(() => {
    setNewAppCategories([])
  }, [policy])

  useEffect(() => {
    if (apps.length === 1 && selectedAppId !== apps[0].id) {
      setSelectedAppId(apps[0].id)
      return
    }
    if (selectedAppId && !apps.some((app) => app.id === selectedAppId)) {
      setSelectedAppId(apps[0]?.id || "")
      return
    }
    if (!selectedAppId && apps[0]?.id) {
      setSelectedAppId(apps[0].id)
    }
  }, [apps, selectedAppId])

  function handleSelectApp(appId) {
    setSelectedAppId(appId)
    setOneTimeKey("")
    setOneTimeKeyId("")
    setOneTimeKeyScopes([])
    setOneTimeKeyCategories([])
    setApiTestResult("")
  }

  useEffect(() => {
    if (!selectedAppId) return
    const appConsent = consents.find((consent) => consent.app_id === selectedAppId && !consent.revoked_at)
    const selectedApp = apps.find((app) => app.id === selectedAppId)
    const appCategories = selectedApp?.default_categories?.length ? selectedApp.default_categories : defaultCategoriesForPolicy(policy)
    const suggestedScopes = permissionSuggestionForCategories(policy, appCategories).scopes
    const nextScopes = appConsent?.scopes?.length ? appConsent.scopes : suggestedScopes.length ? suggestedScopes : defaultScopesForPolicy(policy)
    setSelectedScopes(normalizeSelectedScopes(nextScopes, policy))
  }, [apps, consents, policy, selectedAppId])

  useEffect(() => {
    if (!authUser) {
      setDisplayNameDraft("")
      setDisplayNameSuccess("")
      return
    }
    setDisplayNameDraft(authUser.user_metadata?.memact_display_name || "")
  }, [authUser?.id])

  async function handleEmailLogin(event) {
    event.preventDefault()
    setError("")
    setAuthNotice("")
    setAuthLoading("email")
    setStatus("Sending login link.")
    try {
      const { error: otpError } = await requireSupabase().auth.signInWithOtp({
        email,
        options: {
          emailRedirectTo: getAuthRedirectTarget()
        }
      })
      if (otpError) throw otpError
      rememberAuthMethod("Email link")
      setAuthNotice("Check your email for the login link.")
      setStatus("Login link sent.")
    } catch (authError) {
      setError(formatAuthErrorMessage(authError))
      setStatus(authStatusMessage(authError))
    } finally {
      setAuthLoading("")
    }
  }

  async function handleEmailSignup(event) {
    event.preventDefault()
    setError("")
    setAuthNotice("")
    setPasswordSuccess("")
    const validation = getPasswordState(password, passwordConfirm)
    if (validation.errors.length) {
      setError(validation.errors[0])
      return
    }
    setAuthLoading("signup")
    setStatus("Creating account.")
    try {
      const cleanDisplayName = signupDisplayName.trim().replace(/\s+/g, " ").slice(0, 80)
      const cleanEmail = email.trim().toLowerCase()
      if (cleanDisplayName.length < 2) {
        setError("Add a display name with at least 2 characters.")
        return
      }
      const { data, error: signUpError } = await requireSupabase().auth.signUp({
        email: cleanEmail,
        password,
        options: {
          emailRedirectTo: getEmailConfirmationRedirectTarget(),
          data: {
            memact_display_name: cleanDisplayName,
            memact_display_name_updated_at: new Date().toISOString(),
            memact_password_ready: true,
            memact_password_updated_at: new Date().toISOString()
          }
        }
      })
      if (signUpError) throw signUpError
      setPassword("")
      setPasswordConfirm("")
      setSignupDisplayName("")
      if (data?.session) {
        rememberAuthMethod("Email password")
        setAuthChecking(false)
        applySession(data.session, "default")
        setStatus("Account created.")
      } else {
        rememberAuthMethod("Email password")
        setEmail(cleanEmail)
        setPendingVerificationEmail(cleanEmail)
        setVerificationCode("")
        setAuthMode("sign-up")
        navigateToPage("home", { replace: true, hash: "#sign-up" })
        setStatus("Verification code sent.")
      }
    } catch (authError) {
      setError(formatAuthErrorMessage(authError, "Account creation did not finish."))
      setStatus(authStatusMessage(authError))
    } finally {
      setAuthLoading("")
    }
  }

  async function handlePasswordLogin(event) {
    event.preventDefault()
    setError("")
    setAuthNotice("")
    setPasswordSuccess("")
    setAuthLoading("password")
    setStatus("Signing in.")
    authEventGuardRef.current = "password-login"
    try {
      const auth = requireSupabase()
      const cleanEmail = email.trim().toLowerCase()
      const { data, error: signInError } = await auth.auth.signInWithPassword({
        email: cleanEmail,
        password
      })
      if (signInError) throw signInError
      setPassword("")
      setPasswordConfirm("")
      let signedInSession = data?.session || null
      const signedInUser = signedInSession?.user || data?.user || null

      if (!signedInSession) {
        const { data: sessionData, error: sessionError } = await auth.auth.getSession()
        if (sessionError) throw sessionError
        signedInSession = sessionData?.session || null
      }

      if (!signedInSession) {
        throw new Error("Login finished, but Memact did not receive a browser session. Refresh and try again.")
      }

      rememberAuthMethod("Email password")
      const guarded = await beginSignInVerificationIfNeeded(auth, signedInSession, cleanEmail)
      if (guarded) {
        setAuthChecking(false)
        return
      }
      setAuthChecking(false)
      applySession(signedInSession, "default")
      markPasswordReadyInBackground(auth, signedInUser || signedInSession.user, setAuthUser)
      setStatus("Signed in.")
    } catch (authError) {
      setError(passwordLoginErrorMessage(authError))
      setStatus(authStatusMessage(authError))
    } finally {
      if (authEventGuardRef.current === "password-login") {
        authEventGuardRef.current = ""
      }
      setAuthLoading("")
    }
  }

  async function beginSignInVerificationIfNeeded(auth, signedInSession, preferredEmail = "") {
    const requiresVerification = await shouldRequireSignInVerification(auth, signedInSession)
    if (!requiresVerification) return false
    await auth.auth.reauthenticate()
    const challengeEmail = preferredEmail || getUserEmail(null, signedInSession?.user).toLowerCase()
    setAuthSession(null)
    setAuthUser(null)
    setPassword("")
    setPasswordConfirm("")
    setPendingSignInVerificationEmail(challengeEmail)
    setSignInVerificationCode("")
    setAuthMode("sign-in")
    navigateToPage("home", { replace: true, hash: "#sign-in" })
    setStatus("Verification code sent.")
    return true
  }

  async function handleVerifySignInCode(event) {
    event.preventDefault()
    setError("")
    setAuthNotice("")
    const cleanCode = signInVerificationCode.replace(/\s+/g, "")
    if (!pendingSignInVerificationEmail) {
      setError("Sign in again so Memact can send a fresh verification code.")
      return
    }
    if (!/^[0-9A-Za-z]{6,10}$/.test(cleanCode)) {
      setError("Enter the verification code from your email.")
      return
    }
    setAuthLoading("verify-signin")
    setStatus("Verifying sign in.")
    authEventGuardRef.current = "signin-code"
    try {
      const auth = requireSupabase()
      const { data: userData, error: userError } = await auth.auth.getUser()
      if (userError) throw userError
      const { error: updateError } = await auth.auth.updateUser({
        data: {
          ...(userData?.user?.user_metadata || {}),
          memact_last_reauth_at: new Date().toISOString()
        },
        nonce: cleanCode
      })
      if (updateError) throw updateError
      const { data: sessionData, error: sessionError } = await auth.auth.getSession()
      if (sessionError) throw sessionError
      const verifiedSession = sessionData?.session || null
      if (!verifiedSession) throw new Error("Verification finished, but Memact did not receive a browser session.")
      setPendingSignInVerificationEmail("")
      setSignInVerificationCode("")
      setAuthChecking(false)
      applySession(verifiedSession, "default")
      setStatus("Signed in.")
    } catch (verifyError) {
      setError(formatAuthErrorMessage(verifyError, "Verification code did not work. Check the latest email and try again."))
      setStatus(authStatusMessage(verifyError))
    } finally {
      authEventGuardRef.current = ""
      setAuthLoading("")
    }
  }

  function clearPendingSignInVerification() {
    setPendingSignInVerificationEmail("")
    setSignInVerificationCode("")
    setPassword("")
    setAuthNotice("")
  }

  async function handleVerifySignupCode(event) {
    event.preventDefault()
    setError("")
    setAuthNotice("")
    const cleanEmail = pendingVerificationEmail.trim().toLowerCase()
    const cleanCode = verificationCode.replace(/\s+/g, "")
    if (!cleanEmail) {
      setError("Start sign up again so Memact knows which email to verify.")
      return
    }
    if (!/^[0-9A-Za-z]{6,10}$/.test(cleanCode)) {
      setError("Enter the verification code from your email.")
      return
    }
    setAuthLoading("verify-signup")
    setStatus("Verifying email.")
    try {
      const { data, error: verifyError } = await requireSupabase().auth.verifyOtp({
        email: cleanEmail,
        token: cleanCode,
        type: "email"
      })
      if (verifyError) throw verifyError
      await finishEmailVerification(data?.session || null)
    } catch (verifyError) {
      setError(formatAuthErrorMessage(verifyError, "Verification code did not work. Check the latest email and try again."))
      setStatus(authStatusMessage(verifyError))
    } finally {
      setAuthLoading("")
    }
  }

  function clearPendingVerification() {
    setPendingVerificationEmail("")
    setVerificationCode("")
    setAuthNotice("")
  }

  async function shouldRequireSignInVerification(auth, signedInSession) {
    if (!SIGNIN_RISK_FUNCTION_NAME || !signedInSession) return false
    try {
      const { data, error: riskError } = await auth.functions.invoke(SIGNIN_RISK_FUNCTION_NAME, {
        body: {
          event: "password_sign_in"
        }
      })
      if (riskError) return false
      return Boolean(data?.requires_verification || data?.requiresVerification || data?.ip_changed || data?.ipChanged)
    } catch {
      return false
    }
  }

  async function handleForgotPassword() {
    setError("")
    setPasswordSuccess("")
    setEmailChangeSuccess("")
    if (!email.trim()) {
      setError("Enter your email first so Memact knows where to send the reset link.")
      return
    }
    setAuthLoading("forgot-password")
    setStatus("Sending password reset link.")
    try {
      const { error: resetError } = await requireSupabase().auth.resetPasswordForEmail(email.trim(), {
        redirectTo: getAuthRedirectTarget()
      })
      if (resetError) throw resetError
      setAuthNotice("Check your email for the password reset link.")
      setStatus("Password reset link sent.")
    } catch (resetError) {
      setError(formatAuthErrorMessage(resetError, "Could not send the password reset link."))
      setStatus(authStatusMessage(resetError))
    } finally {
      setAuthLoading("")
    }
  }

  async function handleGithubLogin() {
    setError("")
    setAuthNotice("")
    setAuthLoading("github")
    setStatus("Opening GitHub login.")
    try {
      rememberAuthMethod("GitHub")
      const { error: oauthError } = await requireSupabase().auth.signInWithOAuth({
        provider: "github",
        options: {
          redirectTo: getAuthRedirectTarget()
        }
      })
      if (oauthError) throw oauthError
    } catch (authError) {
      setError(formatAuthErrorMessage(authError))
      setStatus(authStatusMessage(authError))
      setAuthLoading("")
    }
  }

  async function handleInviteUser(event) {
    event.preventDefault()
    setError("")
    setAuthNotice("")
    setInviteSuccess("")
    const cleanEmail = inviteEmail.trim().toLowerCase()
    if (!/^\S+@\S+\.\S+$/.test(cleanEmail)) {
      setError("Enter a valid email address for the invite.")
      return
    }
    if (cleanEmail === getUserEmail(user, authUser).toLowerCase()) {
      setError("Use a different email address for the invite.")
      return
    }
    setAuthLoading("invite-user")
    setStatus("Sending invite.")
    try {
      const auth = requireSupabase()
      const { data, error: inviteError } = await auth.functions.invoke(INVITE_FUNCTION_NAME, {
        body: {
          email: cleanEmail,
          redirect_to: getEmailConfirmationRedirectTarget()
        }
      })
      if (inviteError) throw inviteError
      const invitedEmail = data?.email || cleanEmail
      setInviteEmail("")
      setInviteSuccess(`Invite sent to ${invitedEmail}.`)
      setAuthNotice(`Invite sent to ${invitedEmail}.`)
      setStatus("Invite sent.")
    } catch (inviteError) {
      setError(formatAuthErrorMessage(inviteError, "Could not send the invite. Check the Supabase invite function."))
      setStatus(authStatusMessage(inviteError))
    } finally {
      setAuthLoading("")
    }
  }

  async function handleResendConfirmation() {
    setError("")
    setAuthNotice("")
    const targetEmail = (pendingVerificationEmail || email).trim().toLowerCase()
    if (!targetEmail) {
      setError("Enter your email first so Memact knows where to send the confirmation email.")
      return
    }
    setAuthLoading("resend-confirmation")
    setStatus("Sending confirmation email.")
    try {
      const auth = requireSupabase()
      if (typeof auth.auth.resend !== "function") {
        throw new Error("Confirmation resend is not available in this Supabase client.")
      }
      const { error: resendError } = await auth.auth.resend({
        type: "signup",
        email: targetEmail,
        options: {
          emailRedirectTo: getEmailConfirmationRedirectTarget()
        }
      })
      if (resendError) throw resendError
      setPendingVerificationEmail(targetEmail)
      setAuthNotice("Verification code sent again.")
      setStatus("Verification code sent.")
    } catch (resendError) {
      setError(formatAuthErrorMessage(resendError, "Could not resend the confirmation email."))
      setStatus(authStatusMessage(resendError))
    } finally {
      setAuthLoading("")
    }
  }

  async function handleSetPassword(event) {
    event.preventDefault()
    setError("")
    setPasswordSuccess("")
    const validationMessage = passwordState.errors[0] || ""
    if (validationMessage) {
      setError(validationMessage)
      return
    }
    setAuthLoading("set-password")
    setStatus("Saving password.")
    try {
      const { data, error: updateError } = await requireSupabase().auth.updateUser({
        password: setupPassword,
        data: {
          ...(authUser?.user_metadata || {}),
          memact_password_ready: true,
          memact_password_updated_at: new Date().toISOString()
        }
      })
      if (updateError) throw updateError
      if (data?.user) {
        setAuthUser(data.user)
      }
      setSetupPassword("")
      setSetupPasswordConfirm("")
      setAuthFlow("default")
      setAuthNotice("")
      setPasswordSuccess("Password saved. Next time you can sign in with email and password.")
      setStatus("Password ready.")
    } catch (passwordError) {
      setError(passwordSetupErrorMessage(passwordError))
      setStatus(authStatusMessage(passwordError))
    } finally {
      setAuthLoading("")
    }
  }

  async function handleChangeEmail(event) {
    event.preventDefault()
    setError("")
    setEmailChangeSuccess("")
    const nextEmail = newEmailAddress.trim().toLowerCase()
    if (!nextEmail) {
      setError("Enter the new email address first.")
      return
    }
    if (nextEmail === (authUser?.email || "").toLowerCase()) {
      setError("Use a different email address.")
      return
    }
    setAuthLoading("change-email")
    setStatus("Sending email change confirmation.")
    try {
      const { data, error: updateError } = await requireSupabase().auth.updateUser({
        email: nextEmail
      })
      if (updateError) throw updateError
      if (data?.user) {
        setAuthUser(data.user)
      }
      setNewEmailAddress("")
      setEmailChangeSuccess("Check both email inboxes to confirm the change, based on your Supabase email settings.")
      setStatus("Email change started.")
    } catch (emailError) {
      setError(formatAuthErrorMessage(emailError, "Email change did not finish."))
      setStatus(authStatusMessage(emailError))
    } finally {
      setAuthLoading("")
    }
  }

  async function handleUpdateDisplayName(event) {
    event.preventDefault()
    setError("")
    setDisplayNameSuccess("")
    const cleanName = displayNameDraft.trim().replace(/\s+/g, " ").slice(0, 80)
    if (cleanName.length < 2) {
      setError("Use at least 2 characters for your display name.")
      scrollElementIntoView("error-message")
      return
    }
    setAuthLoading("display-name")
    setStatus("Saving display name.")
    try {
      const { data, error: updateError } = await requireSupabase().auth.updateUser({
        data: {
          ...(authUser?.user_metadata || {}),
          memact_display_name: cleanName,
          memact_display_name_updated_at: new Date().toISOString()
        }
      })
      if (updateError) throw updateError
      if (data?.user) {
        setAuthUser(data.user)
      }
      setDisplayNameDraft(cleanName)
      setDisplayNameSuccess("Display name saved.")
      setStatus("Display name saved.")
    } catch (displayNameError) {
      setError(formatAuthErrorMessage(displayNameError, "Display name did not save."))
      setStatus(authStatusMessage(displayNameError))
      scrollElementIntoView("error-message")
    } finally {
      setAuthLoading("")
    }
  }

  async function handleCreateApp(event) {
    event.preventDefault()
    setError("")
    setCanRetryDashboard(false)
    const cleanName = newAppName.trim()
    if (!cleanName) {
      setError("App name is required.")
      scrollElementIntoView("error-message")
      return
    }
    if (hasDuplicateAppName(apps, cleanName)) {
      setError("You already have an app with this name.")
      scrollElementIntoView("error-message")
      return
    }
    if (!normalizeSelectedCategories(newAppCategories, policy).length) {
      setError("Choose at least one activity category before creating the app.")
      scrollElementIntoView("error-message")
      return
    }
    try {
      const developerUrl = normalizeOptionalHttpUrl(newAppDeveloperUrl, "Developer website")
      const redirectUrl = normalizeOptionalHttpUrl(newAppRedirectUrl, "Connect redirect URL")
      const result = await client.createApp(session, {
        name: cleanName,
        description: newAppDescription.trim(),
        developer_url: developerUrl,
        redirect_urls: redirectUrl ? [redirectUrl] : [],
        categories: normalizeSelectedCategories(newAppCategories, policy)
      })
      await refreshDashboard(client, session, dashboardActions, statusForAccessError)
      setSelectedAppId(result.app.id)
      setShowAppForm(false)
      setNewAppName("")
      setNewAppDescription("")
      setNewAppDeveloperUrl("")
      setNewAppRedirectUrl("")
      setNewAppCategories([])
      setOneTimeKey("")
      setOneTimeKeyId("")
      setOneTimeKeyScopes([])
      setOneTimeKeyCategories([])
      setApiTestResult("")
      setStatus("App created.")
      scrollElementIntoView("permissions-panel")
    } catch (appError) {
      setError(appError.message)
      setStatus(statusForAccessError(appError).status)
      scrollElementIntoView("error-message")
    }
  }

  async function handleRetryDashboard() {
    if (authChecking || !session) return
    await refreshDashboard(client, session, dashboardActions, statusForAccessError)
  }

  async function handleDeleteApp() {
    if (!selectedAppId) return
    const app = apps.find((item) => item.id === selectedAppId)
    const appName = app?.name || "this app"
    const confirmed = window.confirm(`Delete ${appName}? Its API keys will stop working.`)
    if (!confirmed) return
    setError("")
    setCanRetryDashboard(false)
    setStatus("Deleting app.")
    try {
      await client.deleteApp(session, selectedAppId)
      setSelectedAppId("")
      setOneTimeKey("")
      setOneTimeKeyId("")
      setOneTimeKeyScopes([])
      setOneTimeKeyCategories([])
      setApiTestResult("")
      await refreshDashboard(client, session, dashboardActions, statusForAccessError)
      setStatus("App deleted.")
      scrollElementIntoView("app-panel")
    } catch (deleteError) {
      setError(deleteError.message)
      setStatus(statusForAccessError(deleteError).status)
      scrollElementIntoView("error-message")
    }
  }

  async function handleGrantConsent() {
    setError("")
    try {
      await client.grantConsent(session, {
        app_id: selectedAppId,
        scopes: normalizeSelectedScopes(selectedScopes, policy),
        categories: getSelectedAppCategories()
      })
      await refreshDashboard(client, session, dashboardActions, statusForAccessError)
      setStatus("Permissions saved.")
      scrollElementIntoView("permissions-panel")
    } catch (consentError) {
      setError(consentError.message)
      scrollElementIntoView("error-message")
    }
  }

  async function handleCreateKey() {
    setError("")
    setOneTimeKey("")
    setOneTimeKeyId("")
    setOneTimeKeyScopes([])
    setOneTimeKeyCategories([])
    const keyScopes = normalizeSelectedScopes(selectedScopes, policy)
    const permissionCategories = getSelectedAppCategories()
    try {
      const result = await client.createApiKey(session, {
        app_id: selectedAppId,
        name: "Default app key",
        scopes: keyScopes
      })
      await refreshDashboard(client, session, dashboardActions, statusForAccessError)
      setOneTimeKey(result.key)
      setOneTimeKeyId(result.api_key?.id || "")
      setOneTimeKeyScopes(keyScopes)
      setOneTimeKeyCategories(permissionCategories)
      setApiTestResult("")
      setStatus("API key created. Copy it now.")
      scrollElementIntoView("one-time-key-panel")
    } catch (keyError) {
      setError(keyError.message)
      scrollElementIntoView("error-message")
    }
  }

  function getSelectedAppCategories() {
    const selectedApp = apps.find((app) => app.id === selectedAppId)
    const appCategories = selectedApp?.default_categories?.length ? selectedApp.default_categories : defaultCategoriesForPolicy(policy)
    return normalizeSelectedCategories(appCategories, policy)
  }

  async function handleRevokeKey(keyId) {
    setError("")
    try {
      await client.revokeApiKey(session, keyId)
      if (keyId === oneTimeKeyId) {
        setOneTimeKey("")
        setOneTimeKeyId("")
        setOneTimeKeyScopes([])
        setOneTimeKeyCategories([])
        setApiTestResult("")
      }
      await refreshDashboard(client, session, dashboardActions, statusForAccessError)
      setStatus("API key revoked.")
      scrollElementIntoView("api-keys-panel")
    } catch (keyError) {
      setError(keyError.message)
      scrollElementIntoView("error-message")
    }
  }

  async function copyOneTimeKey() {
    if (!oneTimeKey) return
    try {
      await navigator.clipboard.writeText(oneTimeKey)
      setStatus("API key copied.")
    } catch {
      setStatus("Copy failed. Select the key manually.")
    }
  }

  async function testOneTimeKey() {
    if (!oneTimeKey) return
    setError("")
    setApiTestResult("")
    setStatus("Testing API key.")
    try {
      const result = await client.verifyApiKey(oneTimeKey, oneTimeKeyScopes, oneTimeKeyCategories)
      const verifiedScopes = Array.isArray(result.scopes) ? result.scopes : []
      setApiTestResult(`Verified for ${verifiedScopes.length} scope${verifiedScopes.length === 1 ? "" : "s"}.`)
      setStatus("API key works.")
      scrollElementIntoView("one-time-key-panel")
    } catch (testError) {
      setError(testError.message)
      setStatus("API key test failed.")
      scrollElementIntoView("error-message")
    }
  }

  async function handleConnectApprove() {
    if (!connectRequest?.app_id) return
    setError("")
    setConnectNotice("")
    setConnectLoading("approve")
    setStatus("Connecting app.")
    try {
      const result = await client.connectApp(session, connectRequest)
      const connectionId = result?.consent?.id || ""
      setConnectNotice("App connected. You can close this tab or return to the app.")
      setStatus("App connected.")
      if (connectRequest.redirect_uri) {
        window.location.href = buildConnectRedirect(connectRequest.redirect_uri, {
          connected: "1",
          connection_id: connectionId,
          state: connectRequest.state
        })
      }
    } catch (connectError) {
      setError(connectError.message)
      setStatus("Connect app failed.")
      scrollElementIntoView("error-message")
    } finally {
      setConnectLoading("")
    }
  }

  function handleConnectCancel() {
    setStatus("Connection cancelled.")
    if (connectRequest.redirect_uri) {
      window.location.href = buildConnectRedirect(connectRequest.redirect_uri, {
        connected: "0",
        state: connectRequest.state
      })
      return
    }
    navigateToPage("access", { replace: true })
  }

  function handleExternalBack() {
    window.location.href = getExternalBackUrl()
  }

  function getExternalBackUrl() {
    if (connectRequest?.redirect_uri) {
      return buildConnectRedirect(connectRequest.redirect_uri, {
        state: connectRequest.state || undefined
      })
    }
    return "https://www.memact.com/"
  }

  function updateConnectSelection({ scopes: nextScopes = [], categories: nextCategories = [] } = {}) {
    setConnectRequest((current) => ({
      ...current,
      scopes: nextScopes,
      categories: nextCategories
    }))
    setConnectDetails((current) => current ? {
      ...current,
      requested_scopes: nextScopes,
      requested_categories: nextCategories
    } : current)
  }

  function navigateToDataTransparency(request) {
    navigateWithConnectParams(routeForPage("data"), request)
  }

  function navigateToConnect(request) {
    navigateWithConnectParams(routeForPage("connect"), request)
  }

  function navigateWithConnectParams(pathname, request) {
    const url = new URL(pathname, window.location.origin)
    if (request?.app_id) url.searchParams.set("app_id", request.app_id)
    if (request?.scopes?.length) url.searchParams.set("scopes", request.scopes.join(","))
    if (request?.categories?.length) url.searchParams.set("categories", request.categories.join(","))
    if (request?.redirect_uri) url.searchParams.set("redirect_uri", request.redirect_uri)
    if (request?.state) url.searchParams.set("state", request.state)
    window.history.pushState({}, "", `${url.pathname}${url.search}`)
    const page = pageFromLocation(window.location)
    setCurrentPage(page)
    setActiveTab(page)
  }

  async function signOut() {
    setError("")
    setStatus("Signing out.")
    try {
      if (supabase) {
        const { error: signOutError } = await supabase.auth.signOut()
        if (signOutError) throw signOutError
      }
    } catch (signOutError) {
      setError(signOutError.message)
    }
    setAuthSession(null)
    setAuthUser(null)
    dashboardActions.resetData()
    setOneTimeKey("")
    setOneTimeKeyId("")
    setOneTimeKeyScopes([])
    setOneTimeKeyCategories([])
    setApiTestResult("")
    setDisplayNameDraft("")
    setDisplayNameSuccess("")
    setInviteEmail("")
    setInviteSuccess("")
    setAuthMode("sign-up")
    setPendingVerificationEmail("")
    setVerificationCode("")
    setPendingSignInVerificationEmail("")
    setSignInVerificationCode("")
    setStatus("Signed out.")
    navigateToPage("home", { replace: true })
  }

  const scopes = policy?.scopes || {}
  const isPublicLearnPage = currentPage === "learn"
  const showAuth = !session && !authChecking && !isPublicLearnPage
  const isInitialLoading = authChecking && !session
  const statusNeedsAttention = /missing|failed|offline/i.test(status)
  const showStatusPill = !showAuth && Boolean(error || statusNeedsAttention)
  const showExternalBackHeader = session && (currentPage === "connect" || currentPage === "data")
  const showLearnBackHeader = isPublicLearnPage
  const activePortalTabLabel = currentPage === "account" ? "Account" : currentPage === "help" ? "Help" : "Dashboard"
  const [isMobileTabsOpen, setIsMobileTabsOpen] = useState(false)
  const tabsRef = useRef(null)

  const handleTabSelect = (page) => {
    navigateToPage(page)
    setIsMobileTabsOpen(false)
  }

  const toggleMobileTabs = () => {
    setIsMobileTabsOpen((open) => !open)
  }


  useEffect(() => {
    setIsMobileTabsOpen(false)
  }, [currentPage])

  useEffect(() => {
    if (!isMobileTabsOpen) return
    const handlePointerDown = (event) => {
      if (!tabsRef.current?.contains(event.target)) {
        setIsMobileTabsOpen(false)
      }
    }
    document.addEventListener("pointerdown", handlePointerDown)
    return () => document.removeEventListener("pointerdown", handlePointerDown)
  }, [isMobileTabsOpen])

  if (isInitialLoading) {
    return (
      <div className="loading-screen">
        <div className="loading-screen-inner">
          <img className="loading-screen-logo" src="/logo.png" alt="Memact" width="132" height="30" />
          <div className="loading-indicator" aria-label="Loading" />
        </div>
      </div>
    )
  }

  return (
    <main className={showAuth ? "page page-auth" : "page"}>
      <header className="topbar">
        <a className="logo-link" href="https://www.memact.com/" aria-label="Go to memact.com">
          <img className="logo-img" src="/logo.png" alt="Memact" width="132" height="30" />
        </a>
        {showExternalBackHeader ? (
          <nav className="nav back-nav" aria-label="Return navigation">
            <button type="button" className="button back-button" onClick={handleExternalBack} aria-label="Back to app">
              <Chevron className="back-chevron" />
            </button>
          </nav>
        ) : showLearnBackHeader ? (
          <nav className="nav back-nav" aria-label="Return navigation">
            <button type="button" className="button back-button" onClick={() => navigateToPage("home")} aria-label="Back to Memact">
              <Chevron className="back-chevron" />
            </button>
          </nav>
        ) : session ? (
          <nav ref={tabsRef} className={isMobileTabsOpen ? "tabs is-open" : "tabs"} aria-label="Memact portal tabs">
            <button type="button" className="tab tab-current" onClick={toggleMobileTabs} aria-expanded={isMobileTabsOpen}>{activePortalTabLabel}</button>
            <div className="tabs-list">
              <button type="button" className={currentPage === "access" ? "tab is-active" : "tab"} onClick={() => handleTabSelect("access")}>Dashboard</button>
              <button type="button" className={currentPage === "account" ? "tab is-active" : "tab"} onClick={() => handleTabSelect("account")}>Account</button>
              <button type="button" className={currentPage === "help" ? "tab is-active" : "tab"} onClick={() => handleTabSelect("help")}>Help</button>
            </div>
            <button type="button" className="nav-dropdown-toggle" aria-label="Toggle tabs menu" aria-expanded={isMobileTabsOpen} onClick={toggleMobileTabs}>
              <Chevron className={isMobileTabsOpen ? "nav-dropdown-chevron is-open" : "nav-dropdown-chevron"} />
            </button>
          </nav>
        ) : null}
        {showStatusPill ? <span className="status-pill" aria-live="polite">{status}</span> : null}
      </header>

      {error && !isInitialLoading ? (
        <div id="error-message" className="notice notice-danger error-overlay" role="alert">
          <span>{error}</span>
          <div className="error-overlay-actions">
            {canRetryDashboard ? <button type="button" className="inline-retry" onClick={handleRetryDashboard}>Retry</button> : null}
            <button type="button" className="error-dismiss" onClick={() => setError("")} aria-label="Dismiss error">x</button>
          </div>
        </div>
      ) : null}
      {authNotice && !isInitialLoading ? (
        <div className={error ? "notice notice-success success-overlay has-error" : "notice notice-success success-overlay"} role="status">
          <span>{authNotice}</span>
          <button type="button" className="error-dismiss" onClick={() => setAuthNotice("")} aria-label="Dismiss notice">x</button>
        </div>
      ) : null}

      {currentPage === "learn" ? (
        <section className="dashboard">
          <LearnPanel />
        </section>
      ) : currentPage === "help" ? (
        <section className="dashboard">
          <HelpPanel />
        </section>
      ) : session && currentPage === "connect" ? (
        <ConnectPage
          connectRequest={connectRequest}
          connectDetails={connectDetails}
          loading={connectLoading}
          notice={connectNotice}
          onApprove={handleConnectApprove}
          onCancel={handleConnectCancel}
          onLearnMore={() => navigateToPage("help")}
          onDataTransparency={() => navigateToDataTransparency(connectRequest)}
        />
      ) : session && currentPage === "data" && connectRequest?.app_id && connectDetails?.app ? (
        <DataTransparencyPage
          app={connectDetails?.app}
          scopes={connectDetails?.scopes || scopes}
          categories={connectDetails?.activity_categories || policy?.activity_categories || {}}
          requestedScopes={connectDetails?.requested_scopes || connectRequest?.scopes || []}
          requestedCategories={connectDetails?.requested_categories || connectRequest?.categories || []}
          transparency={connectDetails?.transparency || connectDetails?.data_transparency || connectDetails?.app?.transparency || {}}
          onUpdateSelection={updateConnectSelection}
          onBackToConsent={() => navigateToConnect(connectRequest)}
          onManageConsent={() => navigateToPage("access")}
        />
      ) : session && currentPage === "data" ? (
        <section className="connect-shell">
          <article className="panel connect-card">
            <p className="eyebrow">Data transparency</p>
            <h1>{connectRequest?.app_id && connectLoading === "loading" ? "Loading app transparency." : "Open this from an app consent link."}</h1>
            <p className="muted">
              {connectRequest?.app_id && connectLoading === "loading"
                ? "Checking the Memact app request before showing any data disclosure."
                : "This page only works with a real Memact app request. Use the Data Transparency link beside that app's consent screen."}
            </p>
            <div className="connect-actions">
              <button type="button" onClick={() => navigateToPage("access")}>Open dashboard</button>
              <button type="button" className="ghost" onClick={() => navigateToPage("help")}>Learn more</button>
            </div>
          </article>
        </section>
      ) : session ? (
        <Dashboard
          activeTab={activeTab}
          user={user}
          authUser={authUser}
          apps={apps}
          apiKeys={apiKeys}
          consents={consents}
          policy={policy}
          scopes={scopes}
          categories={policy?.activity_categories || {}}
          selectedAppId={selectedAppId}
          selectedScopes={selectedScopes}
          newAppName={newAppName}
          newAppDescription={newAppDescription}
          newAppDeveloperUrl={newAppDeveloperUrl}
          newAppRedirectUrl={newAppRedirectUrl}
          newAppCategories={newAppCategories}
          oneTimeKey={oneTimeKey}
          oneTimeKeyScopes={oneTimeKeyScopes}
          oneTimeKeyCategories={oneTimeKeyCategories}
          apiTestResult={apiTestResult}
          showAppForm={showAppForm}
          setSelectedAppId={handleSelectApp}
          setSelectedScopes={setSelectedScopes}
          setNewAppName={setNewAppName}
          setNewAppDescription={setNewAppDescription}
          setNewAppDeveloperUrl={setNewAppDeveloperUrl}
          setNewAppRedirectUrl={setNewAppRedirectUrl}
          setNewAppCategories={setNewAppCategories}
          setShowAppForm={setShowAppForm}
          onCreateApp={handleCreateApp}
          onDeleteApp={handleDeleteApp}
          onGrantConsent={handleGrantConsent}
          onCreateKey={handleCreateKey}
          onRevokeKey={handleRevokeKey}
          onCopyKey={copyOneTimeKey}
          onTestKey={testOneTimeKey}
          onSignOut={signOut}
          authLoading={authLoading}
          needsPasswordSetup={needsPasswordSetup}
          setupPassword={setupPassword}
          setupPasswordConfirm={setupPasswordConfirm}
          passwordState={passwordState}
          passwordSuccess={passwordSuccess}
          setSetupPassword={setSetupPassword}
          setSetupPasswordConfirm={setSetupPasswordConfirm}
          onSetPassword={handleSetPassword}
          newEmailAddress={newEmailAddress}
          setNewEmailAddress={setNewEmailAddress}
          emailChangeSuccess={emailChangeSuccess}
          authFlow={authFlow}
          onChangeEmail={handleChangeEmail}
          displayName={getDisplayName(user, authUser)}
          displayNameDraft={displayNameDraft}
          setDisplayNameDraft={setDisplayNameDraft}
          displayNameSuccess={displayNameSuccess}
          onUpdateDisplayName={handleUpdateDisplayName}
          inviteEmail={inviteEmail}
          setInviteEmail={setInviteEmail}
          inviteSuccess={inviteSuccess}
          onInviteUser={handleInviteUser}
        />
      ) : (
        <Landing
          isConnecting={Boolean(connectRequest?.app_id && isConnectPath())}
          showAuth={showAuth}
          email={email}
          signupDisplayName={signupDisplayName}
          password={password}
          passwordConfirm={passwordConfirm}
          pendingVerificationEmail={pendingVerificationEmail}
          verificationCode={verificationCode}
          pendingSignInVerificationEmail={pendingSignInVerificationEmail}
          signInVerificationCode={signInVerificationCode}
          passwordState={signupPasswordState}
          authMode={authMode}
          authLoading={authLoading}
          lastAuthMethod={lastAuthMethod}
          setEmail={setEmail}
          setSignupDisplayName={setSignupDisplayName}
          setPassword={setPassword}
          setPasswordConfirm={setPasswordConfirm}
          setVerificationCode={setVerificationCode}
          setSignInVerificationCode={setSignInVerificationCode}
          setAuthMode={setLandingAuthMode}
          onEmailSignup={handleEmailSignup}
          onVerifySignupCode={handleVerifySignupCode}
          onVerifySignInCode={handleVerifySignInCode}
          onEmailLogin={handleEmailLogin}
          onPasswordLogin={handlePasswordLogin}
          onForgotPassword={handleForgotPassword}
          onResendConfirmation={handleResendConfirmation}
          onClearPendingVerification={clearPendingVerification}
          onClearPendingSignInVerification={clearPendingSignInVerification}
          onGithubLogin={handleGithubLogin}
          onLearnMore={() => { navigateToPage("learn") }}
        />
      )}
    </main>
  )
}

function statusForAccessError(error) {
  if (error instanceof TypeError || /failed to fetch|networkerror|load failed/i.test(String(error?.message || ""))) {
    return {
      message: ACCESS_MODE === "supabase" ? "Could not reach Supabase Dashboard. Check the Website env vars and project settings." : "Could not reach Dashboard. Make sure it is running.",
      status: ACCESS_MODE === "supabase" ? "Supabase Dashboard offline." : "Dashboard offline."
    }
  }
  if (error instanceof AccessApiError) {
    if (error.status === 401) return { message: "Please sign in again.", status: "Login expired." }
    if (error.status === 403) return { message: "Dashboard denied this request.", status: "Dashboard denied." }
    if (error.status === 409) return { message: "This app already exists.", status: "Dashboard sync failed." }
    if (error.status >= 500) return { message: ACCESS_MODE === "supabase" ? "Supabase Dashboard needs the SQL migration or project setup." : "Dashboard service had a server error. Check Dashboard logs.", status: "Dashboard sync failed." }
  }
  return {
    message: error?.message || "Dashboard sync failed.",
    status: "Dashboard sync failed."
  }
}



function formatAuthErrorMessage(error, fallback = "Login did not finish.") {
  const baseMessage = String(error?.message || "").trim()
  if (/invalid login credentials/i.test(baseMessage)) {
    return "Email or password did not match. You can use the email link if this is your first login."
  }
  if (/email not confirmed/i.test(baseMessage)) {
    return "Confirm your email first, then sign in again."
  }
  const code = String(error?.code || "").trim()
  const status = Number.isFinite(error?.status) ? `status ${error.status}` : ""
  const details = String(error?.details || error?.hint || "").trim()
  const suffix = [code, status, details].filter(Boolean).join(" - ")
  if (baseMessage && suffix) return `${baseMessage} (${suffix})`
  if (baseMessage) return baseMessage
  return suffix || fallback
}

function authStatusMessage(error) {
  const message = String(error?.message || "").toLowerCase()
  if (message.includes("failed to fetch") || message.includes("networkerror")) {
    return "Login did not connect."
  }
  if (message.includes("supabase is not configured")) {
    return "Supabase env vars are missing."
  }
  return "Login did not finish."
}

function passwordLoginErrorMessage(error) {
  return formatAuthErrorMessage(error, "Password login did not finish.")
}

function passwordSetupErrorMessage(error) {
  const message = String(error?.message || "")
  if (/same password/i.test(message)) {
    return "Choose a new password that is different from the last one."
  }
  if (/password/i.test(message) && /weak|short|strength/i.test(message)) {
    return "Use a stronger password before saving it."
  }
  return message || "Password setup did not finish."
}

function shouldOfferPasswordSetup(user) {
  if (!user) return false
  const provider = user.app_metadata?.provider || user.identities?.[0]?.provider || "email"
  if (provider !== "email") return false
  return !Boolean(user.user_metadata?.memact_password_ready)
}

function shouldOpenAccountTab(user, isRecoveryFlow) {
  return isRecoveryFlow || shouldOfferPasswordSetup(user)
}

function detectAuthFlowFromUrl() {
  if (typeof window === "undefined") return "default"
  const path = window.location.pathname.toLowerCase()
  const query = `${window.location.search || ""}${window.location.hash || ""}`.toLowerCase()
  if (query.includes("type=invite")) return "invite"
  if (path === "/auth/confirm" || query.includes("type=signup")) return "verified"
  if (query.includes("type=recovery")) return "recovery"
  return "default"
}

function authModeFromLocation() {
  if (typeof window === "undefined") return "sign-up"
  return String(window.location.hash || "").toLowerCase().includes("sign-in") ? "sign-in" : "sign-up"
}

function shouldCheckSessionOnLoad() {
  if (typeof window === "undefined") return false
  const page = pageFromLocation(window.location)
  const path = window.location.pathname.toLowerCase()
  const authPayload = `${window.location.search || ""}${window.location.hash || ""}`.toLowerCase()
  return page === "home" ||
    isProtectedPage(page) ||
    path === "/auth/confirm" ||
    authPayload.includes("code=") ||
    authPayload.includes("token_hash=") ||
    authPayload.includes("access_token=") ||
    authPayload.includes("type=signup") ||
    authPayload.includes("type=invite") ||
    authPayload.includes("type=recovery") ||
    authPayload.includes("type=magiclink")
}

async function resolveInitialSession(authClient) {
  const tokenHash = getAuthTokenHashFromUrl()
  if (tokenHash && typeof authClient?.auth?.verifyOtp === "function") {
    try {
      const verified = await withAuthTimeout(authClient.auth.verifyOtp({
        token_hash: tokenHash,
        type: getAuthEmailTypeFromUrl()
      }), AUTH_CODE_EXCHANGE_TIMEOUT_MS)
      if (verified?.data?.session || verified?.error) {
        return verified
      }
    } catch (verifyError) {
      return { data: { session: null }, error: verifyError }
    }
  }

  const authCode = getAuthCodeFromUrl()
  if (authCode && typeof authClient?.auth?.exchangeCodeForSession === "function") {
    try {
      const exchanged = await withAuthTimeout(authClient.auth.exchangeCodeForSession(authCode), AUTH_CODE_EXCHANGE_TIMEOUT_MS)
      if (exchanged?.data?.session || exchanged?.error) {
        return exchanged
      }
    } catch (exchangeError) {
      const fallback = await withAuthTimeout(authClient.auth.getSession(), AUTH_SESSION_CHECK_TIMEOUT_MS)
      if (fallback?.data?.session) return fallback
      return { data: { session: null }, error: exchangeError }
    }
  }

  return withAuthTimeout(authClient.auth.getSession(), AUTH_SESSION_CHECK_TIMEOUT_MS)
}

function getAuthCodeFromUrl() {
  if (typeof window === "undefined") return ""
  return new URLSearchParams(window.location.search || "").get("code") || ""
}

function getAuthTokenHashFromUrl() {
  if (typeof window === "undefined") return ""
  const hashParams = new URLSearchParams(String(window.location.hash || "").replace(/^#/, ""))
  return new URLSearchParams(window.location.search || "").get("token_hash") || hashParams.get("token_hash") || ""
}

function getAuthEmailTypeFromUrl() {
  if (typeof window === "undefined") return "signup"
  const searchParams = new URLSearchParams(window.location.search || "")
  const hashParams = new URLSearchParams(String(window.location.hash || "").replace(/^#/, ""))
  const requestedType = String(searchParams.get("type") || hashParams.get("type") || "signup").toLowerCase()
  const allowedTypes = new Set(["signup", "magiclink", "recovery", "invite", "email_change", "email"])
  return allowedTypes.has(requestedType) ? requestedType : "signup"
}

function withAuthTimeout(promise, timeoutMs) {
  let timeoutId
  const timeout = new Promise((_, reject) => {
    timeoutId = window.setTimeout(() => reject(new Error("Login callback took too long.")), timeoutMs)
  })
  return Promise.race([promise, timeout]).finally(() => {
    window.clearTimeout(timeoutId)
  })
}

function markPasswordReadyInBackground(auth, user, setAuthUser) {
  if (!user || user.user_metadata?.memact_password_ready) return
  auth.auth.updateUser({
    data: {
      ...user.user_metadata,
      memact_password_ready: true,
      memact_password_updated_at: new Date().toISOString()
    }
  })
    .then(({ data }) => {
      if (data?.user) {
        setAuthUser(data.user)
      }
    })
    .catch(() => {})
}

function isConnectPath() {
  return typeof window !== "undefined" && window.location.pathname === "/connect"
}

function parseConnectRequest() {
  if (typeof window === "undefined") {
    return { app_id: "", scopes: [], categories: [], redirect_uri: "", state: "" }
  }
  const params = new URLSearchParams(window.location.search)
  return {
    app_id: params.get("app_id") || "",
    scopes: parseListParam(params.get("scopes")),
    categories: parseListParam(params.get("categories")),
    redirect_uri: sanitizeConnectRedirectParam(params.get("redirect_uri") || ""),
    state: String(params.get("state") || "").slice(0, 300)
  }
}

function parseListParam(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
}

function getAuthRedirectTarget() {
  if (isConnectPath()) {
    return window.location.href
  }
  return getAuthRedirectUrl(routeForPage("access"))
}

function getEmailConfirmationRedirectTarget() {
  return getAuthRedirectUrl("/auth/confirm")
}

function readLastAuthMethod() {
  if (typeof window === "undefined") return ""
  try {
    return window.localStorage.getItem(LAST_AUTH_METHOD_KEY) || ""
  } catch {
    return ""
  }
}

function writeLastAuthMethod(method) {
  if (typeof window === "undefined") return
  try {
    window.localStorage.setItem(LAST_AUTH_METHOD_KEY, method)
  } catch {
    // Last-used hints are optional; blocked storage should not affect auth.
  }
}

function buildConnectRedirect(redirectUri, values) {
  try {
    const url = new URL(redirectUri)
    if (!isSafeHttpUrl(url)) return routeForPage("access")
    Object.entries(values || {}).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, value)
      }
    })
    return url.toString()
  } catch {
    return routeForPage("access")
  }
}

function normalizeOptionalHttpUrl(value, label) {
  const trimmed = String(value || "").trim()
  if (!trimmed) return ""
  try {
    const url = new URL(trimmed)
    if (!isSafeHttpUrl(url)) {
      throw new Error(`${label} must start with http:// or https://.`)
    }
    return url.toString()
  } catch (error) {
    if (error?.message?.includes("http://")) throw error
    throw new Error(`${label} must be a valid http:// or https:// URL.`)
  }
}

function sanitizeConnectRedirectParam(value) {
  const trimmed = String(value || "").trim()
  if (!trimmed) return ""
  try {
    const url = new URL(trimmed)
    return isSafeHttpUrl(url) ? url.toString() : ""
  } catch {
    return ""
  }
}

function isSafeHttpUrl(url) {
  return url?.protocol === "https:" || url?.protocol === "http:"
}

function getPasswordState(password, confirmPassword) {
  const checks = [
    { label: "At least 12 characters", ok: password.length >= 12 },
    { label: "One uppercase letter", ok: /[A-Z]/.test(password) },
    { label: "One lowercase letter", ok: /[a-z]/.test(password) },
    { label: "One number", ok: /\d/.test(password) },
    { label: "One special character", ok: /[^A-Za-z0-9]/.test(password) },
    { label: "Passwords match", ok: password.length > 0 && password === confirmPassword }
  ]
  const passedCount = checks.filter((check) => check.ok).length
  const percent = Math.round((passedCount / checks.length) * 100)
  const level = percent >= 100 ? "strong" : percent >= 67 ? "good" : percent >= 34 ? "fair" : "weak"
  const label = level === "strong" ? "Strong password" : level === "good" ? "Good password" : level === "fair" ? "Needs more strength" : "Weak password"
  const errors = checks.filter((check) => !check.ok).map((check) => check.label)
  return {
    checks,
    percent,
    level,
    label,
    errors,
    canSubmit: errors.length === 0
  }
}

function scrollElementIntoView(id, block = "start") {
  if (typeof window === "undefined") return
  if (id === "error-message") return
  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => {
      document.getElementById(id)?.scrollIntoView({
        behavior: "smooth",
        block
      })
    })
  })
}

createRoot(document.getElementById("root")).render(<App />)
