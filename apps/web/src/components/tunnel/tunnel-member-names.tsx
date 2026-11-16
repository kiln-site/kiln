import * as React from "react"
import { Check, LoaderCircle, Pencil, Plus, Star, X } from "lucide-react"

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
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"

import {
  namesOf,
  useMakeTunnelNamePrimary,
  useTailnetAliases,
  useTailnetSave,
  wholeName,
  type TunnelMemberName,
  type TunnelOverview,
} from "@/components/tunnel/tailnet-data"
import { useCopyFeedback } from "@/components/workspace-header"
import { notALoginField } from "@/lib/not-a-login-field"

// A connected member's names in one tailnet: the one it was given as it
// connected, which can be renamed but not removed, and its aliases, at any
// depth under any of the tailnet's TLDs.

export const TunnelMemberNames = React.memo(function TunnelMemberNames({
  canWrite,
  memberId,
  memberName,
  tailnet,
}: {
  canWrite: boolean
  memberId: string
  /** What the member is called, for the dialogs' titles. */
  memberName: string
  tailnet: TunnelOverview
}) {
  // A database has no primary address; a game server's or an App's can be
  // any of its names.
  const canStar = !memberId.startsWith("database:")
  const makePrimary = useMakeTunnelNamePrimary()
  const names = React.useMemo(
    () => namesOf(tailnet, memberId),
    [memberId, tailnet]
  )
  const [dialog, setDialog] = React.useState<"add" | "rename" | null>(null)
  const generated = names.find((name) => name.generated)
  const { remove } = useTailnetAliases()
  const close = React.useCallback(() => setDialog(null), [])

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1">
      {names.length === 0 ? (
        <span className="type-meta text-muted-foreground">
          Named once it's connected
        </span>
      ) : null}
      {names.map((name) => (
        <NameChip
          key={name.id}
          star={
            canStar && (name.primary || canWrite) ? (
              <ChipButton
                disabled={name.primary || makePrimary.isPending}
                label={
                  name.primary
                    ? `${wholeName(name)} is the primary address`
                    : `Make ${wholeName(name)} the primary address`
                }
                pressed={name.primary}
                tooltip={name.primary ? "Primary address" : "Make primary"}
                onClick={() => makePrimary.mutate(name)}
              >
                {makePrimary.isPending &&
                makePrimary.variables?.id === name.id ? (
                  <LoaderCircle className="animate-spin" />
                ) : (
                  <Star
                    className={
                      name.primary ? "fill-current text-primary-ink" : ""
                    }
                  />
                )}
              </ChipButton>
            ) : null
          }
          action={
            !canWrite ? null : name.generated ? (
              <ChipButton
                label={`Rename ${wholeName(name)}`}
                tooltip="Rename"
                onClick={() => setDialog("rename")}
              >
                <Pencil />
              </ChipButton>
            ) : (
              <ChipButton
                disabled={remove.isPending}
                label={`Remove ${wholeName(name)}`}
                tooltip="Remove"
                onClick={() => remove.mutate(name)}
              >
                {remove.isPending && remove.variables?.id === name.id ? (
                  <LoaderCircle className="animate-spin" />
                ) : (
                  <X />
                )}
              </ChipButton>
            )
          }
          name={name}
        />
      ))}
      {canWrite && generated ? (
        <Button
          type="button"
          size="xs"
          variant="ghost"
          className="h-6 px-1.5 text-muted-foreground"
          onClick={() => setDialog("add")}
        >
          <Plus />
          Name
        </Button>
      ) : null}
      {dialog === "rename" && generated ? (
        <RenameDialog
          generated={generated}
          memberName={memberName}
          tailnet={tailnet}
          onClose={close}
        />
      ) : null}
      {dialog === "add" ? (
        <AddAliasDialog
          memberId={memberId}
          memberName={memberName}
          tailnet={tailnet}
          onClose={close}
        />
      ) : null}
    </div>
  )
})

const NameChip = React.memo(function NameChip({
  action,
  name,
  star,
}: {
  action: React.ReactNode
  name: TunnelMemberName
  star: React.ReactNode
}) {
  const whole = wholeName(name)
  const { copied, copy } = useCopyFeedback(whole)
  return (
    <span
      className={`inline-flex h-6 max-w-full min-w-0 items-center rounded-md border text-xs ${
        name.generated
          ? "border-primary/30 bg-primary/8"
          : "border-border/70 bg-muted/25"
      }`}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className="min-w-0 truncate px-1.5 font-mono outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            aria-label={`Copy ${whole}`}
            onClick={() => void copy()}
          >
            {whole}
          </button>
        </TooltipTrigger>
        <TooltipContent side="top">
          {copied
            ? "Copied"
            : name.generated
              ? "Its name here. Click to copy."
              : "Click to copy"}
        </TooltipContent>
      </Tooltip>
      {star}
      {action}
    </span>
  )
})

