/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** LIFF app ID from the LINE Developers Console. Set in liff/.env */
  readonly VITE_LIFF_ID: string | undefined
  /**
   * Base URL of the API server, e.g. https://xxx.up.railway.app. Leave unset in
   * dev — vite.config.ts proxies /api/* to localhost:3000. Required in any
   * deploy where this app and server are on different origins.
   */
  readonly VITE_API_BASE_URL: string | undefined
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
