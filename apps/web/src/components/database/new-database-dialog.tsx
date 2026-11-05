import * as React from "react"
import {
  databaseEngineHasNamedDatabase,
  databaseNameIssue,
  databaseUsernameIssue,
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

import { DatabaseEngineChoice } from "@/components/database/database-engine-choice"

/** What a new database is asked to be. Left out, a value is generated. */
export interface NewDatabaseValues {
  databaseName?: string
  engine: DatabaseEngine
  name: string
  username?: string
}

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
  const [engine, setEngine] = React.useState<DatabaseEngine>(
    initial?.engine ?? "postgres"
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
            if (blocked) return
            onSubmit({
              engine,
              name: name.trim(),
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
          <DatabaseEngineChoice value={engine} onChange={setEngine} />
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
