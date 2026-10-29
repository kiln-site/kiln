import * as React from "react"
import { useQuery } from "@tanstack/react-query"

import { UnfinishedRestoreNotice } from "@/components/backups/resource-backup-dialogs"
import {
  appDirectoryQueryOptions,
  unfinishedRestoresQueryOptions,
} from "@/lib/query-options"

/**
 * Every restore of an App's folder or a volume that didn't finish, which
 * the user can see backups of: each fences its target until someone
 * finishes or abandons it.
 */
export const UnfinishedRestores = React.memo(function UnfinishedRestores() {
  const restores = useQuery(unfinishedRestoresQueryOptions())
  const apps = useQuery(appDirectoryQueryOptions())
  if (!restores.data?.length) return null
  const appName = (appId: string) =>
    apps.data?.find((app) => app.id === appId)?.name ?? appId.slice(0, 8)
  return (
    <div className="mb-3 grid gap-2">
      {restores.data.map((restore) => {
        const { target } = restore
        const owner = /^([a-f0-9]{40})\//u.exec(target.id)?.[1]
        const targetName =
          target.kind === "app"
            ? `${appName(target.id)}’s folder`
            : owner
              ? `${appName(owner)}’s volume ${target.id.slice(owner.length + 1)}`
              : `volume ${target.id.slice(0, 8)} on ${restore.relayName}`
        return (
          <UnfinishedRestoreNotice
            key={`${restore.relayId}:${restore.taskId}`}
            backupName={restore.backupName}
            canResolve={restore.canResolve}
            relayId={restore.relayId}
            targetName={targetName}
            taskId={restore.taskId}
          />
        )
      })}
    </div>
  )
})
