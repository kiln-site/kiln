import {
  brickInputs,
  type Brick,
  type DatabaseEngine,
} from "@workspace/contracts"

// Which Brick a new database runs: one of the database Bricks in the
// catalogs, each an engine.

// The order they have always been offered in.
const order: ReadonlyArray<DatabaseEngine> = [
  "mysql",
  "mariadb",
  "postgres",
  "redis",
  "valkey",
]

/** A database Brick's engine, which is its type. */
export function databaseBrickEngine(brick: Brick): DatabaseEngine {
  return brick.type as DatabaseEngine
}

export function sortedDatabaseBricks(
  bricks: ReadonlyArray<Brick>
): Array<Brick> {
  const rank = (brick: Brick) => {
    const index = order.indexOf(databaseBrickEngine(brick))
    return index === -1 ? order.length : index
  }
  return [...bricks].sort(
    (left, right) =>
      rank(left) - rank(right) ||
      left.metadata.name.localeCompare(right.metadata.name)
  )
}

export function DatabaseBrickChoice({
  bricks,
  onChange,
  value,
}: {
  bricks: ReadonlyArray<Brick>
  onChange: (brick: Brick) => void
  /** The chosen Brick's source. */
  value: string | null
}) {
  return (
    <fieldset>
      <legend className="mb-2 text-xs font-medium">Brick</legend>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        {bricks.map((brick) => {
          // The version it runs unless another is chosen.
          const version = brickInputs(brick).find(
            (input) => input.key === "version"
          )?.default
          return (
            <button
              key={brick.source}
              aria-pressed={value === brick.source}
              className={`rounded-lg border px-2 py-3 text-left transition-colors ${
                value === brick.source
                  ? "border-primary/60 bg-primary/10 text-foreground"
                  : "border-border/70 bg-background/30 text-muted-foreground hover:bg-accent/30"
              }`}
              title={brick.metadata.summary}
              type="button"
              onClick={() => onChange(brick)}
            >
              <span className="type-card-title block truncate">
                {brick.metadata.name}
              </span>
              <span className="type-meta mt-0.5 block font-mono">
                {version === undefined ? " " : String(version)}
              </span>
            </button>
          )
        })}
      </div>
    </fieldset>
  )
}
