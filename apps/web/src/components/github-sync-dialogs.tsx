import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  Check,
  ChevronDown,
  Folder,
  Info,
  FolderRoot,
  LoaderCircle,
  Lock,
  Trash2,
  Layers,
} from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@workspace/ui/components/command"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@workspace/ui/components/dialog"
import { Input } from "@workspace/ui/components/input"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@workspace/ui/components/popover"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select"
import { showToast } from "@workspace/ui/components/sonner"
import { Separator } from "@workspace/ui/components/separator"
import { Switch } from "@workspace/ui/components/switch"
import { Textarea } from "@workspace/ui/components/textarea"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"
import { cn } from "@workspace/ui/lib/utils"

import { GitHubMark } from "@/components/github-mark"
import {
  AppKindIcon,
  RelayKindIcon,
  ServerKindIcon,
} from "@/components/instance-kind-icon"
import { SourceAccount } from "@/components/source-account"
import {
  InstancePickerContent,
  type InstancePickerItem,
} from "@/components/instance-picker"
import {
  githubBranchesQueryOptions,
  githubFoldersQueryOptions,
  githubRepositoriesQueryOptions,
  queryKeys,
} from "@/lib/query-options"
import { deleteGitHubSync, saveGitHubSync } from "@/server/github-sync"
import type {
  GitHubConnectionView,
  GitHubSyncTarget,
  GitHubSyncView,
} from "@/server/github-sync.server"

