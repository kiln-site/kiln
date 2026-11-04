import * as React from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Effect } from "effect"
import { Gauge, LoaderCircle } from "lucide-react"
import { resourceLimitsEqual, type ResourceLimits } from "@workspace/contracts"

import { Button } from "@workspace/ui/components/button"
import { showToast } from "@workspace/ui/components/sonner"

import { InfoSection } from "@/components/info-page"
import { ResourceLimitRows } from "@/components/resource-limits/resource-limit-rows"
import { resourceLimitsCapacityQueryOptions } from "@/lib/query-options"
import {
  draftMemoryBytes,
  parseResourceLimitsDraft,
  resourceLimitsDraft,
  type ResourceLimitField,
  type ResourceLimitsCapacity,
  type ResourceLimitsDraft,
} from "@/lib/resource-limits"

/**
 * One set of limits in the section: a game server's, a database's, or one of
 * an app's services'. `fields` picks the limits that apply to it.
 */
export interface ResourceLimitsGroup {
  readonly fields?: ReadonlyArray<ResourceLimitField>
  readonly key: string
  readonly label?: string
  readonly limits: ResourceLimits
}

type SectionProps = {
  /** Beside the title, such as what applies them. */
  action?: React.ReactNode
  /** Why the limits can't change right now, such as an offline Relay. */
  disabledReason?: string
  /** What a disk limit can't go under, such as the files already there. */
  diskFloorBytes?: number | null
  editable: boolean
  groups: ReadonlyArray<ResourceLimitsGroup>
  /** What saving does, for this kind of instance. */
  hint: React.ReactNode
  onSave: (limits: Readonly<Record<string, ResourceLimits>>) => Promise<unknown>
  /**
   * The one group to show, when they're paged through. Every group's draft
   * is kept and saved either way.
   */
  shownGroup?: string
  /** Beside the title, such as whether saved limits are waiting. */
  status?: React.ReactNode
  target: {
    id: string
    kind: "app" | "database" | "server"
    relayId: string
  }
}

// An instance's memory, CPU, and disk limits on its Info page, the same for
// every kind of instance. Saving sends every group's limits; `onSave`
// applies them.
export function ResourceLimitsSection(props: SectionProps) {
  const { action, disabledReason, editable, groups, status, target } = props
  const capacityOptions = resourceLimitsCapacityQueryOptions(
    target.relayId,
    target.kind,
    target.id
  )
  const { data: capacity = null, isLoading } = useQuery({
    ...capacityOptions,
    enabled: editable && disabledReason === undefined,
  })
  return (
    <InfoSection
      action={action}
      content
      icon={<Gauge />}
      status={status}
      title="Resource limits"
    >
      {/* New limits from the Relay start a fresh draft. */}
      <ResourceLimitsForm
        {...props}
        key={groups
          .map(
            ({ key, limits }) =>
              `${key}:${limits.cpuMillis}:${limits.memoryBytes}:${limits.diskBytes}`
          )
          .join("|")}
        capacity={capacity}
        capacityKey={capacityOptions.queryKey}
        loadingCapacity={isLoading}
      />
    </InfoSection>
  )
}

