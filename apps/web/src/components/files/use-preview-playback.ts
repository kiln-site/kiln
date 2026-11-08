import * as React from "react"

import { forkPromise } from "@/effect/promise"
import { useRelayPreviewLink } from "@/lib/use-relay-preview-link"
import type { FileContentViewerProps } from "@/components/files/file-content-viewer"

/**
 * Playback of a file through a preview link. When the player fails, as
 * when its link expires and it seeks, it gets a fresh link once and picks
 * up where it was; a second failure means the browser can't play the file.
 */
export function usePreviewPlayback<TElement extends HTMLMediaElement>({
  displayPath,
  entry,
  instance,
}: Pick<FileContentViewerProps, "displayPath" | "entry" | "instance">) {
  const { link, renew } = useRelayPreviewLink({
    instanceId: instance.id,
    path: displayPath,
    relayId: instance.relayId,
    revision: entry.modifiedAt,
  })
  const revision = entry.modifiedAt
  const mediaRef = React.useRef<TElement>(null)
  // Each belongs to the revision it was found for, so a file replaced with
  // one that plays starts afresh rather than staying failed.
  const resume = React.useRef<{
    playing: boolean
    revision: number
    time: number
  } | null>(null)
  const renewedFor = React.useRef<number | null>(null)
  const [unplayableRevision, setUnplayableRevision] = React.useState<
    number | null
  >(null)
  const [metadata, setMetadata] = React.useState<{
    duration: number | null
    revision: number
  } | null>(null)
  const unplayable = unplayableRevision === revision
  const duration = metadata?.revision === revision ? metadata.duration : null

  const handlers = {
    onCanPlay: () => {
      // Playing again, so a later failure may renew once more.
      renewedFor.current = null
    },
    onError: () => {
      const media = mediaRef.current
      if (!media || renewedFor.current === revision) {
        setUnplayableRevision(revision)
        return
      }
      renewedFor.current = revision
      resume.current = {
        playing: !media.paused,
        revision,
        time: media.currentTime,
      }
      renew()
    },
    onLoadedMetadata: () => {
      const media = mediaRef.current
      if (!media) return
      setMetadata({
        duration: Number.isFinite(media.duration) ? media.duration : null,
        revision,
      })
      const position = resume.current
      resume.current = null
      if (position?.revision !== revision) return
      media.currentTime = position.time
      // A browser may refuse to resume without a gesture; the controls stay.
      if (position.playing) forkPromise(() => media.play())
    },
  }

  return { duration, handlers, link, mediaRef, unplayable }
}

export function formatDuration(seconds: number | null) {
  if (seconds === null) return null
  const whole = Math.round(seconds)
  const hours = Math.floor(whole / 3600)
  const minutes = Math.floor((whole % 3600) / 60)
  const rest = String(whole % 60).padStart(2, "0")
  return hours
    ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}`
    : `${minutes}:${rest}`
}
