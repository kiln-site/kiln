import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { MAXIMUM_INSTANCE_NAME_LENGTH, type Brick } from "@workspace/contracts"
import { ChevronRight, CircleAlert, LoaderCircle, Plus } from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import { showToast } from "@workspace/ui/components/sonner"

import type { AddableKind } from "@/components/brick-kinds"
import { OfferedBrickBrowser } from "@/components/offered-brick-browser"
import {
  errorMessage,
  normalizeTld,
  useSetTunnels,
  useTunnels,
  type TunnelsResult,
} from "@/components/tunnel/tunnel-data"
import {
  initialLogin,
  loginComplete,
  TailscaleLoginFields,
  TailscaleLoginHelp,
} from "@/components/tunnel/tunnel-settings"
import { recoverPromise } from "@/effect/promise"
import { notALoginField } from "@/lib/not-a-login-field"
import {
  tunnelsQueryOptions,
  tunnelBricksQueryOptions,
} from "@/lib/query-options"
import { createTunnel } from "@/server/tunnels"

// A tunnel in the Add dialog: the catalogs' tunnel Bricks, and what a new
// one is asked beside the Brick chosen: its name, its first TLD and its
// Tailscale login. It runs nowhere yet; its gateways follow what connects.

export const AddTunnelPane = React.memo(function AddTunnelPane({
  kinds,
  onClose,
  onKindChange,
}: {
  kinds: ReadonlyArray<AddableKind>
  onClose: () => void
  onKindChange: (kind: AddableKind) => void
}) {
  const bricks = useQuery(tunnelBricksQueryOptions())
  const [pending, setPending] = React.useState(false)
  return (
    <OfferedBrickBrowser
      bricks={bricks.data}
      disabled={pending}
      emptyMessage="No tunnel Bricks are in your catalogs."
      error={bricks.error?.message}
      initial={tailscaleBrick}
      kind="tunnel"
      kinds={kinds}
      pending={bricks.isPending}
      onKindChange={onKindChange}
    >
      {(brick) => (
        <NewTunnelForm
          brick={brick}
          onClose={onClose}
          onPendingChange={setPending}
        />
      )}
    </OfferedBrickBrowser>
  )
})

const tailscaleBrick = (bricks: ReadonlyArray<Brick>) =>
  bricks.find((brick) => brick.type === "tailscale")

interface AddTunnelInput {
  brick: string
  login: ReturnType<typeof initialLogin>
  name: string
  tld: string
}

