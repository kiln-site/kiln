import * as React from "react"
import { useMutation } from "@tanstack/react-query"
import {
  ArrowDown,
  ArrowUp,
  Check,
  ExternalLink,
  KeyRound,
  LoaderCircle,
  Plus,
  X,
} from "lucide-react"
import { MAXIMUM_INSTANCE_NAME_LENGTH } from "@workspace/contracts"

import { Badge } from "@workspace/ui/components/badge"
import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import { showToast } from "@workspace/ui/components/sonner"

import {
  normalizeTld,
  useSetTailnets,
  useTailnetSave,
  type TunnelOverview,
} from "@/components/tunnel/tailnet-data"
import { notALoginField } from "@/lib/not-a-login-field"
import { configureTailscaleIntegration } from "@/server/tunnels"

// What a tailnet shares: its name and TLDs, and its Tailscale login.

const MAXIMUM_TLDS = 16

/** The Tailscale login's fields, for a new tailnet or one that has one. */
export interface TailscaleLoginValues {
  clientId: string
  clientSecret: string
  tag: string
}

export function initialLogin(
  tailnet?: Pick<TunnelOverview, "integration">
): TailscaleLoginValues {
  return {
    clientId: tailnet?.integration?.clientId ?? "",
    clientSecret: "",
    tag: tailnet?.integration?.tags[0] ?? "tag:kiln",
  }
}

/** Whether the login can be checked: a new one needs its secret. */
export function loginComplete(
  values: TailscaleLoginValues,
  secretRequired: boolean
): boolean {
  const secret = values.clientSecret.trim()
  return (
    values.clientId.trim().length > 0 &&
    values.tag.trim().length > 0 &&
    (secretRequired ? secret.length >= 20 : !secret || secret.length >= 20)
  )
}

export function TailscaleLoginFields({
  compact = false,
  disabled,
  hasSecret,
  values,
  onChange,
}: {
  /** One field a row, for a narrow column. */
  compact?: boolean
  disabled?: boolean
  /** A saved secret stays when this is left blank. */
  hasSecret: boolean
  values: TailscaleLoginValues
  onChange: (values: TailscaleLoginValues) => void
}) {
  const set =
    (field: keyof TailscaleLoginValues) =>
    (event: React.ChangeEvent<HTMLInputElement>) =>
      onChange({ ...values, [field]: event.target.value })
  return (
    <div className={compact ? "grid gap-3" : "grid gap-4 sm:grid-cols-2"}>
      <label className="block">
        <span className="mb-2 block text-xs font-medium">OAuth client ID</span>
        <Input
          {...notALoginField}
          disabled={disabled}
          value={values.clientId}
          onChange={set("clientId")}
          placeholder="kAbCdEfGh123CNTRL"
          className="font-mono"
        />
      </label>
      <label className="block">
        <span className="mb-2 block text-xs font-medium">Device tag</span>
        <Input
          {...notALoginField}
          disabled={disabled}
          value={values.tag}
          onChange={set("tag")}
          placeholder="tag:kiln"
          className="font-mono"
        />
      </label>
      <label className={compact ? "block" : "block sm:col-span-2"}>
        <span className="mb-2 block text-xs font-medium">
          OAuth client secret
        </span>
        <Input
          {...notALoginField}
          type="password"
          disabled={disabled}
          value={values.clientSecret}
          onChange={set("clientSecret")}
          placeholder={
            hasSecret
              ? "Unchanged"
              : "tskey-client-kAbCdEfGh123CNTRL-a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6"
          }
          className="font-mono"
        />
      </label>
    </div>
  )
}

const credentialPermissions = [
  { group: "General", permission: "DNS" },
  { group: "Devices", permission: "Core" },
  { group: "Devices", permission: "Routes" },
  { group: "Keys", permission: "Auth Keys" },
] as const

