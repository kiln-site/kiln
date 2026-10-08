interface ImportMetaEnv {
  readonly KILN_BUILD_SHA: string
  readonly KILN_RELEASE_NUMBER: string
  readonly KILN_VERSION: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
