import * as React from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import {
  FolderX,
  HardDrive,
  History,
  LoaderCircle,
  ShieldCheck,
} from "lucide-react"
import type { BackupTarget } from "@workspace/contracts"

import { Button } from "@workspace/ui/components/button"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@workspace/ui/components/input-group"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select"
import { showToast } from "@workspace/ui/components/sonner"
import { Switch } from "@workspace/ui/components/switch"
import { Textarea } from "@workspace/ui/components/textarea"

import { SettingsPanel, SettingsRow } from "@/components/settings-panel"
import { queryKeys } from "@/lib/query-options"
import {
  setPreferredBackupStorage,
  type getBackupStorage,
} from "@/server/backup-storage"
import {
  updateBackupExcludes,
  updateBackupLimits,
  type getBackupPolicy,
} from "@/server/backups"

// One target's backup settings: its retention, a platform administrator's
// ceiling on it, where its backups go, and what game server backups leave
// out. A blank retention field keeps without that limit.

type BackupStorage = Awaited<ReturnType<typeof getBackupStorage>>[number]
type BackupPolicy = Awaited<ReturnType<typeof getBackupPolicy>>

const GIB = 1024 ** 3

interface RetentionDraft {
  days: string
  quantity: string
  size: string
}

interface Retention {
  days: number | null
  quantity: number | null
  sizeBytes: number | null
}

