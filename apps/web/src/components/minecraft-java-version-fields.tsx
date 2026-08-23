import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import type { Brick, BrickVariable } from "@workspace/contracts"

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
  javaVersionSelectOptions,
  latestStableVersion,
  recommendedSupportedJavaVersion,
  stringVariableAllows,
} from "@/lib/brick-variables"
import { brickVersionsQueryOptions } from "@/lib/query-options"

export function javaVersionDefinition(brick: {
  variables: Brick["variables"]
}): BrickVariable | null {
  const definition = brick.variables.java_version
  return definition?.type === "string" ? definition : null
}

export function supportedBrickVersions(
  versions: ReadonlyArray<string>,
  definition: BrickVariable,
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
    brickId,
    disabled = false,
    environment,
    javaInputName,
    javaVersion,
    onJavaVersionChange,
    onVersionChange,
    selectLatestByDefault = false,
    showDescriptions = true,
    variableDefinitions,
    version,
    versionInputName,
  }: {
    brickId: string
    disabled?: boolean
    environment: Readonly<Record<string, string>>
    javaInputName?: string
    javaVersion: string
    onJavaVersionChange: (value: string) => void
    onVersionChange: (value: string) => void
    selectLatestByDefault?: boolean
    showDescriptions?: boolean
    variableDefinitions: Brick["variables"]
    version: string
    versionInputName?: string
  }) {
    const labelId = React.useId()
    const javaLabelId = React.useId()
    const versionDefinition = variableDefinitions.version
    const javaDefinition = javaVersionDefinition({
      variables: variableDefinitions,
    })
    const catalog = brickArtifactCatalog({ runtime: { environment } })
    const versionsQuery = useQuery({
      ...brickVersionsQueryOptions(catalog?.type ?? "", catalog?.variant ?? ""),
      enabled: catalog !== null,
    })
    const defaultVersion =
      versionDefinition?.default === undefined
        ? ""
        : String(versionDefinition.default)
    const [draftVersion, setDraftVersion] = React.useState(version)
    const [draftJavaVersion, setDraftJavaVersion] = React.useState(javaVersion)
    const fieldVersion = selectLatestByDefault ? draftVersion : version
    const fieldJavaVersion = selectLatestByDefault
      ? draftJavaVersion
      : javaVersion
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
    const latestVersion = React.useMemo(
      () => latestStableVersion(versions),
      [versions]
    )
    const usePicker =
      catalog !== null &&
      !versionsQuery.isError &&
      (versionsQuery.isPending || versions.length > 0)
    const required = Boolean(
      versionDefinition?.required && versionDefinition.default === undefined
    )
    const javaVersions = React.useMemo(
      () =>
        javaDefinition
          ? javaVersionSelectOptions(javaDefinition, fieldJavaVersion)
          : [],
      [fieldJavaVersion, javaDefinition]
    )
    const recommendedJavaForVersion = React.useCallback(
      (nextVersion: string) =>
        javaDefinition
          ? recommendedSupportedJavaVersion(
              brickId,
              javaDefinition,
              nextVersion
            )
          : null,
      [brickId, javaDefinition]
    )
    const changeVersion = React.useCallback(
      (nextVersion: string) => {
        if (selectLatestByDefault) setDraftVersion(nextVersion)
        onVersionChange(nextVersion)
        const nextJava = recommendedJavaForVersion(nextVersion)
        if (!nextJava) return
        if (selectLatestByDefault) setDraftJavaVersion(nextJava)
        onJavaVersionChange(nextJava)
      },
      [
        onJavaVersionChange,
        onVersionChange,
        recommendedJavaForVersion,
        selectLatestByDefault,
      ]
    )
    const handleJavaVersionChange = React.useCallback(
      (nextJava: string) => {
        if (selectLatestByDefault) setDraftJavaVersion(nextJava)
        onJavaVersionChange(nextJava)
      },
      [onJavaVersionChange, selectLatestByDefault]
    )
    const automaticVersionRef = React.useRef<string | null>(fieldVersion)

    React.useEffect(() => {
      if (
        !selectLatestByDefault ||
        !latestVersion ||
        automaticVersionRef.current !== fieldVersion ||
        latestVersion === fieldVersion
      ) {
        return
      }

      automaticVersionRef.current = latestVersion
      setDraftVersion(latestVersion)
      const nextJava = recommendedJavaForVersion(latestVersion)
      if (nextJava) setDraftJavaVersion(nextJava)
    }, [
      fieldVersion,
      latestVersion,
      recommendedJavaForVersion,
      selectLatestByDefault,
    ])

    const handleVersionChange = React.useCallback(
      (nextVersion: string) => {
        automaticVersionRef.current = null
        changeVersion(nextVersion)
      },
      [changeVersion]
    )

    if (!versionDefinition || versionDefinition.type !== "string") return null

    const javaRequired = Boolean(
      javaDefinition?.required && javaDefinition.default === undefined
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
                maxLength={versionDefinition.rules?.maxLength}
                minLength={versionDefinition.rules?.minLength}
                pattern={versionDefinition.rules?.pattern}
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
                pattern={versionDefinition.rules?.pattern}
                minLength={versionDefinition.rules?.minLength}
                maxLength={versionDefinition.rules?.maxLength}
                disabled={disabled}
                className="font-mono tabular-nums"
                required={required}
              />
            )}
            {showDescriptions ? (
              <span className="block text-[0.5625rem] leading-4 font-normal">
                {versionDefinition.description}
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
                  pattern={javaDefinition.rules?.pattern}
                  minLength={javaDefinition.rules?.minLength}
                  maxLength={javaDefinition.rules?.maxLength}
                  disabled={disabled}
                  className="font-mono tabular-nums"
                  required={javaRequired}
                />
              )}
            </div>
          ) : null}
        </div>
        {javaDefinition && showDescriptions ? (
          <span className="block text-[0.5625rem] leading-4 font-normal">
            {javaDefinition.description}
          </span>
        ) : null}
      </div>
    )
  }
)
