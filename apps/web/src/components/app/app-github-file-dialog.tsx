import { useQuery } from "@tanstack/react-query"
import { LoaderCircle } from "lucide-react"

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@workspace/ui/components/dialog"

import type { App } from "@/components/app/app-presentation"
import { CodeDocumentPanel } from "@/components/code-document-panel"
import { appGitHubSourceFileQueryOptions } from "@/lib/query-options"
import type { AppGitHubSourceView } from "@/server/app-deployments.server"

// The Dockerfile or Compose file a GitHub app deploys, read-only, as its
// branch has it now. The toolbar opens it on GitHub.
export function AppGitHubFileDialog({
  app,
  source,
  onOpenChange,
}: {
  app: App
  source: AppGitHubSourceView
  onOpenChange: (open: boolean) => void
}) {
  const file = useQuery(
    appGitHubSourceFileQueryOptions(app.relayId, app.id, source)
  )
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-5xl">
        <DialogHeader className="sr-only">
          <DialogTitle>{source.path}</DialogTitle>
          <DialogDescription>
            {source.path} in {source.repository} on {source.branch}.
          </DialogDescription>
        </DialogHeader>
        {file.data ? (
          <CodeDocumentPanel
            content={file.data.content}
            languagePath={source.path}
            noun={source.build === "compose" ? "Compose file" : "Dockerfile"}
            sourceLabel="View on GitHub"
            sourceUrl={file.data.url}
            title={`${source.path} · ${source.branch}`}
          />
        ) : (
          <div className="grid h-[min(72dvh,42rem)] min-h-80 place-items-center bg-card px-6 text-center text-xs">
            {file.isError ? (
              <span className="text-destructive">{file.error.message}</span>
            ) : (
              <LoaderCircle className="size-4 animate-spin text-muted-foreground" />
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
