import * as React from "react"
import { SlidersHorizontal, TriangleAlert } from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"

import {
  BackupConfigurationDialog,
  type BackupConfiguration,
  type BackupConfigurationTarget,
} from "@/components/backup-configuration-dialog"
import { InstanceKindCounts } from "@/components/instance-kind-counts"
import {
  schedulePickerTarget,
  scheduleTargetNames,
  type ScheduleOption,
} from "@/components/schedule-targets"
import { scheduleBackupDestination } from "@/lib/schedule-backup-configuration"
import {
  backupStep,
  backupStepConsistency,
  backupStepTargetKeys,
  type AppVolumes,
  type ScheduleBackupAction,
} from "@/lib/schedule-backup-step"
import type { getBackupStorage } from "@/server/backup-storage"

/** A schedule's backup step: what it backs up, and Configure Backup. */
export const ScheduleBackupStep = React.memo(function ScheduleBackupStep({
  action,
  appVolumes,
  onChange,
  permissionKey,
  storage,
  targets,
}: {
  action: ScheduleBackupAction
  appVolumes: AppVolumes
  onChange: (action: ScheduleBackupAction) => void
  permissionKey: "canCreate" | "canUpdate"
  storage: ReadonlyArray<Awaited<ReturnType<typeof getBackupStorage>>[number]>
  /** The schedule's. */
  targets: ReadonlyArray<ScheduleOption>
}) {
  const [configuring, setConfiguring] = React.useState(false)
  const step = React.useMemo(
    () => backupStep(action, targets, appVolumes, permissionKey),
    [action, appVolumes, permissionKey, targets]
  )
  const listed = React.useMemo(
    () =>
      step.listed.map(({ option, removeOnly }): BackupConfigurationTarget => ({
        ...schedulePickerTarget(option),
        ...(option.kind === "app" && !removeOnly
          ? { description: appBackupDescription(option, appVolumes) }
          : {}),
        unavailable: removeOnly,
      })),
    [appVolumes, step]
  )
  const destination =
    action.destination.kind === "storage"
      ? action.destination.storageId
      : "local"

  const save = (configuration: BackupConfiguration) => {
    const {
      consistency: _consistency,
      targetKeys: _targetKeys,
      ...rest
    } = action
    const stopped = configuration.consistency === "stopped"
    const targetKeys = backupStepTargetKeys(step, configuration.targetKeys)
    onChange({
      ...rest,
      destination: scheduleBackupDestination(configuration.destinationKeys[0]),
      mode: configuration.mode,
      name: configuration.name,
      ...(stopped ? { consistency: "stopped" as const } : {}),
      ...(targetKeys ? { targetKeys: [...targetKeys] } : {}),
    })
    setConfiguring(false)
  }

  return (
    <>
      <Button
        aria-label="Configure Backup"
        className="size-8 max-w-full min-w-0 shrink-0 justify-center truncate px-0 sm:w-fit sm:justify-start sm:px-2.5"
        type="button"
        title={action.name}
        variant="outline"
        onClick={() => setConfiguring(true)}
      >
        <SlidersHorizontal className="size-4 shrink-0" />
        <span className="hidden truncate sm:inline">Configure Backup</span>
      </Button>
      {Object.values(step.counts).some((count) => count > 0) ? (
        <span className="type-code ml-1 hidden items-center gap-2.5 text-muted-foreground sm:flex">
          <InstanceKindCounts counts={step.counts} />
        </span>
      ) : (
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              aria-label="Nothing to back up"
              className="grid size-6 shrink-0 place-items-center text-amber-300 light:text-amber-700"
              role="img"
            >
              <TriangleAlert className="size-3.5" />
            </span>
          </TooltipTrigger>
          <TooltipContent side="top">Nothing to back up</TooltipContent>
        </Tooltip>
      )}
      <BackupConfigurationDialog
        consistencyChoiceFor={backupStepConsistency}
        description="An App is backed up by the volumes it uses."
        initialConsistency={action.consistency ?? "live"}
        initialDestinationKeys={[destination]}
        initialMode={action.mode}
        initialName={action.name}
        initialTargetKeys={step.chosen}
        onOpenChange={setConfiguring}
        onSubmit={save}
        open={configuring}
        singleDestination
        step
        storage={storage}
        submitLabel="Save backup"
        targets={listed}
        targetsNote={(chosen) => (
          <>
            {step.empty.length > 0
              ? `${scheduleTargetNames(step.empty)} ${step.empty.length === 1 ? "has" : "have"} no volumes to back up. `
              : null}
            {backupStepTargetKeys(step, chosen)
              ? "Only what's chosen is backed up."
              : "Targets added to the schedule later are backed up too."}
          </>
        )}
        title="Configure Backup"
      />
    </>
  )
})

function appBackupDescription(app: ScheduleOption, appVolumes: AppVolumes) {
  const volumes = appVolumes.of(app)
  if (volumes) return `Backs up ${volumes.join(", ")}`
  return appVolumes.loading
    ? "Finding which volumes it uses…"
    : "Backs up the volumes it uses"
}
