import * as React from "react"
import { Maximize, ZoomIn, ZoomOut } from "lucide-react"

import { Button } from "@workspace/ui/components/button"

import { EditorTooltip } from "@/components/files/editor-tooltip"
import type { FileContentViewerProps } from "@/components/files/file-content-viewer"
import {
  FileViewerFrame,
  FileViewerLoading,
  FileViewerUnavailable,
} from "@/components/files/file-viewer-frame"
import { FilePageContent } from "@/components/files/file-page-content"
import { fileFormatLabel, imageTypeForPath } from "@/lib/file-media-types"
import { formatBytes } from "@/lib/format-bytes"
import { useRelayFileUrl } from "@/lib/use-relay-file-url"

// Images are read whole into the page; larger ones are downloaded instead.
const MAX_IMAGE_BYTES = 64 * 1024 * 1024
const ZOOM_STEPS = [0.1, 0.25, 0.5, 1, 2, 4, 8, 16] as const

type Zoom = "fit" | number

/**
 * An image or animated GIF, read from the Relay. It opens fitted to the
 * view, never enlarged; zoomed past 100% it keeps hard pixel edges, as game
 * textures want.
 */
export function ImageViewer({
  displayPath,
  entry,
  instance,
  onTreeExpand,
  treeCollapsed,
}: FileContentViewerProps) {
  const tooLarge = entry.size !== null && entry.size > MAX_IMAGE_BYTES
  const image = useRelayFileUrl({
    instanceId: instance.id,
    maxBytes: MAX_IMAGE_BYTES,
    path: tooLarge ? null : displayPath,
    relayId: instance.relayId,
    revision: entry.modifiedAt,
    type: imageTypeForPath(displayPath) ?? "",
  })
  const [zoom, setZoom] = React.useState<Zoom>("fit")
  // What the browser made of the image, for the download it came from, so a
  // new revision starts afresh.
  const [decoded, setDecoded] = React.useState<{
    broken: boolean
    natural: { height: number; width: number } | null
    url: string
  } | null>(null)
  const url = image.status === "ready" ? image.url : null
  const current = decoded && decoded.url === url ? decoded : null
  const natural = current?.natural ?? null
  const broken = current?.broken ?? false
  const [viewport, setViewport] = React.useState({ height: 0, width: 0 })
  const viewportRef = React.useRef<HTMLDivElement>(null)

  React.useLayoutEffect(() => {
    const element = viewportRef.current
    if (!element) return
    const observer = new ResizeObserver(([observed]) => {
      if (!observed) return
      setViewport({
        height: observed.contentRect.height,
        width: observed.contentRect.width,
      })
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [image.status])

  const fitScale = natural
    ? Math.min(
        1,
        Math.max(viewport.width - 32, 1) / natural.width,
        Math.max(viewport.height - 32, 1) / natural.height
      )
    : 1
  const scale = zoom === "fit" ? fitScale : zoom
  const zoomBy = (direction: 1 | -1) => {
    const steps = direction > 0 ? ZOOM_STEPS : [...ZOOM_STEPS].reverse()
    const next = steps.find((step) =>
      direction > 0 ? step > scale + 0.001 : step < scale - 0.001
    )
    if (next !== undefined) setZoom(next)
  }

  const ready = image.status === "ready" && !broken
  const controls = ready ? (
    <div className="flex items-center gap-0.5" role="group" aria-label="Zoom">
      <EditorTooltip content="Zoom Out">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Zoom out"
          disabled={scale <= ZOOM_STEPS[0]}
          onClick={() => zoomBy(-1)}
        >
          <ZoomOut className="size-[17px]" />
        </Button>
      </EditorTooltip>
      <EditorTooltip content={zoom === "fit" ? "Actual Size" : "Fit to View"}>
        <Button
          type="button"
          variant={zoom === "fit" ? "ghost" : "secondary"}
          size="sm"
          className="h-8 min-w-14 px-2 font-mono text-xs"
          aria-label={zoom === "fit" ? "Show actual size" : "Fit to view"}
          onClick={() => setZoom(zoom === "fit" ? 1 : "fit")}
        >
          {zoom === "fit" ? (
            <Maximize className="size-3.5" />
          ) : (
            `${Math.round(scale * 100)}%`
          )}
        </Button>
      </EditorTooltip>
      <EditorTooltip content="Zoom In">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Zoom in"
          disabled={scale >= ZOOM_STEPS[ZOOM_STEPS.length - 1]}
          onClick={() => zoomBy(1)}
        >
          <ZoomIn className="size-[17px]" />
        </Button>
      </EditorTooltip>
    </div>
  ) : null

  const status = [
    natural ? `${natural.width} × ${natural.height}` : null,
    entry.size === null ? null : formatBytes(entry.size),
    fileFormatLabel(displayPath),
  ]
    .filter(Boolean)
    .join(" · ")

  return (
    <FileViewerFrame
      controls={controls}
      displayPath={displayPath}
      instance={instance}
      status={status}
      statusDetail={ready && natural ? `${Math.round(scale * 100)}%` : null}
      treeCollapsed={treeCollapsed}
      onTreeExpand={onTreeExpand}
    >
      {tooLarge ? (
        <FileViewerUnavailable
          message={`Images over ${formatBytes(MAX_IMAGE_BYTES)} aren't shown here. Download it to view it.`}
        />
      ) : image.status === "failed" ? (
        <FileViewerUnavailable message={image.message} />
      ) : broken ? (
        <FileViewerUnavailable message="Your browser can't show this image. Download it to view it." />
      ) : image.status === "loading" ? (
        <FileViewerLoading />
      ) : (
        <div
          ref={viewportRef}
          className="min-h-0 flex-1 overflow-auto [background:repeating-conic-gradient(var(--muted)_0_25%,transparent_0_50%)_0_0/16px_16px]"
        >
          <div className="grid min-h-full min-w-full place-items-center p-4">
            <img
              alt={displayPath.split("/").at(-1) ?? displayPath}
              className="block max-w-none"
              draggable={false}
              src={image.url}
              style={
                natural
                  ? {
                      height: natural.height * scale,
                      imageRendering: scale > 1 ? "pixelated" : "auto",
                      width: natural.width * scale,
                    }
                  : { visibility: "hidden" }
              }
              onError={() =>
                setDecoded({ broken: true, natural: null, url: image.url })
              }
              onLoad={(event) =>
                setDecoded({
                  broken: false,
                  natural: {
                    height: event.currentTarget.naturalHeight,
                    width: event.currentTarget.naturalWidth,
                  },
                  url: image.url,
                })
              }
            />
          </div>
          <FilePageContent
            path={displayPath}
            reached={natural !== null}
            view="image"
          />
        </div>
      )}
    </FileViewerFrame>
  )
}
