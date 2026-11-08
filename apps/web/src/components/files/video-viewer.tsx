import * as React from "react"

import type { FileContentViewerProps } from "@/components/files/file-content-viewer"
import {
  FileViewerFrame,
  FileViewerLoading,
  FileViewerUnavailable,
} from "@/components/files/file-viewer-frame"
import { FilePageContent } from "@/components/files/file-page-content"
import {
  formatDuration,
  usePreviewPlayback,
} from "@/components/files/use-preview-playback"
import { fileFormatLabel } from "@/lib/file-media-types"
import { formatBytes } from "@/lib/format-bytes"

/**
 * A video in the browser's own player, streamed from the Relay through a
 * preview link so it starts at once and seeks without downloading it all.
 */
export function VideoViewer({
  displayPath,
  entry,
  instance,
  onTreeExpand,
  treeCollapsed,
}: FileContentViewerProps) {
  const { duration, handlers, link, mediaRef, unplayable } =
    usePreviewPlayback<HTMLVideoElement>({ displayPath, entry, instance })
  const [size, setSize] = React.useState<{
    height: number
    width: number
  } | null>(null)
  const status = [
    size ? `${size.width} × ${size.height}` : null,
    formatDuration(duration),
    entry.size === null ? null : formatBytes(entry.size),
    fileFormatLabel(displayPath),
  ]
    .filter(Boolean)
    .join(" · ")

  return (
    <FileViewerFrame
      displayPath={displayPath}
      instance={instance}
      status={status}
      treeCollapsed={treeCollapsed}
      onTreeExpand={onTreeExpand}
    >
      {link.status === "failed" ? (
        <FileViewerUnavailable message={link.message} />
      ) : unplayable ? (
        <FileViewerUnavailable message="This browser can't play this video. Download it to watch it." />
      ) : link.status === "loading" ? (
        <FileViewerLoading />
      ) : (
        <div className="grid min-h-0 flex-1 place-items-center bg-black">
          <video
            ref={mediaRef}
            className="max-h-full max-w-full"
            controls
            playsInline
            preload="metadata"
            src={link.url}
            {...handlers}
            onLoadedMetadata={(event) => {
              setSize({
                height: event.currentTarget.videoHeight,
                width: event.currentTarget.videoWidth,
              })
              handlers.onLoadedMetadata()
            }}
          />
          <FilePageContent
            path={displayPath}
            reached={size !== null}
            view="video"
          />
        </div>
      )}
    </FileViewerFrame>
  )
}
