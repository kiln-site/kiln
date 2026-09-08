import { memo, useMemo } from "react"
import { Result } from "effect"
import {
  accessPermissionSupported,
  expandPermissionSelections,
  permissionBlocks,
  permissionCatalog,
  permissionCollections,
  type AccessPermission,
  type PermissionScopeType,
  type PermissionSelection,
} from "@workspace/contracts"

export const PermissionEditor = memo(function PermissionEditor({
  scopeType,
  selections,
  onChange,
  available,
  disabled = false,
  capabilities,
}: {
  scopeType: PermissionScopeType
  selections: Array<PermissionSelection>
  onChange: (selections: Array<PermissionSelection>) => void
  available?: ReadonlyArray<AccessPermission>
  disabled?: boolean
  capabilities?: ReadonlyArray<string>
}) {
  const selected = useMemo(
    () => new Set(selections.map((item) => `${item.kind}:${item.key}`)),
    [selections]
  )
  const unsupported = useMemo(
    () =>
      selections.filter((selection) =>
        Result.isFailure(
          Result.try(() =>
            expandPermissionSelections([selection], scopeType, capabilities)
          )
        )
      ),
    [selections, scopeType, capabilities]
  )
  const effective = useMemo(
    () =>
      new Set(
        expandPermissionSelections(
          selections.filter((selection) => !unsupported.includes(selection)),
          scopeType,
          capabilities
        )
      ),
    [selections, unsupported, scopeType, capabilities]
  )
  function toggle(selection: PermissionSelection) {
    const key = `${selection.kind}:${selection.key}`
    onChange(
      selected.has(key)
        ? selections.filter((item) => `${item.kind}:${item.key}` !== key)
        : [...selections, selection]
    )
  }
  function maySelect(selection: PermissionSelection) {
    return (
      !available ||
      expandPermissionSelections([selection], scopeType, capabilities).every(
        (key) => available.includes(key)
      )
    )
  }
  return (
    <fieldset disabled={disabled} className="space-y-4">
      <legend className="sr-only">Permissions</legend>
      {unsupported.length ? (
        <div className="rounded-md border p-3 text-sm">
          <p>
            These saved permissions are unavailable for this resource. Remove
            them before saving.
          </p>
          {unsupported.map((selection) => (
            <label
              key={`${selection.kind}:${selection.key}`}
              className="mt-2 flex items-center gap-2"
            >
              <input
                type="checkbox"
                checked
                onChange={() => toggle(selection)}
              />
              {selection.key}
            </label>
          ))}
        </div>
      ) : null}
      <label className="flex items-start gap-2 rounded-md border p-3 text-sm">
        <input
          type="checkbox"
          className="mt-1 accent-primary"
          checked={selected.has("collection:all")}
          disabled={
            !selected.has("collection:all") &&
            !maySelect({ kind: "collection", key: "all" })
          }
          onChange={() => toggle({ kind: "collection", key: "all" })}
        />
        <span>
          All permissions
          <span className="block text-xs text-muted-foreground">
            Includes future permissions for this resource.
          </span>
        </span>
      </label>
      <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
        {permissionBlocks.map((block) => {
          const permissions = permissionCatalog.filter(
            (permission) =>
              permission.block === block.key &&
              !permission.compatibilityOnly &&
              accessPermissionSupported(permission.key, scopeType, capabilities)
          )
          if (!permissions.length) return null
          const collection = permissionCollections.find(
            (entry) => entry.key === `${block.key}.all`
          )!
          const group: PermissionSelection = {
            kind: "collection",
            key: collection.key,
          }
          return (
            <section key={block.key} className="space-y-2">
              <label className="flex items-center gap-2 text-sm font-medium">
                <input
                  type="checkbox"
                  className="accent-primary"
                  checked={selected.has(`collection:${group.key}`)}
                  disabled={
                    !selected.has(`collection:${group.key}`) &&
                    !maySelect(group)
                  }
                  onChange={() => toggle(group)}
                />
                {block.label}
              </label>
              {permissions.map((permission) => {
                const item: PermissionSelection = {
                  kind: "permission",
                  key: permission.key,
                }
                const explicit = selected.has(`permission:${permission.key}`),
                  inherited = !explicit && effective.has(permission.key)
                return (
                  <label
                    key={permission.key}
                    className="flex items-start gap-2 pl-4 text-sm text-muted-foreground"
                  >
                    <input
                      type="checkbox"
                      className="mt-1 accent-primary"
                      checked={explicit || inherited}
                      disabled={inherited || (!explicit && !maySelect(item))}
                      onChange={() => toggle(item)}
                    />
                    <span>
                      {permission.label}
                      {inherited ? (
                        <span className="ml-1 text-xs">(included)</span>
                      ) : null}
                      <span className="block text-xs opacity-80">
                        {permission.description}
                      </span>
                    </span>
                  </label>
                )
              })}
            </section>
          )
        })}
      </div>
      <p className="text-xs text-muted-foreground">
        Block checkboxes include future permissions in that block. Selecting
        individual permissions keeps those exact choices. Included permissions
        follow from your other selections.
      </p>
    </fieldset>
  )
})
