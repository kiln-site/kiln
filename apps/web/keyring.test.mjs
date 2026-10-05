import assert from "node:assert/strict"
import { test } from "vite-plus/test"

import {
  decryptWithKeyring,
  encryptWithKeyring,
  parseSecretKeyring,
} from "./keyring.mjs"

const oldSecret = "old-secret-abcdefghijklmnopqrstuvwxyz-123456"
const newSecret = "new-secret-abcdefghijklmnopqrstuvwxyz-654321"

test("parses an ordered versioned keyring", () => {
  assert.deepEqual(parseSecretKeyring(`2:${newSecret},1:${oldSecret}`), [
    { version: 2, value: newSecret },
    { version: 1, value: oldSecret },
  ])
})

test("rejects missing, short, malformed, and duplicate secrets", () => {
  assert.throws(() => parseSecretKeyring(undefined), /is required/u)
  assert.throws(() => parseSecretKeyring("1:short"), /at least 32/u)
  assert.throws(() => parseSecretKeyring(oldSecret), /<version>:<secret>/u)
  assert.throws(
    () => parseSecretKeyring(`1:${oldSecret},1:${newSecret}`),
    /duplicate version 1/u
  )
})

test("decrypts old ciphertext after rotation and marks it for re-encryption", () => {
  const purpose = "relay-credential"
  const oldKeyring = parseSecretKeyring(`1:${oldSecret}`)
  const rotatedKeyring = parseSecretKeyring(`2:${newSecret},1:${oldSecret}`)
  const oldCiphertext = encryptWithKeyring(
    "relay-token-value",
    oldKeyring,
    purpose
  )

  assert.match(oldCiphertext, /^v1\.1\./u)
  assert.deepEqual(decryptWithKeyring(oldCiphertext, rotatedKeyring, purpose), {
    needsRotation: true,
    plaintext: "relay-token-value",
    version: 1,
  })

  const rotatedCiphertext = encryptWithKeyring(
    "relay-token-value",
    rotatedKeyring,
    purpose
  )
  assert.match(rotatedCiphertext, /^v1\.2\./u)
  assert.deepEqual(
    decryptWithKeyring(rotatedCiphertext, rotatedKeyring, purpose),
    {
      needsRotation: false,
      plaintext: "relay-token-value",
      version: 2,
    }
  )
})

test("rejects missing keys, tampering, and use under another purpose", () => {
  const oldKeyring = parseSecretKeyring(`1:${oldSecret}`)
  const newKeyring = parseSecretKeyring(`2:${newSecret}`)
  const ciphertext = encryptWithKeyring(
    "relay-token-value",
    oldKeyring,
    "relay-credential"
  )
  const tamperedParts = ciphertext.split(".")
  const tag = tamperedParts[3]
  tamperedParts[3] = `${tag.startsWith("A") ? "B" : "A"}${tag.slice(1)}`
  const tamperedCiphertext = tamperedParts.join(".")

  assert.throws(
    () => decryptWithKeyring(ciphertext, newKeyring, "relay-credential"),
    /unavailable key version 1/u
  )
  assert.throws(
    () =>
      decryptWithKeyring(
        tamperedCiphertext,
        oldKeyring,
        "relay-credential"
      ),
    /authenticate data|Unsupported state/u
  )
  assert.throws(
    () => decryptWithKeyring(ciphertext, oldKeyring, "another-purpose"),
    /authenticate data|Unsupported state/u
  )
})
