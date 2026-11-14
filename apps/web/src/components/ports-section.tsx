import * as React from "react"
import { Effect } from "effect"
import {
  AlertTriangle,
  BrickWall,
  Cable,
  Check,
  CircleAlert,
  Copy,
  LoaderCircle,
  Pencil,
  Trash2,
} from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import {
  Dialog,
  DialogContent,
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
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"

import {
  WorkspaceTableCell,
  WorkspaceTableHead,
  WorkspaceTableHeading,
} from "@/components/workspace-table"

// The Ports section of an instance's Network page: one table, one form and
// one remove dialog for every kind that publishes ports on its Relay. Each
// kind brings its own rows and saves them its own way.

export type PortProtocol = "tcp" | "udp" | "both"

export function PortsSection({
  action,
  children,
  footer,
}: {
  action?: React.ReactNode
  children: React.ReactNode
  footer?: React.ReactNode
}) {
  return (
    <section className="border border-border/80 bg-card/55">
      <div className="flex min-h-13 flex-wrap items-center justify-between gap-3 border-b border-border/70 px-4 py-2">
        <h2 className="font-heading text-base font-semibold tracking-tight">
          Ports
        </h2>
        <div className="flex items-center gap-2">{action}</div>
      </div>
      {children}
      {footer}
    </section>
  )
}

/** A line under the table: why ports can't change, or what went wrong. */
export function PortsNote({
  children,
  tone = "muted",
}: {
  children: React.ReactNode
  tone?: "error" | "muted" | "warning"
}) {
  return (
    <p
      className={
        tone === "error"
          ? "border-t border-destructive/20 bg-destructive/5 px-4 py-2 text-xs text-destructive light:bg-destructive/10"
          : tone === "warning"
            ? "type-support border-t border-amber-400/20 bg-amber-400/5 px-4 py-2 text-amber-100 light:bg-amber-400/10 light:text-amber-800"
            : "type-support border-t border-border/70 px-4 py-2 text-muted-foreground"
      }
    >
      {children}
    </p>
  )
}

export function PortsTable({ children }: { children: React.ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[40rem] table-fixed border-collapse text-left">
        <WorkspaceTableHead>
          <WorkspaceTableHeading className="w-[27%]">
            Name
          </WorkspaceTableHeading>
          <WorkspaceTableHeading className="w-[15%]">
            Internal port
          </WorkspaceTableHeading>
          <WorkspaceTableHeading>Public address</WorkspaceTableHeading>
          <WorkspaceTableHeading className="w-[6.5rem] text-right">
            Actions
          </WorkspaceTableHeading>
        </WorkspaceTableHead>
        <tbody className="divide-y divide-border/70">{children}</tbody>
      </table>
    </div>
  )
}

/** A band between the primary port and the rest. */
export function PortsDivider() {
  return (
    <tr aria-hidden="true">
      <td
        className="h-3 border-y border-border/70 bg-muted/25 p-0"
        colSpan={4}
      />
    </tr>
  )
}

/** What a row's icon says in place of "published": a warning or an error. */
export interface PortNotice {
  label: string
  tone: "error" | "warning"
  tooltip: string
  onClick: () => void
}

export function PortRow({
  actions,
  address,
  busy,
  detail,
  internalPort,
  name,
  notice,
  primary = false,
}: {
  actions?: React.ReactNode
  /** Its public address, to copy. A string alone is shown as it is. */
  address: { copy: string; label: string } | string | null
  /** What it is doing, as "Adding" or "Removing", while it does. */
  busy?: string
  /** Under its name: its protocol, or what to say in its place. */
  detail: string
  internalPort: number | null
  name: string
  notice?: PortNotice
  primary?: boolean
}) {
  return (
    <tr
      aria-label={busy ? `${busy} ${name}` : undefined}
      className="hover:bg-muted/10"
    >
      <WorkspaceTableCell>
        <div className="flex min-w-0 items-center gap-2.5">
          <PortIcon busy={busy} notice={notice} primary={primary} />
          <div className="min-w-0">
            <span className="block truncate text-xs font-medium">{name}</span>
            <span className="type-technical-label mt-0.5 block truncate text-muted-foreground">
              {detail}
            </span>
          </div>
          {primary ? (
            <span className="type-technical-label shrink-0 self-center border border-primary/30 bg-primary/8 px-2 py-1 text-primary-ink">
              Primary
            </span>
          ) : null}
        </div>
      </WorkspaceTableCell>
      <WorkspaceTableCell>
        <span className="font-mono text-xs text-foreground">
          {internalPort ?? "—"}
        </span>
      </WorkspaceTableCell>
      <WorkspaceTableCell>
        {address === null ? (
          <span className="type-code block truncate text-muted-foreground">
            Unavailable
          </span>
        ) : typeof address === "string" ? (
          <span className="block truncate font-mono text-sm font-medium text-muted-foreground">
            {address}
          </span>
        ) : (
          <PublicAddressCopy address={address.copy} label={address.label} />
        )}
      </WorkspaceTableCell>
      <WorkspaceTableCell className="px-2">
        <div className="flex justify-end gap-0.5">{actions}</div>
      </WorkspaceTableCell>
    </tr>
  )
}

/** A row's edit and remove buttons; each shows when it has a handler. */
export function PortRowActions({
  disabled,
  name,
  onEdit,
  onRemove,
}: {
  disabled: boolean
  name: string
  onEdit?: () => void
  onRemove?: () => void
}) {
  return (
    <>
      {onEdit ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              aria-label={`Edit ${name}`}
              disabled={disabled}
              onClick={onEdit}
              size="icon-sm"
              type="button"
              variant="ghost"
            >
              <Pencil />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Edit port</TooltipContent>
        </Tooltip>
      ) : null}
      {onRemove ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              aria-label={`Remove ${name}`}
              disabled={disabled}
              onClick={onRemove}
              size="icon-sm"
              type="button"
              variant="ghost"
            >
              <Trash2 />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Remove port</TooltipContent>
        </Tooltip>
      ) : null}
    </>
  )
}

