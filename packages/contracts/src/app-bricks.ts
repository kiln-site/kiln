import {
  brickAnswers,
  brickAnswersProblem,
  brickInputs,
  brickTemplateInput,
  fillBrickTemplate,
  type BrickInputValue,
  type BrickPort,
  type BrickRecipe,
} from "./brick-recipe.js"

// What Kiln runs of an App Brick so far: what it deploys and how it starts,
// the variables it sets, the port its website answers on, the ports it
// publishes on its Relay, and the folders it keeps. Hearth
// keeps an App's configuration, so Hearth turns the Brick and its answers
// into it, and the Relay deploys that configuration as it always has.

/**
 * Where an App's website answers: the port, and for a Compose project the
 * service that listens on it. Kiln routes the App's address to it.
 */
export interface AppBrickWeb {
  port: number
  service?: string
}

/** A port of its container an App publishes on its Relay, as an App's are. */
export interface AppBrickPublishedPort {
  containerPort: number
  hostPort: number
  protocol: "tcp" | "udp"
}

/**
 * What an App Brick deploys once its answers are in: an image, or the
 * Dockerfile or Compose file at a path in its source. The source is chosen
 * when the Brick is installed (a repository, or a file written in Hearth),
 * never by the Brick.
 */
export type AppBrickDeploy = (
  | {
      type: "image"
      image: string
      /** The variables the Brick sets, each with its template filled in. */
      environment: Record<string, string>
    }
  | { type: "dockerfile" | "compose"; path: string }
) & {
  /**
   * The folders of its container it keeps across deployments, each on a
   * volume made when it is installed. A Compose project keeps its own.
   */
  volumes: ReadonlyArray<string>
  /**
   * What its container runs in place of its image's command, when the
   * Brick says: one line, as an App's start command is written, which reads
   * back as the Brick's arguments (`appCommandLine`).
   */
  command?: string
  /** The ports it publishes on its Relay, when the Brick has public ones. */
  ports?: ReadonlyArray<AppBrickPublishedPort>
  /**
   * The command that succeeds in its container once it is ready, when the
   * Brick gives one: its container's health check. A Compose project says
   * each service's in its own file.
   */
  ready?: string
  /** Where its website answers, when the Brick and its answers say. */
  web?: AppBrickWeb
}

/**
 * What an App can deploy. Kiln's catalog has a Brick for each, and an App
 * that wasn't installed from a Brick is read as the one for what it deploys.
 */
export type AppBrickDeployType = AppBrickDeploy["type"]

/**
 * Kiln's own Brick for each thing an App can deploy, by ID. An App made
 * from one is its owner's in every part, so it follows no Brick: it keeps
 * none, and is never offered a revision.
 */
export const genericAppBrickIds: ReadonlySet<string> = new Set([
  "compose",
  "docker-image",
  "dockerfile",
])

/** As long as the image an App's configuration names may be. */
export const APP_IMAGE_MAX_LENGTH = 512

/** As long as an App's start command may be, written as one line. */
export const APP_COMMAND_MAX_LENGTH = 4_000

// The parts of `deploy` Kiln runs for an App, by type.
const deployed: Record<AppBrickDeployType, ReadonlyArray<string>> = {
  compose: ["type", "path", "ports"],
  dockerfile: ["type", "path", "command", "ports", "ready", "volumes"],
  image: ["type", "image", "command", "env", "ports", "ready", "volumes"],
}

// A folder an App Brick keeps: a path a volume can be mounted at, as an
// App's own mounts are, written one way so the same folder is the same
// path. Never the whole container, nor a path that climbs out of itself,
// nor one with a line break or another control character in it.
const keptFolderPattern = /^(?:\/[^:/]+)+$/u
const keptFolder = (folder: string) =>
  folder.length <= 512 &&
  keptFolderPattern.test(folder) &&
  ![...folder].some((character) => character < " " || character === "\u007f") &&
  !folder.split("/").some((part) => part === "." || part === "..")

// The folders a Brick keeps, each on a volume of its own.
function volumesProblem(volumes: ReadonlyArray<string>): string | null {
  const unusable = volumes.find((folder) => !keptFolder(folder))
  if (unusable !== undefined) {
    return `An App Brick keeps folders by their path, such as /data (${unusable})`
  }
  const twice = volumes.find((folder, index) => volumes.indexOf(folder) < index)
  return twice === undefined
    ? null
    : `An App Brick keeps each folder once (${twice})`
}

// How an App Brick's port is reached: through the proxy unless it says.
const exposed = (port: BrickPort) => port.expose ?? "http"

