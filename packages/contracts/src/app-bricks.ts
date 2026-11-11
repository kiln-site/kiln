import {
  brickAnswers,
  brickAnswersProblem,
  brickInputs,
  fillBrickTemplate,
  type BrickInputValue,
  type BrickRecipe,
} from "./brick-recipe.js"

// What Kiln runs of an App Brick so far: what it deploys, and nothing a
// Brick can say around that. Hearth keeps an App's configuration, so Hearth
// turns the Brick and its answers into it, and the Relay deploys that
// configuration as it always has.

/**
 * What an App Brick deploys once its answers are in: an image, or the
 * Dockerfile or Compose file at a path in its source. The source is chosen
 * when the Brick is installed (a repository, or a file written in Hearth),
 * never by the Brick.
 */
export type AppBrickDeploy =
  | {
      type: "image"
      image: string
      /** The variables the Brick sets, each with its template filled in. */
      environment: Record<string, string>
    }
  | { type: "dockerfile" | "compose"; path: string }

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
  compose: ["type", "path"],
  dockerfile: ["type", "path"],
  image: ["type", "image", "env"],
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
  return null
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
  if (deploy.type !== "image") {
    // Its file is in its source; `appBrickProblem` refused one written here.
    return { deploy: { path: deploy.path ?? "", type: deploy.type } }
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
  return { deploy: { environment, image, type: "image" } }
}
