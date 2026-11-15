import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import type { Brick } from "@workspace/contracts"
import { ChevronRight, CircleAlert, LoaderCircle, Plus } from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import { showToast } from "@workspace/ui/components/sonner"

import type { AddableKind } from "@/components/brick-kinds"
import {
  BrickRelayField,
  useBrickRelayReady,
  type BrickRelayOption,
} from "@/components/brick-relay-field"
import { OfferedBrickBrowser } from "@/components/offered-brick-browser"
import { recoverPromise } from "@/effect/promise"
import {
  errorMessage,
  normalizeTld,
  tailnetSaveInput,
  useSetTailnets,
  useTailnets,
  type TailnetOverview,
  type TailnetsResult,
} from "@/components/tunnel/tailnet-data"
import {
  TailnetField,
  type TailnetChoice,
} from "@/components/tunnel/tailnet-field"
import {
  initialLogin,
  loginComplete,
  TailscaleLoginFields,
  TailscaleLoginHelp,
} from "@/components/tunnel/tailnet-settings"
import { infraRelayOptionsQueryOptions } from "@/lib/infra-directory"
import { notALoginField } from "@/lib/not-a-login-field"
import {
  tailnetsQueryOptions,
  tunnelBricksQueryOptions,
} from "@/lib/query-options"
import { createTailnet, saveTailnet } from "@/server/tunnels"

// A tunnel in the Add dialog: the catalogs' tunnel Bricks, and what a new
// one is asked beside the Brick chosen. It runs on a Relay and joins a
// tailnet, one there is or one made with it.

const NO_RELAYS: ReadonlyArray<BrickRelayOption> = []

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

const creatableRelays = ({
  relays,
}: {
  relays: ReadonlyArray<BrickRelayOption & { canCreate: boolean }>
}): ReadonlyArray<BrickRelayOption> => relays.filter((relay) => relay.canCreate)

interface AddTunnelInput {
  authKey: string
  brick: string
  choice: TailnetChoice
  login: ReturnType<typeof initialLogin>
  relayId: string
  relayName: string
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
  const { data: relays = NO_RELAYS } = useQuery({
    ...infraRelayOptionsQueryOptions("tunnel"),
    select: creatableRelays,
  })
  const [chosenRelayId, setRelayId] = React.useState<string | null>(null)
  const relayId = chosenRelayId ?? relays[0]?.id ?? ""
  const relayName = relays.find(({ id }) => id === relayId)?.name ?? ""
  const { compatible, connected } = useBrickRelayReady(relays, relayId, brick)

  const { data: tailnets } = useTailnets()
  // The tailnets a tunnel here could join: changeable, not being deleted,
  // and with no tunnel on this Relay yet.
  const joinable = React.useMemo(
    () =>
      tailnets.stacks.filter(
        (tailnet) =>
          tailnet.access.manage &&
          !tailnet.cleanup &&
          !tailnet.deployments.some(
            (deployment) => deployment.relayId === relayId
          )
      ),
    [relayId, tailnets.stacks]
  )
  const [picked, setPicked] = React.useState<TailnetChoice | null>(null)
  // The one picked while it can still be joined here, else the first.
  const choice: TailnetChoice | null =
    picked?.kind === "new" ||
    (picked?.kind === "existing" && joinable.some(({ id }) => id === picked.id))
      ? picked
      : joinable[0]
        ? { kind: "existing", id: joinable[0].id }
        : null
  const existing =
    choice?.kind === "existing"
      ? joinable.find(({ id }) => id === choice.id)
      : undefined
  const creating = choice?.kind === "new"
  // A tailnet with no Tailscale login of its own takes a one-time key.
  const needsAuthKey = existing !== undefined && existing.integration === null

  // A TLD is unique across Kiln, so `kiln` only while no tailnet has it.
  const [tld, setTld] = React.useState(() =>
    tailnets.stacks.some((tailnet) => tailnet.domains.includes("kiln"))
      ? ""
      : "kiln"
  )
  const [login, setLogin] = React.useState(() => initialLogin())
  const [authKey, setAuthKey] = React.useState("")

  const add = useAddTunnel({ onClose, onPendingChange })
  const ready =
    brick !== null &&
    Boolean(relayId) &&
    compatible &&
    connected &&
    choice !== null &&
    (!creating ||
      (normalizeTld(tld).length > 0 && loginComplete(login, true))) &&
    (!needsAuthKey || authKey.trim().length > 0)

  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault()
        event.stopPropagation()
        if (!ready || !brick || !choice || add.isPending) return
        add.mutate({
          authKey: authKey.trim(),
          brick: brick.source,
          choice,
          login,
          relayId,
          relayName,
          tld,
        })
      }}
    >
      <p className="type-technical-label text-muted-foreground">
        Tunnel details
      </p>
      <BrickRelayField
        brick={brick}
        disabled={add.isPending}
        relays={relays}
        value={relayId}
        onChange={setRelayId}
      />
      <TailnetField
        disabled={add.isPending}
        tailnets={joinable}
        value={choice}
        onChange={setPicked}
      />
      {creating ? (
        <NewTailnetFields
          disabled={add.isPending}
          login={login}
          tld={tld}
          onLoginChange={setLogin}
          onTldChange={setTld}
        />
      ) : null}
      {needsAuthKey ? (
        <label className="block space-y-1.5 text-xs font-medium text-muted-foreground">
          <span>Auth key</span>
          <Input
            {...notALoginField}
            type="password"
            className="font-mono"
            disabled={add.isPending}
            placeholder="tskey-auth-…"
            value={authKey}
            onChange={(event) => setAuthKey(event.currentTarget.value)}
          />
          <span className="block font-normal">
            {existing?.name} has no Tailscale login, so this tunnel joins with a
            one-time key from its Tailscale admin console.
          </span>
        </label>
      ) : null}
      {add.isPending ? (
        <p className="flex items-start gap-2 text-xs leading-relaxed text-muted-foreground">
          <LoaderCircle className="mt-0.5 size-3.5 shrink-0 animate-spin" />
          Starting Tailscale on {relayName}. It logs in before the tunnel is
          ready, which can take a minute.
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
          {add.isPending ? "Starting…" : "Create"}
        </Button>
      </div>
    </form>
  )
}

