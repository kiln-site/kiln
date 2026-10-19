import { cn } from "@workspace/ui/lib/utils"

import { GitHubMark } from "@/components/github-mark"
import type { GitHubConnectionView } from "@/server/github-sync.server"

/** The GitHub account a source reads from, or its app until installed. */
export function SourceAccount({
  className,
  showType = true,
  source,
}: {
  className?: string
  showType?: boolean
  source: Pick<GitHubConnectionView, "appName" | "installation">
}) {
  const installation = source.installation
  return (
    <span className={cn("flex min-w-0 items-center gap-2", className)}>
      {installation?.accountAvatarUrl ? (
        <img
          alt=""
          src={avatarUrl(installation.accountAvatarUrl)}
          className={cn(
            "size-5 shrink-0 border bg-background",
            installation.accountType === "Organization"
              ? "rounded"
              : "rounded-full"
          )}
          loading="lazy"
        />
      ) : (
        <span className="grid size-5 shrink-0 place-items-center rounded-full border bg-background text-muted-foreground">
          <GitHubMark className="size-3" />
        </span>
      )}
      <span className="min-w-0">
        <span className="block truncate text-xs font-medium">
          {installation?.accountLogin ?? source.appName}
        </span>
        {showType ? (
          <span className="type-support block truncate text-muted-foreground">
            {installation
              ? installation.accountType === "Organization"
                ? "Organization"
                : "Personal account"
              : "Not installed"}
          </span>
        ) : null}
      </span>
    </span>
  )
}

function avatarUrl(url: string) {
  return `${url}${url.includes("?") ? "&" : "?"}s=48`
}
