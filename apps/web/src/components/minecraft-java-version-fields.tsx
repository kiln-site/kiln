import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { brickInputRequired, type BrickInput } from "@workspace/contracts"

import { Input } from "@workspace/ui/components/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select"

import { BrickVersionPicker } from "@/components/brick-version-picker"
import { brickArtifactCatalog } from "@/lib/brick-artifact"
import {
  isTextBrickField,
  javaVersionSelectOptions,
  stringVariableAllows,
  type BrickFields,
} from "@/lib/brick-variables"
import { brickVersionsQueryOptions } from "@/lib/query-options"

export function javaVersionDefinition(
  definitions: BrickFields
): BrickInput | null {
  const definition = definitions.java_version
  return definition && isTextBrickField(definition) ? definition : null
}

export function supportedBrickVersions(
  versions: ReadonlyArray<string>,
  definition: BrickInput,
  defaultVersion: string
): Array<string> {
  const allowed = versions.filter((version) =>
    stringVariableAllows(definition, version)
  )
  if (defaultVersion && !allowed.includes(defaultVersion)) {
    return stringVariableAllows(definition, defaultVersion)
      ? [defaultVersion, ...allowed]
      : allowed
  }
  return allowed
}

export const MinecraftJavaVersionFields = React.memo(
  function MinecraftJavaVersionFields({
    disabled = false,
    environment,
    javaInputName,
    javaVersion,
    onJavaVersionChange,
    onVersionChange,
    showDescriptions = true,
    variableDefinitions,
    version,
    versionInputName,
  }: {
    disabled?: boolean
    environment: Readonly<Record<string, string>>
    javaInputName?: string
    javaVersion: string
    onJavaVersionChange: (value: string) => void
    onVersionChange: (value: string) => void
    showDescriptions?: boolean
    variableDefinitions: BrickFields
    version: string
    versionInputName?: string
  }) {
    const labelId = React.useId()
    const javaLabelId = React.useId()
    const versionDefinition = variableDefinitions.version
    const javaDefinition = javaVersionDefinition(variableDefinitions)
    const catalog = brickArtifactCatalog(environment)
    const versionsQuery = useQuery({
      ...brickVersionsQueryOptions(catalog?.type ?? "", catalog?.variant ?? ""),
      enabled: catalog !== null,
    })
    const defaultVersion =
      versionDefinition?.default === undefined
        ? ""
        : String(versionDefinition.default)
    const fieldVersion = version
    const fieldJavaVersion = javaVersion
    const versions = React.useMemo(
      () =>
        versionDefinition
          ? supportedBrickVersions(
              versionsQuery.data?.versions ?? [],
              versionDefinition,
              defaultVersion
            )
          : [],
      [defaultVersion, versionDefinition, versionsQuery.data?.versions]
    )
    const usePicker =
      catalog !== null &&
      !versionsQuery.isError &&
      (versionsQuery.isPending || versions.length > 0)
    const required = Boolean(
      versionDefinition &&
      brickInputRequired(versionDefinition) &&
      versionDefinition.default === undefined
    )
    const javaVersions = React.useMemo(
      () =>
        javaDefinition
          ? javaVersionSelectOptions(javaDefinition, fieldJavaVersion)
          : [],
      [fieldJavaVersion, javaDefinition]
    )
    // Each field reports its own change and nothing else. What follows the
    // version, Java included, is worked out once by whoever holds the
    // answers, from every answer and not this pair alone.
    const handleVersionChange = onVersionChange
    const handleJavaVersionChange = React.useCallback(
      (nextJava: string) => {
        // The select reports an empty choice when the Java held isn't one
        // it offers. That is no answer: what is held stays, to be refused
        // by name when the form is sent.
        if (nextJava) onJavaVersionChange(nextJava)
      },
      [onJavaVersionChange]
    )

    if (!versionDefinition || !isTextBrickField(versionDefinition)) return null

    const javaRequired = Boolean(
      javaDefinition &&
      brickInputRequired(javaDefinition) &&
      javaDefinition.default === undefined
    )

    return (
      <div className="space-y-1.5 text-xs font-medium text-muted-foreground">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1 space-y-1.5">
            <span id={labelId}>{versionDefinition.label}</span>
            {usePicker ? (
              <BrickVersionPicker
                labelledBy={labelId}
                name={versionInputName ?? "version"}
                value={fieldVersion}
                versions={versions}
                disabled={disabled}
                loading={versionsQuery.isPending}
                maxLength={versionDefinition.max}
                minLength={versionDefinition.min}
                pattern={versionDefinition.pattern}
                required={required}
                onChange={handleVersionChange}
              />
            ) : (
              <Input
                aria-labelledby={labelId}
                name={versionInputName ?? "version"}
                value={fieldVersion}
                onChange={(event) =>
                  handleVersionChange(event.currentTarget.value)
                }
                placeholder="Enter a version"
                pattern={versionDefinition.pattern}
                minLength={versionDefinition.min}
                maxLength={versionDefinition.max}
                disabled={disabled}
                className="font-mono tabular-nums"
                required={required}
              />
            )}
            {showDescriptions ? (
              <span className="type-meta block font-normal">
                {versionDefinition.help}
              </span>
            ) : null}
          </div>
          {javaDefinition ? (
            <div
              className={
                javaVersions.length > 0
                  ? "w-[5.75rem] shrink-0 space-y-1.5"
                  : "w-[7.5rem] shrink-0 space-y-1.5"
              }
            >
              <span id={javaLabelId}>Java</span>
              {javaVersions.length > 0 ? (
                <>
                  {javaInputName ? (
                    <input
                      type="hidden"
                      name={javaInputName}
                      value={fieldJavaVersion}
                    />
                  ) : null}
                  <Select
                    value={fieldJavaVersion}
                    onValueChange={handleJavaVersionChange}
                    disabled={disabled}
                  >
                    <SelectTrigger
                      aria-labelledby={javaLabelId}
                      className="h-8 w-full px-2.5 font-mono text-xs tabular-nums"
                    >
                      <SelectValue placeholder="Java" />
                    </SelectTrigger>
                    <SelectContent className="z-[70]">
                      {javaVersions.map((option) => (
                        <SelectItem
                          key={option}
                          className="font-mono text-xs tabular-nums"
                          value={option}
                        >
                          {option}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </>
              ) : (
                <Input
                  aria-labelledby={javaLabelId}
                  name={javaInputName ?? "java_version"}
                  value={fieldJavaVersion}
                  onChange={(event) =>
                    handleJavaVersionChange(event.currentTarget.value)
                  }
                  placeholder="Java"
                  pattern={javaDefinition.pattern}
                  minLength={javaDefinition.min}
                  maxLength={javaDefinition.max}
                  disabled={disabled}
                  className="font-mono tabular-nums"
                  required={javaRequired}
                />
              )}
            </div>
          ) : null}
        </div>
        {javaDefinition && showDescriptions ? (
          <span className="type-meta block font-normal">
            {javaDefinition.help}
          </span>
        ) : null}
      </div>
    )
  }
)
