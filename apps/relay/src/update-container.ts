import { randomBytes } from "node:crypto"

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

// Marks the container an update creates, so rollback can find it even when
// Docker created it but the answer was lost.
const UPDATE_OPERATION_LABEL = "io.kiln.update-operation"

/**
 * Replaces a running Hearth or Relay container with one from the target
 * image, keeping its configuration, networks, and name.
 *
 * The old container is stopped and renamed aside, and the replacement
 * created, started, and checked. Until the replacement is healthy, any
 * failure rolls back (see `rollbackContainerReplacementEffect`): the old
 * container comes back under its name and running, and the channel tag
 * points at its image again. Once the replacement is healthy the update has
 * happened: removing the old container is cleanup, and a failure there
 * never rolls back.
 */
export function replaceContainerEffect(
  input: {
    backupName: string
    // Added as the installation label when the container has none.
    installationId?: string | undefined
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

    const operation = randomBytes(8).toString("hex")
    let replacementId: string | undefined
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
      // The join link a Relay was installed with is spent once it joined,
      // and holds a secret: a replacement starts without it.
      if (Array.isArray(current.Config.Env)) {
        preservedConfig.Env = current.Config.Env.filter(
          (entry: unknown) =>
            typeof entry !== "string" || !entry.startsWith("KILN_RELAY_JOIN=")
        )
      }
      // Docker's default hostname is the old container ID. Let Docker
      // regenerate it after the old container becomes the backup.
      if (isDockerGeneratedHostname(current.Config.Hostname, current.Id)) {
        delete preservedConfig.Hostname
      }
      const targetHealthcheck = target.Config?.Healthcheck
      yield* onPhase("replace.createTarget")
      const created = yield* updateOperation(
        "replace.createTarget",
        docker.createContainer(input.targetContainer, {
          ...preservedConfig,
          Image: input.targetReference,
          Labels: {
            ...current.Config.Labels,
            ...target.Config?.Labels,
            ...(input.installationId &&
            !current.Config.Labels?.[KILN_INSTALLATION_LABEL]?.trim()
              ? { [KILN_INSTALLATION_LABEL]: input.installationId }
              : {}),
            "org.opencontainers.image.version": input.targetVersion,
            [UPDATE_OPERATION_LABEL]: operation,
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
              [primaryNetwork]: userDefinedNetwork(primaryNetwork)
                ? {
                    Aliases: networkAliases(
                      networks[primaryNetwork]?.Aliases,
                      input.targetContainer
                    ),
                  }
                : {},
            },
          },
        })
      )
      replacementId = created.Id

      if (networkNames.length > 1) {
        yield* onPhase("replace.connectNetwork")
      }
      yield* Effect.forEach(
        networkNames.filter((network) => network !== primaryNetwork),
        (network) =>
          updateOperation(
            "replace.connectNetwork",
            docker.connectNetwork(
              network,
              input.targetContainer,
              userDefinedNetwork(network)
                ? {
                    aliases: networkAliases(
                      networks[network]?.Aliases,
                      input.targetContainer
                    ),
                  }
                : {}
            )
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
    }).pipe(
      Effect.catch((cause) =>
        rollbackContainerReplacementEffect(
          input,
          current,
          docker,
          operation,
          replacementId
        ).pipe(
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
    // The replacement is healthy, so the update has happened. The old
    // container (by its ID, whatever its name) is left behind if it can't
    // be removed, rather than undoing a working update.
    yield* onPhase("replace.removeBackup")
    yield* docker
      .removeContainer(current.Id, { force: true, timeout: 90_000 })
      .pipe(Effect.ignore)
  }).pipe(Effect.withSpan("relay.update.replaceContainer"))
}

/**
 * Puts the original container back, working from what Docker reports
 * rather than which steps reported success, since a step can fail after
 * Docker applied it (a create, rename, or stop whose answer was lost):
 *
 * 1. Containers this update created (by its label, or the ID Docker gave)
 *    are removed, but only once the original is confirmed to still exist,
 *    so the only working container is never deleted.
 * 2. The original (by its ID) gets its name back, unless something this
 *    update didn't create holds it, which is reported and left alone.
 * 3. Once it owns its name again, it's started if it was running.
 * 4. The channel tag points at its image again.
 *
 * Each step is attempted; what couldn't be done is returned.
 */
const rollbackContainerReplacementEffect = Effect.fn(
  "relay.update.rollbackContainer"
)(function* (
  input: {
    backupName: string
    // Added as the installation label when the container has none.
    installationId?: string | undefined
    targetContainer: string
    targetReference: string
  },
  current: ContainerInspect,
  docker: DockerEngine,
  operation: string,
  replacementId: string | undefined
) {
  const rollbackFailures: Array<string> = []
  const fail = (message: string) =>
    Effect.sync(() => {
      rollbackFailures.push(message)
    })
  const attempt = <A>(
    phase: string,
    effect: Effect.Effect<A, Error>
  ): Effect.Effect<A | undefined> =>
    updateOperation(phase, effect).pipe(
      Effect.catch((error) => fail(error.message).pipe(Effect.as(undefined)))
    )
  const original = attempt(
    "rollback.inspectOriginal",
    docker.inspectContainer<ContainerInspect>(current.Id).pipe(
      Effect.map((found): ContainerInspect | null => found),
      Effect.catchIf(isDockerNotFound, () => Effect.succeed(null))
    )
  )

  // 1. This update's containers, by its label and the ID Docker answered.
  const labelled = yield* attempt(
    "rollback.findReplacement",
    docker.listContainers({
      all: true,
      filters: { label: [`${UPDATE_OPERATION_LABEL}=${operation}`] },
    })
  )
  const replacements = new Set([
    ...(labelled ?? []).map((container) => container.Id),
    ...(replacementId ? [replacementId] : []),
  ])
  replacements.delete(current.Id)
  if (replacements.size > 0) {
    const before = yield* original
    if (before === null) {
      yield* fail(
        "The original container no longer exists, so its replacement was kept"
      )
    } else if (before !== undefined) {
      for (const id of replacements) {
        // Gone is gone, even if the removal's answer was lost.
        yield* attempt(
          "rollback.removeReplacement",
          docker.removeContainer(id, { force: true, timeout: 90_000 }).pipe(
            Effect.catch((cause) =>
              docker.inspectContainer(id).pipe(
                Effect.andThen(Effect.fail(cause)),
                Effect.catchIf(isDockerNotFound, () => Effect.void)
              )
            )
          )
        )
      }
    }
  }

  // 2. The original's name, from what holds it now.
  const restored = yield* original
  if (!restored) {
    if (restored === null) {
      yield* fail("The original container no longer exists")
    }
  } else {
    const owns = (container: ContainerInspect) =>
      container.Name.replace(/^\//u, "") === input.targetContainer
    let ownsName = owns(restored)
    if (!ownsName) {
      const holder = yield* attempt(
        "rollback.inspectName",
        docker.inspectContainer<ContainerInspect>(input.targetContainer).pipe(
          Effect.map((found): ContainerInspect | null => found),
          Effect.catchIf(isDockerNotFound, () => Effect.succeed(null))
        )
      )
      if (holder) {
        yield* fail(
          `${input.targetContainer} is held by container ${holder.Id.slice(0, 12)}, which this update didn't create, so the original kept the name ${restored.Name.replace(/^\//u, "")}`
        )
      } else if (holder === null) {
        // A rename can fail after Docker applied it: what Docker reports
        // decides.
        yield* updateOperation(
          "rollback.restoreBackup",
          docker.renameContainer(current.Id, input.targetContainer)
        ).pipe(Effect.ignore)
        const renamed = yield* attempt(
          "rollback.restoreBackup",
          docker.inspectContainer<ContainerInspect>(current.Id)
        )
        ownsName = renamed !== undefined && owns(renamed)
        if (renamed !== undefined && !ownsName) {
          yield* fail(
            `The original container couldn't take back the name ${input.targetContainer}`
          )
        }
      }
    }

    // 3. Its running state, once it owns its name.
    if (ownsName && current.State.Running) {
      yield* updateOperation(
        "rollback.startBackup",
        docker.startContainer(current.Id, { timeout: 120_000 })
      ).pipe(Effect.ignore)
      const started = yield* attempt(
        "rollback.startBackup",
        docker.inspectContainer<ContainerInspect>(current.Id)
      )
      if (started !== undefined && !started.State.Running) {
        yield* fail("The original container couldn't be started again")
      }
    }
  }

  // 4. The channel tag.
  yield* attempt(
    "rollback.restoreReference",
    docker.tagImage(current.Image, input.targetReference)
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
      const current =
        yield* docker.inspectContainer<ContainerInspect>(container)
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

// Docker's own bridge, host, and none networks take no aliases: a Relay
// the installer started without a proxy is on the bridge.
export function userDefinedNetwork(network: string): boolean {
  return (
    !["bridge", "host", "none"].includes(network) &&
    !network.startsWith("container:")
  )
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
