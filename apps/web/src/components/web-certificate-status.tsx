import * as React from "react"
import { useMutation, useQuery } from "@tanstack/react-query"

import { showToast } from "@workspace/ui/components/sonner"

import type { IdentityStatusPresentation } from "@/components/identity-name"
import { StatusIndicator } from "@/components/status-indicator"
import type { WebHostnameResourceRef } from "@/components/web-hostname-dns"
import { resourceWebHostnamesQueryOptions } from "@/lib/query-options"
import {
  checkWebCertificate,
  type ResourceWebHostnames,
  type WebHostnameCertificate,
} from "@/server/domains"

/** How a web route hostname still waiting on its certificate shows. */
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
      detail: `No certificate yet.${canCheck ? "\nClick to retry." : ""}`,
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
  const { isPending, mutate } = useMutation({
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
            ? { message: `${hostname} doesn't resolve yet`, type: "warning" }
            : asked
              ? {
                  message: `Asked Let's Encrypt for ${hostname}'s certificate`,
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
  return {
    check: React.useCallback(() => mutate(), [mutate]),
    checking: isPending,
  }
}

/** A web route's certificate, while one of its names still waits on one. */
export const WebCertificateStatus = React.memo(function WebCertificateStatus({
  hostnames,
  resource,
}: {
  hostnames: ReadonlyArray<string>
  resource: WebHostnameResourceRef
}) {
  const key = hostnames.join(" ")
  const select = React.useCallback(
    ({ canChange, certificates }: ResourceWebHostnames) => {
      const names = key.split(" ")
      // The name furthest from a certificate.
      const waiting = certificates
        .filter((pending) => names.includes(pending.hostname))
        .sort((left, right) => severity(right) - severity(left))[0]
      return waiting ? { ...waiting, canChange } : null
    },
    [key]
  )
  const { data: waiting } = useQuery({
    ...resourceWebHostnamesQueryOptions(
      resource.relayId,
      resource.resourceType,
      resource.resourceId
    ),
    select,
  })
  return waiting ? (
    <CertificateStatus
      canChange={waiting.canChange}
      certificate={waiting}
      hostname={waiting.hostname}
      resource={resource}
    />
  ) : null
})

/** The status of one hostname's certificate, which checks again when clicked. */
export const CertificateStatus = React.memo(function CertificateStatus({
  canChange,
  certificate,
  hostname,
  resource,
}: {
  canChange: boolean
  certificate: WebHostnameCertificate
  hostname: string
  resource: WebHostnameResourceRef
}) {
  const { check, checking } = useCheckWebCertificate(resource, hostname)
  return (
    <StatusIndicator
      busy={checking}
      status={certificatePresentation(certificate, canChange)}
      onActivate={canChange ? check : undefined}
    />
  )
})

function severity({ failed, waitingFor }: WebHostnameCertificate): number {
  return (waitingFor === "certificate" ? 1 : 0) + (failed ? 2 : 0)
}
