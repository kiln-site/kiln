import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import type { AppConfig } from "@workspace/contracts"

import type { App } from "@/components/app/app-presentation"
import type { ComposeMount } from "@/lib/compose-mounts"
import {
  appDeploymentSummaryQueryOptions,
  appGitHubSourceFileQueryOptions,
} from "@/lib/query-options"

export type ComposeMountsModule = typeof import("@/lib/compose-mounts")

export interface AppComposeMounts {
  // Null until the file and its parser load, and for a file that doesn't
  // read as Compose.
  mounts: ReadonlyArray<ComposeMount> | null
  module: ComposeMountsModule | undefined
  // The Compose file's name, and whether its mounts are edited here: a
  // repository's are changed in the repository.
  path: string
  editable: boolean
}

// What the app's Compose file mounts: the pasted one, or the one its
// repository deploys, as its branch has it now.
export function useAppComposeMounts(
  app: App,
  config: Pick<AppConfig, "compose" | "sourceType">
): AppComposeMounts | null {
  const { data: source } = useQuery({
    ...appDeploymentSummaryQueryOptions(app.relayId, app.id),
    enabled: config.sourceType === "github",
    select: (summary) =>
      summary.source?.build === "compose" ? summary.source : null,
  })
  const github = config.sourceType === "github" ? (source ?? null) : null
  const { data: githubFile } = useQuery({
    ...appGitHubSourceFileQueryOptions(app.relayId, app.id, {
      branch: github?.branch ?? "",
      path: github?.path ?? "",
    }),
    enabled: github !== null,
    select: (file) => file.content,
  })
  const pasted = config.sourceType === "compose"
  const text = pasted ? config.compose : (githubFile ?? null)
  const { data: module } = useQuery({
    queryKey: ["compose-mounts-module"],
    queryFn: () => import("@/lib/compose-mounts"),
    enabled: pasted || github !== null,
    staleTime: Infinity,
  })
  const project = composeProject(app)
  const mounts = React.useMemo(() => {
    if (!module || text === null) return null
    return (
      module
        .composeMounts(text, project)
        ?.map((mount) => runningMount(app.containers, mount)) ?? null
    )
  }, [app.containers, module, project, text])
  if (!pasted && github === null) return null
  return {
    editable: pasted,
    module,
    mounts,
    path: pasted ? "compose.yaml" : (github?.path ?? "compose.yaml"),
  }
}

// The project the Relay runs the file as, which names its volumes. A
// project rolled over beside the last carries its deployment's ID, but
// one with volumes is never rolled.
function composeProject(app: App): string {
  const label = app.containers.find(
    (container) => container.labels["com.docker.compose.project"]
  )?.labels["com.docker.compose.project"]
  return label?.replace(/-\d{14}$/u, "") ?? `kiln-app-${app.id}`
}

// What a variable in the file made a mount, as the service's running
// container has it: whether it's a volume, and the volume's name. A mount
// the file names itself is as the file says, which may be ahead of what's
// deployed: a volume renamed there is a new one, though the container
// still has the old.
function runningMount(
  containers: App["containers"],
  mount: ComposeMount
): ComposeMount {
  if (mount.kind !== "bind" && mount.kind !== "volume") return mount
  // A variable in its source, or in the name it's declared with.
  if (!mount.source.includes("$") && !mount.dockerName?.includes("$")) {
    return mount
  }
  const running = containers
    .find((container) => container.service === mount.service)
    ?.mounts?.find((candidate) => candidate.destination === mount.target)
  if (running?.type === "volume") {
    return { ...mount, dockerName: running.source, kind: "volume" }
  }
  if (running?.type === "bind") {
    return { ...mount, dockerName: null, kind: "bind" }
  }
  return mount
}
