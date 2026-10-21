import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { LoaderCircle, ToyBrick } from "lucide-react"

import { DeleteAppDialog } from "@/components/app/app-dialogs"
import {
  AppContainerSelectionContext,
  createAppContainerSelection,
} from "@/components/app/app-container-selection"
import { AppContainerSection } from "@/components/app/app-container-section"
import { AppInfoRail } from "@/components/app/app-info-rail"
import { appRelayAvailable, type App } from "@/components/app/app-presentation"
import {
  AppGeneralSettings,
  AppSourceSettings,
  AppWebRouteSettings,
} from "@/components/app/app-settings"
import { AppVolumesSection } from "@/components/app/app-volumes-section"
import { useAppWorkspace } from "@/components/app/app-workspace-context"
import {
  InfoDangerAction,
  InfoDangerZone,
  InfoPage,
  InfoSection,
} from "@/components/info-page"
import { appConfigQueryOptions } from "@/lib/query-options"

// The app's details, its containers, and what it runs, each section with
// the actions that change it, and a rail summing up where it runs, who owns
// it, and its deployment. An app opens here.
export function AppInfoPage() {
  const { app, routeId } = useAppWorkspace()
  // Another app is a fresh page, so an open dialog's draft and the selected
  // container can't carry over to it.
  return (
    <AppInfoContent
      key={`${app.relayId}:${app.id}`}
      app={app}
      routeId={routeId}
    />
  )
}

function AppInfoContent({ app, routeId }: { app: App; routeId: string }) {
  const config = useQuery(appConfigQueryOptions(app.relayId, app.id))
  const [selection] = React.useState(createAppContainerSelection)
  const canManage =
    app.permissions.includes("app.manage") && appRelayAvailable(app)

  return (
    <AppContainerSelectionContext.Provider value={selection}>
      <InfoPage rail={<AppInfoRail app={app} routeId={routeId} />}>
        {/* What the app is and what it runs, side by side when there's
            room. */}
        <div className="@container">
          <div className="grid gap-4 @2xl:grid-cols-2">
            <AppGeneralSettings
              app={app}
              canRename={app.permissions.includes("app.manage")}
            />
            {config.data ? (
              <AppSourceSettings
                app={app}
                canManage={canManage}
                config={config.data.config}
                routeId={routeId}
              />
            ) : (
              <InfoSection icon={<ToyBrick />} title="Brick" content>
                {config.isError ? (
                  <p className="text-xs text-destructive">
                    {config.error.message}
                  </p>
                ) : (
                  <div className="grid h-16 place-items-center">
                    <LoaderCircle className="size-4 animate-spin text-muted-foreground" />
                  </div>
                )}
              </InfoSection>
            )}
          </div>
        </div>
        <AppContainerSection app={app} routeId={routeId} />
        {config.data ? (
          <AppVolumesSection
            app={app}
            canManage={canManage}
            config={config.data.config}
            routeId={routeId}
          />
        ) : null}
        <AppWebRouteSettings
          app={app}
          canManage={canManage}
          routeId={routeId}
        />
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
        Delete app
      </InfoDangerAction>
    </InfoDangerZone>
  )
}
