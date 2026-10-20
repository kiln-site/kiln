import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import type { AppGitHubBuild } from "@workspace/contracts"

import { Input } from "@workspace/ui/components/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select"
import { cn } from "@workspace/ui/lib/utils"

import {
  Field,
  RepositoryPicker,
  SwitchRow,
} from "@/components/github-sync-dialogs"
import { SourceAccount } from "@/components/source-account"
import {
  githubBranchesQueryOptions,
  githubRepositoriesQueryOptions,
  githubSourcesQueryOptions,
} from "@/lib/query-options"

// Where a GitHub app deploys from: a repository branch, and the Dockerfile or
// Compose file in it that it builds.

export interface GitHubSourceDraft {
  autoDeploy: boolean
  branch: string
  build: AppGitHubBuild
  connectionId: string
  path: string
  repository: string
}

const defaultPaths: Record<AppGitHubBuild, string> = {
  compose: "compose.yaml",
  dockerfile: "Dockerfile",
}

export function emptyGitHubSourceDraft(): GitHubSourceDraft {
  return {
    autoDeploy: true,
    branch: "",
    build: "dockerfile",
    connectionId: "",
    path: defaultPaths.dockerfile,
    repository: "",
  }
}

export function githubSourceDraftReady(draft: GitHubSourceDraft): boolean {
  return (
    draft.connectionId !== "" &&
    draft.repository !== "" &&
    draft.branch !== "" &&
    draft.path.trim() !== ""
  )
}

export function GitHubSourceFields({
  draft,
  onChange,
}: {
  draft: GitHubSourceDraft
  onChange: (draft: GitHubSourceDraft) => void
}) {
  const sources = useQuery(githubSourcesQueryOptions())
  const usable = React.useMemo(
    () =>
      (sources.data?.sources ?? []).filter(
        (source) =>
          (source.installation && !source.installation.suspended) ||
          source.id === draft.connectionId
      ),
    [draft.connectionId, sources.data]
  )
  // The first usable source until the person picks; any change saves it.
  const connectionId = draft.connectionId || usable[0]?.id || ""
  const connection = usable.find((source) => source.id === connectionId)
  const repositories = useQuery({
    ...githubRepositoriesQueryOptions(connectionId),
    enabled: connectionId !== "",
  })
  const branches = useQuery({
    ...githubBranchesQueryOptions(connectionId, draft.repository),
    enabled: connectionId !== "" && draft.repository !== "",
  })
  const update = (change: Partial<GitHubSourceDraft>) =>
    onChange({ ...draft, connectionId, ...change })

  if (sources.isSuccess && usable.length === 0) {
    return (
      <p className="border border-dashed px-3 py-2.5 text-xs text-muted-foreground">
        Connect a GitHub account first.{" "}
        <Link
          to="/infra/sources"
          search={{ add: true }}
          className="text-primary hover:underline"
        >
          Add a source
        </Link>
      </p>
    )
  }

  return (
    <div className="space-y-3">
      <Field label="Source">
        <Select
          value={connectionId}
          onValueChange={(value) => {
            if (!value || value === connectionId) return
            update({ branch: "", connectionId: value, repository: "" })
          }}
        >
          <SelectTrigger className="h-10 w-full">
            <SelectValue
              placeholder={sources.isPending ? "Loading…" : "Choose a source"}
            />
          </SelectTrigger>
          <SelectContent>
            {usable.map((source) => (
              <SelectItem key={source.id} value={source.id}>
                <span className="flex min-w-0 items-center gap-2">
                  <SourceAccount source={source} showType={false} />
                  <span className="type-meta truncate font-mono text-muted-foreground">
                    {source.appName}
                  </span>
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_12rem]">
        <Field label="Repository">
          <RepositoryPicker
            error={repositories.error}
            loading={repositories.isPending && connectionId !== ""}
            manageUrl={connection?.manageUrl ?? null}
            repositories={repositories.data ?? []}
            value={draft.repository}
            onChange={(repository) =>
              update({
                branch:
                  repositories.data?.find((item) => item.fullName === repository)
                    ?.defaultBranch ?? "",
                repository,
              })
            }
          />
        </Field>
        <Field label="Branch">
          <Select
            value={draft.branch}
            disabled={!draft.repository || branches.isPending}
            onValueChange={(value) => {
              // Radix reports "" while the options re-render.
              if (!value || value === draft.branch) return
              update({ branch: value })
            }}
          >
            <SelectTrigger className="w-full font-mono">
              <SelectValue
                placeholder={
                  draft.repository && branches.isPending ? "Loading…" : "Branch"
                }
              />
            </SelectTrigger>
            <SelectContent>
              {(branches.data ?? (draft.branch ? [draft.branch] : [])).map(
                (branch) => (
                  <SelectItem key={branch} value={branch} className="font-mono">
                    {branch}
                  </SelectItem>
                )
              )}
            </SelectContent>
          </Select>
        </Field>
      </div>
      <div
        role="radiogroup"
        aria-label="Build"
        className="grid grid-cols-2 gap-2"
      >
        {(
          [
            ["dockerfile", "Dockerfile", "Builds one container"],
            ["compose", "Docker Compose", "Runs every service in the file"],
          ] as const
        ).map(([build, label, detail]) => (
          <button
            key={build}
            role="radio"
            aria-checked={draft.build === build}
            type="button"
            className={cn(
              "flex flex-col gap-0.5 border px-3 py-2.5 text-left transition-colors outline-none focus-visible:ring-1 focus-visible:ring-ring",
              draft.build === build
                ? "border-primary/60 bg-primary/10"
                : "hover:bg-muted/40"
            )}
            onClick={() =>
              update({
                build,
                // The other build's default follows the switch.
                path:
                  draft.path === defaultPaths[draft.build]
                    ? defaultPaths[build]
                    : draft.path,
              })
            }
          >
            <span className="text-[0.8125rem] font-medium">{label}</span>
            <span className="text-xs text-muted-foreground">{detail}</span>
          </button>
        ))}
      </div>
      <Field
        label={draft.build === "compose" ? "Compose file" : "Dockerfile"}
        hint="From the repository's root"
      >
        <Input
          className="font-mono"
          placeholder={defaultPaths[draft.build]}
          spellCheck={false}
          autoComplete="off"
          value={draft.path}
          onChange={(event) => update({ path: event.currentTarget.value })}
        />
      </Field>
      <p className="type-meta text-muted-foreground">
        {draft.build === "compose"
          ? "Paths in the file are relative to its folder. Mount the app’s data with ${KILN_DATA}."
          : "Built with the whole repository as its context."}
      </p>
      <SwitchRow
        checked={draft.autoDeploy}
        info={
          connection?.webhookActive === false
            ? "Deploys each new commit on the branch. Kiln checks for one every minute."
            : "Deploys each new commit pushed to the branch."
        }
        label="Deploy on push"
        onCheckedChange={(autoDeploy) => update({ autoDeploy })}
      />
    </div>
  )
}
