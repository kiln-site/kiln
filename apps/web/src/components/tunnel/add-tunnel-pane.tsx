import * as React from "react"
import { useMutation, useQuery } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { LoaderCircle, Plus } from "lucide-react"
import { MAXIMUM_INSTANCE_NAME_LENGTH } from "@workspace/contracts"

import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select"
import { showToast } from "@workspace/ui/components/sonner"

import { AddKindNavigation } from "@/components/add-kind-navigation"
import type { AddableKind } from "@/components/brick-kinds"
import {
  errorMessage,
  normalizeTld,
  tailnetSaveInput,
  useSetTailnets,
  useTailnets,
  useTailscaleTunnelBrick,
  type TailnetsResult,
} from "@/components/tunnel/tailnet-data"
import {
  initialLogin,
  loginComplete,
  TailscaleLoginFields,
  TailscaleLoginHelp,
} from "@/components/tunnel/tailnet-settings"
import { notALoginField } from "@/lib/not-a-login-field"
import { relaysQueryOptions } from "@/lib/query-options"
import { createTailnet, saveTailnet } from "@/server/tunnels"

// A tunnel in the Add dialog. Its only type is Tailscale: pick a Relay, then
// a tailnet that has no tunnel there yet, or a new one with its name, first
// TLD and Tailscale login. Tunnels aren't Bricks.

const NEW_TAILNET = "new"

