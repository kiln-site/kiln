import * as React from "react"
import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query"
import {
  ArrowRight,
  Building2,
  ExternalLink,
  ImageUp,
  LoaderCircle,
  RefreshCw,
  Trash2,
  User,
} from "lucide-react"

import { Badge } from "@workspace/ui/components/badge"
import { Button } from "@workspace/ui/components/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@workspace/ui/components/dialog"
import { Input } from "@workspace/ui/components/input"
import { showToast } from "@workspace/ui/components/sonner"
import { cn } from "@workspace/ui/lib/utils"

import kilnAppIcon from "@/assets/branding/app-icon-512.png"
import { GitHubMark } from "@/components/github-mark"
import { SourceAccount } from "@/components/source-account"
import {
  githubSourceRepositoryCountQueryOptions,
  queryKeys,
} from "@/lib/query-options"
import {
  deleteGitHubConnection,
  refreshGitHubConnection,
  startGitHubConnection,
} from "@/server/github-sync"
import type { GitHubConnectionView } from "@/server/github-sync.server"

export function AddSourceDialog({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient()
  const [account, setAccount] = React.useState<"organization" | "user">("user")
  const [organization, setOrganization] = React.useState("")
  const [name, setName] = React.useState(randomAppName)
  const start = useMutation({
    mutationFn: () =>
      startGitHubConnection({
        data: {
          account,
          name,
          organization: account === "organization" ? organization : undefined,
        },
      }),
  })
  const nameValid = name.trim().length >= 3 && name.trim().length <= 34
  const canSubmit =
    nameValid &&
    (account === "user" || /^[A-Za-z0-9-]{1,39}$/u.test(organization.trim()))
  // Stays busy while this tab leaves for GitHub.
  const leaving = start.isPending || start.isSuccess

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!canSubmit || leaving) return
    // GitHub continues in a new tab. It opens during the click, as popup
    // blockers require, and the manifest is posted into it once Hearth has
    // signed it. A blocked tab falls back to this one.
    const tab = window.open("about:blank", githubSetupTab)
    if (tab) tab.opener = null
    start.mutate(undefined, {
      onError: () => tab?.close(),
      // GitHub creates an app from a manifest the browser posts to it.
      onSuccess: (result) => {
        const form = document.createElement("form")
        form.method = "post"
        form.action = result.action
        form.target = tab ? githubSetupTab : "_self"
        const field = document.createElement("input")
        field.type = "hidden"
        field.name = "manifest"
        field.value = result.manifest
        form.append(field)
        document.body.append(form)
        form.submit()
        form.remove()
        if (!tab) return
        // Setup lands on Sources in that tab; this one refreshes as the
        // source appears.
        showToast({
          message: "Finish adding the source on GitHub",
          type: "info",
        })
        void invalidateSources(queryClient)
        onClose()
      },
    })
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !leaving && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add Source</DialogTitle>
          <DialogDescription className="sr-only">
            Connect an account Kiln reads repositories from.
          </DialogDescription>
        </DialogHeader>
        <form className="grid gap-5" onSubmit={submit}>
          <fieldset className="grid gap-2">
            <legend className="mb-1.5 text-xs font-medium">Provider</legend>
            <div className="grid grid-cols-2 gap-2">
              <ChoiceCard
                checked
                description="A private GitHub App"
                icon={<GitHubMark className="size-4" />}
                label="GitHub"
                onSelect={() => undefined}
              />
            </div>
          </fieldset>
          <fieldset className="grid gap-2">
            <legend className="mb-1.5 text-xs font-medium">
              Where are your repositories?
            </legend>
            <div className="grid grid-cols-2 gap-2">
              <ChoiceCard
                checked={account === "user"}
                description="Your own repositories"
                icon={<User className="size-4" />}
                label="Personal account"
                onSelect={() => setAccount("user")}
              />
              <ChoiceCard
                checked={account === "organization"}
                description="Needs an org owner"
                icon={<Building2 className="size-4" />}
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

/** What Kiln knows about a source, and the changes made on GitHub. */
export function ConfigureSourceDialog({
  hearthUrl,
  source,
  onClose,
}: {
  hearthUrl: string
  source: GitHubConnectionView
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const installation = source.installation
  const repositoryCount = useQuery({
    ...githubSourceRepositoryCountQueryOptions(source.id),
    enabled: installation !== null && !installation.suspended,
  })
  const refresh = useMutation({
    mutationFn: () => refreshGitHubConnection({ data: { id: source.id } }),
    onSuccess: async (result) => {
      await invalidateSources(queryClient)
      showToast({
        message: result.installed
          ? "Source is up to date"
          : "The app isn't installed on an account yet",
        type: result.installed ? "success" : "warning",
      })
    },
    onError: (cause) =>
      showToast({
        message:
          cause instanceof Error ? cause.message : "GitHub couldn't be reached",
        type: "error",
      }),
  })

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Configure source</DialogTitle>
          <DialogDescription>
            Repository access and the app itself are managed on GitHub; Kiln
            picks up the changes.
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-3 rounded-lg border p-3">
          <SourceAccount source={source} className="flex-1" />
          <Badge variant="outline" className="shrink-0 gap-1.5">
            <GitHubMark className="size-3" />
            GitHub
          </Badge>
        </div>
        <dl className="grid gap-3 text-xs">
          <FactRow
            label="Repositories"
            action={
              installation ? (
                <ExternalButton href={source.manageUrl ?? source.appUrl}>
                  Change
                </ExternalButton>
              ) : (
                <Button asChild size="xs">
                  <a href={source.installUrl}>
                    <GitHubMark /> Install
                  </a>
                </Button>
              )
            }
          >
            {!installation
              ? "Install the app on an account to choose repositories."
              : installation.suspended
                ? "Suspended on GitHub; syncs from it stop until it's resumed."
                : repositoryAccess(
                    installation.repositorySelection,
                    repositoryCount.data
                  )}
          </FactRow>
          <FactRow label="Updates">
            <UpdatesDescription
              hearthUrl={hearthUrl}
              webhooks={source.webhookActive}
            />
          </FactRow>
          <FactRow
            label="GitHub App"
            action={
              <ExternalButton href={source.settingsUrl}>
                Settings
              </ExternalButton>
            }
          >
            <span className="font-medium">{source.appName}</span>
            <span className="block text-muted-foreground">
              Can read and write contents, and read metadata.
            </span>
          </FactRow>
          <FactRow
            label="Logo"
            action={
              <Button
                type="button"
                size="xs"
                variant="outline"
                onClick={() => openKilnLogoUpload(source)}
              >
                <ImageUp /> Use Kiln's
              </Button>
            }
          >
            GitHub only takes an app's logo on its settings page.
          </FactRow>
          {source.ownerName ? (
            <FactRow label="Added by">{source.ownerName}</FactRow>
          ) : null}
        </dl>
        <DialogFooter className="sm:justify-between">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={refresh.isPending}
            onClick={() => refresh.mutate()}
          >
            <RefreshCw className={refresh.isPending ? "animate-spin" : ""} />
            Check on GitHub
          </Button>
          <Button type="button" size="sm" onClick={onClose}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function DeleteSourceDialog({
  source,
  onClose,
}: {
  source: GitHubConnectionView
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const remove = useMutation({
    mutationFn: () => deleteGitHubConnection({ data: { id: source.id } }),
    onSuccess: async () => {
      await invalidateSources(queryClient)
      showToast({ message: "Source deleted", type: "success" })
      onClose()
    },
  })
  const account = source.installation?.accountLogin ?? source.appName

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && !remove.isPending && onClose()}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Delete source</DialogTitle>
          <DialogDescription>
            Kiln {source.installation ? "uninstalls its app from" : "forgets"}{" "}
            {account}
            {source.syncCount > 0
              ? ` and deletes ${source.syncCount} ${source.syncCount === 1 ? "sync" : "syncs"}`
              : ""}
            . Files already synced stay where they are.
          </DialogDescription>
        </DialogHeader>
        {remove.error ? <DialogError error={remove.error} /> : null}
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={remove.isPending}
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={remove.isPending}
            onClick={() => remove.mutate()}
          >
            {remove.isPending ? (
              <LoaderCircle className="animate-spin" />
            ) : (
              <Trash2 />
            )}
            Delete source
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function repositoryAccess(
  selection: "all" | "selected",
  count: number | undefined
) {
  if (count === undefined) {
    return selection === "all" ? "All repositories" : "Selected repositories"
  }
  const noun = count === 1 ? "repository" : "repositories"
  return selection === "all"
    ? `All ${count} ${noun}`
    : `${count} selected ${noun}`
}

/** Sources and the syncs that count them change together. */
export function invalidateSources(queryClient: QueryClient) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: queryKeys.github.sources }),
    queryClient.invalidateQueries({ queryKey: queryKeys.github.overview }),
  ])
}