export function GitHubSyncEditorDialog({
  initialSourceId,
  initialTarget,
  sources,
  sync,
  targets,
  onClose,
}: {
  /** Chosen on Sources before opening. */
  initialSourceId: string | null
  initialTarget: GitHubSyncTarget | null
  sources: ReadonlyArray<GitHubConnectionView>
  sync: GitHubSyncView | null
  targets: ReadonlyArray<GitHubSyncTarget>
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const usable = React.useMemo(
    () =>
      sources.filter(
        (source) =>
          (source.installation && !source.installation.suspended) ||
          source.id === sync?.connectionId
      ),
    [sources, sync?.connectionId]
  )
  const [target, setTarget] = React.useState<GitHubSyncTarget | null>(
    sync?.target ?? initialTarget
  )
  const [connectionId, setConnectionId] = React.useState(
    () =>
      sync?.connectionId ??
      usable.find((source) => source.id === initialSourceId)?.id ??
      usable[0]?.id ??
      ""
  )
  const [repository, setRepository] = React.useState(sync?.repository ?? "")
  const [branch, setBranch] = React.useState(sync?.branch ?? "")
  const [sourcePath, setSourcePath] = React.useState(sync?.sourcePath ?? "")
  const [targetPath, setTargetPath] = React.useState(sync?.targetPath ?? "")
  const [patterns, setPatterns] = React.useState(
    sync?.includePatterns.join("\n") ?? ""
  )
  const [autoSync, setAutoSync] = React.useState(sync?.autoSync ?? true)
  const [overwrite, setOverwrite] = React.useState(sync?.overwrite ?? false)
  const connection = usable.find((item) => item.id === connectionId) ?? null

  const repositories = useQuery({
    ...githubRepositoriesQueryOptions(connectionId),
    enabled: connectionId !== "",
  })
  const branches = useQuery({
    ...githubBranchesQueryOptions(connectionId, repository),
    enabled: connectionId !== "" && repository !== "",
  })
  const folders = useQuery({
    ...githubFoldersQueryOptions(connectionId, repository, branch),
    enabled: connectionId !== "" && repository !== "" && branch !== "",
  })
  const selectRepository = React.useCallback(
    (fullName: string) => {
      setRepository(fullName)
      setSourcePath("")
      setBranch(
        repositories.data?.find((item) => item.fullName === fullName)
          ?.defaultBranch ?? ""
      )
    },
    [repositories.data]
  )
  const includePatterns = React.useMemo(
    () =>
      patterns
        .split("\n")
        .map((pattern) => pattern.trim())
        .filter(Boolean),
    [patterns]
  )
  const folderFiles = folders.data?.folders.find(
    (folder) => folder.path === sourcePath
  )?.files

  const save = useMutation({
    mutationFn: () =>
      saveGitHubSync({
        data: {
          autoSync,
          branch,
          connectionId,
          id: sync?.id,
          includePatterns,
          overwrite,
          repository,
          sourcePath,
          target: {
            id: target!.id,
            kind: target!.kind,
            relayId: target!.relayId,
          },
          targetPath,
        },
      }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.github.overview }),
        queryClient.invalidateQueries({ queryKey: queryKeys.github.sources }),
      ])
      showToast({
        message: sync ? "Sync saved; syncing now" : "Sync created; syncing now",
        type: "success",
      })
      onClose()
    },
  })
  const canSave =
    target !== null &&
    connection !== null &&
    repository !== "" &&
    branch !== "" &&
    !save.isPending

  return (
    <Dialog open onOpenChange={(open) => !open && !save.isPending && onClose()}>
      <DialogContent className="grid max-h-[min(92dvh,52rem)] grid-rows-[auto_minmax(0,1fr)] gap-4 overflow-hidden sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{sync ? "Edit Sync" : "Create Sync"}</DialogTitle>
          <DialogDescription className="sr-only">
            Copy files from a repository folder into a game server or app.
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid min-h-0 grid-rows-[minmax(0,1fr)_auto] gap-4"
          action={() => {
            if (canSave) save.mutate()
          }}
        >
          <div className="-mx-1 min-h-0 space-y-5 overflow-y-auto px-1 pb-1">
            <div className="space-y-3">
              <Field label="Source">
                <Select
                  value={connectionId}
                  disabled={sync !== null}
                  onValueChange={(value) => {
                    if (!value || value === connectionId) return
                    setConnectionId(value)
                    setRepository("")
                    setBranch("")
                    setSourcePath("")
                  }}
                >
                  <SelectTrigger className="h-10 w-full">
                    <SelectValue placeholder="Choose a source" />
                  </SelectTrigger>
                  <SelectContent>
                    {usable.map((item) => (
                      <SelectItem key={item.id} value={item.id}>
                        {/* One account can back several sources; their apps
                            tell them apart. */}
                        <span className="flex min-w-0 items-center gap-2">
                          <SourceAccount source={item} showType={false} />
                          <span className="type-meta truncate font-mono text-muted-foreground">
                            {item.appName}
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
                    value={repository}
                    onChange={selectRepository}
                  />
                </Field>
                <Field label="Branch">
                  <Select
                    value={branch}
                    disabled={!repository || branches.isPending}
                    onValueChange={(value) => {
                      // Radix reports "" while the options re-render, which
                      // would drop the default branch.
                      if (!value || value === branch) return
                      setBranch(value)
                      setSourcePath("")
                    }}
                  >
                    <SelectTrigger className="w-full font-mono">
                      <SelectValue
                        placeholder={
                          repository && branches.isPending
                            ? "Loading…"
                            : "Branch"
                        }
                      />
                    </SelectTrigger>
                    <SelectContent>
                      {(branches.data ?? (branch ? [branch] : [])).map(
                        (item) => (
                          <SelectItem
                            key={item}
                            value={item}
                            className="font-mono"
                          >
                            {item}
                          </SelectItem>
                        )
                      )}
                    </SelectContent>
                  </Select>
                </Field>
              </div>
              <Field
                label="Repository folder"
                hint={
                  folderFiles === undefined
                    ? undefined
                    : `${folderFiles} ${folderFiles === 1 ? "file" : "files"}`
                }
              >
                <FolderPicker
                  disabled={!branch}
                  error={folders.error}
                  folders={folders.data?.folders ?? []}
                  loading={folders.isFetching}
                  value={sourcePath}
                  onChange={setSourcePath}
                />
              </Field>
              <Field
                label="Only these files"
                hint="Optional, one pattern per line"
              >
                <Textarea
                  value={patterns}
                  rows={3}
                  spellCheck={false}
                  className="min-h-0 font-mono text-xs"
                  placeholder={"server.properties\n*.yml\nplugins/**"}
                  onChange={(event) => setPatterns(event.currentTarget.value)}
                />
              </Field>
            </div>

            <Separator />

            <div className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                <Field label="Instance">
                  <TargetPicker
                    disabled={sync !== null}
                    targets={targets}
                    value={target}
                    onChange={setTarget}
                  />
                </Field>
                <Field
                  label="Destination folder"
                  hint="Relative to its Files tab"
                >
                  <div className="relative">
                    <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 font-mono text-xs text-muted-foreground">
                      /
                    </span>
                    <Input
                      value={targetPath}
                      placeholder="Top level"
                      spellCheck={false}
                      autoComplete="off"
                      className="pl-6 font-mono"
                      onChange={(event) =>
                        setTargetPath(event.currentTarget.value)
                      }
                    />
                  </div>
                </Field>
              </div>
            </div>

            <Separator />

            <div className="grid gap-3 sm:grid-cols-2">
              <SwitchRow
                checked={autoSync}
                info="Syncs again whenever the branch gets a new commit."
                label="Sync automatically"
                onCheckedChange={setAutoSync}
              />
              <SwitchRow
                checked={overwrite}
                info="Replaces files already on the instance, even ones edited there. Off keeps them."
                label="Replace existing files"
                onCheckedChange={setOverwrite}
              />
            </div>

            {save.error ? <DialogError error={save.error} /> : null}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={save.isPending}
              onClick={onClose}
            >
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={!canSave}>
              {save.isPending ? (
                <LoaderCircle className="animate-spin" />
              ) : (
                <Check />
              )}
              {sync ? "Save and sync" : "Create and sync"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function RepositoryPicker({
  error,
  loading,
  manageUrl,
  repositories,
  value,
  onChange,
}: {
  error: Error | null
  loading: boolean
  manageUrl: string | null
  repositories: ReadonlyArray<{
    fullName: string
    id: number
    private: boolean
  }>
  value: string
  onChange: (repository: string) => void
}) {
  const [open, setOpen] = React.useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="w-full justify-between gap-2 px-3 font-normal"
        >
          <span className="flex min-w-0 items-center gap-2">
            <GitHubMark className="size-3.5 text-muted-foreground" />
            <span className={cn("truncate", !value && "text-muted-foreground")}>
              {value ||
                (loading ? "Loading repositories…" : "Choose a repository")}
            </span>
          </span>
          <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="z-[70] w-[min(28rem,calc(100vw-2rem))] p-1.5"
      >
        <Command>
          <CommandInput placeholder="Search repositories…" />
          <CommandList aria-label="Repositories">
            {repositories.map((repository) => (
              <CommandItem
                key={repository.id}
                value={repository.fullName}
                onSelect={() => {
                  onChange(repository.fullName)
                  setOpen(false)
                }}
              >
                <span className="min-w-0 flex-1 truncate">
                  {repository.fullName}
                </span>
                {repository.private ? (
                  <Lock className="size-3 text-muted-foreground" />
                ) : null}
                {repository.fullName === value ? <Check /> : null}
              </CommandItem>
            ))}
            <CommandEmpty>
              {loading
                ? "Loading repositories…"
                : error
                  ? error.message
                  : "No repositories found."}
            </CommandEmpty>
          </CommandList>
          {manageUrl ? (
            <p className="type-support border-t px-2 pt-2 pb-1 text-muted-foreground">
              Missing one?{" "}
              <a
                href={manageUrl}
                target="_blank"
                rel="noreferrer"
                className="text-primary hover:underline"
              >
                Give the app access on GitHub
              </a>
            </p>
          ) : null}
        </Command>
      </PopoverContent>
    </Popover>
  )
}

function FolderPicker({
  disabled,
  error,
  folders,
  loading,
  value,
  onChange,
}: {
  disabled: boolean
  error: Error | null
  folders: ReadonlyArray<{ files: number; path: string }>
  loading: boolean
  value: string
  onChange: (path: string) => void
}) {
  const [open, setOpen] = React.useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className="w-full justify-between gap-2 px-3 font-normal"
        >
          <span className="flex min-w-0 items-center gap-2">
            {value ? (
              <Folder className="size-3.5 text-muted-foreground" />
            ) : (
              <FolderRoot className="size-3.5 text-muted-foreground" />
            )}
            <span className="truncate font-mono">
              {value ? `/${value}` : "/ (repository root)"}
            </span>
          </span>
          {loading ? (
            <LoaderCircle className="size-4 shrink-0 animate-spin text-muted-foreground" />
          ) : (
            <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="z-[70] w-[min(36rem,calc(100vw-2rem))] p-1.5"
      >
        <Command>
          <CommandInput placeholder="Search folders…" />
          <CommandList aria-label="Folders">
            {folders.map((folder) => (
              <CommandItem
                key={folder.path}
                value={folder.path || "/"}
                onSelect={() => {
                  onChange(folder.path)
                  setOpen(false)
                }}
              >
                {folder.path ? <Folder /> : <FolderRoot />}
                <span className="min-w-0 flex-1 truncate font-mono text-xs">
                  /{folder.path}
                </span>
                <span className="type-code text-muted-foreground">
                  {folder.files}
                </span>
                {folder.path === value ? <Check /> : null}
              </CommandItem>
            ))}
            <CommandEmpty>
              {loading
                ? "Reading the branch…"
                : error
                  ? error.message
                  : "No folders found."}
            </CommandEmpty>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

function TargetPicker({
  disabled,
  targets,
  value,
  onChange,
}: {
  disabled: boolean
  targets: ReadonlyArray<GitHubSyncTarget>
  value: GitHubSyncTarget | null
  onChange: (target: GitHubSyncTarget) => void
}) {
  const [open, setOpen] = React.useState(false)
  const items = React.useMemo(
    () =>
      targets.map((target): InstancePickerItem => ({
        identity:
          target.kind === "relay"
            ? {
                id: target.id,
                kind: "relay",
                relayId: target.relayId,
                source: "fleet",
              }
            : { id: target.id, kind: target.kind, relayId: target.relayId },
        key: targetKey(target),
        meta:
          target.kind === "relay"
            ? "Host files"
            : `${target.relayName} · ${target.id.slice(0, 8)}`,
        name: target.name,
        searchText: `${targetKindLabel[target.kind]} ${target.relayName} ${target.id}`,
      })),
    [targets]
  )
  const selectedKeys = React.useMemo(
    () => new Set(value ? [targetKey(value)] : []),
    [value]
  )
  const TargetIcon = value ? targetIcon[value.kind] : Layers
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className="w-full justify-between gap-2 px-3 font-normal"
        >
          <span className="flex min-w-0 items-center gap-2">
            <TargetIcon className="size-3.5 text-muted-foreground" />
            <span className={cn("truncate", !value && "text-muted-foreground")}>
              {value?.name ?? "Choose an instance"}
            </span>
          </span>
          <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="z-[70] w-[min(34rem,calc(100vw-2rem))] overflow-hidden p-0"
      >
        <InstancePickerContent
          ariaLabel="Instances"
          emptyMessage="No instances you can edit files on."
          items={items}
          selectedKeys={selectedKeys}
          onSelect={(item) => {
            const target = targets.find(
              (candidate) => targetKey(candidate) === item.key
            )
            if (target) onChange(target)
            setOpen(false)
          }}
        />
      </PopoverContent>
    </Popover>
  )
}

export function DeleteSyncDialog({
  sync,
  onClose,
}: {
  sync: GitHubSyncView
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const remove = useMutation({
    mutationFn: () => deleteGitHubSync({ data: { id: sync.id } }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.github.overview }),
        queryClient.invalidateQueries({ queryKey: queryKeys.github.sources }),
      ])
      showToast({ message: "Sync deleted", type: "success" })
      onClose()
    },
  })
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && !remove.isPending && onClose()}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Delete this sync?</DialogTitle>
          <DialogDescription>
            {sync.target.name} stops following{" "}
            <span className="font-mono">
              {sync.repository}
              {sync.sourcePath ? `/${sync.sourcePath}` : ""}
            </span>
            . Files already synced stay on it.
          </DialogDescription>
        </DialogHeader>
        {remove.error ? <DialogError error={remove.error} /> : null}
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={remove.isPending}
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            size="sm"
            disabled={remove.isPending}
            onClick={() => remove.mutate()}
          >
            {remove.isPending ? (
              <LoaderCircle className="animate-spin" />
            ) : (
              <Trash2 />
            )}
            Delete sync
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function SwitchRow({
  checked,
  info,
  label,
  onCheckedChange,
}: {
  checked: boolean
  info: string
  label: string
  onCheckedChange: (checked: boolean) => void
}) {
  return (
    <label className="flex items-center justify-between gap-3 rounded-lg border p-3">
      <span className="flex min-w-0 items-center gap-1.5">
        <span className="truncate text-xs font-medium">{label}</span>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={`About ${label.toLowerCase()}`}
              className="shrink-0 text-muted-foreground hover:text-foreground"
              // Inside the label, a click would flip the switch.
              onClick={(event) => event.preventDefault()}
            >
              <Info className="size-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top" className="max-w-60">
            {info}
          </TooltipContent>
        </Tooltip>
      </span>
      <Switch checked={checked} onCheckedChange={onCheckedChange} />
    </label>
  )
}

function Field({
  children,
  hint,
  label,
}: {
  children: React.ReactNode
  hint?: string
  label: string
}) {
  return (
    <label className="block min-w-0">
      <span className="mb-1.5 flex items-center justify-between gap-3 text-xs font-medium">
        {label}
        {hint ? (
          <span className="font-normal text-muted-foreground">{hint}</span>
        ) : null}
      </span>
      {children}
    </label>
  )
}

function DialogError({ error }: { error: Error }) {
  return (
    <p role="alert" className="text-xs text-destructive">
      {error.message}
    </p>
  )
}

const targetKindLabel = {
  app: "App",
  relay: "Relay",
  server: "Game Server",
} as const satisfies Record<GitHubSyncTarget["kind"], string>

const targetIcon = {
  app: AppKindIcon,
  relay: RelayKindIcon,
  server: ServerKindIcon,
} as const satisfies Record<GitHubSyncTarget["kind"], typeof ServerKindIcon>

function targetKey(target: Pick<GitHubSyncTarget, "id" | "kind" | "relayId">) {
  return `${target.kind}:${target.relayId}:${target.id}`
}
