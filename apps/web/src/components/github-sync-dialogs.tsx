import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  ArrowRight,
  Boxes,
  Building2,
  Check,
  ChevronDown,
  Folder,
  FolderRoot,
  Info,
  LoaderCircle,
  Lock,
  Server,
  Trash2,
  User,
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
import { Switch } from "@workspace/ui/components/switch"
import { Textarea } from "@workspace/ui/components/textarea"
import { cn } from "@workspace/ui/lib/utils"

import { GitHubMark } from "@/components/github-mark"
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
import {
  deleteGitHubConnection,
  deleteGitHubSync,
  saveGitHubSync,
  startGitHubConnection,
} from "@/server/github-sync"
import type {
  GitHubConnectionView,
  GitHubSyncTarget,
  GitHubSyncView,
} from "@/server/github-sync.server"

export function ConnectGitHubDialog({
  hearthUrl,
  webhooksReachable,
  onClose,
}: {
  hearthUrl: string
  webhooksReachable: boolean
  onClose: () => void
}) {
  const [account, setAccount] = React.useState<"organization" | "user">("user")
  const [organization, setOrganization] = React.useState("")
  const [name, setName] = React.useState(() => defaultAppName(hearthUrl))
  const start = useMutation({
    mutationFn: () =>
      startGitHubConnection({
        data: {
          account,
          name,
          organization: account === "organization" ? organization : undefined,
        },
      }),
    // GitHub creates an app from a manifest the browser posts to it.
    onSuccess: (result) => {
      const form = document.createElement("form")
      form.method = "post"
      form.action = result.action
      const field = document.createElement("input")
      field.type = "hidden"
      field.name = "manifest"
      field.value = result.manifest
      form.append(field)
      document.body.append(form)
      form.submit()
    },
  })
  const nameValid = name.trim().length >= 3 && name.trim().length <= 34
  const canSubmit =
    nameValid &&
    (account === "user" || /^[A-Za-z0-9-]{1,39}$/u.test(organization.trim()))
  // Stays busy while the browser leaves for GitHub.
  const leaving = start.isPending || start.isSuccess

  return (
    <Dialog open onOpenChange={(open) => !open && !leaving && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitHubMark />
            Connect GitHub
          </DialogTitle>
          <DialogDescription>
            Kiln creates a private GitHub App with the access it needs. You
            install it and choose which repositories it can read.
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-5"
          action={() => {
            if (canSubmit && !leaving) start.mutate()
          }}
        >
          <fieldset className="grid gap-2">
            <legend className="mb-1.5 text-xs font-medium">
              Where are your repositories?
            </legend>
            <div className="grid grid-cols-2 gap-2">
              <AccountOption
                checked={account === "user"}
                description="Your own repositories"
                icon={User}
                label="Personal account"
                onSelect={() => setAccount("user")}
              />
              <AccountOption
                checked={account === "organization"}
                description="Needs an org owner"
                icon={Building2}
                label="Organization"
                onSelect={() => setAccount("organization")}
              />
            </div>
            {account === "organization" ? (
              <Field label="Organization" hint="As in github.com/name">
                <Input
                  autoFocus
                  value={organization}
                  placeholder="my-org"
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) =>
                    setOrganization(event.currentTarget.value)
                  }
                />
              </Field>
            ) : null}
          </fieldset>
          <Field label="App name" hint="Unique on GitHub">
            <Input
              value={name}
              maxLength={34}
              autoComplete="off"
              onChange={(event) => setName(event.currentTarget.value)}
            />
          </Field>
          <dl className="grid gap-2 rounded-lg border bg-muted/30 p-3 text-xs">
            <div className="flex gap-2">
              <dt className="w-24 shrink-0 text-muted-foreground">Access</dt>
              <dd>
                Repository contents and metadata. Kiln only reads them for now;
                write access is there for saving edits back later.
              </dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-24 shrink-0 text-muted-foreground">Updates</dt>
              <dd>
                {webhooksReachable ? (
                  "GitHub tells Kiln about every push."
                ) : (
                  <>
                    GitHub can't reach{" "}
                    <span className="font-mono">{new URL(hearthUrl).host}</span>
                    , so Kiln checks for new commits every minute.
                  </>
                )}
              </dd>
            </div>
          </dl>
          {start.error ? <DialogError error={start.error} /> : null}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={leaving}
              onClick={onClose}
            >
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={!canSubmit || leaving}>
              {leaving ? (
                <LoaderCircle className="animate-spin" />
              ) : (
                <GitHubMark />
              )}
              Continue to GitHub
              <ArrowRight />
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function AccountOption({
  checked,
  description,
  icon: Icon,
  label,
  onSelect,
}: {
  checked: boolean
  description: string
  icon: typeof User
  label: string
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      className={cn(
        "flex items-start gap-2.5 rounded-lg border p-3 text-left transition-colors",
        checked
          ? "border-primary bg-primary/10"
          : "hover:border-foreground/25 hover:bg-accent/30"
      )}
      onClick={onSelect}
    >
      <Icon
        className={cn(
          "mt-0.5 size-4 shrink-0",
          checked ? "text-primary" : "text-muted-foreground"
        )}
      />
      <span className="min-w-0">
        <span className="block text-xs font-semibold">{label}</span>
        <span className="type-support block text-muted-foreground">
          {description}
        </span>
      </span>
    </button>
  )
}

export function GitHubSyncEditorDialog({
  connections,
  initialTarget,
  sync,
  targets,
  onClose,
}: {
  connections: ReadonlyArray<GitHubConnectionView>
  initialTarget: GitHubSyncTarget | null
  sync: GitHubSyncView | null
  targets: ReadonlyArray<GitHubSyncTarget>
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const usable = React.useMemo(
    () =>
      connections.filter(
        (connection) =>
          connection.installation && !connection.installation.suspended
      ),
    [connections]
  )
  const [target, setTarget] = React.useState<GitHubSyncTarget | null>(
    sync?.target ?? initialTarget
  )
  const [connectionId, setConnectionId] = React.useState(
    sync?.connectionId ?? usable[0]?.id ?? ""
  )
  const [repository, setRepository] = React.useState(sync?.repository ?? "")
  const [branch, setBranch] = React.useState(sync?.branch ?? "")
  const [sourcePath, setSourcePath] = React.useState(sync?.sourcePath ?? "")
  const [targetPath, setTargetPath] = React.useState(sync?.targetPath ?? "")
  const [patterns, setPatterns] = React.useState(
    sync?.includePatterns.join("\n") ?? ""
  )
  const [autoSync, setAutoSync] = React.useState(sync?.autoSync ?? true)
  const [afterSync, setAfterSync] = React.useState<"none" | "restart">(
    sync?.afterSync ?? "none"
  )
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
          afterSync: target?.kind === "server" ? afterSync : "none",
          autoSync,
          branch,
          connectionId,
          id: sync?.id,
          includePatterns,
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
      await queryClient.invalidateQueries({
        queryKey: queryKeys.github.overview,
      })
      showToast({
        message: sync ? "Sync saved; syncing now" : "Sync added; syncing now",
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
          <DialogTitle>{sync ? "Edit sync" : "Add sync"}</DialogTitle>
          <DialogDescription>
            Copy files from a repository folder into a game server or app. Files
            with the same name are replaced; others are left alone.
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid min-h-0 grid-rows-[minmax(0,1fr)_auto] gap-4"
          action={() => {
            if (canSave) save.mutate()
          }}
        >
          <div className="-mx-1 min-h-0 space-y-5 overflow-y-auto px-1 pb-1">
            <EditorSection step={1} title="From GitHub">
              {usable.length > 1 || (sync && !connection) ? (
                <Field label="Account">
                  <Select
                    value={connectionId}
                    disabled={sync !== null}
                    onValueChange={(value) => {
                      setConnectionId(value)
                      setRepository("")
                      setBranch("")
                      setSourcePath("")
                    }}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="Choose an account" />
                    </SelectTrigger>
                    <SelectContent>
                      {usable.map((item) => (
                        <SelectItem key={item.id} value={item.id}>
                          {item.installation?.accountLogin ?? item.appName}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
              ) : null}
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
                label="Folder"
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
            </EditorSection>

            <EditorSection step={2} title="Into">
              <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                <Field
                  label={sync ? "Game server or app" : "Game server or app"}
                >
                  <TargetPicker
                    disabled={sync !== null}
                    targets={targets}
                    value={target}
                    onChange={(next) => {
                      setTarget(next)
                      if (next.kind !== "server") setAfterSync("none")
                    }}
                  />
                </Field>
                <Field label="Folder" hint="Created if missing">
                  <div className="relative">
                    <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 font-mono text-xs text-muted-foreground">
                      /
                    </span>
                    <Input
                      value={targetPath}
                      placeholder="Root folder"
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
            </EditorSection>

            <EditorSection step={3} title="When">
              <label className="flex items-start justify-between gap-4 rounded-lg border p-3">
                <span className="min-w-0">
                  <span className="block text-xs font-medium">
                    Sync automatically
                  </span>
                  <span className="type-support block text-muted-foreground">
                    {connection?.webhookActive === false
                      ? "Kiln checks the branch for new commits every minute."
                      : "Every push to the branch syncs the changed files."}
                  </span>
                </span>
                <Switch checked={autoSync} onCheckedChange={setAutoSync} />
              </label>
              {target?.kind === "server" ? (
                <Field label="After files change">
                  <Select
                    value={afterSync}
                    onValueChange={(value) =>
                      setAfterSync(value === "restart" ? "restart" : "none")
                    }
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">
                        Do nothing; changes apply on the next restart
                      </SelectItem>
                      <SelectItem value="restart">
                        Restart the game server if it's running
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
              ) : null}
            </EditorSection>

            {repository && target ? (
              <p className="flex items-start gap-2 rounded-lg border border-primary/25 bg-primary/5 p-3 text-xs">
                <Info className="mt-0.5 size-3.5 shrink-0 text-primary" />
                <span>
                  {includePatterns.length > 0 ? "Matching files" : "Every file"}{" "}
                  in{" "}
                  <span className="font-mono">
                    {repository}/{sourcePath}
                  </span>{" "}
                  on <span className="font-mono">{branch || "…"}</span> will be
                  copied to <span className="font-semibold">{target.name}</span>{" "}
                  at{" "}
                  <span className="font-mono">
                    /{targetPath.replace(/^\/+/u, "")}
                  </span>
                  {autoSync ? ", and again whenever it changes." : "."}
                </span>
              </p>
            ) : null}
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
              {sync ? "Save and sync" : "Add and sync"}
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
        identity: { id: target.id, kind: target.kind, relayId: target.relayId },
        key: targetKey(target),
        meta: `${target.relayName} · ${target.id.slice(0, 8)}`,
        name: target.name,
        searchText: `${target.kind === "app" ? "App" : "Game Server"} ${target.relayName} ${target.id}`,
      })),
    [targets]
  )
  const selectedKeys = React.useMemo(
    () => new Set(value ? [targetKey(value)] : []),
    [value]
  )
  const TargetIcon = value?.kind === "app" ? Boxes : Server
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
              {value?.name ?? "Choose a game server or app"}
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
          ariaLabel="Game servers and apps"
          emptyMessage="No game servers or apps you can edit files on."
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

export function RemoveConnectionDialog({
  connection,
  onClose,
}: {
  connection: GitHubConnectionView
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const [uninstall, setUninstall] = React.useState(true)
  const remove = useMutation({
    mutationFn: () =>
      deleteGitHubConnection({
        data: {
          id: connection.id,
          uninstall: uninstall && !!connection.installation,
        },
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: queryKeys.github.overview,
      })
      showToast({ message: "GitHub disconnected", type: "success" })
      onClose()
    },
  })
  const account = connection.installation?.accountLogin ?? connection.appName

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && !remove.isPending && onClose()}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Disconnect {account}?</DialogTitle>
          <DialogDescription>
            {connection.syncCount > 0
              ? `Its ${connection.syncCount} ${connection.syncCount === 1 ? "sync stops and is deleted" : "syncs stop and are deleted"}. `
              : ""}
            Files already synced stay where they are.
          </DialogDescription>
        </DialogHeader>
        {connection.installation ? (
          <label className="flex items-start justify-between gap-4 rounded-lg border p-3">
            <span className="min-w-0">
              <span className="block text-xs font-medium">
                Uninstall from {connection.installation.accountLogin}
              </span>
              <span className="type-support block text-muted-foreground">
                The app keeps its GitHub page;{" "}
                <a
                  href={connection.appUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-primary hover:underline"
                >
                  delete it there
                </a>{" "}
                if you won't reconnect.
              </span>
            </span>
            <Switch checked={uninstall} onCheckedChange={setUninstall} />
          </label>
        ) : null}
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
            Disconnect
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
      await queryClient.invalidateQueries({
        queryKey: queryKeys.github.overview,
      })
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

function EditorSection({
  children,
  step,
  title,
}: {
  children: React.ReactNode
  step: number
  title: string
}) {
  return (
    <section>
      <h3 className="flex items-center gap-2 text-xs font-semibold">
        <span className="type-code grid size-5 place-items-center rounded-full border bg-background text-muted-foreground">
          {step}
        </span>
        {title}
      </h3>
      <div className="mt-2.5 space-y-3">{children}</div>
    </section>
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

function targetKey(target: Pick<GitHubSyncTarget, "id" | "kind" | "relayId">) {
  return `${target.kind}:${target.relayId}:${target.id}`
}

function defaultAppName(hearthUrl: string) {
  const host = new URL(hearthUrl).hostname.split(".")[0] ?? "hearth"
  return `Kiln ${host}`.slice(0, 34)
}