/** What the OAuth client needs from Tailscale, and where to make one. */
export function TailscaleLoginHelp({ tag }: { tag: string }) {
  const shown = tag.trim().startsWith("tag:")
    ? tag.trim()
    : `tag:${tag.trim() || "kiln"}`
  return (
    <div>
      <h3 className="text-xs font-semibold">What the OAuth client needs</h3>
      <Button
        asChild
        type="button"
        size="sm"
        variant="outline"
        className="mt-3 w-full"
      >
        <a
          href="https://console.tailscale.com/admin/settings/trust-credentials/add"
          target="_blank"
          rel="noreferrer"
        >
          Create an OAuth client
          <ExternalLink />
        </a>
      </Button>
      <ul className="mt-3 divide-y divide-border/70 border border-border/70">
        {credentialPermissions.map(({ group, permission }) => (
          <li
            key={`${group}:${permission}`}
            className="flex items-center justify-between gap-3 px-2.5 py-2"
          >
            <span className="flex min-w-0 items-baseline gap-1">
              <span className="type-technical-label shrink-0 text-muted-foreground">
                {group} /
              </span>
              <span className="truncate text-xs font-medium">{permission}</span>
            </span>
            <span className="type-technical-label shrink-0 text-primary-ink">
              Write
            </span>
          </li>
        ))}
      </ul>
      <p className="type-meta mt-3 leading-relaxed text-muted-foreground">
        For Devices → Core and Keys → Auth Keys, select{" "}
        <span className="font-mono text-foreground">{shown}</span> under Tags.
      </p>
    </div>
  )
}

/** A tailnet's Tailscale login, checked with Tailscale as it's saved. */
export const TailnetLoginCard = React.memo(function TailnetLoginCard({
  tailnet,
}: {
  tailnet: TunnelOverview
}) {
  const [values, setValues] = React.useState(() => initialLogin(tailnet))
  const setTailnets = useSetTailnets()
  const save = useMutation({
    mutationFn: () =>
      configureTailscaleIntegration({
        data: {
          clientId: values.clientId.trim(),
          clientSecret: values.clientSecret.trim() || undefined,
          domains: tailnet.domains,
          id: tailnet.id,
          previousDomains: tailnet.domains,
          tag: values.tag.trim(),
        },
      }),
    onSuccess: (configured) => {
      setTailnets(configured.result)
      setValues((current) => ({ ...current, clientSecret: "" }))
      showToast({
        message: `${tailnet.name}'s Tailscale login is checked and saved`,
        type: "success",
      })
    },
  })
  const hasSecret = tailnet.integration !== null
  const changed =
    values.clientId.trim() !== (tailnet.integration?.clientId ?? "") ||
    values.tag.trim() !== (tailnet.integration?.tags[0] ?? "") ||
    values.clientSecret.trim().length > 0
  return (
    <form
      className="grid gap-5 p-4 md:grid-cols-[minmax(0,1fr)_16rem]"
      onSubmit={(event) => {
        event.preventDefault()
        save.mutate()
      }}
    >
      <div className="min-w-0">
        {tailnet.integration?.lastError ? (
          <p
            className="mb-4 border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-xs text-destructive light:bg-destructive/10"
            role="alert"
          >
            {tailnet.integration.lastError}
          </p>
        ) : null}
        <TailscaleLoginFields
          disabled={save.isPending}
          hasSecret={hasSecret}
          values={values}
          onChange={setValues}
        />
        {save.error ? (
          <p className="mt-3 text-xs text-destructive" role="alert">
            {save.error.message}
          </p>
        ) : null}
        <div className="mt-4 flex justify-end">
          <Button
            type="submit"
            size="sm"
            disabled={
              !changed || !loginComplete(values, !hasSecret) || save.isPending
            }
          >
            {save.isPending ? (
              <LoaderCircle className="animate-spin" />
            ) : (
              <KeyRound />
            )}
            {save.isPending ? "Checking…" : "Check and save"}
          </Button>
        </div>
      </div>
      <aside className="border-t pt-4 md:border-t-0 md:border-l md:pt-0 md:pl-5">
        <TailscaleLoginHelp tag={values.tag} />
      </aside>
    </form>
  )
})

/**
 * A tailnet's name and its TLDs, in order. Generated names are under the
 * first; Tailscale's split DNS sends every one to its tunnels.
 */
