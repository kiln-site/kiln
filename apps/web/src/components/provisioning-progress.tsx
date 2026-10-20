import * as React from "react"
import { Effect } from "effect"
import type {
  ProvisioningKind,
  ProvisioningState,
  ProvisioningWorkPhase,
} from "@workspace/contracts"
import {
  Check,
  Copy,
  LoaderCircle,
  OctagonX,
  TriangleAlert,
} from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import { showToast } from "@workspace/ui/components/sonner"

import { PageContent } from "@/components/page-content"
import { provisioningFailureDiagnostics } from "@/lib/provisioning-diagnostics"

// What an instance shows while its Relay provisions it, for every kind of
// instance: the steps it goes through, and what to do if one fails.

type Step = { detail: string; label: string; phase: ProvisioningWorkPhase }

interface ProvisioningCopy {
  /** What it's called in the guidance, as in "this failed server". */
  readonly noun: string
  /** What happens while it provisions. */
  readonly summary: string
  /** What Kiln kept when it failed. */
  readonly failure: string
  readonly steps: ReadonlyArray<Step>
  readonly guidance: Readonly<Record<ProvisioningWorkPhase, string>>
}

const COPY: Readonly<Record<ProvisioningKind, ProvisioningCopy>> = {
  server: {
    noun: "server",
    summary:
      "Kiln is downloading and assembling the server on the Relay. You can leave this page; provisioning will continue and this workspace will unlock automatically.",
    failure:
      "Kiln kept the server record intact, but the Relay could not finish building it. The Relay's reported reason and next step are below.",
    steps: [
      {
        phase: "preparing",
        label: "Prepare",
        detail: "Checking capacity and creating storage",
      },
      {
        phase: "pulling_image",
        label: "Download",
        detail: "Fetching the server image",
      },
      {
        phase: "creating_container",
        label: "Build",
        detail: "Allocating ports and creating the container",
      },
      {
        phase: "finalizing",
        label: "Finalize",
        detail: "Connecting services and publishing the server",
      },
    ],
    guidance: {
      preparing:
        "Check Docker networking, storage, and capacity on the Relay. After resolving the cause, delete this failed server and provision it again.",
      pulling_image:
        "Check the image name, registry access, and the Relay's internet connection. After resolving the cause, delete this failed server and provision it again.",
      creating_container:
        "Check the Relay for port conflicts and Docker container errors. After resolving the cause, delete this failed server and provision it again.",
      finalizing:
        "Check Relay networking and service configuration. After resolving the cause, delete this failed server and provision it again.",
    },
  },
  database: {
    noun: "database",
    summary:
      "Kiln is creating the database's storage and container on the Relay, then waiting for it to accept connections. You can leave this page; provisioning will continue and this page will unlock automatically.",
    failure:
      "Kiln kept the database record and its credentials, but the Relay could not finish creating it. The Relay's reported reason and next step are below.",
    steps: [
      {
        phase: "preparing",
        label: "Prepare",
        detail: "Checking capacity and creating its volume and network",
      },
      {
        phase: "pulling_image",
        label: "Download",
        detail: "Fetching the database image",
      },
      {
        phase: "creating_container",
        label: "Build",
        detail: "Creating and starting the container",
      },
      {
        phase: "finalizing",
        label: "Finalize",
        detail: "Waiting for the database to accept connections",
      },
    ],
    guidance: {
      preparing:
        "Check Docker networking, storage, and capacity on the Relay. After resolving the cause, delete this failed database and create it again.",
      pulling_image:
        "Check the Relay's internet connection and registry access. After resolving the cause, delete this failed database and create it again.",
      creating_container:
        "Check the Relay for Docker container errors. After resolving the cause, delete this failed database and create it again.",
      finalizing:
        "Check the database's logs on the Relay for why it didn't become ready. After resolving the cause, delete this failed database and create it again.",
    },
  },
  app: {
    noun: "app",
    summary:
      "Kiln is creating the app's network and data directory on the Relay. Once it's ready, choose what it runs and deploy it.",
    failure:
      "Kiln kept the app record, but the Relay could not finish creating it. The Relay's reported reason and next step are below.",
    // An app's images and containers come with its first deployment.
    steps: [
      {
        phase: "preparing",
        label: "Prepare",
        detail: "Creating its network and data directory",
      },
    ],
    guidance: {
      preparing:
        "Check Docker networking and storage on the Relay. After resolving the cause, delete this failed app and create it again.",
      pulling_image:
        "Check the image or Dockerfile, registry access, and the Relay's internet connection. After resolving the cause, delete this failed app and create it again.",
      creating_container:
        "Check the Relay for port conflicts and Docker container errors. After resolving the cause, delete this failed app and create it again.",
      finalizing:
        "Check Relay networking and the app's configuration. After resolving the cause, delete this failed app and create it again.",
    },
  },
}

/**
 * An instance's pages once it exists; until then, how far its provisioning
 * got, whichever page is open.
 */
export function ProvisioningGate({
  children,
  provisioning,
  ...progress
}: Omit<React.ComponentProps<typeof ProvisioningProgress>, "provisioning"> & {
  children: React.ReactNode
  provisioning: ProvisioningState | undefined
}) {
  if (!provisioning) return children
  return (
    <>
      <PageContent
        view={provisioning.phase === "failed" ? "unavailable" : "waiting"}
      />
      <ProvisioningProgress {...progress} provisioning={provisioning} />
    </>
  )
}

