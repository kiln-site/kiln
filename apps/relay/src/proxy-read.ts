import { relayProxyBrowserMetadataSchema } from "@workspace/contracts"
import type {
  RelayProxyBrowserMetadata,
  RelayProxyDiagnostics,
  RelayProxySettings,
} from "@workspace/contracts"

export type RelayProxyReadResult =
  | RelayProxyBrowserMetadata
  | {
      diagnostics: RelayProxyDiagnostics
      settings: RelayProxySettings
    }

export async function readRelayProxy(options: {
  browserOrigin: string
  includeDiagnostics: boolean
  loadDiagnostics: () => Promise<RelayProxyDiagnostics>
  settings: RelayProxySettings
}): Promise<RelayProxyReadResult> {
  if (!options.includeDiagnostics) {
    return relayProxyBrowserMetadataSchema.parse({
      browserOrigin: options.browserOrigin,
      mode: options.settings.mode,
    })
  }
  return {
    diagnostics: await options.loadDiagnostics(),
    settings: options.settings,
  }
}
