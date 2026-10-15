import {
  LEGACY_KILN_GIT_REPO,
  DEFAULT_KILN_GIT_REPO,
  kilnImageRepository,
} from "@workspace/contracts"
import { Effect } from "effect"

import { type DockerEngine, isDockerNotFound } from "./docker-engine.js"
import { RelaySystemUpdateError } from "./effect/errors.js"

// Official images retain the pre-rename source label until older Relays that
// require this exact value have had a compatibility release available.
export const KILN_IMAGE_SOURCE = LEGACY_KILN_GIT_REPO
export const KILN_INSTALLATION_LABEL = "io.kiln.installation"

export type KilnComponent = "hearth" | "relay"

export interface ContainerInspect {
  Config: Record<string, unknown> & {
    Cmd?: unknown
    Entrypoint?: unknown
    Healthcheck?: unknown
    Hostname?: string
    Image?: string
    Labels?: Record<string, string> | null
  }
  HostConfig: Record<string, unknown> & {
    NetworkMode?: string
  }
  Id: string
  Image: string
  Mounts?: Array<{
    Destination: string
    Name?: string
    RW?: boolean
    Type?: string
  }>
  Name: string
  NetworkSettings?: {
    Networks?: Record<string, { Aliases?: Array<string> | null }>
  }
  State: {
    Health?: { Status?: string }
    Running: boolean
  }
}

export interface ImageInspect {
  Config?: {
    Healthcheck?: unknown
    Labels?: Record<string, string> | null
  }
}

export function kilnComponent(value: string | undefined): KilnComponent | null {
  return value === "hearth" || value === "relay" ? value : null
}

export function managedImageChannel(
  image: string,
  component: KilnComponent,
  repository = DEFAULT_KILN_GIT_REPO
): string | null {
  const stable = `${kilnImageRepository(component, repository)}:latest`
  const nightly = `${kilnImageRepository(component, repository)}:latest-nightly`
  return image === stable || image === nightly ? image : null
}

/**
 * Replaces a running Hearth or Relay container with one from the target
 * image, keeping its configuration, networks, and name. The old container is
 * renamed aside first and comes back, running, if any step after that fails
 * (stopping it, renaming it, or the replacement failing to start or become
 * healthy); the channel tag is pointed back at the old image too.
 */
export function replaceContainerEffect(
  input: {
    backupName: string
    targetContainer: string
    targetImage: string
    targetReference: string
    targetVersion: string
  },
  docker: DockerEngine,
  onPhase: (phase: string) => Effect.Effect<void>
) {
  return Effect.gen(function* () {
    yield* onPhase("replace.inspectContainer")
    const [current, target] = yield* Effect.all(
      [
        updateOperation(
          "replace.inspectContainer",
          docker.inspectContainer<ContainerInspect>(input.targetContainer)
        ),
        updateOperation(
          "replace.inspectImage",
          docker.inspectImage<ImageInspect>(input.targetImage)
        ),
      ] as const,
      { concurrency: 2 }
    )
    const networks = current.NetworkSettings?.Networks ?? {}
    const networkNames = Object.keys(networks)
    const configuredNetwork = current.HostConfig.NetworkMode
    const primaryNetwork =
      configuredNetwork && Object.hasOwn(networks, configuredNetwork)
        ? configuredNetwork
        : networkNames[0]
    if (!primaryNetwork) {
      return yield* updateFailure(
        "replace.validate",
        "The target has no Docker network to preserve"
      )
    }

    yield* Effect.gen(function* () {
      yield* onPhase("replace.tagTarget")
      yield* updateOperation(
        "replace.tagTarget",
        docker.tagImage(input.targetImage, input.targetReference)
      )
      yield* onPhase("replace.stopCurrent")
      yield* updateOperation(
        "replace.stopCurrent",
        docker.stopContainer(input.targetContainer, {
          seconds: 30,
          timeout: 45_000,
        })
      )
      yield* onPhase("replace.renameCurrent")
      yield* updateOperation(
        "replace.renameCurrent",
        docker.renameContainer(input.targetContainer, input.backupName)
      )

      const preservedConfig = { ...current.Config }
      delete preservedConfig.Cmd
      delete preservedConfig.Entrypoint
      delete preservedConfig.Healthcheck
      // Docker's default hostname is the old container ID. Let Docker
      // regenerate it after the old container becomes the backup.
      if (isDockerGeneratedHostname(current.Config.Hostname, current.Id)) {
        delete preservedConfig.Hostname
      }
      const targetHealthcheck = target.Config?.Healthcheck
      yield* onPhase("replace.createTarget")
      yield* updateOperation(
        "replace.createTarget",
        docker.createContainer(input.targetContainer, {
          ...preservedConfig,
          Image: input.targetReference,
          Labels: {
            ...current.Config.Labels,
            ...target.Config?.Labels,
            "org.opencontainers.image.version": input.targetVersion,
          },
          ...(targetHealthcheck === undefined
            ? {}
            : { Healthcheck: targetHealthcheck }),
          HostConfig: {
            ...current.HostConfig,
            NetworkMode: primaryNetwork,
          },
          NetworkingConfig: {
            EndpointsConfig: {
              [primaryNetwork]: {
                Aliases: networkAliases(
                  networks[primaryNetwork]?.Aliases,
                  input.targetContainer
                ),
              },
            },
          },
        })
      )

      if (networkNames.length > 1) {
        yield* onPhase("replace.connectNetwork")
      }
      yield* Effect.forEach(
        networkNames.filter((network) => network !== primaryNetwork),
        (network) =>
          updateOperation(
            "replace.connectNetwork",
            docker.connectNetwork(network, input.targetContainer, {
              aliases: networkAliases(
                networks[network]?.Aliases,
                input.targetContainer
              ),
            })
          ),
        { discard: true }
      )

      yield* onPhase("replace.startTarget")
      yield* updateOperation(
        "replace.startTarget",
        docker.startContainer(input.targetContainer, { timeout: 120_000 })
      )
      yield* onPhase("replace.waitUntilHealthy")
      yield* updateOperation(
        "replace.waitUntilHealthy",
        waitUntilHealthy(docker, input.targetContainer)
      )
      yield* onPhase("replace.removeBackup")
      yield* updateOperation(
        "replace.removeBackup",
        docker.removeContainer(input.backupName, {
          force: true,
          timeout: 90_000,
        })
      )
    }).pipe(
      Effect.catch((cause) =>
        rollbackContainerReplacementEffect(input, current, docker).pipe(
          Effect.flatMap((rollbackFailures) =>
            Effect.fail(
              RelaySystemUpdateError.make({
                phase: "replace",
                reason: cause.message,
                cause,
                rollbackFailures,
              })
            )
          )
        )
      ),
      Effect.uninterruptible
    )
  }).pipe(Effect.withSpan("relay.update.replaceContainer"))
}