// The ports of an App Brick Kiln runs: one where its website answers, and
// any it publishes on its Relay. Anything a port says beyond that is
// refused until Kiln runs it.
function portsProblem(
  type: AppBrickDeployType,
  ports: ReadonlyArray<BrickPort>
): string | null {
  const published = new Set<string>()
  let web = false
  for (const port of ports) {
    if (exposed(port) === "private") {
      return "Kiln doesn't run an App Brick's private ports yet"
    }
    if (exposed(port) === "http") {
      if (web) return "Kiln gives an App Brick one web port for now"
      web = true
      if (port.protocol !== undefined && port.protocol !== "tcp") {
        return "A web port is TCP"
      }
      if (type === "compose" && port.service === undefined) {
        return "A Compose project's web port names its service"
      }
      continue
    }
    if (type === "compose") {
      return "A Compose project publishes its ports in its own file"
    }
    // Kiln picks no port on the Relay for an App yet, so the Brick says.
    if (port.host === undefined) {
      return `An App Brick's public port names its port on the Relay, as host (${port.name})`
    }
    for (const protocol of portProtocols(port)) {
      const key = `${port.host}/${protocol}`
      if (published.has(key)) {
        return `An App Brick publishes each port on the Relay once (${key})`
      }
      published.add(key)
    }
  }
  return null
}

const portProtocols = (port: BrickPort): ReadonlyArray<"tcp" | "udp"> =>
  port.protocol === "both" ? ["tcp", "udp"] : [port.protocol ?? "tcp"]

/**
 * Which ports of its container a Brick publishes, as an App keeps of the
 * Brick it follows: each as `25/tcp`, in order, whatever port of the Relay
 * each is published on, which is its owner's to change.
 */
export function appBrickPublishes(
  ports: ReadonlyArray<AppBrickPublishedPort> | undefined
): Array<string> {
  return [
    ...new Set(
      (ports ?? []).map((port) => `${port.containerPort}/${port.protocol}`)
    ),
  ].sort()
}

/**
 * A Brick's start command as an App's configuration writes one: a line the
 * Relay splits back into the same arguments, whatever they hold. An
 * argument with a space, a quote or nothing in it is quoted.
 */
export function appCommandLine(command: ReadonlyArray<string>): string {
  return command
    .map((word) =>
      /^[A-Za-z0-9_@%+=:,./-]+$/u.test(word)
        ? word
        : `'${word.replaceAll("'", "'\\''")}'`
    )
    .join(" ")
}

/**
 * Why Kiln can't install this as an App yet, or null when it can. It names
 * the first part the Brick uses that Kiln doesn't run for an App.
 */
export function appBrickProblem(recipe: BrickRecipe): string | null {
  const { deploy } = recipe
  if (recipe.kind !== "app" || deploy === undefined) {
    return "This isn't an App Brick"
  }
  const unrun = Object.keys(deploy).find(
    (part) => !deployed[deploy.type].includes(part)
  )
  if (unrun !== undefined) {
    return `Kiln doesn't run an App Brick's ${unrun} yet`
  }
  // An App is ready by a command, which becomes its container's health
  // check. Docker runs a check inside the container, so one by HTTP is a
  // command the Brick writes for what its image holds, and a log line is
  // no health check at all.
  if (deploy.ready !== undefined && !("command" in deploy.ready)) {
    return "Kiln checks an App Brick is ready by a command for now"
  }
  // Kept on one line, as an App's start command is, and no longer than
  // one may be once its arguments are quoted: a longer one can't be cut.
  if (deploy.type !== "compose" && deploy.command !== undefined) {
    if (deploy.command.some((word) => /[\r\n\0]/u.test(word))) {
      return "An App Brick's start command can't hold a line break"
    }
    if (appCommandLine(deploy.command).length > APP_COMMAND_MAX_LENGTH) {
      return "This Brick's start command is longer than an App's can be"
    }
  }
  return (
    portsProblem(deploy.type, deploy.ports ?? []) ??
    volumesProblem(appBrickVolumes(recipe))
  )
}

// The command an App Brick is ready by, if it gives one.
function appBrickReady(
  recipe: Pick<BrickRecipe, "deploy">
): { ready: string } | Record<string, never> {
  const ready = recipe.deploy?.ready
  return ready !== undefined && "command" in ready
    ? { ready: ready.command }
    : {}
}

/**
 * The folders an App Brick keeps across deployments, as it writes them.
 * They are the Brick's alone to say: no answer changes them.
 */
export function appBrickVolumes(
  recipe: Pick<BrickRecipe, "deploy">
): ReadonlyArray<string> {
  const { deploy } = recipe
  return deploy !== undefined && deploy.type !== "compose"
    ? (deploy.volumes ?? [])
    : []
}

/**
 * A Brick's answers as an install keeps them: every input's value as it
 * stands then, what was given, what follows another answer, and its
 * default, with a secret made for each input that asks Kiln to make one.
 * Kept that way, a later revision that changes a default changes it for new
 * installs only, and a secret is made once.
 */
