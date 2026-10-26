import * as React from "react"
import { useQuery } from "@tanstack/react-query"

import { cn } from "@workspace/ui/lib/utils"

import {
  iconSubjectKey,
  iconUrl,
  userPictureUrl,
  type IconIndex,
  type IconSubject,
} from "@/lib/icons"
import { iconIndexQueryOptions } from "@/lib/query-options"

/**
 * Where a subject's shown icon loads from, or null when it has none of its
 * own. Each caller watches only its own entry, so another icon changing
 * doesn't render it.
 */
export function useIconUrl(subject: IconSubject | null): string | null {
  const key = subject ? iconSubjectKey(subject) : null
  const select = React.useCallback(
    (index: IconIndex) => (key ? (index.digests[key] ?? null) : null),
    [key]
  )
  const { data: digest } = useQuery({
    ...iconIndexQueryOptions(),
    enabled: key !== null,
    notifyOnChangeProps: ["data"],
    select,
  })
  return subject && digest ? iconUrl(subject, digest) : null
}

/**
 * Where a user's picture loads from, or null when they have none. The index
 * knows the reader's own and, for administrators, everyone's; anyone else's
 * loads by user ID and shows initials until it does, or if there's none.
 */
export function useUserPictureUrl(userId: string | null | undefined) {
  const select = React.useCallback(
    (index: IconIndex) => {
      if (!userId) return null
      const subject: IconSubject = { kind: "user", id: userId }
      const digest = index.digests[iconSubjectKey(subject)]
      if (digest) return iconUrl(subject, digest)
      return index.everyone || index.selfId === userId
        ? null
        : userPictureUrl(userId)
    },
    [userId]
  )
  const { data } = useQuery({
    ...iconIndexQueryOptions(),
    enabled: Boolean(userId),
    notifyOnChangeProps: ["data"],
    select,
  })
  return data ?? null
}

/**
 * A subject's own icon, filling its box, or `fallback` while it has none or
 * if it fails to load.
 */
export const SubjectIcon = React.memo(function SubjectIcon({
  className,
  fallback,
  subject,
}: {
  className?: string
  fallback: React.ReactNode
  subject: IconSubject | null
}) {
  const url = useIconUrl(subject)
  const [failed, setFailed] = React.useState<string | null>(null)
  if (!url || failed === url) return <>{fallback}</>
  return (
    <img
      alt=""
      aria-hidden="true"
      className={cn(
        "size-full rounded-[inherit] object-contain data-[small]:[image-rendering:pixelated]",
        className
      )}
      decoding="async"
      draggable={false}
      onError={() => setFailed(url)}
      onLoad={markSmallIcon}
      src={url}
    />
  )
})

/**
 * Marks a tiny icon drawn larger than it is, such as a 64-pixel Minecraft
 * server icon, so it's scaled up as crisp pixels rather than blurred.
 */
export function markSmallIcon(event: React.SyntheticEvent<HTMLImageElement>) {
  const image = event.currentTarget
  image.toggleAttribute(
    "data-small",
    image.naturalWidth > 0 &&
      image.naturalWidth <= 64 &&
      image.naturalWidth < image.clientWidth
  )
}