function NewTunnelForm({
  brick,
  onClose,
  onPendingChange,
}: {
  brick: Brick | null
  onClose: () => void
  onPendingChange: (pending: boolean) => void
}) {
  const { data: tunnels } = useTunnels()
  const [name, setName] = React.useState("")
  // A TLD is unique across Kiln, so `kiln` only while no tunnel has it.
  const [tld, setTld] = React.useState(() =>
    tunnels.tunnels.some((tunnel) => tunnel.domains.includes("kiln"))
      ? ""
      : "kiln"
  )
  const [login, setLogin] = React.useState(() => initialLogin())
  const add = useAddTunnel({ onClose, onPendingChange })
  const ready =
    brick !== null &&
    name.trim().length > 0 &&
    normalizeTld(tld).length > 0 &&
    loginComplete(login, true)

  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault()
        event.stopPropagation()
        if (!ready || !brick || add.isPending) return
        add.mutate({ brick: brick.source, login, name: name.trim(), tld })
      }}
    >
      <p className="type-technical-label text-muted-foreground">
        Tunnel details
      </p>
      <p className="text-xs leading-relaxed text-muted-foreground">
        A tunnel puts what you connect to it on your Tailscale tailnet, by name.
        Kiln adds a gateway on each Relay something connected runs on.
      </p>
      <label className="block space-y-1.5 text-xs font-medium text-muted-foreground">
        <span>Name</span>
        <Input
          {...notALoginField}
          autoFocus
          disabled={add.isPending}
          maxLength={MAXIMUM_INSTANCE_NAME_LENGTH}
          placeholder="Home"
          value={name}
          onChange={(event) => setName(event.currentTarget.value)}
        />
      </label>
      <label className="block space-y-1.5 text-xs font-medium text-muted-foreground">
        <span>TLD</span>
        <Input
          {...notALoginField}
          className="font-mono"
          disabled={add.isPending}
          placeholder="kiln"
          value={tld}
          onChange={(event) => setTld(event.currentTarget.value)}
        />
        <span className="block font-normal">
          What's connected is named under it, like survival.
          {normalizeTld(tld) || "kiln"}. Add more on its Info page.
        </span>
      </label>
      <TailscaleLoginFields
        compact
        disabled={add.isPending}
        hasSecret={false}
        values={login}
        onChange={setLogin}
      />
      <details className="group text-xs">
        <summary className="flex cursor-pointer list-none items-center gap-1 font-medium text-muted-foreground hover:text-foreground">
          <ChevronRight className="size-3.5 transition-transform group-open:rotate-90" />
          What the OAuth client needs
        </summary>
        <div className="mt-2">
          <TailscaleLoginHelp tag={login.tag} />
        </div>
      </details>
      {add.isPending ? (
        <p className="flex items-start gap-2 text-xs leading-relaxed text-muted-foreground">
          <LoaderCircle className="mt-0.5 size-3.5 shrink-0 animate-spin" />
          Checking the Tailscale login.
        </p>
      ) : add.error ? (
        <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/8 px-3 py-2 text-xs text-destructive light:bg-destructive/16">
          <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
          {errorMessage(add.error)}
        </div>
      ) : null}
      <div className="grid grid-cols-2 gap-2 pt-1">
        <Button type="button" variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button disabled={!ready || add.isPending} type="submit">
          {add.isPending ? <LoaderCircle className="animate-spin" /> : <Plus />}
          {add.isPending ? "Creating…" : "Create"}
        </Button>
      </div>
    </form>
  )
}

/**
 * Makes the tunnel and opens it. A request dropped on the way back is
 * checked against what Hearth now has before it reads as a failure.
 */
function useAddTunnel({
  onClose,
  onPendingChange,
}: {
  onClose: () => void
  onPendingChange: (pending: boolean) => void
}) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const setTunnels = useSetTunnels()

  // The tunnel made, by its TLD, which no other tunnel has.
  const made = (result: TunnelsResult, input: AddTunnelInput) =>
    result.tunnels.find((tunnel) =>
      tunnel.domains.includes(normalizeTld(input.tld))
    ) ?? null

  const finish = async (result: TunnelsResult, input: AddTunnelInput) => {
    const tunnel = made(result, input)
    if (!tunnel) return false
    setTunnels(result)
    showToast({ message: `${tunnel.name} is ready`, type: "success" })
    onClose()
    await navigate({
      params: { tunnelId: tunnel.id },
      to: "/tunnel/$tunnelId/info",
    })
    return true
  }

  return useMutation({
    mutationFn: (input: AddTunnelInput) =>
      createTunnel({
        data: {
          brick: input.brick,
          clientId: input.login.clientId.trim(),
          clientSecret: input.login.clientSecret.trim(),
          domains: [normalizeTld(input.tld)],
          name: input.name,
          tag: input.login.tag.trim(),
        },
      }),
    onMutate: () => onPendingChange(true),
    onSuccess: async (next, input) => {
      await finish(next, input)
    },
    onError: async (cause, input) => {
      // The create may have gone through though its answer never arrived.
      const fresh = await recoverPromise(
        () =>
          queryClient.fetchQuery({ ...tunnelsQueryOptions(), staleTime: 0 }),
        () => null
      )
      if (fresh && (await finish(fresh, input))) return
      showToast({
        description: errorMessage(cause),
        duration: 8_000,
        message: "The tunnel wasn't created",
        type: "error",
      })
    },
    onSettled: () => onPendingChange(false),
  })
}
