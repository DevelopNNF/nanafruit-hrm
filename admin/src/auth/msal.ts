import {
  EventType,
  PublicClientApplication,
  type AccountInfo,
  type AuthenticationResult,
  type Configuration,
  type RedirectRequest,
} from '@azure/msal-browser'

function requireEnv(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(`${name} is not set — copy admin/.env.example to admin/.env`)
  }
  return value
}

/** The token request every call to our API makes. Exported so the API client and
 *  the sign-in gate ask for the same scope — two lists that can drift are two
 *  chances to hand back a token the server will not accept. */
export const apiRequest: RedirectRequest = {
  scopes: [requireEnv('VITE_ENTRA_API_SCOPE', import.meta.env.VITE_ENTRA_API_SCOPE)],
}

const config: Configuration = {
  auth: {
    clientId: requireEnv('VITE_ENTRA_CLIENT_ID', import.meta.env.VITE_ENTRA_CLIENT_ID),
    // Naming the tenant rather than /common is what makes this single-tenant:
    // an account from any other directory cannot even start the sign-in.
    authority: `https://login.microsoftonline.com/${requireEnv(
      'VITE_ENTRA_TENANT_ID',
      import.meta.env.VITE_ENTRA_TENANT_ID
    )}`,
    // Must match a redirect URI registered on the app registration exactly.
    // Deriving it from the origin means dev and prod need no separate build.
    redirectUri: window.location.origin,
    // Without this, signing out leaves the user on a Microsoft page. Same
    // registration requirement as redirectUri — it must be listed there too.
    // Unused when logout is stopped short by onRedirectNavigate below, but
    // still required by MSAL's config validation.
    postLogoutRedirectUri: window.location.origin,
    // MSAL calls this with the URL it's about to navigate to, for both login
    // and logout. Login must go through — that's the sign-in flow. Logout
    // must not: its target is Entra's tenant-wide end-session endpoint, which
    // tears down the *shared* AAD SSO cookie and signs the user out of
    // Outlook, the Azure portal, and anything else sharing this browser's
    // Microsoft session, not just this app. Returning false here only skips
    // that navigation — logoutRedirect has already cleared this app's local
    // MSAL cache by the time this runs, which is the whole of what "logged
    // out of HRM" needs to mean, since there's no server-side session to
    // invalidate either.
    onRedirectNavigate: (url) => !url.includes('/oauth2/v2.0/logout'),
  },
  cache: {
    // sessionStorage, not localStorage: closing the tab ends the session, and
    // the tokens are not readable by another tab that happens to share the
    // origin. The cost is a silent SSO round trip when opening a new tab, which
    // is invisible to the user and worth it for an app holding staff records.
    cacheLocation: 'sessionStorage',
  },
}

// Created inside initMsal rather than at module scope so that a missing env var
// throws somewhere main.tsx can catch it and render an explanation, instead of
// dying during module evaluation and leaving a blank page.
let instance: PublicClientApplication | null = null

export async function initMsal(): Promise<PublicClientApplication> {
  const created = new PublicClientApplication(config)
  await created.initialize()

  // A cached account from an earlier visit. MsalProvider completes any pending
  // redirect on mount, so this only covers the already-signed-in case.
  const cached = created.getAllAccounts()[0]
  if (!created.getActiveAccount() && cached) {
    created.setActiveAccount(cached)
  }

  // Keeps MSAL's own notion of "the current account" current. Nothing in this
  // app reads it without a fallback — see getSignedInAccount — because this
  // fires on its own schedule, a beat behind the render that follows a redirect.
  created.addEventCallback((event) => {
    if (event.eventType === EventType.LOGIN_SUCCESS && event.payload) {
      const { account } = event.payload as AuthenticationResult
      if (account) created.setActiveAccount(account)
    }
  })

  instance = created
  return created
}

/**
 * The signed-in account, or null if there is none.
 *
 * Falls back to the first cached account rather than trusting the active one,
 * because those are two different guarantees. AuthGate renders its children as
 * soon as getAllAccounts() is non-empty — that is msal-react's whole test for
 * "authenticated", and MsalProvider never sets an active account. Setting it is
 * left to the LOGIN_SUCCESS callback above, which lands *after* that first
 * render on the pass that returns from a redirect. Asking for the list is
 * asking for exactly what AuthGate promised; asking for the active account is
 * asking for more than anything guarantees, and loses the race once per login.
 */
export function getSignedInAccount(): AccountInfo | null {
  const msal = getMsalInstance()
  return msal.getActiveAccount() ?? msal.getAllAccounts()[0] ?? null
}

/**
 * The instance, for code outside the React tree — the API client, which needs a
 * token but has no hook to get one from.
 */
export function getMsalInstance(): PublicClientApplication {
  if (!instance) throw new Error('initMsal() has not finished')
  return instance
}
