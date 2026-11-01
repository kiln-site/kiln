import * as React from "react"
import { useMutation, useQuery } from "@tanstack/react-query"
import { CircleAlert, Clock3 } from "lucide-react"

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
 * its name and asking for it, waiting for its name to resolve, or without
 * one after Let's Encrypt was asked.
 */
export function certificatePresentation(
  certificate: WebHostnameCertificate,
  canCheck: boolean
): IdentityStatusPresentation {
  if (certificate.waitingFor === "dns" && certificate.failed) {
    return {
      detail: `Its DNS doesn't point here yet.${canCheck ? "\nClick to check again." : ""}`,
      label: "Waiting for DNS",
      tone: "info",
    }
  }
  if (certificate.waitingFor === "certificate" && certificate.failed) {
    return {
      detail: `Couldn't get a certificate.${canCheck ? "\nClick to retry." : ""}`,
      label: "Unverified",
      tone: "danger",
    }
  }
  return {
    detail: "Getting its certificate.",
    label: "Verifying",
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
    onSuccess: ({ asked, certificate }) =>
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
            : asked
              ? {
                  description: "Its status updates once it's issued.",
                  message: `Asked Let's Encrypt again for ${hostname}`,
                  type: "info",
                }
              : {
                  description:
                    "Let's Encrypt allows only a few attempts an hour. Try again later.",
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
  const Icon = presentation.tone === "danger" ? CircleAlert : Clock3
  const content = (
    <span
      className={cn(
        "type-meta inline-flex shrink-0 items-center gap-1 whitespace-nowrap",
        badgeTone[presentation.tone],
        checking && "opacity-60"
      )}
    >
      <Icon aria-hidden className="size-3" />
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
      <TooltipContent className="max-w-xs whitespace-pre-line">
        {presentation.detail}
      </TooltipContent>
    </Tooltip>
  )
})

const badgeTone: Record<IdentityStatusPresentation["tone"], string> = {
  danger: "text-destructive",
  info: "text-sky-700 dark:text-sky-300",
  neutral: "text-muted-foreground",
  success: "text-emerald-700 dark:text-emerald-300",
  warning: "text-amber-700 dark:text-amber-300",
}

// Which of a route's names to show: the one furthest from a certificate.
function severity(certificate: WebHostnameCertificate): number {
  if (certificate.waitingFor === "certificate")
    return certificate.failed ? 3 : 1
  return certificate.failed ? 2 : 0
}
