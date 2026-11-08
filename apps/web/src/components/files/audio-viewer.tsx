import { AudioLines } from "lucide-react"

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
 * An audio file in the browser's own player, streamed from the Relay
 * through a preview link, as video is.
 */
export function AudioViewer({
  displayPath,
  entry,
  instance,
  onTreeExpand,
  treeCollapsed,
}: FileContentViewerProps) {
  const { duration, handlers, link, mediaRef, unplayable } =
    usePreviewPlayback<HTMLAudioElement>({ displayPath, entry, instance })
  const name = displayPath.split("/").at(-1) ?? displayPath
  const status = [
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
        <FileViewerUnavailable message="This browser can't play this audio. Download it to listen to it." />
      ) : link.status === "loading" ? (
        <FileViewerLoading />
      ) : (
        <div className="grid min-h-0 flex-1 place-items-center px-6">
          <div className="w-full max-w-md border bg-muted/10 p-5">
            <div className="mb-4 flex min-w-0 items-center gap-3">
              <div className="grid size-11 shrink-0 place-items-center border bg-primary/8 text-primary-ink">
                <AudioLines className="size-5" />
              </div>
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold">{name}</p>
                <p className="type-meta font-mono text-muted-foreground">
                  {formatDuration(duration) ?? "—"}
                </p>
              </div>
            </div>
            <audio
              ref={mediaRef}
              className="w-full"
              controls
              preload="metadata"
              src={link.url}
              {...handlers}
            />
          </div>
          <FilePageContent
            path={displayPath}
            reached={duration !== null}
            view="audio"
          />
        </div>
      )}
    </FileViewerFrame>
  )
}
