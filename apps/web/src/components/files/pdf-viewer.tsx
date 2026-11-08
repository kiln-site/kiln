import { ExternalLink } from "lucide-react"

import { Button } from "@workspace/ui/components/button"

import type { FileContentViewerProps } from "@/components/files/file-content-viewer"
import {
  FileViewerFrame,
  FileViewerLoading,
  FileViewerUnavailable,
} from "@/components/files/file-viewer-frame"
import { FilePageContent } from "@/components/files/file-page-content"
import { formatBytes } from "@/lib/format-bytes"
import { useRelayFileUrl } from "@/lib/use-relay-file-url"

// PDFs are read whole into the page; larger ones are downloaded instead.
const MAX_PDF_BYTES = 128 * 1024 * 1024

/**
 * A PDF in the browser's own viewer. The file is read through the same
 * proof-checked download as any other and handed to the viewer as an
 * object URL, so it works whether the Relay is reached directly or through
 * Hearth. Browsers without a built-in viewer offer to open or download it.
 */
export function PdfViewer({
  displayPath,
  entry,
  instance,
  onTreeExpand,
  treeCollapsed,
}: FileContentViewerProps) {
  const tooLarge = entry.size !== null && entry.size > MAX_PDF_BYTES
  const inline =
    typeof navigator === "undefined" || navigator.pdfViewerEnabled !== false
  const pdf = useRelayFileUrl({
    instanceId: instance.id,
    maxBytes: MAX_PDF_BYTES,
    path: tooLarge ? null : displayPath,
    relayId: instance.relayId,
    revision: entry.modifiedAt,
    type: "application/pdf",
  })
  const name = displayPath.split("/").at(-1) ?? displayPath
  return (
    <FileViewerFrame
      controls={
        pdf.status === "ready" ? (
          <Button
            asChild
            variant="ghost"
            size="sm"
            className="h-8 gap-1.5 px-2 text-xs"
          >
            <a href={pdf.url} rel="noopener" target="_blank">
              <ExternalLink className="size-3.5" />
              <span className="hidden sm:inline">Open in Tab</span>
            </a>
          </Button>
        ) : null
      }
      displayPath={displayPath}
      instance={instance}
      status={[entry.size === null ? null : formatBytes(entry.size), "PDF"]
        .filter(Boolean)
        .join(" · ")}
      treeCollapsed={treeCollapsed}
      onTreeExpand={onTreeExpand}
    >
      {tooLarge ? (
        <FileViewerUnavailable
          message={`PDFs over ${formatBytes(MAX_PDF_BYTES)} aren't shown here. Download it to read it.`}
        />
      ) : pdf.status === "failed" ? (
        <FileViewerUnavailable message={pdf.message} />
      ) : pdf.status === "loading" ? (
        <FileViewerLoading />
      ) : inline ? (
        <>
          <iframe
            className="min-h-0 w-full flex-1 border-0 bg-muted/20"
            src={pdf.url}
            title={name}
          />
          <FilePageContent path={displayPath} view="pdf" />
        </>
      ) : (
        <FileViewerUnavailable message="This browser has no built-in PDF viewer. Open it in a tab or download it to read it." />
      )}
    </FileViewerFrame>
  )
}
