/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** LIFF app ID from the LINE Developers Console. Set in liff/.env */
  readonly VITE_LIFF_ID: string | undefined
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
