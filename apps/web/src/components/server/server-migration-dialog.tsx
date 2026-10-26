import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  Activity,
  Archive,
  ArrowRightLeft,
  CircleAlert,
  Copy,
  Globe,
  LoaderCircle,
  Route,
  Square,
  Trash2,
  Users,
} from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@workspace/ui/components/dialog"
import { Input } from "@workspace/ui/components/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select"
import { cn } from "@workspace/ui/lib/utils"

import { backupStorageQueryOptions } from "@/lib/query-options"
import { migrationRoomProblems } from "@/lib/server-migration-room"
import {
  serverMigrationPreviewQueryOptions,
  serverMigrationsQueryOptions,
} from "@/lib/server-migration-queries"
import type {
  ServerMigrationDestination,
  ServerMigrationPreview,
} from "@/server/server-migrations.server"
import { startServerMigration } from "@/server/server-migrations"

export type ServerMigrationMode = "duplicate" | "migrate"

const NO_RELAY = "__none__"
const NAME_LIMIT = 32

/**
 * Copies a game server to a new one: a duplicate on any Relay the person
 * may create servers on, or a move to another Relay. It starts the copy and
 * closes; the copy carries on in the background with a progress toast.
 */
export function ServerMigrationDialog({
  initialMode,
  onOpenChange,
  open,
  server,
}: {
  initialMode: ServerMigrationMode
  onOpenChange: (open: boolean) => void
  open: boolean
  server: { id: string; name: string; relayId: string }
}) {
  const preview = useQuery({
    ...serverMigrationPreviewQueryOptions({
      instanceId: server.id,
      relayId: server.relayId,
    }),
    enabled: open,
  })
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <div className="mb-2 flex size-9 items-center justify-center rounded-lg border border-primary/25 bg-primary/10 text-primary-ink">
            <ArrowRightLeft className="size-4" />
          </div>
          <DialogTitle>Move or duplicate {server.name}</DialogTitle>
          <DialogDescription>
            The copy is a new server with its own ID. Its files and settings
            come along; choose what else does.
          </DialogDescription>
        </DialogHeader>
        {preview.isPending ? (
          <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
            <LoaderCircle className="size-4 animate-spin" />
            Checking where this server can go…
          </div>
        ) : preview.isError ? (
          <Callout tone="error">{preview.error.message}</Callout>
        ) : (
          <MigrationForm
            initialMode={initialMode}
            preview={preview.data}
            server={server}
            onDone={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

function MigrationForm({
  initialMode,
  onDone,
  preview,
  server,
}: {
  initialMode: ServerMigrationMode
  onDone: () => void
  preview: ServerMigrationPreview
  server: { id: string; name: string; relayId: string }
}) {
  const queryClient = useQueryClient()
  const [mode, setMode] = React.useState(initialMode)
  const destinations = React.useMemo(
    () =>
      preview.destinations.filter(
        (destination) => mode === "duplicate" || !destination.current
      ),
    [mode, preview.destinations]
  )
  const [backup, setBackup] = React.useState(false)
  const [backupDestination, setBackupDestination] = React.useState("default")
  // Whether the copy fits there, as the Relays said when the dialog opened.
  // Checked again when it starts and before the server stops.
  const roomProblemsFor = (destination: ServerMigrationDestination) =>
    destination.room && preview.room
      ? migrationRoomProblems({
          destination: destination.room,
          limits: true,
          localBackups:
            backup &&
            (backupDestination === "local" ||
              (backupDestination === "default" &&
                preview.room.defaultBackupLocal))
              ? 1
              : 0,
          server: preview.room.server,
          source: preview.room.source,
        })
      : []
  const [relayId, setRelayId] = React.useState<string | null>(null)
  const selected =
    destinations.find((destination) => destination.id === relayId) ??
    defaultDestination(
      destinations,
      mode,
      (destination) =>
        !destination.problems.length && !roomProblemsFor(destination).length
    )
  const [name, setName] = React.useState<string | null>(null)
  const effectiveName =
    name ?? defaultName(server.name, mode, selected?.takenNames ?? [])
  const [copyAccess, setCopyAccess] = React.useState(
    preview.allowed.copyAccess && preview.accessCount > 0
  )
  const [keepActivity, setKeepActivity] = React.useState(true)
  const [linkBackups, setLinkBackups] = React.useState(true)
  const [moveDomain, setMoveDomain] = React.useState(
    preview.domains.managed && preview.domains.names.length > 0
  )
  const [moveWebRoutes, setMoveWebRoutes] = React.useState(
    preview.webRoutes.length > 0 && preview.allowed.network
  )
  const [stopSource, setStopSource] = React.useState(
    preview.source.running && preview.allowed.power
  )
  const [deleteSource, setDeleteSource] = React.useState(false)
  const [deleteDestination, setDeleteDestination] = React.useState("default")
  const deleting = mode === "migrate" && deleteSource && preview.allowed.delete
  const backupStorage = useQuery({
    ...backupStorageQueryOptions(),
    enabled: backup || deleting,
  })
  const start = useMutation({
    mutationFn: () => {
      if (!selected) throw new Error("Choose a Relay")
      return startServerMigration({
        data: {
          destinationRelayId: selected.id,
          instanceId: server.id,
          mode,
          name: effectiveName.trim(),
          options: {
            backup: backup ? storageChoice(backupDestination) : null,
            copyAccess,
            deleteSource: deleting ? storageChoice(deleteDestination) : null,
            keepActivity,
            linkBackups: linkBackups && linkableBackups > 0,
            moveDomain: mode === "migrate" && moveDomain,
            moveWebRoutes: mode === "migrate" && moveWebRoutes,
            stopSource: mode === "migrate" || stopSource,
          },
          relayId: server.relayId,
        },
      })
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: serverMigrationsQueryOptions().queryKey,
      })
      onDone()
    },
  })
  const pending = start.isPending
  const trimmedName = effectiveName.trim()
  const nameTaken = selected?.takenNames.includes(trimmedName) ?? false
  const roomProblems = selected ? roomProblemsFor(selected) : []
  const blocked =
    !selected ||
    selected.problems.length > 0 ||
    roomProblems.length > 0 ||
    !trimmedName ||
    nameTaken ||
    preview.source.provisioning ||
    (mode === "migrate" && !preview.allowed.stop)
  const linkableBackups =
    selected && selected.linksBackups && preview.allowed.linkBackups
      ? selected.current
        ? preview.backups.here
        : preview.backups.anywhere
      : 0
  const archMismatch =
    selected?.nodeArch &&
    preview.source.nodeArch &&
    selected.nodeArch !== preview.source.nodeArch

  return (
    <form
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault()
        if (!blocked) start.mutate()
      }}
    >
      <div
        role="radiogroup"
        aria-label="What to do"
        className="grid grid-cols-2 gap-1 rounded-lg border bg-background/45 p-1"
      >
        <ModeButton
          active={mode === "duplicate"}
          icon={<Copy />}
          label="Duplicate"
          detail="Keep this server"
          onSelect={() => setMode("duplicate")}
        />
        <ModeButton
          active={mode === "migrate"}
          icon={<ArrowRightLeft />}
          label="Move"
          detail="To another Relay"
          onSelect={() => setMode("migrate")}
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="grid gap-1.5">
          <span className="type-technical-label text-muted-foreground">
            {mode === "migrate" ? "Move to" : "Copy to"}
          </span>
          <Select
            value={selected?.id ?? NO_RELAY}
            onValueChange={(value) => {
              if (value !== NO_RELAY) setRelayId(value)
            }}
            disabled={pending}
          >
            <SelectTrigger
              aria-label="Relay"
              className="h-9 w-full bg-background"
            >
              <SelectValue placeholder="Choose a Relay" />
            </SelectTrigger>
            <SelectContent className="min-w-(--radix-select-trigger-width)">
              {destinations.length === 0 ? (
                <SelectItem value={NO_RELAY} disabled>
                  No Relay available
                </SelectItem>
              ) : (
                destinations.map((destination) => (
                  <SelectItem key={destination.id} value={destination.id}>
                    {destination.name}
                    {destination.current ? " · this Relay" : ""}
                    {destination.problems.length
                      ? " · unavailable"
                      : roomProblemsFor(destination).length
                        ? " · not enough room"
                        : ""}
                  </SelectItem>
                ))
              )}
            </SelectContent>
          </Select>
        </label>
        <label className="grid gap-1.5">
          <span className="type-technical-label text-muted-foreground">
            New server's name
          </span>
          <Input
            aria-label="New server's name"
            aria-invalid={nameTaken}
            className="h-9 bg-background"
            disabled={pending}
            maxLength={NAME_LIMIT}
            value={effectiveName}
            onChange={(event) => setName(event.currentTarget.value)}
          />
        </label>
      </div>

      {destinations.length === 0 ? (
        <Callout tone="warning">
          {mode === "migrate"
            ? "There's no other Relay you can create game servers on. Add a Relay, or ask its owner for access to create servers there."
            : "There's no Relay you can create game servers on. Ask a Relay's owner for access to create servers there."}
        </Callout>
      ) : null}
      {nameTaken && selected ? (
        <p className="-mt-2 text-xs text-destructive">
          A server on {selected.name} is already named {trimmedName}.
        </p>
      ) : null}
      {selected?.problems.map((problem) => (
        <Callout key={`${problem.code}:${problem.relayId}`} tone="error">
          <span className="font-medium">{problem.message}.</span>{" "}
          {problem.remedy}.
        </Callout>
      ))}
      {roomProblems.map((problem) => (
        <Callout key={`${problem.code}:${problem.relayId}`} tone="error">
          {problem.message}.
        </Callout>
      ))}
      {archMismatch && selected ? (
        <Callout tone="warning">
          {selected.name} runs {selected.nodeArch}, and this server runs on{" "}
          {preview.source.nodeArch}. Its Brick's image must support both for the
          copy to start.
        </Callout>
      ) : null}

      <fieldset className="grid gap-3 rounded-lg border border-border/80 bg-background/45 p-3">
        <legend className="type-technical-label px-1 text-muted-foreground">
          Bring along
        </legend>
        <OptionRow
          checked
          disabled
          icon={<Archive />}
          label="Files and settings"
          detail="Always copied: everything in its folder, its Brick, startup settings, and limits."
        />
        <OptionRow
          checked={copyAccess}
          disabled={
            pending || !preview.allowed.copyAccess || preview.accessCount === 0
          }
          icon={<Users />}
          label={
            preview.accessCount === 0
              ? "People with access"
              : preview.accessCount === 1
                ? "The person with access"
                : `The ${preview.accessCount} people with access`
          }
          detail={
            !preview.allowed.copyAccess
              ? "You can't see who has access to this server."
              : preview.accessCount === 0
                ? "Only its owner can reach it now."
                : "They get the same permissions on the new server."
          }
          onChange={setCopyAccess}
        />
        <BackupsOption
          allowed={preview.allowed.linkBackups}
          checked={linkBackups && linkableBackups > 0}
          destination={selected}
          disabled={pending}
          linkable={linkableBackups}
          total={preview.backups.total}
          onChange={setLinkBackups}
        />
        <OptionRow
          checked={keepActivity}
          disabled={pending}
          icon={<Activity />}
          label="Activity history"
          detail="The new server's activity includes this server's history."
          onChange={setKeepActivity}
        />
        {mode === "migrate" ? (
          <DomainOption
            checked={moveDomain}
            destination={selected}
            disabled={pending || !preview.allowed.network}
            preview={preview}
            onChange={setMoveDomain}
          />
        ) : null}
        {preview.webRoutes.length ? (
          mode === "migrate" ? (
            <OptionRow
              checked={moveWebRoutes}
              disabled={pending || !preview.allowed.network}
              icon={<Route />}
              label={`Web routes (${preview.webRoutes.join(", ")})`}
              detail={`Point ${preview.webRoutes.length === 1 ? "this hostname" : "these hostnames"} at ${selected?.name ?? "the new Relay"} afterwards; HTTPS works once DNS reaches it.`}
              onChange={setMoveWebRoutes}
            />
          ) : (
            <OptionRow
              checked={false}
              disabled
              icon={<Route />}
              label="Web routes"
              detail={`${preview.webRoutes.join(", ")} stay with this server; add routes of its own to the copy.`}
            />
          )
        ) : null}
      </fieldset>

      <fieldset className="grid gap-3 rounded-lg border border-border/80 bg-background/45 p-3">
        <legend className="type-technical-label px-1 text-muted-foreground">
          Before copying
        </legend>
        <OptionRow
          checked={backup}
          disabled={pending || !preview.allowed.backup}
          icon={<Archive />}
          label="Back up this server first"
          detail={
            preview.allowed.backup
              ? "A full backup, finished before anything changes."
              : "You can't back up this server."
          }
          onChange={setBackup}
        />
        {backup ? (
          <BackupDestinationSelect
            disabled={pending}
            label="Backup destination"
            storage={backupStorage.data}
            value={backupDestination}
            onChange={setBackupDestination}
          />
        ) : null}
        {mode === "migrate" ? (
          <OptionRow
            checked
            disabled
            icon={<Square />}
            label="Stop this server"
            detail={
              !preview.allowed.stop
                ? "A move stops this server, and you can't stop it."
                : deleting
                  ? "It stops for the move and stays stopped until it's deleted."
                  : "It stops for the move and stays stopped. Once the move finishes, you'll be asked whether to delete it."
            }
          />
        ) : (
          <OptionRow
            checked={stopSource}
            disabled={
              pending || !preview.allowed.power || !preview.source.running
            }
            icon={<Square />}
            label="Stop it while copying"
            detail={
              preview.source.running
                ? "It starts again afterwards. Copying a running server can catch a world mid-save."
                : "It isn't running."
            }
            onChange={setStopSource}
          />
        )}
      </fieldset>

      {mode === "migrate" ? (
        <fieldset className="grid gap-3 rounded-lg border border-border/80 bg-background/45 p-3">
          <legend className="type-technical-label px-1 text-muted-foreground">
            Once moved
          </legend>
          <OptionRow
            checked={deleting}
            disabled={pending || !preview.allowed.delete}
            icon={<Trash2 />}
            label="Delete this server"
            detail={
              preview.allowed.delete
                ? "Kiln takes a full backup of it first, then deletes it. The backup stays after it's gone."
                : "Deleting it needs permission to delete and back up this server."
            }
            onChange={setDeleteSource}
          />
          {deleting ? (
            <BackupDestinationSelect
              disabled={pending}
              label="Final backup destination"
              storage={backupStorage.data}
              value={deleteDestination}
              onChange={setDeleteDestination}
            />
          ) : null}
        </fieldset>
      ) : null}

      {preview.source.provisioning ? (
        <Callout tone="warning">
          This server is still being created; copy it once it's ready.
        </Callout>
      ) : null}
      {start.isError ? (
        <Callout tone="error">{start.error.message}</Callout>
      ) : null}

      <DialogFooter>
        <Button
          type="button"
          variant="ghost"
          disabled={pending}
          onClick={onDone}
        >
          Cancel
        </Button>
        <Button type="submit" disabled={blocked || pending}>
          {pending ? <LoaderCircle className="animate-spin" /> : null}
          {pending
            ? "Starting…"
            : mode === "migrate"
              ? "Move server"
              : "Duplicate server"}
        </Button>
      </DialogFooter>
    </form>
  )
}

