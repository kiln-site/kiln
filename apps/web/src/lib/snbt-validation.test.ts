import { describe, expect, it } from "vite-plus/test"

import {
  maxInlineSnbtValidationCharacters,
  snbtDiagnosticForEditor,
} from "./snbt-validation"

describe("SNBT editor validation", () => {
  it("reports diagnostics for interactive-size documents", () => {
    expect(snbtDiagnosticForEditor("{Health: }")).toMatchObject({
      line: 1,
    })
  })

  it("defers large documents to Relay validation", () => {
    const source = `{${" ".repeat(maxInlineSnbtValidationCharacters)}}`
    expect(snbtDiagnosticForEditor(source)).toBeNull()
  })
})
