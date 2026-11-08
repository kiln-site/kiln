import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"

import { DeleteAppDialog } from "@/components/app/app-dialogs"
import {
  AppContainerSelectionContext,
  createAppContainerSelection,
} from "@/components/app/app-container-selection"
import { AppContainerSection } from "@/components/app/app-container-section"
import { AppInfoRail } from "@/components/app/app-info-rail"
import { appRelayAvailable, type App } from "@/components/app/app-presentation"
import { AppProfile } from "@/components/app/app-profile"
import { AppWebRouteSettings } from "@/components/app/app-settings"
import { AppVolumesSection } from "@/components/app/app-volumes-section"
import { ResourceDeletionAlert } from "@/components/resource-deletion-alert"
import { useAppWorkspace } from "@/components/app/app-workspace-context"
import {
  InfoDangerAction,
  InfoDangerZone,
  InfoPage,
} from "@/components/info-page"
import { appConfigQueryOptions } from "@/lib/query-options"

// What the app is and runs, its containers with their usage, its volumes
// and domains, each section with the actions that change it, and a rail
// summing up where it runs, who owns it, and its deployment. An app opens
// here.
export function AppInfoPage() {
  const { app } = useAppWorkspace()
  // Another app is a fresh page, so an open dialog's draft and the selected
  // container can't carry over to it.
  return <AppInfoContent key={`${app.relayId}:${app.id}`} app={app} />
}

function AppInfoContent({ app }: { app: App }) {
  const config = useQuery(appConfigQueryOptions(app.relayId, app.id))
  const [selection] = React.useState(createAppContainerSelection)
  const canManage =
    app.permissions.includes("app.manage") && appRelayAvailable(app)

  return (
    <AppContainerSelectionContext.Provider value={selection}>
      <InfoPage rail={<AppInfoRail app={app} />}>
        <ResourceDeletionAlert
          canDelete={app.permissions.includes("app.delete")}
          kind="app"
          name={app.name}
          relayId={app.relayId}
          resourceId={app.id}
        />
        <AppProfile app={app} canManage={canManage} />
        <AppContainerSection app={app} config={config.data?.config} />
        {config.data ? (
          <AppVolumesSection
            app={app}
            canManage={canManage}
            config={config.data.config}
          />
        ) : null}
        <AppWebRouteSettings app={app} canManage={canManage} />
        {app.permissions.includes("app.delete") ? (
          <AppDangerZone app={app} />
        ) : null}
      </InfoPage>
    </AppContainerSelectionContext.Provider>
  )
}

function AppDangerZone({ app }: { app: App }) {
  const navigate = useNavigate()
  const leave = React.useCallback(() => {
    void navigate({ to: "/infra/apps", replace: true })
  }, [navigate])
  return (
    <InfoDangerZone>
      <InfoDangerAction
        dialog={(onOpenChange) => (
          <DeleteAppDialog
            app={app}
            open
            onDeleted={leave}
            onOpenChange={onOpenChange}
          />
        )}
      >
        Delete App
      </InfoDangerAction>
    </InfoDangerZone>
  )
}