export function BackupTargetSettings({
  isPlatformAdmin,
  name,
  policy,
  relayId,
  storage,
  target,
}: {
  isPlatformAdmin: boolean
  name: string
  policy: BackupPolicy
  relayId: string
  storage: ReadonlyArray<BackupStorage>
  target: BackupTarget
}) {
  const queryClient = useQueryClient()
  const initial = React.useMemo(
    () => ({
      ceiling: retentionDraft({
        days: policy.adminRetentionDays,
        quantity: policy.adminQuantityLimit || null,
        sizeBytes: policy.adminSizeLimitBytes,
      }),
      enabled: policy.adminQuantityLimit !== 0,
      exclude: policy.exclude.join("\n"),
      retention: retentionDraft({
        days: policy.retentionDays,
        quantity: policy.quantityLimit,
        sizeBytes: policy.sizeLimitBytes,
      }),
      storageId: policy.storageId ?? "local",
    }),
    [policy]
  )
  const [draft, setDraft] = React.useState(initial)
  const destinations = React.useMemo(
    () =>
      storage.filter(
        (destination) =>
          destination.enabled &&
          !destination.deleting &&
          (target.kind !== "platform" || destination.ownerUserId === null)
      ),
    [storage, target.kind]
  )
  const storageId = destinations.some((option) => option.id === draft.storageId)
    ? draft.storageId
    : "local"
  const retention = parseRetention(draft.retention)
  const ceiling = draft.enabled ? parseRetention(draft.ceiling) : null
  const valid = retention !== null && (!draft.enabled || ceiling !== null)
  const changed = JSON.stringify(draft) !== JSON.stringify(initial)

  const save = useMutation({
    mutationFn: async () => {
      if (!retention) return
      await Promise.all([
        updateBackupLimits({
          data: {
            quantityLimit: retention.quantity,
            relayId,
            retentionDays: retention.days,
            scope: "user",
            sizeLimitBytes: retention.sizeBytes,
            target,
          },
        }),
        isPlatformAdmin
          ? updateBackupLimits({
              data: {
                // No backups at all turns them off for the target.
                quantityLimit: ceiling ? ceiling.quantity : 0,
                relayId,
                retentionDays: ceiling?.days ?? null,
                scope: "platform",
                sizeLimitBytes: ceiling?.sizeBytes ?? null,
                target,
              },
            })
          : null,
        excludable(target.kind)
          ? updateBackupExcludes({
              data: {
                exclude: draft.exclude
                  .split("\n")
                  .map((line) => line.trim())
                  .filter(Boolean),
                relayId,
                target,
              },
            })
          : null,
        setPreferredBackupStorage({
          data: {
            relayId,
            storageId: storageId === "local" ? null : storageId,
            target,
          },
        }),
      ])
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: queryKeys.backups.policy(relayId, target),
      })
      showToast({ message: `${name} backup settings saved`, type: "success" })
    },
  })

  return (
    <div className="grid gap-4 lg:grid-cols-2 lg:items-start">
      <div className="grid gap-4">
        <SettingsPanel icon={<History />} title="Retention">
          <RetentionRows
            ceiling={
              isPlatformAdmin
                ? null
                : {
                    days: policy.adminRetentionDays,
                    quantity: policy.adminQuantityLimit,
                    sizeBytes: policy.adminSizeLimitBytes,
                  }
            }
            draft={draft.retention}
            ariaPrefix=""
            onChange={(next) => setDraft({ ...draft, retention: next })}
          />
        </SettingsPanel>
        {isPlatformAdmin ? (
          <SettingsPanel icon={<ShieldCheck />} title="Platform ceiling">
            <SettingsRow label="Allow backups">
              <Switch
                aria-label="Allow backups"
                checked={draft.enabled}
                onCheckedChange={(enabled) => setDraft({ ...draft, enabled })}
              />
            </SettingsRow>
            {draft.enabled ? (
              <RetentionRows
                ariaPrefix="Ceiling: "
                ceiling={null}
                draft={draft.ceiling}
                onChange={(next) => setDraft({ ...draft, ceiling: next })}
              />
            ) : null}
          </SettingsPanel>
        ) : null}
      </div>
      <div className="grid gap-4">
        <SettingsPanel icon={<HardDrive />} title="Destination">
          <SettingsRow label="Back up to">
            <Select
              value={storageId}
              onValueChange={(next) => setDraft({ ...draft, storageId: next })}
            >
              <SelectTrigger
                aria-label="Preferred backup destination"
                className="h-8 w-56 [&_[data-slot=select-value]]:min-w-0 [&_[data-slot=select-value]]:truncate"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="w-max min-w-(--radix-select-trigger-width)">
                <SelectItem value="local">This Relay</SelectItem>
                {destinations.map((destination) => (
                  <SelectItem key={destination.id} value={destination.id}>
                    {destination.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingsRow>
        </SettingsPanel>
        {excludable(target.kind) ? (
          <SettingsPanel icon={<FolderX />} title="Exclusions">
            <div className="p-4">
              <Textarea
                aria-label="Paths left out of backups, one pattern per line"
                className="min-h-28 font-mono text-xs"
                placeholder={"cache/**\nlogs/*.log\nworld/session.lock"}
                value={draft.exclude}
                onChange={(event) =>
                  setDraft({ ...draft, exclude: event.currentTarget.value })
                }
              />
            </div>
          </SettingsPanel>
        ) : null}
        <div className="flex items-center justify-end gap-3">
          {save.error ? (
            <p className="min-w-0 flex-1 text-xs text-destructive">
              {save.error.message}
            </p>
          ) : null}
          <Button
            disabled={!changed || !valid || save.isPending}
            type="button"
            onClick={() => save.mutate()}
          >
            {save.isPending ? <LoaderCircle className="animate-spin" /> : null}
            Save
          </Button>
        </div>
      </div>
    </div>
  )
}

// Newest backups, their total space, and their age. A ceiling the owner
// can't pass shows beside the field it bounds.
function RetentionRows({
  ariaPrefix,
  ceiling,
  draft,
  onChange,
}: {
  ariaPrefix: string
  ceiling: Retention | null
  draft: RetentionDraft
  onChange: (draft: RetentionDraft) => void
}) {
  return (
    <>
      <SettingsRow label="Newest backups">
        <RetentionField
          label={`${ariaPrefix}newest backups kept`}
          limit={ceiling?.quantity ?? null}
          placeholder="All"
          step="1"
          unit=""
          value={draft.quantity}
          valid={draft.quantity === "" || wholeAtLeastOne(draft.quantity)}
          onChange={(quantity) => onChange({ ...draft, quantity })}
        />
      </SettingsRow>
      <SettingsRow label="Total space">
        <RetentionField
          label={`${ariaPrefix}space kept, in GiB`}
          limit={
            ceiling?.sizeBytes === null || ceiling?.sizeBytes === undefined
              ? null
              : gibibytes(ceiling.sizeBytes)
          }
          placeholder="Any"
          step="any"
          unit="GiB"
          value={draft.size}
          valid={draft.size === "" || Number(draft.size) > 0}
          onChange={(size) => onChange({ ...draft, size })}
        />
      </SettingsRow>
      <SettingsRow label="Age">
        <RetentionField
          label={`${ariaPrefix}days kept`}
          limit={ceiling?.days ?? null}
          placeholder="Forever"
          step="1"
          unit="days"
          value={draft.days}
          valid={draft.days === "" || wholeAtLeastOne(draft.days)}
          onChange={(days) => onChange({ ...draft, days })}
        />
      </SettingsRow>
    </>
  )
}

function RetentionField({
  label,
  limit,
  onChange,
  placeholder,
  step,
  unit,
  valid,
  value,
}: {
  label: string
  limit: number | null
  onChange: (value: string) => void
  placeholder: string
  step: string
  unit: string
  valid: boolean
  value: string
}) {
  return (
    <>
      {limit !== null ? (
        <span className="type-meta text-muted-foreground tabular-nums">
          up to {limit}
          {unit ? ` ${unit}` : ""}
        </span>
      ) : null}
      <InputGroup className="w-36">
        <InputGroupInput
          aria-invalid={!valid}
          aria-label={label}
          className="tabular-nums"
          inputMode="decimal"
          min="0"
          placeholder={placeholder}
          step={step}
          type="number"
          value={value}
          onChange={(event) => onChange(event.currentTarget.value)}
        />
        {unit ? (
          <InputGroupAddon align="inline-end">{unit}</InputGroupAddon>
        ) : null}
      </InputGroup>
    </>
  )
}

function retentionDraft(retention: Retention): RetentionDraft {
  return {
    days: retention.days?.toString() ?? "",
    quantity: retention.quantity?.toString() ?? "",
    size:
      retention.sizeBytes === null
        ? ""
        : String(gibibytes(retention.sizeBytes)),
  }
}

// Null when a field isn't a usable limit.
function parseRetention(draft: RetentionDraft): Retention | null {
  const quantity = draft.quantity === "" ? null : Number(draft.quantity)
  const days = draft.days === "" ? null : Number(draft.days)
  const size = draft.size === "" ? null : Number(draft.size)
  if (
    (draft.quantity !== "" && !wholeAtLeastOne(draft.quantity)) ||
    (draft.days !== "" && !wholeAtLeastOne(draft.days)) ||
    (size !== null && !(Number.isFinite(size) && size > 0))
  ) {
    return null
  }
  return {
    days,
    quantity,
    sizeBytes: size === null ? null : Math.max(1, Math.round(size * GIB)),
  }
}

function wholeAtLeastOne(value: string): boolean {
  const number = Number(value)
  return Number.isSafeInteger(number) && number >= 1
}

function gibibytes(bytes: number): number {
  return Math.round((bytes / GIB) * 100) / 100
}

// A game server's folder, an App's, and a volume are archived file by file,
// so their backups can leave paths out; a database's dump and Kiln's
// bundle can't.
function excludable(kind: BackupTarget["kind"]): boolean {
  return kind === "instance" || kind === "app" || kind === "volume"
}