// Where a backup goes: wherever this server's backups go by default, the
// Relay itself, or an S3 destination.
function BackupDestinationSelect({
  disabled,
  label,
  onChange,
  storage,
  value,
}: {
  disabled: boolean
  label: string
  onChange: (value: string) => void
  storage:
    | ReadonlyArray<{
        deleting: boolean
        enabled: boolean
        id: string
        name: string
      }>
    | undefined
  value: string
}) {
  return (
    <Select disabled={disabled} value={value} onValueChange={onChange}>
      <SelectTrigger aria-label={label} className="h-9 w-full bg-background">
        <SelectValue />
      </SelectTrigger>
      <SelectContent className="min-w-(--radix-select-trigger-width)">
        <SelectItem value="default">Default · Preferred destination</SelectItem>
        <SelectItem value="local">Local Relay</SelectItem>
        {(storage ?? [])
          .filter((item) => item.enabled && !item.deleting)
          .map((item) => (
            <SelectItem key={item.id} value={item.id}>
              S3 · {item.name}
            </SelectItem>
          ))}
      </SelectContent>
    </Select>
  )
}

function storageChoice(value: string): { storageId?: string | null } {
  if (value === "default") return {}
  return { storageId: value === "local" ? null : value }
}

// Full backups restore to the copy as linked backups. Ones kept on this
// Relay can't follow a copy to another, and incremental ones belong to this
// server's repository.
function BackupsOption({
  allowed,
  checked,
  destination,
  disabled,
  linkable,
  onChange,
  total,
}: {
  allowed: boolean
  checked: boolean
  destination: ServerMigrationDestination | undefined
  disabled: boolean
  linkable: number
  onChange: (checked: boolean) => void
  total: number
}) {
  if (total === 0) {
    return (
      <OptionRow
        checked={false}
        disabled
        icon={<Archive />}
        label="Backups"
        detail="This server has no backups."
      />
    )
  }
  if (!allowed) {
    return (
      <OptionRow
        checked={false}
        disabled
        icon={<Archive />}
        label="Backups"
        detail="Linking backups needs permission to download this server's backups."
      />
    )
  }
  if (destination && !destination.linksBackups) {
    return (
      <OptionRow
        checked={false}
        disabled
        icon={<Archive />}
        label="Backups"
        detail={`Update ${destination.name} to the latest Kiln release to link backups to a copy there.`}
      />
    )
  }
  const staying = total - linkable
  if (linkable === 0) {
    return (
      <OptionRow
        checked={false}
        disabled
        icon={<Archive />}
        label="Backups"
        detail={
          destination?.current
            ? "Its backups are incremental, so they stay with this server."
            : "Its backups are kept on this Relay or are incremental, so they stay with this server. Back up to S3 first to bring one along."
        }
      />
    )
  }
  return (
    <OptionRow
      checked={checked}
      disabled={disabled}
      icon={<Archive />}
      label={linkable === 1 ? "Link 1 backup" : `Link ${linkable} backups`}
      detail={`They restore to the new server too, and stay until both servers' copies of them are deleted.${
        staying > 0
          ? ` ${staying} ${staying === 1 ? "backup stays" : "backups stay"} with this server: ${destination?.current ? "incremental ones" : "ones kept on this Relay, and incremental ones"}.`
          : ""
      }`}
      onChange={onChange}
    />
  )
}

