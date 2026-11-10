import { brickInputs, type BrickRecipe } from "./brick-recipe.js"

type DatabaseEngine = "mariadb" | "mysql" | "postgres" | "redis" | "valkey"

// What a variable of the container's environment has to be: one of the
// values Kiln supplies, or a secret Kiln makes.
type SuppliedValue =
  | "database.name"
  | "database.password"
  | "database.username"
  | "generated"

/**
 * What Kiln relies on to manage a database of each type. Its login,
 * password rotation, dumps and the viewer go through the type's own image:
 * its command-line tools, which reach the port the engine listens on by
 * default; the variables the image takes its first login from, which
 * Kiln's own commands read back inside the container; and for Redis and
 * Valkey the users file Kiln keeps in the data volume. A database Brick of
 * a type runs that way and no other.
 */
export const databaseEngineRuntimes: Readonly<
  Record<
    DatabaseEngine,
    {
      /** The image's repository, run at whatever tag. */
      image: string
      port: number
      /** Its environment: each variable, and the value it carries. */
      env: Readonly<Record<string, SuppliedValue>>
      /** Where Kiln writes its login, which the engine must start with. */
      aclFile?: string
      /** Where the image keeps its data, when Kiln writes there itself. */
      data?: string
    }
  >
> = {
  mysql: {
    image: "mysql",
    port: 3306,
    env: {
      MYSQL_DATABASE: "database.name",
      MYSQL_USER: "database.username",
      MYSQL_PASSWORD: "database.password",
      MYSQL_ROOT_PASSWORD: "generated",
    },
  },
  mariadb: {
    image: "mariadb",
    port: 3306,
    env: {
      MARIADB_DATABASE: "database.name",
      MARIADB_USER: "database.username",
      MARIADB_PASSWORD: "database.password",
      MARIADB_ROOT_PASSWORD: "generated",
    },
  },
  postgres: {
    image: "postgres",
    port: 5432,
    env: {
      POSTGRES_DB: "database.name",
      POSTGRES_USER: "database.username",
      POSTGRES_PASSWORD: "database.password",
    },
  },
  redis: {
    image: "redis",
    port: 6379,
    env: {},
    aclFile: "/data/users.acl",
    data: "/data",
  },
  valkey: {
    image: "valkey/valkey",
    port: 6379,
    env: {},
    aclFile: "/data/users.acl",
    data: "/data",
  },
}

// A value that is one template and nothing else.
const SINGLE_TEMPLATE = /^\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}$/u

const isDatabaseEngine = (type: string | undefined): type is DatabaseEngine =>
  type !== undefined && Object.hasOwn(databaseEngineRuntimes, type)

/**
 * Why a recipe can't run as a database of its type, or null when it can.
 * Its image's tag is an answer, so that is checked once the answers are in
 * (`databaseEngineRunsImage`).
 */
export function databaseBrickProblem(recipe: BrickRecipe): string | null {
  if (recipe.kind !== "database") {
    return `A ${recipe.kind} Brick isn't a database`
  }
  const engine = recipe.type
  if (!isDatabaseEngine(engine)) {
    return "Kiln runs a database of a type it knows, for now"
  }
  const runtime = databaseEngineRuntimes[engine]
  const deploy = recipe.deploy
  if (deploy?.type !== "image") return "A database Brick runs from an image"
  if (!deploy.image.startsWith(`${runtime.image}:`)) {
    return `A ${engine} database runs from the ${runtime.image} image, at a tag`
  }
  if (deploy.ports?.[0]?.port !== runtime.port) {
    return `A ${engine} database listens on port ${runtime.port}, its first port`
  }
  // Kiln's dumps, restores and wipes read these back inside the container,
  // so each is the one name the image is given it by, set to exactly that.
  // A secret only Kiln makes: with a default or a rule to follow, it would
  // take that value instead, which anyone reading the recipe knows.
  const generated = new Set(
    brickInputs(recipe)
      .filter(
        (input) =>
          input.type === "secret" &&
          input.generate === true &&
          input.default === undefined &&
          input.suggest === undefined
      )
      .map((input) => input.key)
  )
  for (const [name, supplied] of Object.entries(runtime.env)) {
    const value = SINGLE_TEMPLATE.exec(deploy.env?.[name] ?? "")?.[1]
    const set =
      supplied === "generated"
        ? value !== undefined && generated.has(value)
        : value === supplied
    if (!set) {
      return supplied === "generated"
        ? `A ${engine} database sets ${name} to a secret Kiln generates, with no default`
        : `A ${engine} database sets ${name} to {{ ${supplied} }}`
    }
  }
  const volumes = deploy.volumes ?? []
  if (volumes.length !== 1) return "A database Brick keeps exactly one volume"
  if (runtime.data !== undefined && volumes[0] !== runtime.data) {
    return `A ${engine} database keeps its data in ${runtime.data}`
  }
  if (runtime.aclFile !== undefined) {
    const command = deploy.command ?? []
    const flag = command.indexOf("--aclfile")
    if (flag === -1 || command[flag + 1] !== runtime.aclFile) {
      return `A ${engine} database starts with --aclfile ${runtime.aclFile}, where Kiln keeps its login`
    }
  }
  return null
}

// A tag as Docker takes one, so nothing after the colon can name another
// registry, repository or digest.
const IMAGE_TAG = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/u

/** Whether an image, with its templates filled in, is the type's own. */
export function databaseEngineRunsImage(
  engine: DatabaseEngine,
  image: string
): boolean {
  const prefix = `${databaseEngineRuntimes[engine].image}:`
  return image.startsWith(prefix) && IMAGE_TAG.test(image.slice(prefix.length))
}
