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

type AddRelayMethod = "install" | "link"

const methods: ReadonlyArray<{ label: string; value: AddRelayMethod }> = [
  { label: "Install", value: "install" },
  { label: "Pairing link", value: "link" },
]

export function AddRelayDialog({
  joinId,
  open,
  onOpenChange,
}: {
  // The join to confirm, from the link the installer prints.
  joinId?: string
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [method, setMethod] = React.useState<AddRelayMethod>("install")
  const close = React.useCallback(() => onOpenChange(false), [onOpenChange])
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Add a Relay</DialogTitle>
          <DialogDescription>
            {method === "link"
              ? "Paste the link `kiln-relay pair create` printed on the Relay."
              : "Run this on the new machine, then confirm the Relay here."}
          </DialogDescription>
        </DialogHeader>
        <div
          role="tablist"
          aria-label="How to add the Relay"
          className="flex border-b border-border/70"
        >
          {methods.map((option) => (
            <button
              key={option.value}
              role="tab"
              type="button"
              aria-selected={method === option.value}
              className="type-control-sm -mb-px border-b-2 border-transparent px-3 py-2 text-muted-foreground transition-colors hover:text-foreground aria-selected:border-primary aria-selected:text-foreground"
              onClick={() => setMethod(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
        {open ? (
          method === "link" ? (
            <PairingLinkForm onDone={close} />
          ) : (
            <React.Suspense fallback={null}>
              <RelayJoinPanel joinId={joinId} onDone={close} />
            </React.Suspense>
          )
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

// Loaded with the dialog's first open, beside today's pairing-link form.
const RelayJoinPanel = React.lazy(async () => ({
  default: (await import("@/components/relay/relay-join-panel")).RelayJoinPanel,
}))

function PairingLinkForm({ onDone }: { onDone: () => void }) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [pending, setPending] = React.useState(false)
  const [feedback, setFeedback] = React.useState<{
    docsHref?: string
    message: string
  } | null>(null)
  const [reviewedPairing, setReviewedPairing] = React.useState<{
    pairingUri: string
    preview: Awaited<ReturnType<typeof previewRelayPairing>>
  } | null>(null)
  const [installation, setInstallation] = React.useState<"keep" | "use">("keep")
  const addMutation = useMutation({
    mutationFn: addRelay,
    onSuccess: async ({ relay }) => {
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
            // A Relay without an ID takes this Kiln's. One with another
            // keeps it unless someone chooses otherwise, and so does an
            // older one that doesn't say, since it would take any ID it's
            // sent.
            const reported = preview.installation
            setInstallation(
              reported &&
                (reported.id === null ||
                  reported.id === preview.hearthInstallationId)
                ? "use"
                : "keep"
            )
            return
          }
          const { installationWarning, relay } = await addMutation.mutateAsync({
            data: { installation, pairingUri: reviewedPairing.pairingUri },
          })
          const repaired = reviewedPairing.preview.mode === "repair"
          showToast({
            type: installationWarning ? "warning" : "success",
            message: repaired
              ? `${relay.name} repaired`
              : `${relay.name} paired`,
            description: installationWarning ?? undefined,
            duration: 4_000,
          })
          onDone()
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

  const preview = reviewedPairing?.preview
  return (
    <form className="space-y-4" onSubmit={(event) => void submit(event)}>
      {preview ? (
        <>
          <PairingReview
            pairing={preview}
            onBack={() => {
              setFeedback(null)
              setReviewedPairing(null)
            }}
          />
          <PairingInstallation
            choice={installation}
            preview={preview}
            onChange={setInstallation}
          />
        </>
      ) : (
        <Field label="Pairing link" htmlFor="relay-pairing-uri">
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
      )}

      {feedback ? (
        <DialogFeedback
          message={feedback.message}
          docsHref={feedback.docsHref}
        />
      ) : null}

      <DialogFooter>
        <Button type="submit" disabled={pending}>
          {pending ? <LoaderCircle className="animate-spin" /> : <Check />}
          {preview?.mode === "repair"
            ? "Repair connection"
            : preview
              ? "Confirm and pair"
              : "Review pairing"}
        </Button>
      </DialogFooter>
    </form>
  )
}

// What happens to the Relay's installation ID. An older Relay doesn't say
// what it has, and replaces it with any it's sent.
function PairingInstallation({
  choice,
  onChange,
  preview,
}: {
  choice: "keep" | "use"
  onChange: (choice: "keep" | "use") => void
  preview: Awaited<ReturnType<typeof previewRelayPairing>>
}) {
  if (!preview.hearthInstallationId) return null
  if (!preview.installation) {
    return (
      <label className="type-meta flex cursor-pointer items-start gap-2 text-muted-foreground">
        <input
          type="checkbox"
          className="mt-0.5 accent-primary"
          checked={choice === "use"}
          onChange={(event) =>
            onChange(event.currentTarget.checked ? "use" : "keep")
          }
        />
        Give this Relay this Kiln's installation ID, replacing any it has
      </label>
    )
  }
  const current = preview.installation.id
  if (current === null || current === preview.hearthInstallationId) return null
  return (
    <InstallationChoice
      choice={choice}
      disabled={false}
      fixed={preview.installation.fixed || !preview.installation.replace}
      relayInstallationId={current}
      onChange={onChange}
    />
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

/** Keep the Relay's installation ID, or give it this Kiln's. */
export function InstallationChoice({
  choice,
  disabled,
  fixed,
  onChange,
  relayInstallationId,
}: {
  choice: "keep" | "use"
  disabled: boolean
  fixed: boolean
  onChange: (choice: "keep" | "use") => void
  relayInstallationId: string
}) {
  if (fixed) {
    return (
      <p className="type-meta text-muted-foreground">
        This Relay belongs to another Kiln installation,{" "}
        <span className="font-mono break-all">{relayInstallationId}</span>,
        which it keeps. Every Hearth paired with full access can manage it.
      </p>
    )
  }
  return (
    <fieldset className="space-y-2" disabled={disabled}>
      <legend className="type-label text-muted-foreground">
        Installation ID
      </legend>
      {(
        [
          [
            "keep",
            <>
              Keep{" "}
              <span className="truncate font-mono text-xs">
                {relayInstallationId}
              </span>
            </>,
          ],
          ["use", "Use this Kiln's"],
        ] as const
      ).map(([value, label]) => (
        <label
          key={value}
          className="flex min-w-0 cursor-pointer items-center gap-2 text-sm"
        >
          <input
            type="radio"
            name="relay-installation"
            className="accent-primary"
            checked={choice === value}
            onChange={() => onChange(value)}
          />
          {label}
        </label>
      ))}
      <p className="type-meta text-muted-foreground">
        It belongs to another Kiln installation. Its ID decides whose Kiln
        services and backups it finds; every Hearth paired with full access can
        manage it either way.
      </p>
    </fieldset>
  )
}
