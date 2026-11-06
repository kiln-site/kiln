import * as React from "react"
import { useMutation } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { ArrowRight, LoaderCircle, RefreshCw } from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import { showToast } from "@workspace/ui/components/sonner"
import { cn } from "@workspace/ui/lib/utils"

import type { SecurityFix, SecurityItem, SecurityUse } from "@/lib/security"
import { deployAppImageUpdate } from "@/server/app-image-updates"

/** What a row's button says it leads to. */
export function securityFixLabel(fix: SecurityFix): string {
  switch (fix.kind) {
    case "deploy-update":
      return "Update"
    case "change-version":
      return "Choose a version"
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
      return <ChangeVersion key={key} {...props} />
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
        detail: "Container image",
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
        detail: "Container image",
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

// Kiln doesn't know what's newer, so it points at where the image is set.
function ChangeVersion(props: FixProps) {
  const { item, use } = props
  return (
    <FixLayout
      {...props}
      action={
        item.fixable > 0 ? (
          <Button asChild size="sm" variant="outline">
            <SecurityResourceLink use={use}>
              Choose a version
            </SecurityResourceLink>
          </Button>
        ) : undefined
      }
      to={<NoChange value="Choose a newer version" />}
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