export const AddTunnelPane = React.memo(function AddTunnelPane({
  kinds,
  onClose,
  onKindChange,
}: {
  kinds: ReadonlyArray<AddableKind>
  onClose: () => void
  onKindChange: (kind: AddableKind) => void
}) {
  const navigate = useNavigate()
  const setTailnets = useSetTailnets()
  const { data: relays = [] } = useQuery({
    ...relaysQueryOptions(),
    select: (all) => all.filter((relay) => relay.enabled),
  })
  const { data: tailnets } = useTailnets()
  const [chosenRelay, setRelayId] = React.useState<string | null>(null)
  const relayId = chosenRelay ?? relays[0]?.id ?? ""
  // Tailnets that could have a tunnel here: not being deleted, none yet.
  const open = React.useMemo(
    () =>
      tailnets.stacks.filter(
        (tailnet) =>
          tailnet.access.manage &&
          !tailnet.cleanup &&
          tailnet.integration !== null &&
          !tailnet.deployments.some(
            (deployment) => deployment.relayId === relayId
          )
      ),
    [relayId, tailnets.stacks]
  )
  const [chosenTailnet, setTailnetId] = React.useState<string | null>(null)
  const tailnetId =
    chosenTailnet &&
    (chosenTailnet === NEW_TAILNET ||
      open.some(({ id }) => id === chosenTailnet))
      ? chosenTailnet
      : (open[0]?.id ?? NEW_TAILNET)
  const [name, setName] = React.useState("Home")
  const [tld, setTld] = React.useState("kiln")
  const [login, setLogin] = React.useState(() => initialLogin())
  const creating = tailnetId === NEW_TAILNET
  const relayName = relays.find(({ id }) => id === relayId)?.name ?? ""

  // The Brick a tunnel is made from: Kiln's Tailscale one.
  const brick = useTailscaleTunnelBrick()
  const add = useMutation({
    mutationFn: async () => {
      let result: TailnetsResult = tailnets
      let id = tailnetId
      if (creating) {
        const domain = normalizeTld(tld)
        result = await createTailnet({
          data: {
            clientId: login.clientId.trim(),
            clientSecret: login.clientSecret.trim(),
            domains: [domain],
            name: name.trim(),
            tag: login.tag.trim(),
          },
        })
        setTailnets(result)
        // A TLD is unique across Kiln, so it finds the one just made.
        id =
          result.stacks.find((stack) => stack.domains.includes(domain))?.id ??
          ""
      }
      const tailnet = result.stacks.find((stack) => stack.id === id)
      if (!tailnet) throw new Error("The tailnet is gone")
      const next = await saveTailnet({
        data: tailnetSaveInput(tailnet, {
          brick,
          relayIds: [
            ...tailnet.deployments.map((deployment) => deployment.relayId),
            relayId,
          ],
        }),
      })
      return { next, tailnetId: id }
    },
    onSuccess: async ({ next, tailnetId: id }) => {
      setTailnets(next)
      const tunnel = next.stacks
        .find((stack) => stack.id === id)
        ?.deployments.find((deployment) => deployment.relayId === relayId)
      showToast({ message: `A tunnel runs on ${relayName}`, type: "success" })
      onClose()
      await navigate(
        tunnel
          ? { params: { tunnelId: tunnel.id }, to: "/tunnel/$tunnelId/info" }
          : { params: { tailnetId: id }, to: "/tailnet/$tailnetId" }
      )
    },
  })
  const canSubmit =
    Boolean(relayId) &&
    brick !== undefined &&
    !add.isPending &&
    (!creating ||
      (name.trim().length > 0 &&
        normalizeTld(tld).length > 0 &&
        loginComplete(login, true)))

  return (
    <div className="grid h-full min-h-0 overflow-hidden max-md:grid-rows-[max-content_minmax(0,1fr)] max-md:overflow-y-auto md:grid-cols-[10.5rem_minmax(0,1fr)]">
      <aside className="flex min-h-0 flex-col border-b border-border/60 md:border-r md:border-b-0">
        <AddKindNavigation
          disabled={add.isPending}
          kind="tunnel"
          kinds={kinds}
          onKindChange={onKindChange}
        />
      </aside>
      <form
        className="grid min-h-0 overflow-y-auto md:grid-cols-[minmax(0,1fr)_17rem]"
        onSubmit={(event) => {
          event.preventDefault()
          if (canSubmit) add.mutate()
        }}
      >
        <section className="min-w-0 space-y-5 p-5 sm:p-6">
          <div>
            <h2 className="font-heading text-lg font-semibold">
              Tunnel · Tailscale
            </h2>
            <p className="type-support mt-1 text-muted-foreground">
              Reach what runs on a Relay by name from anywhere on your tailnet.
              Tailscale and CoreDNS run beside it.
            </p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="grid gap-2">
              <span className="text-xs font-medium">Relay</span>
              <Select value={relayId} onValueChange={setRelayId}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="No Relays" />
                </SelectTrigger>
                <SelectContent>
                  {relays.map((relay) => (
                    <SelectItem key={relay.id} value={relay.id}>
                      {relay.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            <label className="grid gap-2">
              <span className="text-xs font-medium">Tailnet</span>
              <Select value={tailnetId} onValueChange={setTailnetId}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {open.map((tailnet) => (
                    <SelectItem key={tailnet.id} value={tailnet.id}>
                      {tailnet.name}
                    </SelectItem>
                  ))}
                  <SelectItem value={NEW_TAILNET}>New tailnet</SelectItem>
                </SelectContent>
              </Select>
            </label>
          </div>
          {creating ? (
            <>
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="block">
                  <span className="mb-2 block text-xs font-medium">
                    Tailnet name
                  </span>
                  <Input
                    {...notALoginField}
                    maxLength={MAXIMUM_INSTANCE_NAME_LENGTH}
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                  />
                </label>
                <label className="block">
                  <span className="mb-2 block text-xs font-medium">TLD</span>
                  <Input
                    {...notALoginField}
                    value={tld}
                    placeholder="kiln"
                    className="font-mono"
                    onChange={(event) => setTld(event.target.value)}
                  />
                  <span className="type-meta mt-1.5 block text-muted-foreground">
                    What's connected is named under it, like survival.
                    {normalizeTld(tld) || "kiln"}. Add more later.
                  </span>
                </label>
              </div>
              <TailscaleLoginFields
                disabled={add.isPending}
                hasSecret={false}
                values={login}
                onChange={setLogin}
              />
            </>
          ) : null}
          {add.error ? (
            <p
              className="border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-xs text-destructive light:bg-destructive/10"
              role="alert"
            >
              {errorMessage(add.error)}
            </p>
          ) : null}
          <div className="flex justify-end gap-2 border-t pt-4">
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {add.isPending ? (
                <LoaderCircle className="animate-spin" />
              ) : (
                <Plus />
              )}
              {add.isPending ? "Adding…" : "Add tunnel"}
            </Button>
          </div>
        </section>
        {creating ? (
          <aside className="border-t bg-muted/15 p-5 md:border-t-0 md:border-l">
            <TailscaleLoginHelp tag={login.tag} />
          </aside>
        ) : null}
      </form>
    </div>
  )
})
