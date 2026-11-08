import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { LoaderCircle } from "lucide-react"

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@workspace/ui/components/dialog"
import { cn } from "@workspace/ui/lib/utils"

import { serverDeploymentLogQueryOptions } from "@/lib/query-options"
import type { ServerDeploymentView } from "@/server/app-deployments.server"

// The log a game server's Relay kept of one install, reinstall, or change
// of Brick: each step it took and how it ended.

export const ServerDeploymentLogDialog = React.memo(
  function ServerDeploymentLogDialog({
    deployment,
    open,
    onOpenChange,
  }: {
    deployment: ServerDeploymentView
    open: boolean
    onOpenChange: (open: boolean) => void
  }) {
    const { data, error, isPending } = useQuery(
      serverDeploymentLogQueryOptions(deployment.instanceId, deployment.id)
    )
    const log = data?.log ?? null
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{deployment.serverName}</DialogTitle>
            <DialogDescription>
              {deployment.brickName ?? deployment.brickId ?? "Deployment"} on{" "}
              {deployment.relayName}
            </DialogDescription>
          </DialogHeader>
          {isPending ? (
            <div className="flex h-32 items-center justify-center text-muted-foreground">
              <LoaderCircle className="size-4 animate-spin" />
            </div>
          ) : !log ? (
            <p className="type-support py-6 text-center text-muted-foreground">
              {error?.message ?? data?.reason ?? "This log is no longer kept"}
            </p>
          ) : (
            <ol className="max-h-[60vh] overflow-auto rounded-md border bg-muted/30 p-3 font-mono text-xs leading-5">
              {log.lines.map((line) => (
                <li
                  key={line.id}
                  className={cn(
                    "flex gap-3 break-words whitespace-pre-wrap",
                    line.level === "error" && "text-destructive",
                    line.level === "warn" &&
                      "text-amber-700 dark:text-amber-300"
                  )}
                >
                  {line.timestamp ? (
                    <time
                      className="shrink-0 text-muted-foreground tabular-nums"
                      dateTime={line.timestamp}
                    >
                      {new Date(line.timestamp).toLocaleTimeString()}
                    </time>
                  ) : null}
                  <span className="min-w-0">{line.text}</span>
                </li>
              ))}
            </ol>
          )}
        </DialogContent>
      </Dialog>
    )
  }
)
