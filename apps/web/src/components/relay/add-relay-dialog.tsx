import * as React from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { Effect } from "effect"
import {
  Check,
  CircleAlert,
  Fingerprint,
  LoaderCircle,
  RefreshCw,
  X,
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
import { showToast } from "@workspace/ui/components/sonner"

import { invalidateRelayRuntimeQueries } from "@/components/relay/relay-actions"
import { queryKeys } from "@/lib/query-options"
import { pairingFeedbackFrom } from "@/lib/relay-pairing-errors"
import type { PersistedRelay } from "@/lib/relay-registry"
import { addRelay, previewRelayPairing } from "@/server/relays"

const invitationTimeFormatter = new Intl.DateTimeFormat("en-US", {
  hour: "numeric",
  minute: "2-digit",
  timeZone: "UTC",
  timeZoneName: "short",
})

export function AddRelayDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const formRef = React.useRef<HTMLFormElement>(null)
  const [pending, setPending] = React.useState(false)
  const [feedback, setFeedback] = React.useState<{
    docsHref?: string
    message: string
  } | null>(null)
  const [reviewedPairing, setReviewedPairing] = React.useState<{
    pairingUri: string
    preview: {
      controlEndpoint: string
      existingRelayName: string | null
      expiresAt: number
      managedTls: boolean
      mode: "add" | "repair"
      relayFingerprint: string
      relayName: string
    }
  } | null>(null)
  const addMutation = useMutation({
    mutationFn: addRelay,
    onSuccess: async (relay) => {
      queryClient.setQueryData<Array<PersistedRelay>>(
        queryKeys.relays,
        (current) =>
          current?.some((item) => item.id === relay.id)
            ? current.map((item) => (item.id === relay.id ? relay : item))
            : [...(current ?? []), relay]
      )
      await Promise.all([
        invalidateRelayRuntimeQueries(queryClient),
        queryClient.invalidateQueries({
          queryKey: queryKeys.access.capabilities,
        }),
      ])
    },
  })

  function changeOpen(nextOpen: boolean) {
    if (!nextOpen && pending) return
    onOpenChange(nextOpen)
    if (!nextOpen) {
      setFeedback(null)
      setReviewedPairing(null)
      formRef.current?.reset()
    }
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setPending(true)
    setFeedback(null)
    await Effect.runPromise(
      Effect.tryPromise({
        try: async () => {
          if (!reviewedPairing) {
            const form = new FormData(event.currentTarget)
            const pairingUri = String(form.get("pairingUri") ?? "").trim()
            const preview = await previewRelayPairing({ data: { pairingUri } })
            setReviewedPairing({ pairingUri, preview })
            return
          }
          const relay = await addMutation.mutateAsync({
            data: { pairingUri: reviewedPairing.pairingUri },
          })
          const repaired = reviewedPairing.preview.mode === "repair"
          showToast({
            type: "success",
            message: repaired
              ? `${relay.name} repaired`
              : `${relay.name} paired`,
            description: repaired
              ? "The Relay connection was repaired without replacing its Hearth data."
              : "The Relay is now available to Hearth.",
            duration: 4_000,
          })
          onOpenChange(false)
          setFeedback(null)
          setReviewedPairing(null)
          formRef.current?.reset()
          // A repaired Relay keeps its place; a new one opens its Info page.
          if (!repaired) {
            await navigate({
              params: { relayId: relay.id },
              to: "/relay/$relayId/info",
            })
          }
        },
        catch: (cause) => cause,
      }).pipe(
        Effect.catch((cause) =>
          Effect.sync(() => setFeedback(pairingFeedbackFrom(cause)))
        ),
        Effect.ensuring(Effect.sync(() => setPending(false)))
      )
    )
  }

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <p className="type-technical-label text-primary-ink">
            {reviewedPairing?.preview.mode === "repair"
              ? "Existing connection"
              : "New connection"}
          </p>
          <DialogTitle>
            {reviewedPairing?.preview.mode === "repair"
              ? "Repair Relay connection"
              : "Add a Relay"}
          </DialogTitle>
          <DialogDescription>
            {reviewedPairing?.preview.mode === "repair"
              ? "Verify the Relay identity before authorizing it again."
              : "Paste the one-time pairing URI printed by Relay, then verify its identity before connecting."}
          </DialogDescription>
        </DialogHeader>

        <form
          ref={formRef}
          className="space-y-4"
          onSubmit={(event) => void submit(event)}
        >
          {reviewedPairing ? (
            <PairingReview
              pairing={reviewedPairing.preview}
              onBack={() => {
                setFeedback(null)
                setReviewedPairing(null)
              }}
            />
          ) : (
            <>
              <Field
                label="Create a pairing URI"
                htmlFor="relay-pairing-command"
              >
                <Input
                  id="relay-pairing-command"
                  value="docker exec <container-id> kiln-relay pair create"
                  className="type-meta font-mono"
                  readOnly
                />
                <p className="type-meta text-muted-foreground">
                  Run this against your Relay container, then paste the returned
                  URI below.
                </p>
              </Field>

              <Field label="One-time pairing URI" htmlFor="relay-pairing-uri">
                <textarea
                  id="relay-pairing-uri"
                  name="pairingUri"
                  className="type-code min-h-32 w-full resize-y rounded-md border border-input bg-background/35 px-3 py-2 shadow-xs outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40"
                  placeholder="kiln-relay://pair/v1?payload=…"
                  autoCapitalize="none"
                  autoComplete="off"
                  spellCheck={false}
                  required
                />
              </Field>
            </>
          )}

          {feedback ? (
            <DialogFeedback
              message={feedback.message}
              docsHref={feedback.docsHref}
            />
          ) : null}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() => changeOpen(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? <LoaderCircle className="animate-spin" /> : <Check />}
              {reviewedPairing?.preview.mode === "repair"
                ? "Repair connection"
                : reviewedPairing
                  ? "Confirm and pair"
                  : "Review pairing"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function PairingReview({
  pairing,
  onBack,
}: {
  pairing: {
    controlEndpoint: string
    existingRelayName: string | null
    expiresAt: number
    managedTls: boolean
    mode: "add" | "repair"
    relayFingerprint: string
    relayName: string
  }
  onBack: () => void
}) {
  return (
    <div className="rounded-lg border border-primary/20 bg-primary/[0.045] p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-md border border-primary/20 bg-primary/10 text-primary-ink">
            <Fingerprint className="size-4" />
          </span>
          <div className="min-w-0">
            <p className="type-technical-label text-primary-ink">
              Verify identity
            </p>
            <p className="mt-0.5 truncate text-sm font-semibold">
              {pairing.relayName}
            </p>
          </div>
        </div>
        <Button type="button" size="xs" variant="ghost" onClick={onBack}>
          <X /> Back
        </Button>
      </div>
      {pairing.mode === "repair" ? (
        <div className="mt-4 flex gap-2.5 rounded-md border border-primary/20 bg-background/55 p-3">
          <RefreshCw className="mt-0.5 size-3.5 shrink-0 text-primary-ink" />
          <div>
            <p className="type-label text-foreground">
              Existing Relay identity found
            </p>
            <p className="type-meta mt-1 text-muted-foreground">
              Hearth will repair{" "}
              <span className="font-medium text-foreground">
                {pairing.existingRelayName ?? pairing.relayName}
              </span>{" "}
              in place. Server records, file activity, pins, and access stay
              attached.
            </p>
          </div>
        </div>
      ) : null}
      <dl className="type-meta mt-4 grid gap-3 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <dt className="text-muted-foreground">Relay fingerprint</dt>
          <dd className="mt-1 font-mono break-all text-foreground">
            {pairing.relayFingerprint}
          </dd>
        </div>
        <div className="sm:col-span-2">
          <dt className="text-muted-foreground">Control endpoint</dt>
          <dd className="mt-1 font-mono break-all text-foreground">
            {pairing.controlEndpoint}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">TLS trust</dt>
          <dd className="mt-1 text-foreground">
            {pairing.managedTls ? "Relay-managed CA" : "System trust"}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Invitation expires</dt>
          <dd className="mt-1 text-foreground">
            {invitationTimeFormatter.format(new Date(pairing.expiresAt))}
          </dd>
        </div>
      </dl>
    </div>
  )
}

export function DialogFeedback({
  docsHref,
  message,
}: {
  docsHref?: string
  message: string
}) {
  return (
    <div
      role="status"
      className="type-meta flex items-start gap-2 rounded-md border border-destructive/25 bg-destructive/[0.06] px-3 py-2 text-destructive"
    >
      <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
      <div className="min-w-0 space-y-1">
        <p>{message}</p>
        {docsHref ? (
          <a
            href={docsHref}
            target="_blank"
            rel="noreferrer"
            className="inline-flex font-medium underline underline-offset-2 hover:text-destructive/80"
          >
            Docs
          </a>
        ) : null}
      </div>
    </div>
  )
}

export function Field({
  label,
  htmlFor,
  children,
}: {
  label: string
  htmlFor: string
  children: React.ReactNode
}) {
  return (
    <div className="space-y-1.5">
      <label
        htmlFor={htmlFor}
        className="type-label block text-muted-foreground"
      >
        {label}
      </label>
      {children}
    </div>
  )
}
