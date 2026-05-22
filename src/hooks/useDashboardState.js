import { useMemo, useReducer } from "react"

export const initialDashboardState = {
  user: null,
  apps: [],
  apiKeys: [],
  consents: [],
  featureConnections: [],
  status: "Checking Dashboard.",
  error: "",
  canRetryDashboard: false
}

export function dashboardReducer(state, action) {
  switch (action.type) {
    case "status":
      return { ...state, status: action.status }
    case "error":
      return { ...state, error: action.error }
    case "retry":
      return { ...state, canRetryDashboard: action.canRetryDashboard }
    case "synced":
      return {
        ...state,
        user: action.user,
        apps: action.apps,
        apiKeys: action.apiKeys,
        consents: action.consents,
        featureConnections: action.featureConnections || [],
        error: "",
        status: "Dashboard synced.",
        canRetryDashboard: false
      }
    case "failed":
      return {
        ...state,
        error: action.message,
        status: action.status,
        canRetryDashboard: true
      }
    case "reset-data":
      return {
        ...state,
        user: null,
        apps: [],
        apiKeys: [],
        consents: [],
        featureConnections: [],
        error: "",
        canRetryDashboard: false
      }
    default:
      return state
  }
}

export function useDashboardState() {
  const [state, dispatch] = useReducer(dashboardReducer, initialDashboardState)
  const actions = useMemo(() => ({
    setStatus(status) {
      dispatch({ type: "status", status })
    },
    setError(error) {
      dispatch({ type: "error", error })
    },
    setCanRetryDashboard(canRetryDashboard) {
      dispatch({ type: "retry", canRetryDashboard })
    },
    sync({ user, apps, apiKeys, consents, featureConnections }) {
      dispatch({ type: "synced", user, apps, apiKeys, consents, featureConnections })
    },
    fail({ message, status }) {
      dispatch({ type: "failed", message, status })
    },
    resetData() {
      dispatch({ type: "reset-data" })
    }
  }), [])

  return [state, actions]
}

export async function refreshDashboard(client, session, actions, getAccessStatus) {
  actions.setCanRetryDashboard(false)
  try {
    const [me, dashboard] = await Promise.all([
      client.me(session),
      client.dashboard(session)
    ])
    actions.sync({
      user: me.user,
      apps: dashboard.apps || [],
      apiKeys: dashboard.api_keys || [],
      consents: dashboard.consents || [],
      featureConnections: dashboard.feature_connections || []
    })
  } catch (error) {
    actions.fail(getAccessStatus(error))
  }
}