function ResourceLimitsForm({
  capacity,
  capacityKey,
  disabledReason,
  diskFloorBytes,
  editable,
  groups,
  hint,
  loadingCapacity,
  onSave,
  shownGroup,
}: SectionProps & {
  capacity: ResourceLimitsCapacity | null
  capacityKey: ReadonlyArray<unknown>
  loadingCapacity: boolean
}) {
  const queryClient = useQueryClient()
  const [drafts, setDrafts] = React.useState(() => savedDrafts(groups))
  const [saveError, setSaveError] = React.useState<string | null>(null)
  const [pending, setPending] = React.useState(false)
  const parsed = groups.map((group) => {
    const draft = drafts[group.key] ?? resourceLimitsDraft(group.limits)
    const room = groupCapacity(capacity, groups, drafts, group.key)
    return {
      draft,
      group,
      result: parseResourceLimitsDraft(draft, room),
      room,
    }
  })
  const changed = parsed.some(
    ({ group, result }) =>
      "error" in result || !resourceLimitsEqual(result.limits, group.limits)
  )
  const problem = parsed.find(({ result }) => "error" in result)
  const problemText =
    problem && "error" in problem.result
      ? problem.group.label
        ? `${problem.group.label}: ${problem.result.error}`
        : problem.result.error
      : null
  const disabled = !editable || disabledReason !== undefined || pending

  const setGroup = React.useCallback(
    (key: string, update: React.SetStateAction<ResourceLimitsDraft>) => {
      setSaveError(null)
      setDrafts((current) => {
        const draft = current[key]
        if (!draft) return current
        return {
          ...current,
          [key]: typeof update === "function" ? update(draft) : update,
        }
      })
    },
    []
  )

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (disabled || !changed) return
    const limits: Record<string, ResourceLimits> = {}
    for (const { group, result } of parsed) {
      if ("error" in result) return
      limits[group.key] = result.limits
    }
    setSaveError(null)
    setPending(true)
    await Effect.runPromise(
      Effect.tryPromise({
        try: () => onSave(limits),
        catch: (cause) => cause,
      }).pipe(
        Effect.match({
          onFailure: (cause) =>
            setSaveError(
              cause instanceof Error
                ? cause.message
                : "Could not save the limits"
            ),
          onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: capacityKey })
            showToast({ message: "Resource limits saved", type: "success" })
          },
        }),
        Effect.ensuring(Effect.sync(() => setPending(false)))
      )
    )
  }

  return (
    <form className="space-y-4" onSubmit={save}>
      {parsed.map(({ draft, group, result, room }) =>
        shownGroup !== undefined && group.key !== shownGroup ? null : (
          <ResourceLimitsGroupRows
            key={group.key}
            capacity={room}
            disabled={disabled}
            diskFloorBytes={diskFloorBytes}
            draft={draft}
            group={group}
            invalid={"error" in result ? (result.field ?? null) : null}
            loading={loadingCapacity}
            onChange={setGroup}
          />
        )
      )}
      {saveError || problemText ? (
        <p className="type-support text-destructive">
          {saveError ?? problemText}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-2">
        <p className="type-support mr-auto min-w-0 flex-1 basis-64 text-muted-foreground">
          {disabledReason ?? hint}
        </p>
        {editable ? (
          <div className="flex shrink-0 items-center gap-1.5">
            {changed ? (
              <Button
                disabled={pending}
                size="sm"
                type="button"
                variant="ghost"
                onClick={() => {
                  setSaveError(null)
                  setDrafts(savedDrafts(groups))
                }}
              >
                Reset
              </Button>
            ) : null}
            <Button
              disabled={disabled || !changed || problem !== undefined}
              size="sm"
              type="submit"
            >
              {pending ? <LoaderCircle className="animate-spin" /> : null}
              Save limits
            </Button>
          </div>
        ) : null}
      </div>
    </form>
  )
}

function ResourceLimitsGroupRows({
  capacity,
  disabled,
  diskFloorBytes,
  draft,
  group,
  invalid,
  loading,
  onChange,
}: {
  capacity: ResourceLimitsCapacity | null
  disabled: boolean
  diskFloorBytes?: number | null
  draft: ResourceLimitsDraft
  group: ResourceLimitsGroup
  invalid: ResourceLimitField | null
  loading: boolean
  onChange: (
    key: string,
    update: React.SetStateAction<ResourceLimitsDraft>
  ) => void
}) {
  const { key } = group
  const change = React.useCallback(
    (update: React.SetStateAction<ResourceLimitsDraft>) =>
      onChange(key, update),
    [key, onChange]
  )
  return (
    <div className="space-y-2">
      {group.label ? (
        <p className="type-technical-label text-muted-foreground">
          {group.label}
        </p>
      ) : null}
      <ResourceLimitRows
        capacity={capacity}
        disabled={disabled}
        diskFloorBytes={diskFloorBytes}
        draft={draft}
        fields={group.fields}
        invalid={invalid}
        loading={loading}
        original={group.limits}
        onChange={change}
      />
    </div>
  )
}

function savedDrafts(
  groups: ReadonlyArray<ResourceLimitsGroup>
): Readonly<Record<string, ResourceLimitsDraft>> {
  return Object.fromEntries(
    groups.map((group) => [group.key, resourceLimitsDraft(group.limits)])
  )
}

// What one group can reach: an app's services share the node's memory, so
// what the others are set to is taken from it.
function groupCapacity(
  capacity: ResourceLimitsCapacity | null,
  groups: ReadonlyArray<ResourceLimitsGroup>,
  drafts: Readonly<Record<string, ResourceLimitsDraft>>,
  key: string
): ResourceLimitsCapacity | null {
  if (!capacity || groups.length < 2) return capacity
  const others = groups.reduce((total, group) => {
    const draft = drafts[group.key]
    return group.key === key || !draft
      ? total
      : total + (draftMemoryBytes(draft) ?? 0)
  }, 0)
  return {
    ...capacity,
    assignableMemoryBytes: Math.max(capacity.assignableMemoryBytes - others, 0),
  }
}