// A move takes managed domains along and points them at the new Relay;
// without Cloudflare, Kiln manages no DNS, so the person updates their own.
function DomainOption({
  checked,
  destination,
  disabled,
  onChange,
  preview,
}: {
  checked: boolean
  destination: ServerMigrationDestination | undefined
  disabled: boolean
  onChange: (checked: boolean) => void
  preview: ServerMigrationPreview
}) {
  const relayName = destination?.name ?? "the new Relay"
  if (!preview.domains.managed) {
    return (
      <OptionRow
        checked={false}
        disabled
        icon={<Globe />}
        label="Domains"
        detail={`Cloudflare isn't connected, so Kiln doesn't manage DNS. If players join with a domain of yours, point it at ${relayName}'s address once the move finishes.`}
      />
    )
  }
  if (!preview.domains.names.length) {
    return (
      <OptionRow
        checked={false}
        disabled
        icon={<Globe />}
        label="Domains"
        detail="This server has no managed domain."
      />
    )
  }
  return (
    <OptionRow
      checked={checked}
      disabled={disabled}
      icon={<Globe />}
      label={`Domain (${preview.domains.names.join(", ")})`}
      detail={`Kiln points it at ${relayName}, so players join with the same address.`}
      onChange={onChange}
    />
  )
}

function ModeButton({
  active,
  detail,
  icon,
  label,
  onSelect,
}: {
  active: boolean
  detail: string
  icon: React.ReactNode
  label: string
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      className={cn(
        "flex items-center gap-2.5 rounded-md px-3 py-2 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/35 [&_svg]:size-4 [&_svg]:shrink-0",
        active
          ? "bg-primary/12 text-foreground ring-1 ring-primary/35 light:bg-primary/16"
          : "text-muted-foreground hover:bg-muted/40 hover:text-foreground"
      )}
      onClick={onSelect}
    >
      {icon}
      <span className="min-w-0">
        <span className="block text-sm font-medium">{label}</span>
        <span className="type-meta block text-muted-foreground">{detail}</span>
      </span>
    </button>
  )
}

