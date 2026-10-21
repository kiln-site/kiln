import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import type { AppMount, RelayVolume } from "@workspace/contracts"
import { FileText, FolderTree, HardDrive, Settings2 } from "lucide-react"

import { Button } from "@workspace/ui/components/button"

import {
  AppCodeDialog,
  type EditableAppConfig,
} from "@/components/app/app-config-dialogs"
import { AppMountsDialog } from "@/components/app/app-mounts-dialog"
import type { App } from "@/components/app/app-presentation"
import { ServiceTag, useAppRunsCompose } from "@/components/app/app-settings"
import { InfoSection } from "@/components/info-page"
import { relayVolumesQueryOptions } from "@/lib/query-options"
import { warmSyntaxCodeEditorModule } from "@/lib/syntax-editor-module-preload"

// What the app mounts: the Relay's volumes, paths on the node, and files
// kept in its config, which open in the code dialog. Its containers keep
// nothing else across deploys. Configure changes them; they apply on the
// next deploy.
export function AppVolumesSection({
  app,
  canManage,
  config,
  routeId,
}: {
  app: App
  canManage: boolean
  config: EditableAppConfig
  routeId: string
}) {
  const [configuring, setConfiguring] = React.useState(false)
  const compose = useAppRunsCompose(app)
  const { mounts } = config
  const { data: volumeNames } = useQuery({
    ...relayVolumesQueryOptions(app.relayId),
    enabled: mounts.some((mount) => mount.source.type === "volume"),
    select: volumeNamesById,
  })
  return (
    <InfoSection
      icon={<HardDrive />}
      title="Volumes"
      action={
        canManage ? (
          <>
            <Button
              size="sm"
              type="button"
              variant="outline"
              onClick={() => setConfiguring(true)}
            >
              <Settings2 />
              Configure
            </Button>
            {configuring ? (
              <AppMountsDialog
                app={app}
                compose={compose}
                deploying={app.deployment?.state === "running"}
                routeId={routeId}
                saved={mounts}
                onOpenChange={setConfiguring}
              />
            ) : null}
          </>
        ) : null
      }
      content={mounts.length === 0 ? true : "flush"}
    >
      {mounts.length === 0 ? (
        <p className="text-[0.8125rem] text-muted-foreground">
          Nothing yet, so the app keeps no data across deploys. Mount a volume
          to keep or share data, a path on the node, or a file.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[0.8125rem]">
            <thead>
              <tr className="type-technical-label border-b text-left text-muted-foreground/80 [&>th]:px-4 [&>th]:py-2 [&>th]:font-normal">
                <th>Source</th>
                <th>Mounted at</th>
                {compose ? <th>Service</th> : null}
                <th className="text-right">Access</th>
              </tr>
            </thead>
            <tbody>
              {mounts.map((mount) => (
                <tr
                  key={mount.id}
                  className="border-b border-border/60 last:border-b-0 [&>td]:h-10 [&>td]:px-4 [&>td]:py-1.5"
                >
                  <td className="max-w-0 min-w-48">
                    <AppMountSource
                      app={app}
                      canManage={canManage}
                      mount={mount}
                      mounts={mounts}
                      routeId={routeId}
                      volumeNames={volumeNames}
                    />
                  </td>
                  <td className="max-w-0 min-w-40">
                    <span
                      className="block truncate font-mono text-xs"
                      title={mount.target}
                    >
                      {mount.target}
                    </span>
                  </td>
                  {compose ? (
                    <td className="whitespace-nowrap">
                      {mount.service ? (
                        <ServiceTag app={app} service={mount.service} />
                      ) : (
                        <span className="text-muted-foreground">Every</span>
                      )}
                    </td>
                  ) : null}
                  <td className="text-right whitespace-nowrap text-muted-foreground">
                    {mount.readOnly ? "Read-only" : "Read-write"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </InfoSection>
  )
}

function volumeNamesById(data: {
  volumes: ReadonlyArray<RelayVolume>
}): ReadonlyMap<string, string> {
  return new Map(
    data.volumes.flatMap((volume) =>
      volume.id ? [[volume.id, volume.name] as const] : []
    )
  )
}

function AppMountSource({
  app,
  canManage,
  mount,
  mounts,
  routeId,
  volumeNames,
}: {
  app: App
  canManage: boolean
  mount: AppMount
  mounts: ReadonlyArray<AppMount>
  routeId: string
  volumeNames: ReadonlyMap<string, string> | undefined
}) {
  const { source } = mount
  switch (source.type) {
    case "volume": {
      const name = volumeNames?.get(source.volumeId)
      return (
        <span className="flex min-w-0 items-center gap-2">
          <HardDrive className="size-3.5 shrink-0 text-muted-foreground" />
          {volumeNames && name === undefined ? (
            <span className="truncate text-destructive">Volume deleted</span>
          ) : (
            <span className="truncate" title={name}>
              {name ?? `Volume ${source.volumeId.slice(0, 8)}`}
            </span>
          )}
        </span>
      )
    }
    case "host":
      return (
        <span
          className="flex min-w-0 items-center gap-2"
          title={`${source.path} on the node`}
        >
          <FolderTree className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate font-mono text-xs">{source.path}</span>
        </span>
      )
    case "file":
      return canManage ? (
        <AppMountFileButton
          app={app}
          content={source.content}
          mount={mount}
          mounts={mounts}
          routeId={routeId}
        />
      ) : (
        <span className="flex min-w-0 items-center gap-2">
          <FileText className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate font-mono text-xs">
            {fileName(mount.target)}
          </span>
        </span>
      )
  }
}

// A file the config mounts, edited in the code dialog. Saving it saves the
// mounts as they are with its new contents.
function AppMountFileButton({
  app,
  content,
  mount,
  mounts,
  routeId,
}: {
  app: App
  content: string
  mount: AppMount
  mounts: ReadonlyArray<AppMount>
  routeId: string
}) {
  const [open, setOpen] = React.useState(false)
  const name = fileName(mount.target)
  return (
    <>
      <Button
        className="max-w-full"
        size="xs"
        type="button"
        variant="outline"
        onPointerEnter={warmSyntaxCodeEditorModule}
        onFocus={warmSyntaxCodeEditorModule}
        onClick={() => {
          warmSyntaxCodeEditorModule()
          setOpen(true)
        }}
      >
        <FileText />
        <span className="truncate font-mono">{name}</span>
      </Button>
      {open ? (
        <AppCodeDialog
          app={app}
          canManage
          configFor={(draft) => ({
            mounts: mounts.map((entry) =>
              entry.id === mount.id
                ? { ...entry, source: { content: draft, type: "file" } }
                : entry
            ),
          })}
          deploying={app.deployment?.state === "running"}
          document={{
            hint: `Mounted at ${mount.target}.`,
            noun: "file",
            path: name,
            placeholder: "",
          }}
          routeId={routeId}
          saved={content}
          onOpenChange={setOpen}
        />
      ) : null}
    </>
  )
}

function fileName(target: string): string {
  return target.split("/").filter(Boolean).at(-1) ?? target
}
