import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import type { DatabaseEngine } from "@workspace/contracts"

import { Input } from "@workspace/ui/components/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select"

import {
  engineLabel,
  engineOptions,
} from "@/components/database/database-presentation"
import { infraRelayOptionsQueryOptions } from "@/lib/infra-directory"
import { managedDatabaseDirectoryQueryOptions } from "@/lib/query-options"
import type { getManagedDatabaseDirectory } from "@/server/databases"

// The database a new app starts connected to: none, a new one on its Relay,
// or one already there. Its credentials go in the app's environment.

type DatabaseMode = "existing" | "new" | "none"

export interface AppDatabaseDraft {
  databaseId: string
  engine: DatabaseEngine
  mode: DatabaseMode
  name: string
}

export const emptyAppDatabaseDraft: AppDatabaseDraft = {
  databaseId: "",
  engine: "postgres",
  mode: "none",
  name: "",
}

export function appDatabaseDraftReady(draft: AppDatabaseDraft): boolean {
  return draft.mode !== "existing" || draft.databaseId !== ""
}

/** What creating the app asks for. A new database is named as the app is. */
export function appDatabaseInput(draft: AppDatabaseDraft, appName: string) {
  switch (draft.mode) {
    case "none":
      return undefined
    case "new":
      return {
        engine: draft.engine,
        kind: "new" as const,
        name: draft.name.trim() || appName,
      }
    case "existing":
      return { id: draft.databaseId, kind: "existing" as const }
  }
}

const modes: ReadonlyArray<{ id: DatabaseMode; label: string }> = [
  { id: "none", label: "None" },
  { id: "new", label: "New" },
  { id: "existing", label: "Existing" },
]

const connectableOn =
  (relayId: string) =>
  (directory: Awaited<ReturnType<typeof getManagedDatabaseDirectory>>) =>
    directory.filter(
      (database) =>
        database.relayId === relayId &&
        database.permissions.includes("database.network.write") &&
        database.permissions.includes("database.credentials.read")
    )

export function AppDatabaseFields({
  appName,
  draft,
  onChange,
  relayId,
}: {
  appName: string
  draft: AppDatabaseDraft
  onChange: (draft: AppDatabaseDraft) => void
  relayId: string
}) {
  const engineLabelId = React.useId()
  const existingLabelId = React.useId()
  const selectConnectable = React.useMemo(
    () => connectableOn(relayId),
    [relayId]
  )
  const { data: canCreate } = useQuery({
    ...infraRelayOptionsQueryOptions("database"),
    select: ({ relays }) =>
      relays.some((relay) => relay.id === relayId && relay.canCreate),
  })
  // Asked for only once someone wants to pick one.
  const databases = useQuery({
    ...managedDatabaseDirectoryQueryOptions(),
    enabled: draft.mode === "existing",
    select: selectConnectable,
  })
  const existing = databases.data?.find(({ id }) => id === draft.databaseId)
  const engine = draft.mode === "new" ? draft.engine : existing?.engine

  return (
    <fieldset className="space-y-3">
      <legend className="mb-2 text-xs font-medium">Database</legend>
      <div className="grid grid-cols-3 gap-2">
        {modes.map((mode) => (
          <button
            key={mode.id}
            aria-pressed={draft.mode === mode.id}
            className={`type-card-title rounded-lg border px-3 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
              draft.mode === mode.id
                ? "border-primary/60 bg-primary/10 text-foreground"
                : "border-border/70 bg-background/30 text-muted-foreground hover:bg-accent/30"
            }`}
            disabled={mode.id === "new" && canCreate === false}
            type="button"
            onClick={() => onChange({ ...draft, mode: mode.id })}
          >
            {mode.label}
          </button>
        ))}
      </div>
      {draft.mode === "new" ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <span id={engineLabelId} className="mb-2 block text-xs font-medium">
              Engine
            </span>
            <Select
              value={draft.engine}
              onValueChange={(value) =>
                onChange({ ...draft, engine: value as DatabaseEngine })
              }
            >
              <SelectTrigger
                aria-labelledby={engineLabelId}
                className="h-9 w-full px-3"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {engineOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label} {option.description}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <label className="block">
            <span className="mb-2 block text-xs font-medium">Name</span>
            <Input
              maxLength={120}
              placeholder={appName || "Same as the app"}
              value={draft.name}
              onChange={(event) =>
                onChange({ ...draft, name: event.currentTarget.value })
              }
            />
          </label>
        </div>
      ) : null}
      {draft.mode === "existing" ? (
        databases.data?.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            There are no databases on this Relay you can connect to.
          </p>
        ) : (
          <div>
            <span
              id={existingLabelId}
              className="mb-2 block text-xs font-medium"
            >
              Connect to
            </span>
            <Select
              value={draft.databaseId}
              onValueChange={(databaseId) => onChange({ ...draft, databaseId })}
            >
              <SelectTrigger
                aria-labelledby={existingLabelId}
                className="h-9 w-full px-3"
              >
                <SelectValue placeholder="Choose a database" />
              </SelectTrigger>
              <SelectContent>
                {databases.data?.map((database) => (
                  <SelectItem key={database.id} value={database.id}>
                    {database.name} · {engineLabel(database.engine)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )
      ) : null}
      {draft.mode !== "none" ? (
        <p className="type-meta text-muted-foreground">
          Connected on its private network, with{" "}
          <span className="font-mono">
            DB_HOST, DB_PORT, DB_USER, DB_PASS
            {engine === "redis" || engine === "valkey" ? "" : ", DB_NAME"}
          </span>{" "}
          in the app's environment.
        </p>
      ) : null}
    </fieldset>
  )
}
