import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import {
  brickInputs,
  databaseEngineHasNamedDatabase,
  databaseNameIssue,
  databaseUsernameIssue,
  type Brick,
  type BrickVariableValue,
  type DatabaseEngine,
} from "@workspace/contracts"
import { CircleAlert, LoaderCircle, Plus } from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"

import type { PickableBrickKind } from "@/components/brick-kinds"
import {
  BrickCatalogBrowser,
  BrickCatalogUnavailable,
  type BrickSelection,
} from "@/components/brick-selector"
import { BrickVariableField } from "@/components/brick-variable-fields"
import {
  defaultBrickVariables,
  updateBrickVariable,
} from "@/lib/brick-variables"
import { databaseBricksQueryOptions } from "@/lib/query-options"

// Every way to create a database picks its Brick from the same browser and
// answers the same questions under it. What differs is around them: where
// it goes, in the form's `children`, and what submitting does.

/** What a new database is asked to be. Left out, a value is generated. */
export interface NewDatabaseValues {
  /** The Brick it runs, by its source. */
  brick: string
  databaseName?: string
  /** Its Brick's type, for whatever shows the choice again. */
  engine: DatabaseEngine
  name: string
  username?: string
  /** Its Brick's answers, such as its version. */
  variables: Record<string, BrickVariableValue>
}

/** What creating one sends: everything but what its Brick already says. */
export function newDatabaseInput({
  engine: _engine,
  ...input
}: NewDatabaseValues) {
  return input
}

// The inputs someone answers: not a secret Kiln makes.
const answered = (brick: Brick) =>
  brickInputs(brick).filter(
    (input) => !(input.type === "secret" && input.generate)
  )

/** The database Bricks to pick from, over whatever `children` asks of one. */
export const DatabaseBrickBrowser = React.memo(function DatabaseBrickBrowser({
  children,
  disabled = false,
  initialBrick,
  kinds,
  onKindChange,
}: {
  /** What's asked of the Brick chosen, under its details. */
  children: (brick: Brick | null) => React.ReactNode
  disabled?: boolean
  /** The source of the Brick to open on. Without one, PostgreSQL's. */
  initialBrick?: string | undefined
  kinds?: ReadonlyArray<PickableBrickKind>
  onKindChange?: (kind: PickableBrickKind) => void
}) {
  const bricksQuery = useQuery(databaseBricksQueryOptions())
  if (!bricksQuery.data) {
    return (
      <BrickCatalogUnavailable
        error={bricksQuery.error?.message}
        kind="database"
        kinds={kinds}
        pending={bricksQuery.isPending}
        onKindChange={onKindChange}
      />
    )
  }
  return (
    <LoadedDatabaseBrickBrowser
      bricks={bricksQuery.data}
      disabled={disabled}
      initialBrick={initialBrick}
      kinds={kinds}
      onKindChange={onKindChange}
    >
      {children}
    </LoadedDatabaseBrickBrowser>
  )
})

function LoadedDatabaseBrickBrowser({
  bricks,
  children,
  disabled,
  initialBrick,
  kinds,
  onKindChange,
}: {
  bricks: Array<Brick>
  children: (brick: Brick | null) => React.ReactNode
  disabled: boolean
  initialBrick: string | undefined
  kinds: ReadonlyArray<PickableBrickKind> | undefined
  onKindChange: ((kind: PickableBrickKind) => void) | undefined
}) {
  const [selection, setSelection] = React.useState<BrickSelection | null>(
    () => {
      const brick =
        bricks.find((candidate) => candidate.source === initialBrick) ??
        bricks.find((candidate) => candidate.type === "postgres") ??
        bricks[0]
      return brick ? { kind: "catalog", brick } : null
    }
  )
  return (
    <BrickCatalogBrowser
      kind="database"
      kinds={kinds}
      onKindChange={onKindChange}
      relayId=""
      bricks={bricks}
      canAddCustomBrick={false}
      selection={selection}
      onSelectionChange={setSelection}
      disabled={disabled}
      className="h-full rounded-none border-0 bg-transparent"
      emptyMessage={
        bricks.length === 0
          ? "No database Bricks are in your catalogs."
          : "No bricks match these filters."
      }
      configuration={children(
        selection?.kind === "catalog" ? selection.brick : null
      )}
    />
  )
}