export function brickInstallAnswers(
  recipe: Pick<BrickRecipe, "inputs">,
  given: Readonly<Record<string, BrickInputValue>>,
  make: () => string
): Record<string, BrickInputValue> {
  const inputs = brickInputs(recipe)
  // An answer to no input stays, for whoever checks them to refuse.
  const answers = { ...given, ...brickAnswers(inputs, given) }
  for (const input of inputs) {
    if (
      input.type === "secret" &&
      input.generate === true &&
      !Object.hasOwn(answers, input.key)
    ) {
      answers[input.key] = make()
    }
  }
  return answers
}

/**
 * What an App Brick deploys with these answers, or what is wrong with the
 * Brick or the answers. An input left unanswered follows its rules, then its
 * default. A secret Kiln makes is among the answers by then
 * (`brickInstallAnswers`): a template that names one not given is a
 * problem, as any unanswered template is.
 */
export function appBrickDeploy(
  recipe: BrickRecipe,
  given: Readonly<Record<string, BrickInputValue>>
): { deploy: AppBrickDeploy } | { problem: string } {
  const problem = appBrickProblem(recipe)
  const { deploy } = recipe
  if (problem !== null || deploy === undefined) {
    return { problem: problem ?? "This isn't an App Brick" }
  }
  const inputs = brickInputs(recipe)
  const unknown = Object.keys(given).find(
    (key) => !inputs.some((input) => input.key === key)
  )
  if (unknown !== undefined) {
    return { problem: `This Brick doesn't ask for ${unknown}` }
  }
  const answers = brickAnswers(inputs, given)
  const refused = brickAnswersProblem(inputs, answers)
  if (refused !== null) return { problem: refused.message }
  // Each port, as written or as an input answers it. An optional input left
  // blank says the App has none there: no website, or nothing published.
  let web: { web: AppBrickWeb } | Record<string, never> = {}
  const published: Array<AppBrickPublishedPort> = []
  for (const port of deploy.ports ?? []) {
    const answered =
      typeof port.port === "number"
        ? port.port
        : answers[brickTemplateInput(port.port) ?? ""]
    if (answered === undefined) continue
    if (
      !(
        typeof answered === "number" &&
        Number.isInteger(answered) &&
        answered >= 1 &&
        answered <= 65_535
      )
    ) {
      return {
        problem:
          exposed(port) === "http"
            ? "This Brick's web port isn't a port"
            : `This Brick's ${port.name} port isn't a port`,
      }
    }
    if (exposed(port) === "http") {
      web = {
        web: {
          port: answered,
          ...(port.service === undefined ? {} : { service: port.service }),
        },
      }
      continue
    }
    for (const protocol of portProtocols(port)) {
      // `appBrickProblem` refused a public port with no host.
      published.push({
        containerPort: answered,
        hostPort: port.host ?? answered,
        protocol,
      })
    }
  }
  // What it starts with and publishes, for an image or a Dockerfile.
  const runs =
    deploy.type === "compose"
      ? {}
      : {
          ...(deploy.command === undefined || deploy.command.length === 0
            ? {}
            : { command: appCommandLine(deploy.command) }),
          ...(published.length === 0 ? {} : { ports: published }),
        }
  const volumes = appBrickVolumes(recipe)
  if (deploy.type !== "image") {
    // Its file is in its source; `appBrickProblem` refused one written here.
    return {
      deploy: {
        path: deploy.path ?? "",
        type: deploy.type,
        volumes,
        ...appBrickReady(recipe),
        ...runs,
        ...web,
      },
    }
  }
  const filled = (template: string) =>
    fillBrickTemplate(template, (name) =>
      name === "brick.id"
        ? recipe.metadata.id
        : name === "brick.name"
          ? recipe.metadata.name
          : Object.hasOwn(answers, name)
            ? String(answers[name])
            : undefined
    )
  const image = filled(deploy.image).trim()
  // An optional input left blank leaves its template as written.
  if (image === "" || image.includes("{{")) {
    return { problem: "This Brick's image needs an answer it wasn't given" }
  }
  if (image.length > APP_IMAGE_MAX_LENGTH) {
    return { problem: "This Brick's image is longer than an App's can be" }
  }
  const environment: Record<string, string> = {}
  for (const [name, template] of Object.entries(deploy.env ?? {})) {
    const value = filled(template)
    if (value.includes("{{")) {
      return { problem: `${name} needs an answer this Brick wasn't given` }
    }
    // An App's environment is kept a line to a variable.
    if (/[\r\n]/u.test(value)) {
      return { problem: `${name} can't hold a line break` }
    }
    environment[name] = value
  }
  return {
    deploy: {
      environment,
      image,
      type: "image",
      volumes,
      ...appBrickReady(recipe),
      ...runs,
      ...web,
    },
  }
}
