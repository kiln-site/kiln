// A mount being written, before it's saved.

export type DraftSource =
  | { type: "file"; content: string }
  | { type: "host"; path: string }
  // A volume this doesn't have an ID for yet is made when it's saved, so
  // cancelling leaves nothing behind.
  | { name: string; type: "volume"; volumeId: string | null }

export interface MountDraft {
  id: string
  readOnly: boolean
  service: string | null
  source: DraftSource
  target: string
}

/**
 * Every draft of a volume just made, which share it: drafts naming the same
 * new volume mean the same volume, and saving again after a failure must find
 * them all done rather than make it twice.
 */
export function withMadeVolume(
  drafts: ReadonlyArray<MountDraft>,
  name: string,
  volumeId: string
): ReadonlyArray<MountDraft> {
  return drafts.map((draft) =>
    draft.source.type === "volume" &&
    !draft.source.volumeId &&
    draft.source.name.trim() === name
      ? { ...draft, source: { name, type: "volume", volumeId } }
      : draft
  )
}
