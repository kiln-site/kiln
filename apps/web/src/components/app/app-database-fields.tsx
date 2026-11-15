import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import type { DatabaseEngine } from "@workspace/contracts"
import { Plus } from "lucide-react"

import { engineLabel } from "@/components/database/database-presentation"
import { NewDatabaseDialog } from "@/components/database/new-database-dialog"
import {
  newDatabaseInput,
  type NewDatabaseValues,
} from "@/components/database/new-database-form"
import { InstanceCard } from "@/components/instance-card"
import { DatabaseKindIcon } from "@/components/instance-kind-icon"
import {
  InstancePickerField,
  PickerPlaceholder,
} from "@/components/instance-picker-field"
import {
  InstancePickerContent,
  InstancePickerFooterAction,
  InstancePickerHeaderAction,
  type InstancePickerItem,
} from "@/components/instance-picker"
import { infraRelayOptionsQueryOptions } from "@/lib/infra-directory"
import { managedDatabaseDirectoryQueryOptions } from "@/lib/query-options"
import type { getManagedDatabaseDirectory } from "@/server/databases"

// The database a new app starts connected to: none, a new one on its Relay,
// or one already there. Its credentials go in the app's environment.

export type AppDatabaseDraft =
  | { kind: "none" }
  | (NewDatabaseValues & { kind: "new" })
  | { engine: DatabaseEngine; id: string; kind: "existing"; name: string }

export const noAppDatabase: AppDatabaseDraft = { kind: "none" }

/** What creating the app asks for. A new database is named as the app is. */
export function appDatabaseInput(draft: AppDatabaseDraft, appName: string) {
  switch (draft.kind) {
    case "none":
      return undefined
    case "new":
      return {
        ...newDatabaseInput(draft),
        kind: "new" as const,
        name: draft.name || appName,
      }
    case "existing":
      return { id: draft.id, kind: "existing" as const }
  }
}

type DatabaseDirectory = Awaited<ReturnType<typeof getManagedDatabaseDirectory>>

const connectableOn = (relayId: string) => (directory: DatabaseDirectory) =>
  directory.filter(
    (database) =>
      database.relayId === relayId &&
      database.permissions.includes("database.network.write") &&
      database.permissions.includes("database.credentials.read")
  )

const databaseItem = (
  database: DatabaseDirectory[number]
): InstancePickerItem => ({
  identity: { id: database.id, kind: "database", relayId: database.relayId },
  key: database.id,
  meta: `${engineLabel(database.engine)} · ${database.id}`,
  name: database.name,
  searchText: `${database.id} ${database.engine}`,
})

export const AppDatabaseFields = React.memo(function AppDatabaseFields({
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
  const [creating, setCreating] = React.useState(false)
  const selectConnectable = React.useMemo(
    () => connectableOn(relayId),
    [relayId]
  )
  // Both are asked for up front, so the picker opens already filled in.
  const { data: databases } = useQuery({
    ...managedDatabaseDirectoryQueryOptions(),
    select: selectConnectable,
  })
  const { data: canCreate } = useQuery({
    ...infraRelayOptionsQueryOptions("database"),
    select: ({ relays }) =>
      relays.some((relay) => relay.id === relayId && relay.canCreate),
  })
  const items = React.useMemo(
    () => (databases ?? []).map(databaseItem),
    [databases]
  )
  const selectedKeys = React.useMemo(
    () => new Set(draft.kind === "existing" ? [draft.id] : []),
    [draft]
  )
  const select = React.useCallback(
    (item: InstancePickerItem) => {
      const database = databases?.find(({ id }) => id === item.key)
      if (!database) return
      onChange({
        engine: database.engine,
        id: database.id,
        kind: "existing",
        name: database.name,
      })
    },
    [databases, onChange]
  )
  return (
    <div>
      <InstancePickerField
        // The new database's dialog takes focus; the trigger mustn't take
        // it back.
        keepFocus={creating}
        label="Database"
        title="Databases"
        value={
          <AppDatabaseSummary
            appName={appName}
            draft={draft}
            relayId={relayId}
          />
        }
      >
        {(close) => (
          <InstancePickerContent
            ariaLabel="Databases"
            emptyMessage="No databases on this Relay"
            filterBar={false}
            footer={
              canCreate === false ? undefined : (
                <InstancePickerFooterAction
                  icon={Plus}
                  label="Create a new database"
                  onClick={() => {
                    close()
                    setCreating(true)
                  }}
                />
              )
            }
            header={
              <InstancePickerHeaderAction
                label="No database"
                selected={draft.kind === "none"}
                onClick={() => {
                  onChange(noAppDatabase)
                  close()
                }}
              />
            }
            items={items}
            selectedKeys={selectedKeys}
            onSelect={(item) => {
              select(item)
              close()
            }}
          />
        )}
      </InstancePickerField>
      <p className="type-meta mt-2 text-muted-foreground">
        A database joins the app's private network, with its credentials in the
        environment as <span className="font-mono">DB_*</span> variables.
      </p>
      {creating ? (
        <NewDatabaseDialog
          initial={draft.kind === "new" ? draft : undefined}
          nameFallback={appName || "Same as the app"}
          note="Created with the app, on the same Relay."
          submitLabel="Add database"
          title="New database"
          onClose={() => setCreating(false)}
          onSubmit={(values) => {
            onChange({ ...values, kind: "new" })
            setCreating(false)
          }}
        />
      ) : null}
    </div>
  )
})

// What the trigger shows: always an icon and two lines, so that what's
// chosen never changes the dialog's height.
function AppDatabaseSummary({
  appName,
  draft,
  relayId,
}: {
  appName: string
  draft: AppDatabaseDraft
  relayId: string
}) {
  if (draft.kind === "existing") {
    return (
      <InstanceCard
        className="min-w-0 flex-1 gap-2 text-left"
        iconClassName="size-7 border-0 bg-muted/55"
        instance={{ id: draft.id, kind: "database", relayId }}
        meta={engineLabel(draft.engine)}
        name={draft.name}
        nameClassName="type-control-sm"
        showFavorite={false}
        showStatus={false}
      />
    )
  }
  const creating = draft.kind === "new"
  return (
    <PickerPlaceholder
      icon={<DatabaseKindIcon className="size-3.5" />}
      meta={
        creating
          ? `New ${engineLabel(draft.engine)} database`
          : "Connect one later from the app's Network page"
      }
      name={
        creating
          ? draft.name.trim() || appName || "New database"
          : "No database"
      }
    />
  )
}