// What a new tailnet is asked: its first TLD and its Tailscale login.
function NewTailnetFields({
  disabled,
  login,
  onLoginChange,
  onTldChange,
  tld,
}: {
  disabled: boolean
  login: ReturnType<typeof initialLogin>
  onLoginChange: (login: ReturnType<typeof initialLogin>) => void
  onTldChange: (tld: string) => void
  tld: string
}) {
  return (
    <div className="space-y-3 border-l-2 border-primary/30 pl-3">
      <label className="block space-y-1.5 text-xs font-medium text-muted-foreground">
        <span>TLD</span>
        <Input
          {...notALoginField}
          className="font-mono"
          disabled={disabled}
          placeholder="kiln"
          value={tld}
          onChange={(event) => onTldChange(event.currentTarget.value)}
        />
        <span className="block font-normal">
          What's connected is named under it, like survival.
          {normalizeTld(tld) || "kiln"}. Add more later.
        </span>
      </label>
      <TailscaleLoginFields
        compact
        disabled={disabled}
        hasSecret={false}
        values={login}
        onChange={onLoginChange}
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
    </div>
  )
}

/**
 * Makes the tunnel, and its tailnet first when it's new. Tailscale logs in
 * before the save returns, which takes a while, so a toast follows it; a
 * request dropped on the way back is checked against what Hearth now has
 * before it reads as a failure.
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
  const setTailnets = useSetTailnets()
  const toastId = "kiln-add-tunnel"

  // The tunnel on the Relay, in the tailnet just made or picked, if any.
  const tunnelIn = (
    result: TailnetsResult,
    input: AddTunnelInput
  ): { tailnet: TailnetOverview; tunnelId: string | null } | null => {
    const tld = normalizeTld(input.tld)
    const tailnet = result.stacks.find((stack) =>
      input.choice.kind === "existing"
        ? stack.id === input.choice.id
        : stack.domains.includes(tld)
    )
    if (!tailnet) return null
    const tunnel = tailnet.deployments.find(
      (deployment) => deployment.relayId === input.relayId
    )
    return { tailnet, tunnelId: tunnel?.id ?? null }
  }

  const finish = async (
    result: TailnetsResult,
    input: AddTunnelInput,
    found: { tailnet: TailnetOverview; tunnelId: string | null }
  ) => {
    setTailnets(result)
    showToast({
      description: `Joined ${found.tailnet.name}`,
      duration: 5_000,
      id: toastId,
      message: `A tunnel runs on ${input.relayName}`,
      type: "success",
    })
    onClose()
    await navigate(
      found.tunnelId
        ? { params: { tunnelId: found.tunnelId }, to: "/tunnel/$tunnelId/info" }
        : { params: { tailnetId: found.tailnet.id }, to: "/tailnet/$tailnetId" }
    )
  }

  return useMutation({
    mutationFn: async (input: AddTunnelInput) => {
      let result = await queryClient.ensureQueryData(tailnetsQueryOptions())
      let tailnet = tunnelIn(result, input)?.tailnet
      // A new tailnet, unless a try that failed after making it made it.
      if (!tailnet && input.choice.kind === "new") {
        result = await createTailnet({
          data: {
            clientId: input.login.clientId.trim(),
            clientSecret: input.login.clientSecret.trim(),
            domains: [normalizeTld(input.tld)],
            name: input.choice.name,
            tag: input.login.tag.trim(),
          },
        })
        setTailnets(result)
        tailnet = tunnelIn(result, input)?.tailnet
      }
      if (!tailnet) throw new Error("The tailnet is gone")
      const next = await saveTailnet({
        data: tailnetSaveInput(tailnet, {
          ...(input.authKey ? { authKey: input.authKey } : {}),
          brick: input.brick,
          relayIds: [
            ...tailnet.deployments.map((deployment) => deployment.relayId),
            input.relayId,
          ],
        }),
      })
      return next
    },
    onMutate: (input) => {
      onPendingChange(true)
      showToast({
        description: "Tailscale is logging in, which can take a minute.",
        duration: Infinity,
        id: toastId,
        message: `Starting a tunnel on ${input.relayName}`,
        type: "loading",
      })
    },
    onSuccess: async (next, input) => {
      const found = tunnelIn(next, input)
      if (found) await finish(next, input, found)
    },
    onError: async (cause, input) => {
      // The save may have gone through though its answer never arrived.
      const fresh = await recoverPromise(
        () =>
          queryClient.fetchQuery({ ...tailnetsQueryOptions(), staleTime: 0 }),
        () => null
      )
      const found = fresh ? tunnelIn(fresh, input) : null
      if (fresh && found?.tunnelId) {
        await finish(fresh, input, found)
        return
      }
      showToast({
        description: errorMessage(cause),
        duration: 8_000,
        id: toastId,
        message: "The tunnel wasn't started",
        type: "error",
      })
    },
    onSettled: () => onPendingChange(false),
  })
}
