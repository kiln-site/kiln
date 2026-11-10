import * as React from "react"
import { Container, Gauge, LoaderCircle } from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"

import {
  InfoCopyValue,
  InfoFact,
  InfoFactPair,
  InfoSection,
} from "@/components/info-page"
import { ResourceLimitsDialog } from "@/components/resource-limits/resource-limits-section"
import { WorkloadUsageMeter } from "@/components/workload-resource-meters"

// The container an instance runs in, on its Info page: what it is, its
// live usage against its limits, and the limits themselves, which open
// from its header. A game server and a database have one; an App's own
// section pages through each service's with the same parts.

type LimitsDialog = Omit<
  React.ComponentProps<typeof ResourceLimitsDialog>,
  "onOpenChange" | "title"
>

/** A button in a section's header that is only an icon. */
export function SectionIconButton({
  children,
  label,
  onClick,
}: {
  children: React.ReactNode
  label: string
  onClick: () => void
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label={label}
          className="text-muted-foreground hover:text-foreground"
          onClick={onClick}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  )
}

/** CPU and memory side by side, each against its limit. */
export const ContainerUsageMeters = React.memo(function ContainerUsageMeters({
  cpuMillis,
  id,
  kind,
  memoryBytes,
  relayId,
  running,
  service,
}: {
  // Null when it runs without one.
  cpuMillis: number | null
  memoryBytes: number | null
} & Pick<
  React.ComponentProps<typeof WorkloadUsageMeter>,
  "id" | "kind" | "relayId" | "running" | "service"
>) {
  const shared = { id, kind, relayId, running, service }
  return (
    <div className="@container border-t border-border/60 px-4 py-2.5">
      <div className="grid gap-x-8 gap-y-1 @lg:grid-cols-2">
        <WorkloadUsageMeter {...shared} limit={cpuMillis} resourceId="cpu" />
        <WorkloadUsageMeter
          {...shared}
          limit={memoryBytes}
          resourceId="memory"
        />
      </div>
    </div>
  )
})

export function InstanceContainerSection({
  action,
  container,
  dataDirectory,
  disk,
  image,
  limits,
  limitsDialog,
  links,
  status,
  usage,
}: {
  /** Beside the title, such as what applies saved limits. */
  action?: React.ReactNode
  container: {
    id: string | null
    name: string | null
    /** The Relay is still being asked for what it reports separately. */
    pending?: boolean
  }
  /** Its folder on the Relay's host; null when the Relay doesn't say. */
  dataDirectory: string | null
  disk: React.ReactNode
  image?: string
  /** What the container runs under now. */
  limits: { cpuMillis: number | null; memoryBytes: number | null }
  limitsDialog: LimitsDialog
  /** Header links to where more of it is, such as its logs. */
  links?: React.ReactNode
  /** Beside the title, such as whether saved limits are waiting. */
  status?: React.ReactNode
  usage: Pick<
    React.ComponentProps<typeof WorkloadUsageMeter>,
    "id" | "kind" | "relayId" | "running"
  >
}) {
  const [limiting, setLimiting] = React.useState(false)
  const unknown = container.pending ? (
    <LoaderCircle
      aria-label="Loading"
      className="size-3.5 animate-spin text-muted-foreground"
    />
  ) : (
    <span className="text-muted-foreground">—</span>
  )
  return (
    <InfoSection
      icon={<Container />}
      title="Container"
      status={status}
      action={
        <>
          {action}
          <SectionIconButton
            label={
              limitsDialog.editable ? "Resource limits" : "View resource limits"
            }
            onClick={() => setLimiting(true)}
          >
            <Gauge />
          </SectionIconButton>
          {links}
          {limiting ? (
            <ResourceLimitsDialog
              {...limitsDialog}
              title="Resource limits"
              onOpenChange={setLimiting}
            />
          ) : null}
        </>
      }
      content="flush"
    >
      <dl className="@container px-4">
        <InfoFactPair>
          <InfoFact label="Container">
            {container.name ? (
              <InfoCopyValue label="container name" value={container.name} />
            ) : (
              unknown
            )}
          </InfoFact>
          <InfoFact label="Container ID">
            {/* Shortened as Docker shows it; the full ID is what's copied. */}
            {container.id ? (
              <InfoCopyValue
                display={container.id.slice(0, 12)}
                label="container ID"
                value={container.id}
              />
            ) : (
              <span className="text-muted-foreground">Not created</span>
            )}
          </InfoFact>
        </InfoFactPair>
        <InfoFactPair>
          <InfoFact label="Data">
            {dataDirectory ? (
              <InfoCopyValue
                display="Copy path"
                label="data path"
                mono={false}
                value={dataDirectory}
              />
            ) : (
              unknown
            )}
          </InfoFact>
          <InfoFact label="Disk">{disk}</InfoFact>
        </InfoFactPair>
        {image ? (
          <InfoFact label="Image">
            <InfoCopyValue label="image" value={image} />
          </InfoFact>
        ) : null}
      </dl>
      <ContainerUsageMeters
        {...usage}
        cpuMillis={limits.cpuMillis}
        memoryBytes={limits.memoryBytes}
        service={null}
      />
    </InfoSection>
  )
}