// GitHub has no API for an app's logo, so download Kiln's and open the
// settings page where it's uploaded.
function openKilnLogoUpload(source: GitHubConnectionView) {
  const link = document.createElement("a")
  link.href = kilnAppIcon
  link.download = "kiln-logo.png"
  link.click()
  window.open(source.settingsUrl, "_blank", "noreferrer")
  showToast({
    duration: 10_000,
    message: "Upload kiln-logo.png under Display information on GitHub",
    type: "info",
  })
}

function UpdatesDescription({
  hearthUrl,
  webhooks,
}: {
  hearthUrl: string
  webhooks: boolean
}) {
  return webhooks ? (
    "GitHub tells Kiln about every push."
  ) : (
    <>
      GitHub can't reach{" "}
      <span className="font-mono">{new URL(hearthUrl).host}</span>, so Kiln
      checks for new commits every minute.
    </>
  )
}

function ChoiceCard({
  checked,
  description,
  icon,
  label,
  onSelect,
}: {
  checked: boolean
  description: string
  icon: React.ReactNode
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
      <span
        className={cn(
          "mt-0.5 shrink-0",
          checked ? "text-primary" : "text-muted-foreground"
        )}
      >
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block text-xs font-semibold">{label}</span>
        <span className="type-support block text-muted-foreground">
          {description}
        </span>
      </span>
    </button>
  )
}