export const TailnetSettingsCard = React.memo(function TailnetSettingsCard({
  canWrite,
  tailnet,
}: {
  canWrite: boolean
  tailnet: TunnelOverview
}) {
  const [name, setName] = React.useState(tailnet.name)
  const [domains, setDomains] = React.useState(tailnet.domains)
  const [adding, setAdding] = React.useState("")
  const save = useTailnetSave()
  const nextTld = normalizeTld(adding)
  const changed =
    name.trim() !== tailnet.name ||
    domains.join(" ") !== tailnet.domains.join(" ")
  const disabled = !canWrite || save.isPending
  const move = (index: number, by: number) =>
    setDomains((current) => {
      const next = [...current]
      const [moved] = next.splice(index, 1)
      next.splice(index + by, 0, moved!)
      return next
    })
  const addTld = () => {
    if (!nextTld || domains.includes(nextTld)) return
    setDomains((current) => [...current, nextTld])
    setAdding("")
  }
  return (
    <form
      className="grid gap-4 p-4"
      onSubmit={(event) => {
        event.preventDefault()
        if (!changed || name.trim().length === 0) return
        save.mutate({
          change: { domains, name: name.trim() },
          doing: "Saving its name and TLDs on every tunnel",
          done: "Its name and TLDs are saved",
          tailnet,
        })
      }}
    >
      <label className="block max-w-sm">
        <span className="mb-2 block text-xs font-medium">Name</span>
        <Input
          {...notALoginField}
          disabled={disabled}
          maxLength={MAXIMUM_INSTANCE_NAME_LENGTH}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <div>
        <p className="mb-2 text-xs font-medium">TLDs</p>
        <ol className="divide-y divide-border/65 rounded-lg border border-border/70">
          {domains.map((domain, index) => (
            <li key={domain} className="flex items-center gap-2 px-3 py-1.5">
              <span className="min-w-0 flex-1 truncate font-mono text-xs">
                .{domain}
              </span>
              {index === 0 ? (
                <Badge variant="outline" className="type-meta">
                  Generated names
                </Badge>
              ) : null}
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                aria-label={`Move .${domain} up`}
                disabled={disabled || index === 0}
                onClick={() => move(index, -1)}
              >
                <ArrowUp />
              </Button>
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                aria-label={`Move .${domain} down`}
                disabled={disabled || index === domains.length - 1}
                onClick={() => move(index, 1)}
              >
                <ArrowDown />
              </Button>
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                aria-label={`Remove .${domain}`}
                disabled={disabled || domains.length === 1}
                onClick={() =>
                  setDomains((current) =>
                    current.filter((candidate) => candidate !== domain)
                  )
                }
              >
                <X />
              </Button>
            </li>
          ))}
        </ol>
        {canWrite && domains.length < MAXIMUM_TLDS ? (
          <div className="mt-2 flex max-w-sm gap-2">
            <Input
              {...notALoginField}
              aria-label="Another TLD"
              disabled={disabled}
              placeholder="test"
              value={adding}
              className="font-mono"
              onChange={(event) => setAdding(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return
                event.preventDefault()
                addTld()
              }}
            />
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={disabled || !nextTld || domains.includes(nextTld)}
              onClick={addTld}
            >
              <Plus />
              Add
            </Button>
          </div>
        ) : null}
        <p className="type-meta mt-2 text-muted-foreground">
          Moving another TLD first moves every generated name under it. An alias
          under a TLD that's removed is forgotten.
        </p>
      </div>
      {save.error ? (
        <p className="text-xs text-destructive" role="alert">
          {save.error.message}
        </p>
      ) : null}
      {canWrite ? (
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={!changed || save.isPending}
            onClick={() => {
              setName(tailnet.name)
              setDomains(tailnet.domains)
            }}
          >
            Undo
          </Button>
          <Button
            type="submit"
            size="sm"
            disabled={!changed || !name.trim() || save.isPending}
          >
            {save.isPending ? (
              <LoaderCircle className="animate-spin" />
            ) : (
              <Check />
            )}
            Save
          </Button>
        </div>
      ) : null}
    </form>
  )
})