export const ProvisioningProgress = React.memo(function ProvisioningProgress({
  failedActions,
  id,
  kind,
  name,
  provisioning,
  relayId,
}: {
  /** What a failed one offers beside its diagnostics, such as deleting it. */
  failedActions?: React.ReactNode
  id: string
  kind: ProvisioningKind
  name: string
  provisioning: ProvisioningState
  relayId: string
}) {
  const copy = COPY[kind]
  const steps = copy.steps
  const failed = provisioning.phase === "failed"
  const effectivePhase = failed
    ? (provisioning.failedPhase ?? "preparing")
    : provisioning.phase === "awaiting_claim" || provisioning.phase === "queued"
      ? "preparing"
      : provisioning.phase
  const activeIndex = steps.findIndex((step) => step.phase === effectivePhase)
  const activeStep = steps[activeIndex]
  const failureGuidance = failed
    ? copy.guidance[provisioning.failedPhase ?? "preparing"]
    : null

  function copyDiagnostics() {
    const diagnostics = provisioningFailureDiagnostics({
      attempt: provisioning.attempt,
      error: provisioning.error,
      failedPhase: provisioning.failedPhase,
      instanceId: id,
      instanceName: name,
      kind,
      relayId,
    })
    Effect.runFork(
      Effect.tryPromise({
        try: () => navigator.clipboard.writeText(diagnostics),
        catch: (cause) => cause,
      }).pipe(
        Effect.match({
          onFailure: () =>
            showToast({
              message:
                "Could not copy diagnostics. Select the error text manually.",
              type: "error",
            }),
          onSuccess: () =>
            showToast({
              message: "Provisioning diagnostics copied",
              type: "success",
            }),
        })
      )
    )
  }

  return (
    <div className="flex min-h-0 w-full flex-1 overflow-y-auto">
      <div className="m-auto grid w-full max-w-5xl gap-10 px-6 py-12 lg:grid-cols-[minmax(0,1fr)_22rem] lg:px-10">
        <section className="self-center">
          <div className="type-technical-label mb-5 flex items-center gap-2 text-primary">
            {failed ? (
              <TriangleAlert className="size-4" />
            ) : (
              <LoaderCircle className="size-4 animate-spin" />
            )}
            {failed ? "Provisioning stopped" : "Provisioning in background"}
          </div>
          <h1 className="max-w-2xl text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
            {failed
              ? `${name} needs your attention.`
              : `${name} is already yours.`}
          </h1>
          <p className="mt-4 max-w-xl text-sm leading-6 text-muted-foreground sm:text-base">
            {failed ? copy.failure : copy.summary}
          </p>
          {failed ? (
            <div className="mt-7 max-w-2xl border border-destructive/30 bg-destructive/6">
              <div className="border-b border-destructive/20 p-4">
                <p className="type-technical-label text-destructive">
                  Failed during {activeStep?.label ?? "provisioning"}
                </p>
                <p
                  className="mt-2 line-clamp-3 text-sm leading-6 break-words text-foreground"
                  title={
                    provisioning.error ??
                    "The Relay did not provide an error message."
                  }
                >
                  {provisioning.error ??
                    "The Relay did not provide an error message."}
                </p>
              </div>
              <div className="p-4">
                <p className="type-technical-label text-muted-foreground">
                  Next step
                </p>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">
                  {failureGuidance}
                </p>
                <div className="mt-4 flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={copyDiagnostics}
                  >
                    <Copy />
                    Copy diagnostics
                  </Button>
                  {failedActions}
                </div>
              </div>
            </div>
          ) : (
            <div className="mt-8 h-px max-w-xl overflow-hidden bg-border">
              <div className="h-full w-1/3 animate-pulse bg-primary" />
            </div>
          )}
        </section>

        <aside className="border border-border/80 bg-background/50">
          <div className="type-technical-label flex items-center justify-between border-b border-border/80 px-4 py-3 text-muted-foreground">
            <span>Build sequence</span>
            <span>Attempt {Math.max(1, provisioning.attempt)}</span>
          </div>
          <ol className="p-4">
            {steps.map((step, index) => {
              const complete = index < activeIndex
              const active = !failed && index === activeIndex
              const failedStep = failed && index === activeIndex
              return (
                <li
                  key={step.phase}
                  className="grid grid-cols-[1.5rem_1fr] gap-x-3 pb-5 last:pb-0"
                >
                  <div className="flex flex-col items-center">
                    <span
                      className={`grid size-6 place-items-center border text-[10px] ${
                        complete
                          ? "border-primary bg-primary text-primary-foreground"
                          : failedStep
                            ? "border-destructive bg-destructive/10 text-destructive"
                            : active
                              ? "border-primary bg-primary/10 text-primary"
                              : "border-border text-muted-foreground"
                      }`}
                    >
                      {complete ? (
                        <Check className="size-3.5" />
                      ) : failedStep ? (
                        <OctagonX className="size-3.5" />
                      ) : (
                        index + 1
                      )}
                    </span>
                    {index < steps.length - 1 ? (
                      <span className="mt-1 h-full w-px bg-border" />
                    ) : null}
                  </div>
                  <div className="min-w-0 pt-0.5">
                    <p
                      className={`text-sm font-medium ${
                        failedStep
                          ? "text-destructive"
                          : active
                            ? "text-primary"
                            : "text-foreground"
                      }`}
                    >
                      {step.label}
                    </p>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">
                      {step.detail}
                    </p>
                  </div>
                </li>
              )
            })}
          </ol>
        </aside>
      </div>
    </div>
  )
})