function FactRow({
  action,
  children,
  label,
}: {
  action?: React.ReactNode
  children: React.ReactNode
  label: string
}) {
  return (
    <div className="flex items-start gap-3">
      <dt className="w-24 shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 flex-1">{children}</dd>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  )
}

function ExternalButton({
  children,
  href,
}: {
  children: React.ReactNode
  href: string
}) {
  return (
    <Button asChild size="xs" variant="outline">
      <a href={href} target="_blank" rel="noreferrer">
        {children}
        <ExternalLink />
      </a>
    </Button>
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

const githubSetupTab = "kiln-github-setup"

// Short words for a default app name, `kiln-<adjective>-<noun>`. App names
// are unique across GitHub, so a random pair rarely collides.
const appNameAdjectives = [
  "amber",
  "ashen",
  "brave",
  "bright",
  "cobalt",
  "coral",
  "dusky",
  "ember",
  "fabled",
  "frosty",
  "golden",
  "hidden",
  "lucky",
  "lunar",
  "mellow",
  "misty",
  "molten",
  "quiet",
  "rapid",
  "rustic",
  "silver",
  "smoky",
  "solar",
  "stormy",
  "sunny",
  "swift",
  "velvet",
  "wild",
] as const
const appNameNouns = [
  "anvil",
  "beacon",
  "brick",
  "cinder",
  "cobble",
  "comet",
  "crater",
  "falcon",
  "flint",
  "forge",
  "glaze",
  "harbor",
  "hearth",
  "ingot",
  "kettle",
  "lantern",
  "marble",
  "pebble",
  "quartz",
  "raven",
  "spark",
  "summit",
  "tinder",
  "torch",
  "willow",
  "wren",
] as const

function randomAppName() {
  const [adjective = 0, noun = 0] = crypto.getRandomValues(new Uint32Array(2))
  return `kiln-${appNameAdjectives[adjective % appNameAdjectives.length]}-${
    appNameNouns[noun % appNameNouns.length]
  }`
}
