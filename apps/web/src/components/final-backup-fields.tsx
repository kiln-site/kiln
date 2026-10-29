import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { Archive } from "lucide-react"

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select"

import { backupStorageQueryOptions } from "@/lib/query-options"

/**
 * Whether a deletion takes a final backup first, and where it goes: the
 * target's default destination, the Relay's own disk, or a destination of
 * the viewer's. `destination` is "default", "local", or a destination's ID.
 */
export const FinalBackupFields = React.memo(function FinalBackupFields({
  available = true,
  createBackup,
  destination,
  hint,
  label,
  open,
  pending,
  unavailable,
  onCreateBackupChange,
  onDestinationChange,
}: {
  available?: boolean
  createBackup: boolean
  destination: string
  /** What the backup holds, when that needs saying. */
  hint?: string
  label: string
  open: boolean
  pending: boolean
  /** Why no backup can be taken, when `available` is false. */
  unavailable?: string
  onCreateBackupChange: (createBackup: boolean) => void
  onDestinationChange: (destination: string) => void
}) {
  const backupStorage = useQuery({
    ...backupStorageQueryOptions(),
    enabled: open && available && createBackup,
  })
  const availableStorage = React.useMemo(
    () =>
      (backupStorage.data ?? []).filter(
        (candidate) => candidate.enabled && !candidate.deleting
      ),
    [backupStorage.data]
  )

  return (
    <div className="grid gap-3 rounded-lg border border-border/80 bg-background/45 p-3">
      <label
        className={`flex items-start gap-3 ${
          available ? "cursor-pointer" : "cursor-not-allowed opacity-60"
        }`}
      >
        <input
          aria-label={label}
          checked={createBackup}
          className="mt-0.5 size-4 rounded-[3px] border-input accent-primary"
          disabled={!available || pending}
          type="checkbox"
          onChange={(event) =>
            onCreateBackupChange(event.currentTarget.checked)
          }
        />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2 text-sm font-medium">
            <Archive className="size-4 text-muted-foreground" />
            {label}
          </span>
          {available ? (
            hint ? (
              <span className="type-meta mt-1 block text-muted-foreground">
                {hint}
              </span>
            ) : null
          ) : (
            <span className="type-meta mt-1 block text-muted-foreground">
              {unavailable}
            </span>
          )}
        </span>
      </label>

      <label className="grid gap-1.5 border-t border-border/70 pt-3">
        <span className="type-technical-label text-muted-foreground">
          Backup destination
        </span>
        <Select
          disabled={!available || !createBackup || pending}
          value={destination}
          onValueChange={onDestinationChange}
        >
          <SelectTrigger
            aria-label="Backup destination"
            className="h-9 w-full bg-background"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="min-w-(--radix-select-trigger-width)">
            <SelectItem value="default">
              Default · Preferred destination
            </SelectItem>
            <SelectItem value="local">Local Relay</SelectItem>
            {availableStorage.map((candidate) => (
              <SelectItem key={candidate.id} value={candidate.id}>
                S3 · {candidate.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </label>
    </div>
  )
})
