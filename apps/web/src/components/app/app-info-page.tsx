import * as React from "react"
import { useNavigate } from "@tanstack/react-router"
import {
  Boxes,
  CalendarClock,
  Fingerprint,
  FolderOpen,
  HardDrive,
  Network,
  Trash2,
} from "lucide-react"

import { Button } from "@workspace/ui/components/button"

import { DeleteAppDialog } from "@/components/app/app-dialogs"
import {
  appStatusPresentation,
  type App,
} from "@/components/app/app-presentation"
import { useAppWorkspace } from "@/components/app/app-workspace-context"
import {
  CopyMetaRow,
  DangerZone,
  InfoCard,
  InfoCardHeader,
  MetaRow,
} from "@/components/info-card"
import { InstanceFavoriteButton } from "@/components/instance-favorite"
import { StatusIndicator } from "@/components/status-indicator"

const createdAtFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
})

// The details every kind of instance has: who and where it is, and how to
// remove it. What the app runs lives on its Overview.
export function AppInfoPage() {
  const { app } = useAppWorkspace()

  return (
    <section className="min-h-0 flex-1 overflow-y-auto bg-card">
      <div className="mx-auto max-w-5xl px-5 py-6 sm:px-8 sm:py-8">
        <AppIdentityCard app={app} />
        <InfoCard className="mt-4">
          <InfoCardHeader
            icon={<Network />}
            title="Relay placement"
            action={<StatusIndicator status={appStatusPresentation(app)} />}
          />
          <div className="grid sm:grid-cols-2">
            <MetaRow
              icon={HardDrive}
              label="Relay"
              value={`${app.relayName} · ${app.relayId}`}
            />
            <MetaRow
              icon={Network}
              label="Docker network"
              value={app.network || "Not created"}
              mono
            />
          </div>
          {app.dataDirectory ? (
            <CopyMetaRow
              icon={FolderOpen}
              label="Data directory on the host"
              value={app.dataDirectory}
            />
          ) : null}
        </InfoCard>

        {app.permissions.includes("app.delete") ? (
          <AppDangerZone app={app} />
        ) : null}
      </div>
    </section>
  )
}

function AppIdentityCard({ app }: { app: App }) {
  return (
    <InfoCard>
      <InfoCardHeader
        icon={<Fingerprint />}
        title="Identity"
        action={
          <div className="flex items-center gap-2">
            <StatusIndicator status={appStatusPresentation(app)} />
            <InstanceFavoriteButton
              id={app.id}
              kind="app"
              relayId={app.relayId}
            />
          </div>
        }
      />
      <MetaRow icon={Boxes} label="Name" value={app.name} />
      <MetaRow
        icon={Fingerprint}
        label="App full ID"
        value={app.id}
        mono
        wrap
      />
      <CopyMetaRow
        icon={Network}
        label="Internal address"
        value={app.hostname}
      />
      <MetaRow
        icon={CalendarClock}
        label="Created"
        value={createdAtFormatter.format(new Date(app.createdAt))}
      />
    </InfoCard>
  )
}

function AppDangerZone({ app }: { app: App }) {
  const navigate = useNavigate()
  const [open, setOpen] = React.useState(false)
  return (
    <>
      <DangerZone
        title="Delete app"
        detail={app.dataDirectory || app.id}
        action={
          <Button
            type="button"
            variant="destructive"
            onClick={() => setOpen(true)}
          >
            <Trash2 />
            Delete
          </Button>
        }
      />
      {open ? (
        <DeleteAppDialog
          app={app}
          open
          onDeleted={() => void navigate({ to: "/infra/apps" })}
          onOpenChange={setOpen}
        />
      ) : null}
    </>
  )
}
