import {
  appBrickDeploy,
  appBrickProblem,
  type AppBrickWeb,
} from "./app-bricks.js"
import {
  BRICK_FORMAT,
  brickAnswers,
  brickAnswersProblem,
  brickConnectionTemplateNames,
  brickIdSchema,
  brickInputs,
  fillBrickTemplate,
  type BrickGroupMember,
  type BrickInputValue,
  type BrickRecipe,
} from "./brick-recipe.js"

// What Kiln installs of a group Brick so far: databases, each from a
// database Brick of the same catalog, and Apps written in the group that
// run an image, set their own variables and are connected to those
// databases. Everything else a
// group can say is refused until Kiln installs it.

/** What reaching a member gives the member connected to it, by template name. */
export type GroupConnection = Readonly<
  Record<(typeof brickConnectionTemplateNames)[number], string>
>

/** A database a group makes: which Brick, and its answers. */
export interface GroupBrickDatabase {
  /** The database Brick it is made from, by its ID in the group's catalog. */
  brick: string
  /** What the group calls it. */
  key: string
  variables: Record<string, BrickInputValue>
}

/** An App a group makes, written in the group. */
export interface GroupBrickApp {
  /** The members it reaches, and the variables it gets for each. */
  connect: Readonly<Record<string, Readonly<Record<string, string>>>>
  /** The variables its recipe sets itself, each with its template filled. */
  environment: Record<string, string>
  image: string
  key: string
  /** What it is called. Without one, it takes the group's name. */
  name?: string
  /** The command it is ready by, when its recipe gives one. */
  ready?: string
  /** The folders it keeps across deployments, each on a volume. */
  volumes: ReadonlyArray<string>
  /** Where its website answers, when its recipe says. */
  web?: AppBrickWeb
}

export interface GroupBrickInstall {
  /** The group's answers, which a connection's variables can use too. */
  answers: Record<string, BrickInputValue>
  /** Made after the databases, connected to them. */
  apps: Array<GroupBrickApp>
  /** Made first. */
  databases: Array<GroupBrickDatabase>
}

const isBrickMember = (
  member: BrickGroupMember
): member is Extract<BrickGroupMember, { brick: unknown }> => "brick" in member

// An App written in a group, as the App Brick it would be alone.
function memberRecipe(
  recipe: BrickRecipe,
  member: Exclude<BrickGroupMember, { brick: unknown }>
): BrickRecipe {
  return {
    format: BRICK_FORMAT,
    kind: "app",
    metadata: recipe.metadata,
    ...(recipe.inputs ? { inputs: recipe.inputs } : {}),
    ...(member.deploy ? { deploy: member.deploy } : {}),
  }
}

/**
 * Why Kiln can't install this group yet, or null when it can. It names the
 * first thing the Brick does that Kiln doesn't for a group.
 */
export function groupBrickProblem(recipe: BrickRecipe): string | null {
  if (recipe.kind !== "group" || recipe.group === undefined) {
    return "This isn't a group Brick"
  }
  const members = Object.entries(recipe.group.members)
  for (const [key, member] of members) {
    if (isBrickMember(member)) {
      if (!brickIdSchema.safeParse(member.brick).success) {
        return `Kiln installs a group's members from its own catalog only (${key})`
      }
      if (member.connect !== undefined) {
        return `Kiln doesn't connect a member made from another Brick yet (${key})`
      }
      continue
    }
    if (member.kind !== "app") {
      return `Kiln doesn't install a ${member.kind} written in a group yet (${key})`
    }
    if (member.deploy?.type !== "image") {
      return `Kiln installs an App written in a group from an image only (${key})`
    }
    const unrun = appBrickProblem(memberRecipe(recipe, member))
    if (unrun !== null) return `${unrun} (${key})`
    for (const target of Object.keys(member.connect ?? {})) {
      const reached = recipe.group.members[target]
      if (!reached || !isBrickMember(reached)) {
        return `Kiln connects an App to a group's databases only (${key})`
      }
    }
  }
  return null
}

/**
 * What a group Brick makes with these answers, or what is wrong with the
 * Brick or the answers. Whether each member's Brick is a database's is for
 * whoever has the catalog to say.
 */
export function groupBrickInstall(
  recipe: BrickRecipe,
  given: Readonly<Record<string, BrickInputValue>>
): { install: GroupBrickInstall } | { problem: string } {
  const problem = groupBrickProblem(recipe)
  if (problem !== null || recipe.group === undefined) {
    return { problem: problem ?? "This isn't a group Brick" }
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
  const answered = (template: string) =>
    fillBrickTemplate(template, (name) =>
      Object.hasOwn(answers, name) ? String(answers[name]) : undefined
    )
  const install: GroupBrickInstall = { answers, apps: [], databases: [] }
  for (const [key, member] of Object.entries(recipe.group.members)) {
    if (isBrickMember(member)) {
      install.databases.push({
        brick: member.brick,
        key,
        // An answer written as text takes the group's templates.
        variables: Object.fromEntries(
          Object.entries(member.inputs ?? {}).map(([name, value]) => [
            name,
            typeof value === "string" ? answered(value) : value,
          ])
        ),
      })
      continue
    }
    const installed = appBrickDeploy(memberRecipe(recipe, member), answers)
    if ("problem" in installed) return { problem: installed.problem }
    if (installed.deploy.type !== "image") {
      return { problem: `Kiln installs ${key} from an image only` }
    }
    install.apps.push({
      connect: member.connect ?? {},
      environment: installed.deploy.environment,
      image: installed.deploy.image,
      key,
      ...(member.name === undefined ? {} : { name: member.name }),
      ...(installed.deploy.ready === undefined
        ? {}
        : { ready: installed.deploy.ready }),
      volumes: installed.deploy.volumes,
      ...(installed.deploy.web === undefined
        ? {}
        : { web: installed.deploy.web }),
    })
  }
  return { install }
}

/**
 * The environment an App gets for the members it is connected to: each
 * variable's template filled from what reaching that member gives, and
 * from the group's answers. A value that would break out of its line is a
 * problem, since an App's environment is kept a line to a variable.
 */
export function groupConnectionEnvironment(
  app: Pick<GroupBrickApp, "connect">,
  connections: Readonly<Record<string, GroupConnection>>,
  answers: Readonly<Record<string, BrickInputValue>>
): { environment: Record<string, string> } | { problem: string } {
  const environment: Record<string, string> = {}
  for (const [target, variables] of Object.entries(app.connect)) {
    const connection = connections[target]
    if (!connection) return { problem: `${target} wasn't made` }
    for (const [name, template] of Object.entries(variables)) {
      const value = fillBrickTemplate(template, (reference) =>
        Object.hasOwn(connection, reference)
          ? connection[reference as keyof GroupConnection]
          : Object.hasOwn(answers, reference)
            ? String(answers[reference])
            : undefined
      )
      if (/[\r\n]/u.test(value)) {
        return { problem: `${name} can't hold a line break` }
      }
      environment[name] = value
    }
  }
  return { environment }
}
