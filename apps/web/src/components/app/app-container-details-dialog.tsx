import * as React from "react"

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@workspace/ui/components/dialog"
import { cn } from "@workspace/ui/lib/utils"

import type { App } from "@/components/app/app-presentation"
import { InfoCopyValue, InfoFact } from "@/components/info-page"
import { useUptime } from "@/components/resource-meters"

type AppContainer = App["containers"][number]

const startedAtFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "medium",
})

// Rows in the dialog's list. A pair sits side by side when there's room.
const rowClassName =
  "border-b border-border/60 [&>div]:border-b-0 sm:[&>div]:min-w-0"
const pairClassName = cn(rowClassName, "sm:grid sm:grid-cols-2 sm:gap-x-8")
// A volume or label: what it is on the left, where it points on the right.
const listRowClassName =
  "grid grid-cols-2 items-center gap-x-8 py-1"

// Everything about one container, with room for its long name, ID, and
// labels, each a click to copy.
export function AppContainerDetailsDialog({
  container,
  onOpenChange,
}: {
  container: AppContainer
  onOpenChange: (open: boolean) => void
}) {
  const labels = Object.entries(container.labels).sort(([left], [right]) =>
    left.localeCompare(right)
  )
  const mounts = container.mounts ?? null
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Container details</DialogTitle>
          <DialogDescription>
            The {container.service} service&apos;s container, as Docker
            reports it.
          </DialogDescription>
        </DialogHeader>
        <div className="flex min-w-0 flex-col">
          <dl className={pairClassName}>
            <InfoFact label="Service">
              <span className="flex min-w-0 items-center gap-1.5">
                <span
                  aria-hidden="true"
                  className={cn(
                    "size-1.5 shrink-0 rounded-full",
                    container.running
                      ? "bg-emerald-400"
                      : "bg-muted-foreground/50"
                  )}
                />
                <InfoCopyValue label="service" value={container.service} />
              </span>
            </InfoFact>
            <InfoFact label="Image">
              <InfoCopyValue label="image" value={container.image} />
            </InfoFact>
          </dl>
          <dl className={rowClassName}>
            <InfoFact label="Container name">
              <InfoCopyValue label="container name" value={container.name} />
            </InfoFact>
          </dl>
          <dl className={rowClassName}>
            <InfoFact label="Container ID">
              <InfoCopyValue label="container ID" value={container.id} />
            </InfoFact>
          </dl>
          <dl className={pairClassName}>
            <InfoFact label="Started at">
              {container.running && container.startedAt ? (
                <InfoCopyValue
                  label="start time"
                  mono={false}
                  display={startedAtFormatter.format(
                    new Date(container.startedAt)
                  )}
                  value={container.startedAt}
                />
              ) : (
                <span className="text-muted-foreground">Not running</span>
              )}
            </InfoFact>
            <InfoFact label="Uptime">
              <ContainerUptime container={container} />
            </InfoFact>
          </dl>
        </div>
        <DetailsList
          count={mounts?.length}
          empty={
            mounts === null
              ? "Update this Relay to see the container's volumes."
              : "No volumes."
          }
          title="Volumes"
        >
          {mounts?.map((mount) => (
            <li
              key={`${mount.destination}:${mount.source}`}
              className={cn(listRowClassName, "min-h-10 text-[0.8125rem]")}
            >
              <span className="flex min-w-0 items-center gap-2">
                <InfoCopyValue label="mount path" value={mount.destination} />
                <MountTag>{mount.type}</MountTag>
                {mount.readOnly ? <MountTag>read-only</MountTag> : null}
              </span>
              <span className="flex min-w-0 justify-end">
                {mount.source ? (
                  <InfoCopyValue
                    label={mount.type === "volume" ? "volume name" : "source"}
                    value={mount.source}
                  />
                ) : (
                  <span className="text-muted-foreground">In memory</span>
                )}
              </span>
            </li>
          ))}
        </DetailsList>
        <DetailsList
          count={labels.length}
          empty="No labels."
          listClassName="max-h-72 overflow-y-auto"
          title="Labels"
        >
          {labels.map(([key, value]) => (
            <li
              key={key}
              className={cn(listRowClassName, "min-h-9")}
            >
              <InfoCopyValue label="label name" value={key} />
              <span className="flex min-w-0 justify-end">
                {value ? (
                  <InfoCopyValue label={`${key} value`} value={value} />
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </span>
            </li>
          ))}
        </DetailsList>
      </DialogContent>
    </Dialog>
  )
}

// Ticks on its own, so the rest of the dialog doesn't re-render.
function ContainerUptime({ container }: { container: AppContainer }) {
  const uptime = useUptime(container.startedAt, container.running)
  return (
    <span
      className={cn(
        "tabular-nums",
        uptime === null && "text-muted-foreground"
      )}
    >
      {uptime ?? (container.running ? "—" : "Stopped")}
    </span>
  )
}

// A titled list below the facts, such as the container's volumes.
function DetailsList({
  children,
  count,
  empty,
  listClassName,
  title,
}: {
  children: React.ReactNode
  count: number | undefined
  empty: string
  listClassName?: string
  title: string
}) {
  return (
    <section className="min-w-0">
      <div className="flex h-8 items-center gap-2 border-b border-border/60">
        <h3 className="type-technical-label text-muted-foreground/80">
          {title}
        </h3>
        {count ? (
          <span className="ml-auto text-xs text-muted-foreground tabular-nums">
            {count}
          </span>
        ) : null}
      </div>
      {count ? (
        <ul
          className={cn(
            "divide-y divide-border/60 border-b border-border/60",
            listClassName
          )}
        >
          {children}
        </ul>
      ) : (
        <p className="py-3 text-[0.8125rem] text-muted-foreground">{empty}</p>
      )}
    </section>
  )
}

function MountTag({ children }: { children: React.ReactNode }) {
  return (
    <span className="shrink-0 border bg-muted/30 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
      {children}
    </span>
  )
}
