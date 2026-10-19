import * as React from "react"
import {
  useMutation,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query"
import { ArrowRight, Building2, LoaderCircle, Trash2, User } from "lucide-react"

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

import { GitHubMark } from "@/components/github-mark"
import { queryKeys } from "@/lib/query-options"
import {
  deleteGitHubConnection,
  startGitHubConnection,
} from "@/server/github-sync"
import type { GitHubConnectionView } from "@/server/github-sync.server"

export function AddSourceDialog({ onClose }: { onClose: () => void }) {
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
  // Stays busy while the browser leaves for GitHub.
  const leaving = start.isPending || start.isSuccess

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!canSubmit || leaving) return
    start.mutate(undefined, {
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

/** Sources and the syncs that count them change together. */
export function invalidateSources(queryClient: QueryClient) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: queryKeys.github.sources }),
    queryClient.invalidateQueries({ queryKey: queryKeys.github.overview }),
  ])
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
