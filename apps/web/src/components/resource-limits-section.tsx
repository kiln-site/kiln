import * as React from "react"
import { Effect } from "effect"
import { Gauge, LoaderCircle } from "lucide-react"
import { resourceLimitsEqual, type ResourceLimits } from "@workspace/contracts"

import { Button } from "@workspace/ui/components/button"
import { showToast } from "@workspace/ui/components/sonner"

import { InfoSection } from "@/components/info-page"
import {
  ResourceLimitsEditor,
  type ResourceLimitKind,
} from "@/components/resource-limits-editor"
import {
  parseResourceLimitsDraft,
  resourceLimitsDraft,
  type ResourceLimitsCapacity,
  type ResourceLimitsDraft,
} from "@/lib/resource-limits"

/**
 * One set of limits in the section: a database's, or one of an app's
 * services'. `fields` picks the limits that apply to it.
 */
export interface ResourceLimitsGroup {
  readonly fields?: ReadonlyArray<ResourceLimitKind>
  readonly key: string
  readonly label?: string
  readonly limits: ResourceLimits
}

// An instance's memory, CPU, and disk limits on its Info page, for any kind
// of instance. Saving sends every group's limits; `onSave` applies them.
export function ResourceLimitsSection({
  capacity,
  disabledReason,
  editable,
  groups,
  hint,
  onSave,
}: {
  capacity: ResourceLimitsCapacity | null
  /** Why the limits can't change right now, such as an offline Relay. */
  disabledReason?: string
  editable: boolean
  groups: ReadonlyArray<ResourceLimitsGroup>
  /** What happens at the limits, for this kind of instance. */
  hint?: React.ReactNode
  onSave: (limits: Readonly<Record<string, ResourceLimits>>) => Promise<unknown>
}) {
  return (
    <InfoSection content icon={<Gauge />} title="Resource limits">
      {/* New limits from the Relay start a fresh draft. */}
      <ResourceLimitsForm
        key={groups
          .map(
            ({ key, limits }) =>
              `${key}:${limits.cpuMillis}:${limits.memoryBytes}:${limits.diskBytes}`
          )
          .join("|")}
        capacity={capacity}
        disabledReason={disabledReason}
        editable={editable}
        groups={groups}
        hint={hint}
        onSave={onSave}
      />
    </InfoSection>
  )
}

function ResourceLimitsForm({
  capacity,
  disabledReason,
  editable,
  groups,
  hint,
  onSave,
}: React.ComponentProps<typeof ResourceLimitsSection>) {
  const [drafts, setDrafts] = React.useState<
    Readonly<Record<string, ResourceLimitsDraft>>
  >(() =>
    Object.fromEntries(
      groups.map((group) => [group.key, resourceLimitsDraft(group.limits)])
    )
  )
  const [error, setError] = React.useState<string | null>(null)
  const [pending, setPending] = React.useState(false)
  const parsed = groups.map((group) => {
    const draft = drafts[group.key] ?? resourceLimitsDraft(group.limits)
    return { group, result: parseResourceLimitsDraft(draft, capacity) }
  })
  const changed = parsed.some(
    ({ group, result }) =>
      "error" in result || !resourceLimitsEqual(result.limits, group.limits)
  )
  const disabled = !editable || disabledReason !== undefined || pending

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (disabled) return
    const limits: Record<string, ResourceLimits> = {}
    for (const { group, result } of parsed) {
      if ("error" in result) {
        setError(group.label ? `${group.label}: ${result.error}` : result.error)
        return
      }
      limits[group.key] = result.limits
    }
    setError(null)
    setPending(true)
    await Effect.runPromise(
      Effect.tryPromise({
        try: () => onSave(limits),
        catch: (cause) => cause,
      }).pipe(
        Effect.match({
          onFailure: (cause) =>
            setError(
              cause instanceof Error
                ? cause.message
                : "Could not save the limits"
            ),
          onSuccess: () =>
            showToast({ message: "Resource limits saved", type: "success" }),
        }),
        Effect.ensuring(Effect.sync(() => setPending(false)))
      )
    )
  }

  return (
    <form className="space-y-3" onSubmit={save}>
      {groups.map((group) => (
        <div key={group.key} className="space-y-1.5">
          {group.label ? (
            <p className="type-technical-label text-muted-foreground">
              {group.label}
            </p>
          ) : null}
          <ResourceLimitsEditor
            capacity={capacity}
            disabled={disabled}
            draft={drafts[group.key] ?? resourceLimitsDraft(group.limits)}
            fields={group.fields}
            onChange={(draft) =>
              setDrafts((current) => ({ ...current, [group.key]: draft }))
            }
          />
        </div>
      ))}
      {hint ? (
        <p className="type-support text-muted-foreground">{hint}</p>
      ) : null}
      {error ? <p className="type-support text-destructive">{error}</p> : null}
      {editable ? (
        <div className="flex items-center justify-end gap-3">
          {disabledReason ? (
            <span className="type-support text-muted-foreground">
              {disabledReason}
            </span>
          ) : null}
          <Button disabled={disabled || !changed} size="sm" type="submit">
            {pending ? <LoaderCircle className="animate-spin" /> : null}
            Save limits
          </Button>
        </div>
      ) : null}
    </form>
  )
}