/**
 * Puts the original container back as it was, from what Docker reports
 * rather than which steps reported success, since a step can fail after
 * Docker applied it (a rename or stop that timed out): whatever else holds
 * the name is removed, the original (found by its ID) gets its name back,
 * and then its running state. Every step is attempted; failures are
 * returned.
 */
const rollbackContainerReplacementEffect = Effect.fn(
  "relay.update.rollbackContainer"
)(function* (
  input: {
    backupName: string
    targetContainer: string
    targetReference: string
  },
  current: ContainerInspect,
  docker: DockerEngine
) {
  const rollbackFailures: Array<string> = []
  const attempt = (operation: Effect.Effect<void, RelaySystemUpdateError>) =>
    operation.pipe(
      Effect.catch((error) =>
        Effect.sync(() => {
          rollbackFailures.push(error.message)
        })
      )
    )
  yield* attempt(
    updateOperation(
      "rollback.removeReplacement",
      docker.inspectContainer<ContainerInspect>(input.targetContainer).pipe(
        Effect.flatMap((holder) =>
          holder.Id === current.Id
            ? Effect.void
            : docker.removeContainer(holder.Id, {
                force: true,
                timeout: 90_000,
              })
        ),
        Effect.catchIf(isDockerNotFound, () => Effect.void)
      )
    )
  )
  // Started only once it has its name back, so it never runs beside a
  // replacement that couldn't be removed.
  yield* attempt(
    updateOperation(
      "rollback.restoreBackup",
      docker.inspectContainer<ContainerInspect>(current.Id).pipe(
        Effect.flatMap((original) =>
          original.Name.replace(/^\//u, "") === input.targetContainer
            ? Effect.void
            : docker.renameContainer(current.Id, input.targetContainer)
        )
      )
    ).pipe(
      Effect.andThen(
        current.State.Running
          ? updateOperation(
              "rollback.startBackup",
              docker.startContainer(current.Id, { timeout: 120_000 })
            )
          : Effect.void
      )
    )
  )
  yield* attempt(
    updateOperation(
      "rollback.restoreReference",
      docker.tagImage(current.Image, input.targetReference)
    )
  )
  return rollbackFailures
})

/**
 * Waits for a started container to become healthy, or, without a health
 * check, to keep running for five seconds.
 */
export function waitUntilHealthy(
  docker: DockerEngine,
  container: string
): Effect.Effect<void, Error> {
  return Effect.gen(function* () {
    const deadline = Date.now() + 120_000
    let runningSince = 0
    while (Date.now() < deadline) {
      const current = yield* docker.inspectContainer<ContainerInspect>(container)
      if (!current.State.Running) {
        return yield* Effect.fail(
          new Error("The replacement container exited during startup")
        )
      }
      const health = current.State.Health?.Status
      if (health === "healthy") return
      if (health === "unhealthy") {
        return yield* Effect.fail(
          new Error("The replacement container failed its health check")
        )
      }
      if (!health) {
        runningSince ||= Date.now()
        if (Date.now() - runningSince >= 5_000) return
      }
      yield* Effect.sleep(1_000)
    }
    return yield* Effect.fail(
      new Error("The replacement container did not become healthy in time")
    )
  })
}

function updateOperation<A>(
  phase: string,
  operation: Effect.Effect<A, Error>
): Effect.Effect<A, RelaySystemUpdateError> {
  return operation.pipe(
    Effect.mapError((cause) =>
      cause instanceof RelaySystemUpdateError
        ? cause
        : RelaySystemUpdateError.make({
            phase,
            reason: cause.message || "System update failed",
            cause,
            rollbackFailures: [],
          })
    )
  )
}

function updateFailure(phase: string, reason: string) {
  return Effect.fail(
    RelaySystemUpdateError.make({
      phase,
      reason,
      rollbackFailures: [],
    })
  )
}

export function isDockerGeneratedHostname(
  hostname: string | undefined,
  containerId: string
): boolean {
  return hostname === containerId.slice(0, 12) || hostname === containerId
}

export function networkAliases(
  aliases: Array<string> | null | undefined,
  targetContainer: string
): Array<string> {
  return Array.from(
    new Set([
      ...(aliases ?? []).filter((alias) => !/^[a-f0-9]{12,64}$/u.test(alias)),
      targetContainer,
    ])
  )
}
