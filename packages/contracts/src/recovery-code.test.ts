import { describe, expect, it } from "vite-plus/test"

import { decodeRecoveryCode, encodeRecoveryCode } from "./recovery-code"

// A recovery code is read back years later, typed, pasted or piped one line
// at a time, so every key it can hold comes back exactly.
describe("recovery codes", () => {
  it("give back every platform backup key on one line", () => {
    for (const key of [
      "Yq0sR3f_kLm9-ZtV7wXc2Bn5Hj8Pd4Ga6Ue1Oi0Kr3",
      "a passphrase with spaces that is long enough",
      "line one\nline two of a key someone pasted in",
      "ключ резервного копирования с юникодом внутри",
      "k".repeat(4096),
    ]) {
      const code = encodeRecoveryCode(key)
      expect(code).not.toMatch(/\s/u)
      expect(decodeRecoveryCode(`  ${code}\n`)).toBe(key)
    }
  })

  it("aren't anything else", () => {
    for (const text of [
      "",
      "kiln-rk-",
      "kiln-rkb-",
      "kiln-rkb-not base64!",
      "kiln-rkb-_w",
      "rk-Yq0sR3f_kLm9",
    ]) {
      expect(decodeRecoveryCode(text)).toBeNull()
    }
  })
})
