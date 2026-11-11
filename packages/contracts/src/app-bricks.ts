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

// What Kiln runs of an App Brick so far: what it deploys, the variables it
// sets, and the port its website answers on. Hearth keeps an App's
// configuration, so Hearth turns the Brick and its answers into it, and the
// Relay deploys that configuration as it always has.

/**
 * Where an App's website answers: the port, and for a Compose project the
 * service that listens on it. Kiln routes the App's address to it.
 */
export interface AppBrickWeb {
  port: number
  service?: string
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

// The parts of `deploy` Kiln runs for an App, by type.
const deployed: Record<AppBrickDeployType, ReadonlyArray<string>> = {
  compose: ["type", "path", "ports"],
  dockerfile: ["type", "path", "ports"],
  image: ["type", "image", "env", "ports"],
}

// The one port of an App Brick Kiln runs: where its website answers.
// Anything a port says beyond that is refused until Kiln runs it.
function webPortProblem(
  type: AppBrickDeployType,
  ports: ReadonlyArray<BrickPort>
): string | null {
  const [port, another] = ports
  if (port === undefined) return null
  if (another !== undefined) {
    return "Kiln gives an App Brick one web port for now"
  }
  if ((port.expose ?? "http") !== "http") {
    return "Kiln only routes an App Brick's web port for now"
  }
  if (port.protocol !== undefined && port.protocol !== "tcp") {
    return "A web port is TCP"
  }
  if (type === "compose" && port.service === undefined) {
    return "A Compose project's web port names its service"
  }
  return null
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
  return webPortProblem(deploy.type, deploy.ports ?? [])
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
  // Its web port, as written or as an input answers it. An optional input
  // left blank says it has none.
  const [port] = deploy.ports ?? []
  const answered =
    port === undefined
      ? undefined
      : typeof port.port === "number"
        ? port.port
        : answers[brickTemplateInput(port.port) ?? ""]
  if (
    answered !== undefined &&
    !(
      typeof answered === "number" &&
      Number.isInteger(answered) &&
      answered >= 1 &&
      answered <= 65_535
    )
  ) {
    return { problem: "This Brick's web port isn't a port" }
  }
  const web =
    answered === undefined
      ? {}
      : {
          web: {
            port: answered,
            ...(port?.service === undefined ? {} : { service: port.service }),
          },
        }
  if (deploy.type !== "image") {
    // Its file is in its source; `appBrickProblem` refused one written here.
    return { deploy: { path: deploy.path ?? "", type: deploy.type, ...web } }
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
  return { deploy: { environment, image, type: "image", ...web } }
}
