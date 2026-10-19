import * as React from "react"
import { Effect } from "effect"
import { Gauge, LoaderCircle } from "lucide-react"
import { resourceLimitsEqual, type ResourceLimits } from "@workspace/contracts"

import { Button } from "@workspace/ui/components/button"
import { showToast } from "@workspace/ui/components/sonner"

import { InfoSection } from "@/components/info-page"
import { ResourceLimitsEditor } from "@/components/resource-limits-editor"
import {
  parseResourceLimitsDraft,
  resourceLimitsDraft,
  type ResourceLimitsCapacity,
} from "@/lib/resource-limits"

// An instance's memory, CPU, and disk limits on its Info page, for any kind
// of instance. Saving sends the whole set; `onSave` applies it.
export function ResourceLimitsSection({
  capacity,
  disabledReason,
  editable,
  hint,
  limits,
  onSave,
}: {
  capacity: ResourceLimitsCapacity | null
  /** Why the limits can't change right now, such as an offline Relay. */
  disabledReason?: string
  editable: boolean
  /** What happens at the limits, for this kind of instance. */
  hint?: React.ReactNode
  limits: ResourceLimits
  onSave: (limits: ResourceLimits) => Promise<unknown>
}) {
  return (
    <InfoSection content icon={<Gauge />} title="Resource limits">
      {/* A new set of limits from the Relay starts a fresh draft. */}
      <ResourceLimitsForm
        key={`${limits.cpuMillis}:${limits.memoryBytes}:${limits.diskBytes}`}
        capacity={capacity}
        disabledReason={disabledReason}
        editable={editable}
        hint={hint}
        limits={limits}
        onSave={onSave}
      />
    </InfoSection>
  )
}

function ResourceLimitsForm({
  capacity,
  disabledReason,
  editable,
  hint,
  limits,
  onSave,
}: React.ComponentProps<typeof ResourceLimitsSection>) {
  const [draft, setDraft] = React.useState(() => resourceLimitsDraft(limits))
  const [error, setError] = React.useState<string | null>(null)
  const [pending, setPending] = React.useState(false)
  const parsed = parseResourceLimitsDraft(draft, capacity)
  const changed =
    "error" in parsed || !resourceLimitsEqual(parsed.limits, limits)
  const disabled = !editable || disabledReason !== undefined || pending

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (disabled) return
    if ("error" in parsed) {
      setError(parsed.error)
      return
    }
    setError(null)
    setPending(true)
    const limits = parsed.limits
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
      <ResourceLimitsEditor
        capacity={capacity}
        disabled={disabled}
        draft={draft}
        onChange={setDraft}
      />
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
