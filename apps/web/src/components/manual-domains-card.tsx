import * as React from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Globe, LoaderCircle, Plus, Trash2 } from "lucide-react"

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
import { showToast } from "@workspace/ui/components/sonner"
import { Switch } from "@workspace/ui/components/switch"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"

import { HearthMark } from "@/components/hearth-mark"
import { InfoRailCard } from "@/components/info-page"
import { notALoginField } from "@/lib/not-a-login-field"
import { queryKeys } from "@/lib/query-options"
import {
  addManualDomain,
  removeManualDomain,
  type ManualDomainOverview,
} from "@/server/domains"

// Domains whose DNS someone manages elsewhere: Kiln holds the names under
// one, so no other instance takes them, and writes no records.

export const ManualDomainsCard = React.memo(function ManualDomainsCard({
  canManagePlatform,
  domains,
}: {
  canManagePlatform: boolean
  domains: ReadonlyArray<ManualDomainOverview>
}) {
  const [adding, setAdding] = React.useState(false)
  return (
    <InfoRailCard
      action={
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              aria-label="Add a domain managed elsewhere"
              size="icon-sm"
              type="button"
              variant="outline"
              onClick={() => setAdding(true)}
            >
              <Plus />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>
            Add a domain managed elsewhere
          </TooltipContent>
        </Tooltip>
      }
      icon={<Globe />}
      title="Managed elsewhere"
      sections={
        domains.length > 0 ? (
          <ul className="divide-y divide-border/60 border-t border-border/60">
            {domains.map((domain) => (
              <ManualDomainRow key={domain.domain} domain={domain} />
            ))}
          </ul>
        ) : null
      }
    >
      {domains.length === 0 ? (
        <p className="type-meta py-2 text-muted-foreground">
          A domain whose DNS you manage yourself. Kiln keeps its names yours and
          tells you where to point them.
        </p>
      ) : null}
      {adding ? (
        <AddManualDomainDialog
          canManagePlatform={canManagePlatform}
          onOpenChange={setAdding}
        />
      ) : null}
    </InfoRailCard>
  )
})

const ManualDomainRow = React.memo(function ManualDomainRow({
  domain,
}: {
  domain: ManualDomainOverview
}) {
  const queryClient = useQueryClient()
  const remove = useMutation({
    mutationFn: () => removeManualDomain({ data: { domain: domain.domain } }),
    onSuccess: () => {
      showToast({ message: `Removed ${domain.domain}`, type: "success" })
      void queryClient.invalidateQueries({
        queryKey: queryKeys.domains.settings,
      })
    },
    onError: (cause) =>
      showToast({
        description: cause.message,
        message: `${domain.domain} wasn't removed`,
        type: "error",
      }),
  })
  return (
    <li className="flex h-10 items-center gap-2 px-3">
      <span className="min-w-0 flex-1 truncate font-mono text-[0.8125rem]">
        {domain.domain}
      </span>
      <span className="type-meta shrink-0 text-muted-foreground">
        {domain.names} {domain.names === 1 ? "name" : "names"}
      </span>
      {domain.platform ? (
        <span aria-label="Kiln's" className="inline-flex" role="img">
          <HearthMark className="size-3.5" />
        </span>
      ) : null}
      <Tooltip>
        <TooltipTrigger asChild>
          <span>
            <Button
              aria-label={`Remove ${domain.domain}`}
              disabled={domain.names > 0 || remove.isPending}
              size="icon-xs"
              type="button"
              variant="ghost"
              onClick={() => remove.mutate()}
            >
              {remove.isPending ? (
                <LoaderCircle className="animate-spin" />
              ) : (
                <Trash2 />
              )}
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent side="left">
          {domain.names > 0
            ? "Take its names off their web routes first"
            : `Remove ${domain.domain}`}
        </TooltipContent>
      </Tooltip>
    </li>
  )
})

function AddManualDomainDialog({
  canManagePlatform,
  onOpenChange,
}: {
  canManagePlatform: boolean
  onOpenChange: (open: boolean) => void
}) {
  const queryClient = useQueryClient()
  const [domain, setDomain] = React.useState("")
  const [platform, setPlatform] = React.useState(false)
  const add = useMutation({
    mutationFn: () =>
      addManualDomain({
        data: { domain: domain.trim(), platform: platform || undefined },
      }),
    onSuccess: ({ attached, conflicts, unreadRelays }) => {
      void queryClient.invalidateQueries({ queryKey: ["domains"] })
      showToast({
        description:
          attached > 0
            ? `Kiln now holds ${attached} ${attached === 1 ? "name" : "names"} its Relays already route under it.`
            : undefined,
        message: `Added ${domain.trim()}`,
        type: "success",
      })
      if (unreadRelays.length > 0) {
        showToast({
          description: `Kiln couldn't read ${unreadRelays.join(", ")}. Names they route under it are taken in when they reconnect.`,
          duration: 12_000,
          message: "Some Relays weren't read",
          type: "warning",
        })
      }
      if (conflicts.length > 0) {
        showToast({
          description: `More than one instance routes ${conflicts.join(", ")}. Keep it on one, and save the other's web routes again.`,
          duration: 12_000,
          message: "Some names weren't taken in",
          type: "warning",
        })
      }
      onOpenChange(false)
    },
  })
  return (
    <Dialog open onOpenChange={(open) => !add.isPending && onOpenChange(open)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add a domain managed elsewhere</DialogTitle>
          <DialogDescription>
            For a domain whose DNS you keep yourself. Web routes can use names
            under it, Kiln keeps each one to the instance that has it, and shows
            the record to point at its Relay. Kiln writes no records.
          </DialogDescription>
        </DialogHeader>
        <form
          id="add-manual-domain"
          className="grid gap-3"
          onSubmit={(event) => {
            event.preventDefault()
            if (domain.trim()) add.mutate()
          }}
        >
          <Input
            {...notALoginField}
            autoFocus
            aria-label="Domain"
            className="font-mono"
            disabled={add.isPending}
            placeholder="example.com"
            value={domain}
            onChange={(event) => setDomain(event.target.value)}
          />
          {canManagePlatform ? (
            <label className="flex items-center justify-between gap-3 text-xs">
              Kiln's, managed by administrators
              <Switch
                checked={platform}
                disabled={add.isPending}
                onCheckedChange={setPlatform}
              />
            </label>
          ) : null}
          {add.error ? (
            <p className="text-xs text-destructive" role="alert">
              {add.error.message}
            </p>
          ) : null}
        </form>
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            disabled={add.isPending}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            form="add-manual-domain"
            disabled={!domain.trim() || add.isPending}
          >
            {add.isPending ? (
              <LoaderCircle className="animate-spin" />
            ) : (
              <Plus />
            )}
            Add
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
