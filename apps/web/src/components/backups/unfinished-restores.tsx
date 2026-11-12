import * as React from "react"
import { useQuery } from "@tanstack/react-query"

import { UnfinishedRestoreNotice } from "@/components/backups/resource-backup-dialogs"
import { unfinishedRestoresQueryOptions } from "@/lib/query-options"

/**
 * Every restore of a volume that didn't finish, which
 * the user can see backups of: each fences its target until someone
 * finishes or abandons it.
 */
export const UnfinishedRestores = React.memo(function UnfinishedRestores() {
  const restores = useQuery(unfinishedRestoresQueryOptions())
  if (!restores.data?.length) return null
  return (
    <div className="mb-3 grid gap-2">
      {restores.data.map((restore) => {
        const { target } = restore
        const targetName = `volume ${target.id.slice(0, 8)} on ${restore.relayName}`
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
