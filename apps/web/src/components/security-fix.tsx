import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { ArrowRight, LoaderCircle, RefreshCw } from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@workspace/ui/components/select"
import { showToast } from "@workspace/ui/components/sonner"
import { cn } from "@workspace/ui/lib/utils"

import { parseImageReference, type ImageTagSuggestion } from "@/lib/image-tags"
import type { SecurityFix, SecurityItem, SecurityUse } from "@/lib/security"
import {
  securityImageVersionsQueryOptions,
  securityQueryKeys,
} from "@/lib/security-queries"
import { deployAppImageUpdate } from "@/server/app-image-updates"
import { deployApp, updateAppConfig } from "@/server/apps"

/** What a row's button says it leads to. */
export function securityFixLabel(fix: SecurityFix): string {
  switch (fix.kind) {
    case "deploy-update":
      return "Update"
    case "change-version":
      return "Update version"
    case "kiln-update":
      return "Update Kiln"
    case "host-packages":
    case "rebuild":
    case "database":
    case "game-server":
      return "How to fix"
  }
}

/** The dialog's title: the job it's there to do. */
export function securityFixTitle(fix: SecurityFix, use: SecurityUse): string {
  switch (fix.kind) {
    case "deploy-update":
    case "change-version":
      return `Update ${use.name}`
    case "host-packages":
      return `Update ${use.relayName}'s host`
    case "kiln-update":
      return `Update Kiln on ${use.relayName}`
    case "rebuild":
    case "database":
    case "game-server":
      return `How to fix ${use.name}`
  }
}

interface FixProps {
  item: SecurityItem
  use: SecurityUse
  vulnerabilities: React.ReactNode
}

/** What one resource runs, what to move it to, and the button that does. */
export function SecurityFixPanel(props: FixProps) {
  const { use } = props
  // Their state is the resource's, so another resource starts fresh.
  const key = `${use.scope}:${use.component ?? ""}`
  const { fix } = use
  switch (fix.kind) {
    case "deploy-update":
      return <DeployUpdate key={key} {...props} fix={fix} />
    case "change-version":
      return <ChangeVersion key={key} {...props} fix={fix} />
    case "rebuild":
      return <Rebuild key={key} {...props} fix={fix} />
    case "host-packages":
      return <HostPackages key={key} {...props} />
    case "kiln-update":
      return (
        <FixLayout
          {...props}
          action={
            <Button asChild size="sm">
              <Link to="/infra/updates">Open Updates</Link>
            </Button>
          }
          note="This comes with Kiln."
          to={<ChangeTo value="Newer Kiln" />}
        />
      )
    case "database":
      return (
        <FixLayout
          {...props}
          action={
            <Button asChild size="sm" variant="outline">
              <SecurityResourceLink use={use}>
                Open database
              </SecurityResourceLink>
            </Button>
          }
          note="Kiln picks this image. Export into a new database after updating Kiln."
          to={<NoChange value="Can't update in place" />}
        />
      )
    case "game-server":
      return (
        <FixLayout
          {...props}
          note="A newer Brick brings a newer image."
          to={<NoChange value="Comes from its Brick" />}
        />
      )
  }
}

/** Opens the resource's Info page. */
export function SecurityResourceLink({
  className,
  use,
  ...props
}: Omit<React.ComponentPropsWithoutRef<"a">, "href" | "target"> & {
  use: SecurityUse
}) {
  switch (use.resourceType) {
    case "app":
      return (
        <Link
          className={className}
          params={{ appId: use.resourceId }}
          to="/app/$appId/info"
          {...props}
        />
      )
    case "database":
      return (
        <Link
          className={className}
          params={{ databaseId: use.resourceId }}
          to="/db/$databaseId/info"
          {...props}
        />
      )
    case "instance":
      return (
        <Link
          className={className}
          params={{ serverId: use.resourceId }}
          to="/server/$serverId/info"
          {...props}
        />
      )
    case "relay":
      return (
        <Link
          className={className}
          params={{ relayId: use.relayId }}
          to="/relay/$relayId/info"
          {...props}
        />
      )
  }
}

// `httpd:2.4.49` as what it is and which version, however it's written.
function imageParts(image: string): { name: string; tag: string | null } {
  const [named = image] = image.split("@")
  const colon = named.lastIndexOf(":")
  return colon > named.lastIndexOf("/")
    ? { name: named.slice(0, colon), tag: named.slice(colon + 1) }
    : { name: named, tag: null }
}

