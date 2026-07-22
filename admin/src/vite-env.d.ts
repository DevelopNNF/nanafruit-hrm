/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Directory (tenant) ID of the Entra app registration. Set in admin/.env */
  readonly VITE_ENTRA_TENANT_ID: string | undefined
  /** Application (client) ID of the same registration. Set in admin/.env */
  readonly VITE_ENTRA_CLIENT_ID: string | undefined
  /** The API scope to ask for, e.g. api://<client-id>/access_as_user */
  readonly VITE_ENTRA_API_SCOPE: string | undefined
  /**
   * Base URL of the API server, e.g. https://xxx.up.railway.app. Leave unset in
   * dev — vite.config.ts proxies /api/* to localhost:3000. Required in any
   * deploy where admin and server are on different origins.
   */
  readonly VITE_API_BASE_URL: string | undefined
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
