import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { FileCode2, LoaderCircle } from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@workspace/ui/components/dialog"
import { cn } from "@workspace/ui/lib/utils"

import { CodeDocumentPanel } from "@/components/code-document-panel"
import { useRelayPermission } from "@/components/relay/relay-settings"
import { relayTraefikConfigurationQueryOptions } from "@/lib/query-options"
import { warmSyntaxCodeEditorModule } from "@/lib/syntax-editor-module-preload"

// The bundled Traefik's files, read-only in a dialog like a Brick recipe.
// Fetched only while the dialog is open.
export function RelayTraefikConfigButton({ relayId }: { relayId: string }) {
  const canRead = useRelayPermission(relayId, "instance.network.read")
  const [open, setOpen] = React.useState(false)
  if (!canRead) return null
  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        onClick={() => {
          warmSyntaxCodeEditorModule()
          setOpen(true)
        }}
      >
        <FileCode2 />
        Traefik config
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-4xl">
          <DialogHeader className="sr-only">
            <DialogTitle>Traefik configuration</DialogTitle>
            <DialogDescription>
              The files this Relay generates for its bundled Traefik.
            </DialogDescription>
          </DialogHeader>
          {open ? <TraefikConfiguration relayId={relayId} /> : null}
        </DialogContent>
      </Dialog>
    </>
  )
}

const files = [
  { id: "dynamic", name: "dynamic/kiln.yaml" },
  { id: "static", name: "traefik.yml" },
] as const

function TraefikConfiguration({ relayId }: { relayId: string }) {
  const configuration = useQuery(relayTraefikConfigurationQueryOptions(relayId))
  const [selected, setSelected] =
    React.useState<(typeof files)[number]["id"]>("dynamic")

  if (configuration.isPending) {
    return (
      <div className="grid h-[min(72dvh,42rem)] min-h-80 place-items-center bg-card text-muted-foreground">
        <LoaderCircle className="size-4 animate-spin" />
      </div>
    )
  }
  const content = configuration.data
    ? selected === "dynamic"
      ? configuration.data.dynamicConfiguration
      : configuration.data.staticConfiguration
    : null
  if (content === null) {
    return (
      <div className="grid h-[min(72dvh,42rem)] min-h-80 place-items-center bg-card px-6 text-center text-xs text-destructive">
        {configuration.error?.message ||
          "This Relay only generates Traefik files for its bundled Traefik."}
      </div>
    )
  }
  const file = files.find(({ id }) => id === selected) ?? files[0]
  return (
    <CodeDocumentPanel
      key={file.id}
      actions={
        <div
          role="tablist"
          aria-label="Configuration file"
          className="mr-1 flex border bg-background/60 p-0.5"
        >
          {files.map(({ id, name }) => (
            <button
              key={id}
              role="tab"
              type="button"
              aria-selected={id === file.id}
              className={cn(
                "type-control-sm px-2.5 py-1 font-mono transition-colors",
                id === file.id
                  ? "bg-primary/15 text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              )}
              onClick={() => setSelected(id)}
            >
              {name}
            </button>
          ))}
        </div>
      }
      content={content}
      languagePath={file.name}
      noun="configuration"
      title="Traefik configuration"
    />
  )
}