function ChipButton({
  children,
  disabled,
  label,
  pressed,
  tooltip,
  onClick,
}: {
  children: React.ReactNode
  disabled?: boolean
  label: string
  pressed?: boolean
  tooltip: string
  onClick: () => void
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          aria-pressed={pressed}
          disabled={disabled}
          className="grid size-6 shrink-0 place-items-center border-l border-inherit text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50 [&_svg]:size-3"
          onClick={onClick}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top">{tooltip}</TooltipContent>
    </Tooltip>
  )
}

function RenameDialog({
  generated,
  memberName,
  tailnet,
  onClose,
}: {
  generated: TunnelMemberName
  memberName: string
  tailnet: TunnelOverview
  onClose: () => void
}) {
  const [label, setLabel] = React.useState(generated.label)
  const save = useTailnetSave()
  const next = label.trim().toLowerCase()
  const domain = tailnet.domains[0] ?? generated.domain
  const canSave = next.length > 0 && next !== generated.label && !save.isPending
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="sm:max-w-md">
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            if (!canSave) return
            save.mutate(
              {
                change: {
                  rename: { label: next, memberId: generated.memberId },
                },
                doing: `Renaming ${memberName} to ${next}.${domain}`,
                done: `${memberName} is ${next}.${domain}`,
                tailnet,
              },
              { onSuccess: onClose }
            )
          }}
        >
          <DialogHeader>
            <DialogTitle>Rename {memberName}</DialogTitle>
            <DialogDescription>
              Its name in {tailnet.name}, under .{domain}. Its aliases stay.
            </DialogDescription>
          </DialogHeader>
          <LabelField domain={domain} label={label} onChange={setLabel} />
          {save.error ? (
            <p className="text-xs text-destructive" role="alert">
              {save.error.message}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canSave}>
              {save.isPending ? (
                <LoaderCircle className="animate-spin" />
              ) : (
                <Check />
              )}
              Rename
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function AddAliasDialog({
  memberId,
  memberName,
  tailnet,
  onClose,
}: {
  memberId: string
  memberName: string
  tailnet: TunnelOverview
  onClose: () => void
}) {
  const [label, setLabel] = React.useState("")
  const [domain, setDomain] = React.useState(tailnet.domains[0] ?? "")
  const { add } = useTailnetAliases()
  const next = label.trim().toLowerCase().replace(/\.+$/u, "")
  const canSave = next.length > 0 && domain.length > 0 && !add.isPending
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="sm:max-w-md">
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            if (!canSave) return
            add.mutate(
              { domain, label: next, memberId, tunnelId: tailnet.id },
              { onSuccess: onClose }
            )
          }}
        >
          <DialogHeader>
            <DialogTitle>Give {memberName} another name</DialogTitle>
            <DialogDescription>
              Any depth under any of {tailnet.name}'s TLDs, like paper.26.3.
              {tailnet.domains[0]}. Every name works.
            </DialogDescription>
          </DialogHeader>
          <LabelField
            domain={domain}
            domains={tailnet.domains}
            label={label}
            placeholder="paper.26.3"
            onChange={setLabel}
            onDomainChange={setDomain}
          />
          {add.error ? (
            <p className="text-xs text-destructive" role="alert">
              {add.error.message}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canSave}>
              {add.isPending ? (
                <LoaderCircle className="animate-spin" />
              ) : (
                <Plus />
              )}
              Add name
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function LabelField({
  domain,
  domains,
  label,
  placeholder,
  onChange,
  onDomainChange,
}: {
  domain: string
  /** The TLDs to pick between; one fixed TLD without. */
  domains?: ReadonlyArray<string>
  label: string
  placeholder?: string
  onChange: (label: string) => void
  onDomainChange?: (domain: string) => void
}) {
  const id = React.useId()
  return (
    <div className="grid gap-2">
      <label htmlFor={id} className="text-xs font-medium">
        Name
      </label>
      <div className="flex items-center">
        <Input
          {...notALoginField}
          autoFocus
          id={id}
          value={label}
          placeholder={placeholder}
          onChange={(event) => onChange(event.target.value)}
          className="min-w-0 rounded-r-none font-mono"
        />
        {domains && domains.length > 1 && onDomainChange ? (
          <Select value={domain} onValueChange={onDomainChange}>
            <SelectTrigger
              aria-label="TLD"
              className="h-8 w-auto shrink-0 rounded-l-none border-l-0 font-mono text-xs"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {domains.map((candidate) => (
                <SelectItem key={candidate} value={candidate}>
                  .{candidate}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <span className="flex h-8 shrink-0 items-center border border-l-0 border-input bg-muted/30 px-3 font-mono text-xs text-muted-foreground">
            .{domain}
          </span>
        )}
      </div>
    </div>
  )
}
