/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_AGENT_BASE?: string
  readonly VITE_AGENT_WS?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
