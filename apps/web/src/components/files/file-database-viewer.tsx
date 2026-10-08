import * as React from "react"
import { Download, EllipsisVertical } from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@workspace/ui/components/popover"

import {
  DATABASE_QUERY_MAX_ROWS,
  type DatabaseSource,
} from "@/components/database-viewer/database-source"
import { DatabaseViewer } from "@/components/database-viewer/database-viewer"
import { FileActionMenuItem } from "@/components/files/file-actions"
import { FileDownloadDialog } from "@/components/files/file-download-dialog"
import {
  FileToolbarIdentity,
  FileTreeRevealButton,
} from "@/components/files/file-viewer-toolbar"
import type { InstanceWorkspaceInstance } from "@/lib/relay-selectors"
import {
  getRelayDatabaseOverview,
  getRelayDatabaseRows,
  mutateRelayDatabase,
  runRelayDatabaseQuery,
} from "@/server/relay"

const liveServerWarning = {
  detail:
    "Plugins may cache or overwrite rows while the server runs. Stop the server for reliable edits.",
  label: "Server running",
}

// A SQLite file inside a server, shown with the file workspace's toolbar.
export function FileDatabaseViewer({
  canWrite,
  displayPath,
  instance,
  onNotDatabase,
  onTreeExpand,
  treeCollapsed,
}: {
  canWrite: boolean
  displayPath: string
  instance: InstanceWorkspaceInstance
  onNotDatabase: () => void
  onTreeExpand: () => void
  treeCollapsed: boolean
}) {
  const source = React.useMemo(
    () =>
      relayFileDatabaseSource({
        canWrite,
        instanceId: instance.id,
        path: displayPath,
        relayId: instance.relayId,
      }),
    [canWrite, displayPath, instance.id, instance.relayId]
  )
  const handleUnavailable = React.useCallback(
    (message: string) => {
      if (message.includes("not a SQLite database")) onNotDatabase()
    },
    [onNotDatabase]
  )
  const identity = React.useCallback(
    ({ readOnly }: { readOnly: boolean | null }) => (
      <FileToolbarIdentity path={displayPath} readOnly={readOnly === true} />
    ),
    [displayPath]
  )
  const liveServer =
    instance.observedState === "running" ||
    instance.observedState === "starting"

  return (
    <DatabaseViewer
      editWarning={liveServer ? liveServerWarning : null}
      identity={identity}
      leading={
        treeCollapsed ? <FileTreeRevealButton onClick={onTreeExpand} /> : null
      }
      source={source}
      trailing={<DatabaseOverflowMenu instance={instance} path={displayPath} />}
      onUnavailable={handleUnavailable}
    />
  )
}

function DatabaseOverflowMenu({
  instance,
  path,
}: {
  instance: InstanceWorkspaceInstance
  path: string
}) {
  const [open, setOpen] = React.useState(false)
  const [downloadOpen, setDownloadOpen] = React.useState(false)
  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant={open ? "secondary" : "ghost"}
            size="icon"
            aria-label="More database actions"
            aria-expanded={open}
            title="More database actions"
          >
            <EllipsisVertical className="size-[18px]" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="end"
          side="bottom"
          sideOffset={7}
          collisionPadding={8}
          className="w-[min(17rem,calc(100vw-1rem))] p-1"
        >
          <p className="type-technical-label px-2 pt-1 pb-1.5 text-muted-foreground">
            Database actions
          </p>
          <FileActionMenuItem
            icon={<Download />}
            label="Download"
            detail="Preview size and compression"
            onClick={() => {
              setOpen(false)
              setDownloadOpen(true)
            }}
          />
        </PopoverContent>
      </Popover>
      <FileDownloadDialog
        instance={instance}
        open={downloadOpen}
        path={path}
        onOpenChange={setDownloadOpen}
      />
    </>
  )
}

function relayFileDatabaseSource({
  canWrite,
  instanceId,
  path,
  relayId,
}: {
  canWrite: boolean
  instanceId: string
  path: string
  relayId: string
}): DatabaseSource {
  const target = { instanceId, path, relayId }
  return {
    // Reading a file database with SQL is safe: SQLite opens it read-only.
    canQuery: true,
    canWrite,
    queryKey: ["relay", relayId, "instances", instanceId, "database", path],
    overview: () => getRelayDatabaseOverview({ data: target }),
    rows: (input) =>
      getRelayDatabaseRows({
        data: { ...target, request: { action: "rows", ...input } },
      }),
    query: (sql, write) =>
      runRelayDatabaseQuery({
        data: {
          ...target,
          request: { action: "query", maxRows: DATABASE_QUERY_MAX_ROWS, sql },
          write,
        },
      }),
    mutate: (table, changes) =>
      mutateRelayDatabase({
        data: { ...target, request: { action: "mutate", changes, table } },
      }),
  }
}