function imageOrigin(image: string): string {
  switch (parseImageReference(image)?.registry) {
    case "docker.io":
      return "Docker Hub image"
    case "ghcr.io":
      return "GitHub Packages image"
    default:
      return "Container image"
  }
}

// Where what's running came from, and what's running of it: what someone
// needs to know before pressing anything.
export function securityFixSource(
  item: SecurityItem,
  fix: SecurityFix
): {
  current: string
  detail: string
  name: string
} {
  switch (fix.kind) {
    case "deploy-update":
    case "change-version": {
      const { name, tag } = imageParts(fix.image)
      return {
        current: tag ?? "Unknown",
        detail: imageOrigin(fix.image),
        name,
      }
    }
    case "rebuild":
      if (fix.repository) {
        return {
          current: "Current build",
          detail: `${fix.repository.branch} branch`,
          name: fix.repository.name,
        }
      }
      return {
        current: "Current build",
        detail: fix.source === "compose" ? "Compose file" : "Dockerfile",
        name: "Built by Kiln",
      }
    case "host-packages":
      return {
        current: "Installed",
        detail: "",
        name: item.name,
      }
    case "kiln-update":
    case "database":
    case "game-server": {
      const { name, tag } = imageParts(item.name)
      return {
        current: tag ?? "Unknown",
        detail: imageOrigin(item.name),
        name,
      }
    }
  }
}

function ChangeTo({
  loading = false,
  value,
}: {
  loading?: boolean
  value: string
}) {
  return (
    <span
      className={cn(
        "flex min-w-0 items-center gap-1.5 truncate font-mono text-[0.8125rem] font-medium",
        loading
          ? "text-muted-foreground"
          : "text-emerald-300 light:text-emerald-700"
      )}
    >
      {loading ? <LoaderCircle className="size-3.5 animate-spin" /> : null}
      <span className="truncate">{value}</span>
    </span>
  )
}

function NoChange({ value }: { value: string }) {
  return (
    <span className="type-meta truncate text-muted-foreground">{value}</span>
  )
}

function FixLayout({
  action,
  item,
  note,
  secondary,
  to,
  use,
  vulnerabilities,
}: {
  action?: React.ReactNode
  item: SecurityItem
  note?: string
  secondary?: React.ReactNode
  to: React.ReactNode
  use: SecurityUse
  vulnerabilities: React.ReactNode
}) {
  const source = securityFixSource(item, use.fix)
  return (
    <>
      <div className="flex h-10 shrink-0 items-center gap-2 rounded-lg border px-3">
        <span className="type-meta shrink-0 text-muted-foreground">
          {use.fix.kind === "host-packages"
            ? "Packages"
            : use.fix.kind === "rebuild"
              ? "Build"
              : "Version"}
        </span>
        <span className="truncate font-mono text-[0.8125rem] text-muted-foreground">
          {source.current}
        </span>
        <ArrowRight className="size-3.5 shrink-0 text-muted-foreground" />
        {to}
      </div>
      {vulnerabilities}
      <div className="flex shrink-0 items-center justify-between gap-3">
        <p className="type-meta line-clamp-2 min-w-0 flex-1 text-muted-foreground">
          {note}
        </p>
        <div className="flex shrink-0 items-center gap-2">
          {secondary}
          {action}
        </div>
      </div>
    </>
  )
}

const failedToast = (error: Error) =>
  showToast({ message: error.message, type: "error" })

const deployingToast = (what: string) =>
  showToast({ message: `Redeploying ${what}`, type: "success" })

function DeployUpdate({
  fix,
  ...props
}: FixProps & { fix: Extract<SecurityFix, { kind: "deploy-update" }> }) {
  const { use } = props
  const { isPending, mutate } = useMutation({
    mutationFn: () =>
      deployAppImageUpdate({
        data: { appId: use.resourceId, relayId: use.relayId },
      }),
    onError: failedToast,
    onSuccess: () => deployingToast(use.name),
  })
  return (
    <FixLayout
      {...props}
      action={
        <Button
          disabled={isPending || !fix.allowed}
          size="sm"
          type="button"
          onClick={() => mutate()}
        >
          {isPending ? (
            <LoaderCircle className="animate-spin" />
          ) : (
            <RefreshCw />
          )}
          Update image
        </Button>
      }
      note={fix.allowed ? "Volumes are kept." : "You can't deploy this."}
      to={<ChangeTo value="Newest build" />}
    />
  )
}

const suggestionLabels = {
  major: "Major update",
  minor: "Newest of this major version",
  patch: "Smallest change",
} satisfies Record<ImageTagSuggestion["kind"], string>

