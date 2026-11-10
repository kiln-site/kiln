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
import { LoaderCircle, Plus } from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import { cn } from "@workspace/ui/lib/utils"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@workspace/ui/components/dialog"
import { Input } from "@workspace/ui/components/input"

import { BrickVariableField } from "@/components/brick-variable-fields"
import {
  DatabaseBrickChoice,
  databaseBrickEngine,
  sortedDatabaseBricks,
} from "@/components/database/database-brick-choice"
import {
  defaultBrickVariables,
  updateBrickVariable,
} from "@/lib/brick-variables"
import { databaseBricksQueryOptions } from "@/lib/query-options"

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
export function newDatabaseInput({ engine: _engine, ...input }: NewDatabaseValues) {
  return input
}

// The inputs someone answers: not a secret Kiln makes.
const answered = (brick: Brick) =>
  brickInputs(brick).filter(
    (input) => !(input.type === "secret" && input.generate)
  )

// Every way to create a database asks the same questions. What's around them
// differs: where it goes, in `children`, and what submitting does.
export function NewDatabaseDialog({
  children,
  description,
  disabled = false,
  error,
  initial,
  nameFallback,
  onClose,
  onSubmit,
  pending = false,
  submitLabel,
  title,
}: {
  children?: React.ReactNode
  description: string
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
  title: string
}) {
  const [name, setName] = React.useState(initial?.name ?? "")
  const bricksQuery = useQuery({
    ...databaseBricksQueryOptions(),
    select: sortedDatabaseBricks,
  })
  const bricks = bricksQuery.data
  // The one chosen, and until one is, the one asked for or PostgreSQL.
  const [chosen, setChosen] = React.useState<string | null>(
    initial?.brick ?? null
  )
  const brick =
    bricks?.find((candidate) => candidate.source === chosen) ??
    bricks?.find((candidate) => candidate.type === "postgres") ??
    bricks?.[0] ??
    null
  const engine: DatabaseEngine = brick
    ? databaseBrickEngine(brick)
    : (initial?.engine ?? "postgres")
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
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault()
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
          <label className="block">
            <span className="mb-2 block text-xs font-medium">Name</span>
            <Input
              autoFocus
              maxLength={120}
              placeholder={nameFallback || "Production data"}
              value={name}
              onChange={(event) => setName(event.currentTarget.value)}
            />
          </label>
          {bricks ? (
            <DatabaseBrickChoice
              bricks={bricks}
              value={brick?.source ?? null}
              onChange={(next) => setChosen(next.source)}
            />
          ) : (
            <p className="flex h-[4.25rem] items-center gap-2 text-xs text-muted-foreground">
              {bricksQuery.isError ? (
                bricksQuery.error.message
              ) : (
                <>
                  <LoaderCircle className="size-3.5 animate-spin" />
                  Loading database Bricks
                </>
              )}
            </p>
          )}
          {bricks?.length === 0 ? (
            <p className="text-xs text-destructive">
              No database Bricks are in your catalogs.
            </p>
          ) : null}
          {brick
            ? answered(brick).map((input) => (
                <BrickVariableField
                  key={`${brick.source}:${input.key}`}
                  definition={input}
                  name={input.key}
                  value={variables[input.key]}
                  onChange={(value) =>
                    setGiven({
                      brick: brick.source,
                      variables: updateBrickVariable(
                        variables,
                        input.key,
                        value
                      ),
                    })
                  }
                />
              ))
            : null}
          <div className={cn("grid gap-3", named && "sm:grid-cols-2")}>
            {named ? (
              <DatabaseIdentifierField
                issue={databaseNameProblem}
                label="Database name"
                maxLength={48}
                value={databaseName}
                onChange={setDatabaseName}
              />
            ) : null}
            <DatabaseIdentifierField
              issue={usernameProblem}
              label="Username"
              maxLength={32}
              value={username}
              onChange={setUsername}
            />
          </div>
          {children}
          {error ? <p className="text-xs text-destructive">{error}</p> : null}
          <DialogFooter>
            <Button variant="ghost" type="button" onClick={onClose}>
              Cancel
            </Button>
            <Button disabled={blocked} type="submit">
              {pending ? <LoaderCircle className="animate-spin" /> : <Plus />}
              {submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// A name inside the database engine, generated unless one is given.
function DatabaseIdentifierField({
  issue,
  label,
  maxLength,
  onChange,
  value,
}: {
  issue: string | null
  label: string
  maxLength: number
  onChange: (value: string) => void
  value: string
}) {
  return (
    <label className="block min-w-0">
      <span className="mb-2 block text-xs font-medium">{label}</span>
      <Input
        autoCapitalize="none"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        aria-invalid={Boolean(issue)}
        className="font-mono"
        maxLength={maxLength}
        placeholder="Generated"
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
      {issue ? (
        <span className="mt-1.5 block text-xs text-destructive">{issue}</span>
      ) : null}
    </label>
  )
}
