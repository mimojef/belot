/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Meta Pixel ID (не е secret, но production стойността е deployment config — виж .env.example). */
  readonly VITE_META_PIXEL_ID?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
