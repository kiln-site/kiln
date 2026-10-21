import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@workspace/ui/components/dialog"

import type { App } from "@/components/app/app-presentation"
import { CodeDocumentPanel } from "@/components/code-document-panel"

// Every Docker label on one container, read-only in the code viewer, one
// `key=value` per line as in a Docker label file.
export function AppContainerLabelsDialog({
  container,
  onOpenChange,
}: {
  container: App["containers"][number]
  onOpenChange: (open: boolean) => void
}) {
  const content = Object.entries(container.labels)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n")
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-4xl">
        <DialogHeader className="sr-only">
          <DialogTitle>{container.service} labels</DialogTitle>
          <DialogDescription>
            The labels on the {container.service} service&apos;s container.
          </DialogDescription>
        </DialogHeader>
        <CodeDocumentPanel
          content={content}
          languagePath="labels.properties"
          noun="labels"
          title={`${container.service} labels`}
        />
      </DialogContent>
    </Dialog>
  )
}
