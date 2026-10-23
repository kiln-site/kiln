import {
  relayConsoleReadActions,
  relayPlatformTargetSchema,
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
  // Refuses a Hearth that this output's kind holds to more than the read
  // action, such as Kiln's services, for the Hearth the Relay installed.
  readonly authorize?: (clientId: string) => Promise<void>
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
  apps: Pick<AppDriver, "consoleSession">,
  // This Relay's ID, and the container it runs in (unknown outside Docker).
  relay: () => { containerId: string | null; id: string },
  platform: {
    // Throws unless the Hearth may read Kiln's services.
    authorize: (clientId: string) => Promise<void>
    // The container of one of Kiln's services on this host, or its proxy.
    container: (
      target: ReturnType<typeof relayPlatformTargetSchema.parse>
    ) => Promise<string | null>
  }
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
      case "relay":
        return {
          readAction: relayConsoleReadActions.relay,
          session: async (signal) => {
            const { containerId, id: relayId } = relay()
            if (id !== relayId) throw new Error("Relay not found")
            if (!containerId) {
              throw new Error("This Relay is not running in a container")
            }
            return docker.containerConsoleSession(id, containerId, signal)
          },
        }
      // Kiln's services on this Relay's host, one container per stream.
      case "platform":
        return {
          authorize: platform.authorize,
          readAction: relayConsoleReadActions.platform,
          session: async (signal) => {
            if (id !== relay().id) throw new Error("Relay not found")
            const target = relayPlatformTargetSchema.parse(stream ?? "hearth")
            const containerId = await platform.container(target)
            if (!containerId) {
              throw new Error(`Kiln's ${target} container isn't on this host`)
            }
            return docker.containerConsoleSession(id, containerId, signal)
          },
        }
      default:
        return kind satisfies never
    }
  }
}