// Far enough to help without a major update. The nearest patch can be as old
// as what it replaces, and a major one can need changes.
function recommended(
  suggestions: ReadonlyArray<ImageTagSuggestion>
): ImageTagSuggestion | undefined {
  return (
    suggestions.find((suggestion) => suggestion.kind === "minor") ??
    suggestions.find((suggestion) => suggestion.kind === "patch") ??
    suggestions[0]
  )
}

function ChangeVersion({
  fix,
  ...props
}: FixProps & { fix: Extract<SecurityFix, { kind: "change-version" }> }) {
  const { item, use } = props
  const { data, error, isPending } = useQuery(
    securityImageVersionsQueryOptions(use.relayId, use.resourceId)
  )
  const [chosen, setChosen] = React.useState<string | null>(null)
  const queryClient = useQueryClient()
  const deploy = useMutation({
    mutationFn: async (image: string) => {
      const target = { appId: use.resourceId, relayId: use.relayId }
      await updateAppConfig({ data: { ...target, config: { image } } })
      await deployApp({ data: target })
      return image
    },
    onError: failedToast,
    onSuccess: (image) => {
      deployingToast(`${use.name} with ${image}`)
      void queryClient.invalidateQueries({ queryKey: securityQueryKeys.all })
    },
  })
  const suggestions = data?.suggestions ?? []
  const best = recommended(suggestions)
  const target =
    suggestions.find((suggestion) => suggestion.image === chosen) ?? best
  if (isPending) {
    return (
      <FixLayout
        {...props}
        action={
          <Button disabled size="sm" type="button">
            Update and redeploy
          </Button>
        }
        to={<ChangeTo loading value="Checking" />}
      />
    )
  }
  if (error || !target) {
    return (
      <FixLayout
        {...props}
        action={
          item.fixable > 0 || error ? (
            <Button asChild size="sm" variant="outline">
              <SecurityResourceLink use={use}>
                Choose a version
              </SecurityResourceLink>
            </Button>
          ) : undefined
        }
        to={
          <NoChange
            value={error ? "Couldn't check for versions" : "No newer version"}
          />
        }
      />
    )
  }
  return (
    <FixLayout
      {...props}
      action={
        <Button
          disabled={deploy.isPending || !fix.allowed}
          size="sm"
          type="button"
          onClick={() => deploy.mutate(target.image)}
        >
          {deploy.isPending ? <LoaderCircle className="animate-spin" /> : null}
          Update and redeploy
        </Button>
      }
      note={fix.allowed ? "Volumes are kept." : "You can't change this image."}
      to={
        suggestions.length > 1 ? (
          <Select
            value={target.image}
            onValueChange={(image) => setChosen(image as string)}
          >
            <SelectTrigger
              aria-label="Version to update to"
              className="h-7 min-w-0 border-0 bg-transparent px-1 font-mono text-[0.8125rem] font-medium text-emerald-300 light:text-emerald-700"
            >
              <span className="truncate">{target.tag}</span>
            </SelectTrigger>
            <SelectContent>
              {suggestions.map((suggestion) => (
                <SelectItem key={suggestion.tag} value={suggestion.image}>
                  {suggestion.tag}
                  {suggestion === best
                    ? " (recommended)"
                    : ` (${suggestionLabels[suggestion.kind].toLowerCase()})`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <ChangeTo value={target.tag} />
        )
      }
    />
  )
}

// Kiln can't change what a repository or a pasted file says, so it says where
// the change goes, and the app's own Redeploy does the rest.
function Rebuild({
  fix,
  ...props
}: FixProps & { fix: Extract<SecurityFix, { kind: "rebuild" }> }) {
  const { use } = props
  const { repository } = fix
  return (
    <FixLayout
      {...props}
      action={
        <Button asChild size="sm" variant="outline">
          <SecurityResourceLink use={use}>Open app</SecurityResourceLink>
        </Button>
      }
      note={`Update ${
        repository?.name ??
        (fix.source === "compose" ? "its Compose file" : "its Dockerfile")
      }, then redeploy.`}
      to={<NoChange value="Changes at its source" />}
    />
  )
}

// Kiln can't update a host itself, so it points at the shell that can.
function HostPackages(props: FixProps) {
  const { use } = props
  return (
    <FixLayout
      {...props}
      action={
        <Button asChild size="sm" variant="outline">
          <Link params={{ relayId: use.relayId }} to="/relay/$relayId/terminal">
            Open Terminal
          </Link>
        </Button>
      }
      to={<NoChange value="Update from its Terminal" />}
    />
  )
}
