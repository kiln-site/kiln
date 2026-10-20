import { memo, useState, type ReactNode } from "react"
import { ArrowLeftRight, Users } from "lucide-react"
import { Button } from "@workspace/ui/components/button"
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@workspace/ui/components/command"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@workspace/ui/components/popover"
import {
  DatabaseKindIcon,
  RelayKindIcon,
  ServerKindIcon,
} from "@/components/instance-kind-icon"
import type { PermissionContext } from "@/components/permission-editor"
import type { ResourceScope } from "@/lib/resource-permissions"
import type { getAccessResources } from "@/server/resource-access"

export type Resource = Awaited<
  ReturnType<typeof getAccessResources>
>["resources"][number]
export type AccessScope = ResourceScope & { name?: string; relayName?: string }
export const EMPTY_RESOURCES: Array<Resource> = []

export const scopeKey = (scope: ResourceScope) =>
  `${scope.relayId}:${scope.resourceType}:${scope.resourceId}`

/** The context chips for a scope, from whichever names are known. */
export function contextFor(scope: AccessScope): PermissionContext {
  return {
    scope: {
      relayId: scope.relayId,
      resourceType: scope.resourceType,
      resourceId: scope.resourceId,
    },
    relayName:
      scope.relayName ??
      (scope.resourceType === "relay" ? scope.name : undefined),
    resourceName: scope.resourceType === "relay" ? undefined : scope.name,
  }
}

export const ResourcePicker = memo(function ResourcePicker({
  resources,
  selected,
  onSelect,
  onSearch,
  platform,
  onPlatform,
  loading,
  error,
  hasMore,
  onMore,
  onPrevious,
  hasPrevious,
  trigger,
}: {
  resources: Array<Resource>
  selected: AccessScope | null
  onSelect: (resource: Resource) => void
  onSearch: (search: string) => void
  platform?: boolean
  onPlatform?: () => void
  loading?: boolean
  error?: string
  hasMore?: boolean
  onMore?: () => void
  onPrevious?: () => void
  hasPrevious?: boolean
  trigger?: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const [searchValue, setSearchValue] = useState("")
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        {trigger ?? (
          <Button type="button" variant="outline" size="sm">
            <ArrowLeftRight />
            {selected ? "Change instance" : "Choose instance"}
          </Button>
        )}
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-[min(32rem,calc(100vw-2rem))] p-1.5"
      >
        <Command shouldFilter={false}>
          <CommandInput
            aria-label="Find instances"
            placeholder="Search by name or ID…"
            value={searchValue}
            onValueChange={(value) => {
              setSearchValue(value)
              onSearch(value)
            }}
          />
          <CommandList aria-label="Instances">
            {platform ? (
              <CommandItem
                value="platform"
                onSelect={() => {
                  onPlatform?.()
                  setOpen(false)
                }}
              >
                <Users />
                Platform users
              </CommandItem>
            ) : null}
            {resources.map((resource) => (
              <CommandItem
                key={scopeKey(resource)}
                value={scopeKey(resource)}
                onSelect={() => {
                  onSelect(resource)
                  setOpen(false)
                }}
              >
                {resource.resourceType === "relay" ? (
                  <RelayKindIcon />
                ) : resource.resourceType === "database" ? (
                  <DatabaseKindIcon />
                ) : (
                  <ServerKindIcon />
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{resource.name}</span>
                  <span className="block truncate font-mono text-xs text-muted-foreground">
                    {resource.resourceType === "relay"
                      ? resource.resourceId
                      : `${resource.resourceId} · ${resource.relayName}`}
                  </span>
                </span>
                <span className="text-xs text-muted-foreground">
                  {resource.resourceType === "instance"
                    ? "Game Server"
                    : resource.resourceType}
                </span>
              </CommandItem>
            ))}
            <CommandEmpty>
              {loading
                ? "Loading instances…"
                : (error ?? "No instances found.")}
            </CommandEmpty>
          </CommandList>
          {hasPrevious ? (
            <Button
              variant="ghost"
              size="sm"
              disabled={loading}
              onClick={onPrevious}
            >
              Previous instances
            </Button>
          ) : null}
          {hasMore ? (
            <Button
              variant="ghost"
              size="sm"
              disabled={loading}
              onClick={onMore}
            >
              Load more instances
            </Button>
          ) : null}
          {error && resources.length ? (
            <p role="alert" className="px-3 py-2 text-xs text-destructive">
              {error}
            </p>
          ) : null}
        </Command>
      </PopoverContent>
    </Popover>
  )
})
