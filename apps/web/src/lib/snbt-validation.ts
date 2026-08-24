import type { SnbtDiagnostic } from "@workspace/contracts"
import { snbtDiagnostic } from "@workspace/contracts"

export const maxInlineSnbtValidationCharacters = 128 * 1024

export function snbtDiagnosticForEditor(
  source: string,
  options: { binaryCompatible?: boolean } = {}
): SnbtDiagnostic | null {
  if (source.length > maxInlineSnbtValidationCharacters) return null
  return snbtDiagnostic(source, options)
}
