import * as React from "react"
import { useMutation, useQuery } from "@tanstack/react-query"
import { CircleAlert, LoaderCircle } from "lucide-react"

import { showToast } from "@workspace/ui/components/sonner"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"
import { cn } from "@workspace/ui/lib/utils"

import type { IdentityStatusPresentation } from "@/components/identity-name"
import type { WebHostnameResourceRef } from "@/components/web-hostname-dns"
import { resourceWebCertificatesQueryOptions } from "@/lib/query-options"
import {
  checkWebCertificate,
  type ResourceWebCertificates,
  type WebHostnameCertificate,
} from "@/server/domains"

/**
 * How a web route hostname's certificate shows while it waits: checking
 * its name first, waiting for its name to resolve, or waiting on Let's
 * Encrypt, which failed once already when it's unverified.
 */
export function certificatePresentation(
  certificate: WebHostnameCertificate,
  canCheck: boolean
): IdentityStatusPresentation {
  const action = canCheck ? " Click to check now." : ""
  if (certificate.waitingFor === "dns" && certificate.failed) {
    return {
      detail: `Its name doesn't resolve yet, so Kiln hasn't asked Let's Encrypt for its certificate. Kiln keeps checking.${action}`,
      label: "Waiting for DNS",
      tone: "warning",
    }
  }
  if (certificate.waitingFor === "certificate" && certificate.failed) {
    return {
      detail: `Let's Encrypt hasn't issued its certificate, so visitors see a warning. Kiln asks again, less often over time.${action}`,
      label: "Unverified",
      tone: "danger",
    }
  }
  return {
    detail:
      certificate.waitingFor === "dns"
        ? "Checking its name resolves before asking Let's Encrypt for its certificate."
        : "Asking Let's Encrypt for its certificate.",
    label: "Verifying",
    pulse: true,
    tone: "warning",
  }
}

/** Has the hostname's Relay check it again now, saying what it found. */
export function useCheckWebCertificate(
  resource: WebHostnameResourceRef,
  hostname: string
) {
  const check = useMutation({
    mutationFn: () =>
      checkWebCertificate({
        data:
          resource.resourceType === "app"
            ? { ...resource, hostname, resourceType: "app" }
            : { ...resource, hostname, resourceType: "instance" },
      }),
    onError: (cause) =>
      showToast({
        description: cause instanceof Error ? cause.message : String(cause),
        message: `Couldn't check ${hostname}`,
        type: "error",
      }),
    onSuccess: (certificate) =>
      showToast(
        certificate === null
          ? { message: `${hostname} has its certificate`, type: "success" }
          : certificate.waitingFor === "dns"
            ? {
                description:
                  "Kiln asks Let's Encrypt for its certificate once it does.",
                message: `${hostname} doesn't resolve yet`,
                type: "warning",
              }
            : {
                description:
                  "Kiln has asked Let's Encrypt again, and keeps asking until it's issued.",
                message: `${hostname} has no certificate yet`,
                type: "info",
              }
      ),
  })
  const { isPending, mutate } = check
  return {
    check: React.useCallback(() => mutate(), [mutate]),
    checking: isPending,
  }
}

/**
 * A web route's certificate beside its hostname, while one of its names
 * still waits on one. Nothing shows once it has them all.
 */
export const WebCertificateStatus = React.memo(function WebCertificateStatus({
  hostnames,
  resource,
}: {
  hostnames: ReadonlyArray<string>
  resource: WebHostnameResourceRef
}) {
  const key = hostnames.join(" ")
  const select = React.useCallback(
    (data: ResourceWebCertificates) => {
      const names = new Set(key.split(" "))
      const waiting = data.pending
        .filter((pending) => names.has(pending.hostname))
        .sort((left, right) => severity(right) - severity(left))[0]
      return waiting
        ? {
            canCheck: data.canCheck,
            failed: waiting.failed,
            hostname: waiting.hostname,
            waitingFor: waiting.waitingFor,
          }
        : null
    },
    [key]
  )
  const { data: waiting } = useQuery({
    ...resourceWebCertificatesQueryOptions(
      resource.relayId,
      resource.resourceType,
      resource.resourceId
    ),
    select,
  })
  if (!waiting) return null
  return (
    <CertificateBadge
      canCheck={waiting.canCheck}
      certificate={waiting}
      hostname={waiting.hostname}
      resource={resource}
    />
  )
})

const CertificateBadge = React.memo(function CertificateBadge({
  canCheck,
  certificate,
  hostname,
  resource,
}: {
  canCheck: boolean
  certificate: WebHostnameCertificate
  hostname: string
  resource: WebHostnameResourceRef
}) {
  const { check, checking } = useCheckWebCertificate(resource, hostname)
  const presentation = certificatePresentation(certificate, canCheck)
  const Icon = presentation.pulse || checking ? LoaderCircle : CircleAlert
  const content = (
    <span
      className={cn(
        "type-meta inline-flex shrink-0 items-center gap-1 whitespace-nowrap",
        presentation.tone === "danger"
          ? "text-destructive"
          : "text-amber-700 dark:text-amber-300"
      )}
    >
      <Icon
        aria-hidden
        className={cn(
          "size-3",
          (presentation.pulse || checking) && "animate-spin"
        )}
      />
      {presentation.label}
    </span>
  )
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {canCheck ? (
          <button
            aria-label={`${presentation.label}: check ${hostname} again`}
            className="inline-flex cursor-pointer rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default"
            disabled={checking}
            type="button"
            onClick={check}
          >
            {content}
          </button>
        ) : (
          <span tabIndex={0}>{content}</span>
        )}
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">
        {presentation.detail}
      </TooltipContent>
    </Tooltip>
  )
})

// Which of a route's names to show: the one furthest from a certificate.
function severity(certificate: WebHostnameCertificate): number {
  if (certificate.waitingFor === "certificate")
    return certificate.failed ? 3 : 1
  return certificate.failed ? 2 : 0
}
