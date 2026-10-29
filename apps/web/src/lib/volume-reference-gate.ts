// While Hearth's database is being replaced, as by a Kiln import, the App
// configurations it would send Relays may not be the ones it holds after,
// so sending them waits (see volume-reference-hold.server).
let held: Promise<void> | null = null

/** Settles once nothing holds Hearth's volume references; null when nothing does. */
export function volumeReferencesHeld(): Promise<void> | null {
  return held
}

/** Holds them until the returned release runs, or refuses if already held. */
export function holdVolumeReferences(): () => void {
  if (held) throw new Error("Hearth's database is already being replaced")
  let release = () => undefined as void
  held = new Promise((resolve) => {
    release = resolve
  })
  return () => {
    held = null
    release()
  }
}