function OptionRow({
  checked,
  detail,
  disabled = false,
  icon,
  label,
  onChange,
}: {
  checked: boolean
  detail: string
  disabled?: boolean
  icon: React.ReactNode
  label: string
  onChange?: (checked: boolean) => void
}) {
  return (
    <label
      className={cn(
        "flex items-start gap-3",
        disabled ? "cursor-not-allowed" : "cursor-pointer"
      )}
    >
      <input
        checked={checked}
        className="mt-0.5 size-4 shrink-0 rounded-[3px] border-input accent-primary"
        disabled={disabled}
        type="checkbox"
        onChange={(event) => onChange?.(event.currentTarget.checked)}
      />
      <span
        className={cn("min-w-0 flex-1", disabled && !checked && "opacity-70")}
      >
        <span className="flex items-center gap-2 text-sm font-medium [&_svg]:size-4 [&_svg]:text-muted-foreground">
          {icon}
          <span className="min-w-0 break-words">{label}</span>
        </span>
        <span className="type-meta mt-0.5 block text-muted-foreground">
          {detail}
        </span>
      </span>
    </label>
  )
}

function Callout({
  children,
  tone,
}: {
  children: React.ReactNode
  tone: "error" | "warning"
}) {
  return (
    <div
      role={tone === "error" ? "alert" : undefined}
      className={cn(
        "flex items-start gap-2 rounded-lg border px-3 py-2 text-xs leading-relaxed",
        tone === "error"
          ? "border-destructive/30 bg-destructive/8 text-destructive light:bg-destructive/16"
          : "border-amber-400/30 bg-amber-400/8 text-amber-200 light:bg-amber-400/16 light:text-amber-800"
      )}
    >
      <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
      <span>{children}</span>
    </div>
  )
}

function defaultDestination(
  destinations: ReadonlyArray<ServerMigrationDestination>,
  mode: ServerMigrationMode,
  usable: (destination: ServerMigrationDestination) => boolean
) {
  const candidates = destinations.filter(usable)
  return (
    (mode === "duplicate"
      ? candidates.find((destination) => destination.current)
      : null) ??
    candidates[0] ??
    destinations[0]
  )
}

// A move keeps the server's name; a duplicate takes the first free
// "<name> copy", "<name> copy 2", … on its Relay.
function defaultName(
  name: string,
  mode: ServerMigrationMode,
  taken: ReadonlyArray<string>
) {
  if (mode === "migrate") return name.slice(0, NAME_LIMIT)
  for (let index = 1; index < 100; index += 1) {
    const suffix = index === 1 ? " copy" : ` copy ${index}`
    const candidate = `${name.slice(0, NAME_LIMIT - suffix.length)}${suffix}`
    if (!taken.includes(candidate)) return candidate
  }
  return `${name.slice(0, NAME_LIMIT - 5)} copy`
}
