import {
  relayConsoleReadActions,
  type RelayBrowserResourceKind,
  type RelayInstanceLifecycleEvent,
} from "@workspace/contracts"

import type { AppDriver } from "./apps.js"
import type { DatabaseDriver } from "./databases.js"
import type { DockerConsoleSession, DockerDriver } from "./docker.js"
import type { RelaySnapshotSample } from "./snapshot-hub.js"

// Where a browser's console output comes from, for each kind of resource. The
// browser socket and its console hubs treat every kind alike; a new kind only
// says how to find its output here.
export interface ConsoleSource {
  // The action a browser needs to read this output.
  readonly readAction: string
  // The resource's output now: its current run's history and what follows.
  readonly session: (signal?: AbortSignal) => Promise<DockerConsoleSession>
  // Where the Relay's snapshots report the resource's runs, for kinds they
  // cover. Hubs then switch to a new run as soon as it starts; others switch
  // once the old run's output ends.
  readonly lifecycle?: (
    sample: RelaySnapshotSample
  ) => ReadonlyArray<RelayInstanceLifecycleEvent> | undefined
}

export type ConsoleSources = (
  kind: RelayBrowserResourceKind,
  id: string,
  // One of the resource's outputs, for kinds with more than one.
  stream?: string
) => ConsoleSource

export function consoleSources(
  docker: Pick<DockerDriver, "consoleSession" | "containerConsoleSession">,
  databases: Pick<DatabaseDriver, "target">,
  apps: Pick<AppDriver, "consoleSession">
): ConsoleSources {
  return (kind, id, stream) => {
    switch (kind) {
      case "instance":
        return {
          lifecycle: (sample) =>
            sample.snapshot.instances.find((instance) => instance.id === id)
              ?.lifecycle,
          readAction: relayConsoleReadActions.instance,
          session: (signal) => docker.consoleSession(id, signal),
        }
      case "database":
        return {
          readAction: relayConsoleReadActions.database,
          session: async (signal) => {
            const database = await databases.target(id)
            if (!database.containerId) {
              throw new Error("Database container ID is missing")
            }
            return docker.containerConsoleSession(
              id,
              database.containerId,
              signal
            )
          },
        }
      case "app":
        return {
          readAction: relayConsoleReadActions.app,
          session: (signal) =>
            apps.consoleSession(
              id,
              stream,
              (containerId, containerSignal) =>
                docker.containerConsoleSession(
                  id,
                  containerId,
                  containerSignal
                ),
              signal
            ),
        }
      default:
        return kind satisfies never
    }
  }
}
