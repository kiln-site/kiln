import { Option, Result, Schema } from "effect"

/**
 * The Relays an "Update all" holds back until Hearth runs the release they
 * update to. Hearth's update reloads the page, so this tab keeps them, and
 * the reloaded updater starts them.
 */

const storageKey = "kiln.system-update-after-hearth"
// A Hearth update finishes in minutes; one older than this was abandoned.
const maxAgeMs = 30 * 60_000

const RelaysAfterHearth = Schema.Struct({
  relayIds: Schema.Array(Schema.String),
  savedAt: Schema.Number,
  version: Schema.String,
})
type RelaysAfterHearth = typeof RelaysAfterHearth.Type

const decode = Schema.decodeUnknownOption(
  Schema.fromJsonString(RelaysAfterHearth)
)

export function saveRelaysAfterHearth(
  version: string,
  relayIds: ReadonlyArray<string>
): void {
  Result.try(() =>
    window.sessionStorage.setItem(
      storageKey,
      JSON.stringify({ relayIds, savedAt: Date.now(), version })
    )
  )
}

export function readRelaysAfterHearth(): RelaysAfterHearth | null {
  const stored = Result.getOrElse(
    Result.try(() => window.sessionStorage.getItem(storageKey)),
    () => null
  )
  if (stored === null) return null
  const saved = decode(stored)
  if (Option.isNone(saved) || Date.now() - saved.value.savedAt > maxAgeMs) {
    clearRelaysAfterHearth()
    return null
  }
  return saved.value
}

export function clearRelaysAfterHearth(): void {
  Result.try(() => window.sessionStorage.removeItem(storageKey))
}