function PortIcon({
  busy,
  notice,
  primary,
}: {
  busy?: string
  notice?: PortNotice
  primary: boolean
}) {
  if (busy) {
    return (
      <div
        aria-label={`${busy} port`}
        className="grid size-7 shrink-0 place-items-center border border-primary/30 bg-primary/5 text-primary-ink"
        role="status"
      >
        <LoaderCircle className="size-3.5 animate-spin" />
      </div>
    )
  }

  if (!notice) {
    const Icon = primary ? BrickWall : Cable
    return (
      <div
        className={`grid size-7 shrink-0 place-items-center border ${
          primary
            ? "border-primary/30 bg-primary/5 text-primary-ink"
            : "border-emerald-400/25 bg-emerald-400/5 text-emerald-300 light:bg-emerald-400/10 light:text-emerald-700"
        }`}
      >
        <Icon className="size-3.5" />
      </div>
    )
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          aria-label={notice.label}
          className={`grid size-7 shrink-0 place-items-center border transition-colors ${
            notice.tone === "warning"
              ? "border-amber-400/30 bg-amber-400/5 text-amber-300 hover:bg-amber-400/10 light:bg-amber-400/10 light:text-amber-700 light:hover:bg-amber-400/20"
              : "border-destructive/35 bg-destructive/5 text-destructive hover:bg-destructive/10 light:bg-destructive/10 light:hover:bg-destructive/20"
          }`}
          onClick={notice.onClick}
          type="button"
        >
          {notice.tone === "warning" ? (
            <AlertTriangle className="size-3.5" />
          ) : (
            <CircleAlert className="size-3.5" />
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent>{notice.tooltip}</TooltipContent>
    </Tooltip>
  )
}

function PublicAddressCopy({
  address,
  label,
}: {
  address: string
  label: string
}) {
  const { copied, copy } = useCopyFeedback(address)

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          aria-label={`Copy ${label}`}
          className={`type-control flex max-w-full items-center gap-1 font-mono transition-colors ${
            copied
              ? "text-emerald-400"
              : "text-primary-ink/75 hover:text-primary-ink"
          }`}
          onClick={() => {
            void copy()
          }}
          type="button"
        >
          <span className="truncate">{address}</span>
          {copied ? (
            <Check className="size-3 shrink-0" />
          ) : (
            <Copy className="size-3 shrink-0 opacity-55" />
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent>
        {copied ? "Address copied" : "Copy address"}
      </TooltipContent>
    </Tooltip>
  )
}

function useCopyFeedback(value: string) {
  const [copied, setCopied] = React.useState(false)
  const resetTimer = React.useRef<number | null>(null)
  React.useEffect(
    () => () => {
      if (resetTimer.current) window.clearTimeout(resetTimer.current)
    },
    []
  )

  async function copy() {
    await copyToClipboard(value)
    setCopied(true)
    if (resetTimer.current) window.clearTimeout(resetTimer.current)
    resetTimer.current = window.setTimeout(() => setCopied(false), 1_800)
  }

  return { copied, copy }
}

async function copyToClipboard(value: string) {
  await Effect.runPromise(
    Effect.tryPromise({
      try: () => navigator.clipboard.writeText(value),
      catch: (cause) => cause,
    }).pipe(
      Effect.catch(() =>
        Effect.sync(() => {
          const textarea = document.createElement("textarea")
          textarea.value = value
          textarea.style.position = "fixed"
          textarea.style.opacity = "0"
          document.body.append(textarea)
          textarea.select()
          document.execCommand("copy")
          textarea.remove()
        })
      )
    )
  )
}

/**
 * A port's fields, in a form: its name, the port inside the container, the
 * one on the Relay, and its protocol. The name and the public port show when
 * given. The internal port is read from the form as `internalPort`, and the
 * name as `name`.
 */
export function PortFields({
  both = false,
  internalPort,
  name,
  protocol,
  publicPort,
  onProtocolChange,
}: {
  /** Whether one port may carry TCP and UDP together. */
  both?: boolean
  internalPort: {
    defaultValue?: number
    value?: string
    onChange?: (value: string) => void
  }
  name?: { defaultValue?: string }
  protocol: PortProtocol
  publicPort?: {
    disabled?: boolean
    readOnly?: boolean
    value: string
    onBlur?: () => void
    onChange?: (value: string) => void
  }
  onProtocolChange: (protocol: PortProtocol) => void
}) {
  return (
    <>
      {name ? (
        <label className="type-label block space-y-1.5">
          Name
          <Input
            autoComplete="off"
            defaultValue={name.defaultValue}
            maxLength={32}
            name="name"
            placeholder="Voice chat"
            required
          />
        </label>
      ) : null}
      <div
        className={
          publicPort
            ? "grid grid-cols-2 gap-3 sm:grid-cols-[7.5rem_7.5rem_minmax(0,1fr)]"
            : "grid grid-cols-[7.5rem_minmax(0,1fr)] gap-3"
        }
      >
        <label className="type-label block space-y-1.5">
          Internal port
          <Input
            defaultValue={internalPort.defaultValue}
            max={65_535}
            min={1}
            name="internalPort"
            placeholder="24454"
            required
            type="number"
            value={internalPort.value}
            onChange={
              internalPort.onChange
                ? (event) => internalPort.onChange?.(event.target.value)
                : undefined
            }
          />
        </label>
        {publicPort ? (
          <label className="type-label block space-y-1.5">
            Public port
            <Input
              aria-label="Public port"
              className="font-mono"
              disabled={publicPort.disabled}
              max={65_535}
              min={1}
              name="publicPort"
              readOnly={publicPort.readOnly}
              required
              type="number"
              value={publicPort.value}
              onBlur={publicPort.onBlur}
              onChange={(event) => publicPort.onChange?.(event.target.value)}
            />
          </label>
        ) : null}
        <label
          className={
            publicPort
              ? "type-label col-span-2 block space-y-1.5 sm:col-span-1"
              : "type-label block space-y-1.5"
          }
        >
          Protocol
          <Select
            name="protocol"
            value={protocol}
            onValueChange={(next) => {
              if (isPortProtocol(next)) onProtocolChange(next)
            }}
          >
            <SelectTrigger aria-label="Protocol" className="h-8 w-full text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="tcp">TCP</SelectItem>
              <SelectItem value="udp">UDP</SelectItem>
              {both ? <SelectItem value="both">TCP + UDP</SelectItem> : null}
            </SelectContent>
          </Select>
        </label>
      </div>
    </>
  )
}

export function RemovePortDialog({
  address,
  name,
  open,
  onConfirm,
  onOpenChange,
}: {
  address: string
  name: string
  open: boolean
  onConfirm: () => void
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Trash2 aria-hidden="true" className="size-5 text-destructive" />
            Remove port
          </DialogTitle>
        </DialogHeader>
        <div className="border border-border bg-muted/20 px-3 py-2.5">
          <span className="block truncate text-sm font-medium text-foreground">
            {name}
          </span>
          <span className="mt-0.5 block truncate font-mono text-xs text-muted-foreground">
            {address}
          </span>
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button type="button" variant="destructive" onClick={onConfirm}>
            <Trash2 />
            Remove port
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function formatHostPort(host: string, port: number): string {
  return `${host.includes(":") && !host.startsWith("[") ? `[${host}]` : host}:${port}`
}

export function formatPortProtocol(protocol: PortProtocol): string {
  return protocol === "both" ? "TCP + UDP" : protocol.toUpperCase()
}

function isPortProtocol(value: unknown): value is PortProtocol {
  return value === "tcp" || value === "udp" || value === "both"
}