/** What a new database is asked, of the Brick chosen for it. */
export function NewDatabaseForm({
  brick,
  children,
  disabled = false,
  error,
  initial,
  nameFallback,
  onClose,
  onSubmit,
  pending = false,
  submitLabel,
}: {
  brick: Brick | null
  /** Where it goes, after its own questions. */
  children?: React.ReactNode
  /** Something else keeps it from being submitted yet. */
  disabled?: boolean
  error?: string | undefined
  initial?: NewDatabaseValues | undefined
  /** Stands in for a blank name. Without one, a name is required. */
  nameFallback?: string
  onClose: () => void
  onSubmit: (values: NewDatabaseValues) => void
  pending?: boolean
  submitLabel: string
}) {
  const [name, setName] = React.useState(initial?.name ?? "")
  // A database Brick's type is its engine.
  const engine = (brick?.type ?? initial?.engine ?? "postgres") as DatabaseEngine
  // Answers given for the Brick shown; another Brick starts from its own.
  const [given, setGiven] = React.useState<{
    brick: string
    variables: Record<string, BrickVariableValue>
  } | null>(
    initial ? { brick: initial.brick, variables: initial.variables } : null
  )
  const variables = React.useMemo(
    () =>
      brick
        ? given?.brick === brick.source
          ? given.variables
          : defaultBrickVariables(brick)
        : {},
    [brick, given]
  )
  const [databaseName, setDatabaseName] = React.useState(
    initial?.databaseName ?? ""
  )
  const [username, setUsername] = React.useState(initial?.username ?? "")
  const named = databaseEngineHasNamedDatabase(engine)
  const chosenDatabaseName = named ? databaseName.trim() : ""
  const chosenUsername = username.trim()
  const databaseNameProblem = chosenDatabaseName
    ? databaseNameIssue(engine, chosenDatabaseName)
    : null
  const usernameProblem = chosenUsername
    ? databaseUsernameIssue(engine, chosenUsername)
    : null
  const blocked =
    disabled ||
    pending ||
    brick === null ||
    (nameFallback === undefined && !name.trim()) ||
    Boolean(databaseNameProblem || usernameProblem)

  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault()
        // A dialog over another form's mustn't submit that one too.
        event.stopPropagation()
        if (blocked || !brick) return
        onSubmit({
          brick: brick.source,
          engine,
          name: name.trim(),
          variables,
          ...(chosenDatabaseName && { databaseName: chosenDatabaseName }),
          ...(chosenUsername && { username: chosenUsername }),
        })
      }}
    >
      <p className="type-technical-label text-muted-foreground">
        Database details
      </p>
      <label className="block space-y-1.5 text-xs font-medium text-muted-foreground">
        <span>Name</span>
        <Input
          maxLength={120}
          placeholder={nameFallback || "Production data"}
          disabled={pending}
          value={name}
          onChange={(event) => setName(event.currentTarget.value)}
        />
      </label>
      {brick
        ? answered(brick).map((input) => (
            <BrickVariableField
              key={`${brick.source}:${input.key}`}
              definition={input}
              disabled={pending}
              name={input.key}
              value={variables[input.key]}
              onChange={(value) =>
                setGiven({
                  brick: brick.source,
                  variables: updateBrickVariable(variables, input.key, value),
                })
              }
            />
          ))
        : null}
      <div className={named ? "grid grid-cols-2 gap-2" : undefined}>
        {named ? (
          <DatabaseIdentifierField
            disabled={pending}
            issue={databaseNameProblem}
            label="Database name"
            maxLength={48}
            value={databaseName}
            onChange={setDatabaseName}
          />
        ) : null}
        <DatabaseIdentifierField
          disabled={pending}
          issue={usernameProblem}
          label="Username"
          maxLength={32}
          value={username}
          onChange={setUsername}
        />
      </div>
      {children}
      {error ? (
        <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/8 px-3 py-2 text-xs text-destructive light:bg-destructive/16">
          <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
          {error}
        </div>
      ) : null}
      <div className="grid grid-cols-2 gap-2 pt-1">
        <Button type="button" variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button disabled={blocked} type="submit">
          {pending ? <LoaderCircle className="animate-spin" /> : <Plus />}
          {submitLabel}
        </Button>
      </div>
    </form>
  )
}

// A name inside the database engine, generated unless one is given.
function DatabaseIdentifierField({
  disabled,
  issue,
  label,
  maxLength,
  onChange,
  value,
}: {
  disabled: boolean
  issue: string | null
  label: string
  maxLength: number
  onChange: (value: string) => void
  value: string
}) {
  return (
    <label className="block min-w-0 space-y-1.5 text-xs font-medium text-muted-foreground">
      <span>{label}</span>
      <Input
        autoCapitalize="none"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        aria-invalid={Boolean(issue)}
        className="font-mono"
        disabled={disabled}
        maxLength={maxLength}
        placeholder="Generated"
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
      {issue ? (
        <span className="block font-normal text-destructive">{issue}</span>
      ) : null}
    </label>
  )
}
