import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { CornerDownLeft, EyeOff, LoaderCircle } from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@workspace/ui/components/popover"

import { useConsoleCommand } from "@/components/console/use-console-command"
import { useInstanceRelayConnected } from "@/components/instance-workspace-context"
import { relaySnapshotQueryOptions } from "@/lib/query-options"
import {
  selectInstanceContainerRunning,
  type InstanceWorkspaceInstance,
} from "@/lib/relay-selectors"

export const ConsoleCommandBar = React.memo(function ConsoleCommandBar({
  active,
  canWrite,
  instance,
}: {
  active: boolean
  canWrite: boolean
  instance: InstanceWorkspaceInstance
}) {
  const relayConnected = useInstanceRelayConnected()
  const selectContainerRunning = React.useMemo(
    () => selectInstanceContainerRunning(instance.id, instance.relayId),
    [instance.id, instance.relayId]
  )
  const { data: containerRunning = false } = useQuery({
    ...relaySnapshotQueryOptions(),
    select: selectContainerRunning,
  })
  const command = useConsoleCommand(
    instance.id,
    instance.relayId,
    active,
    containerRunning,
    relayConnected
  )

  return (
    <div className="shrink-0 border-t bg-background/80 px-3 py-3 sm:px-4">
      {canWrite ? (
        <form className="flex items-center gap-2" onSubmit={command.submit}>
          <span className="hidden font-mono text-xs font-semibold text-primary sm:inline">
            &gt;
          </span>
          <Popover
            open={Boolean(command.completions)}
            onOpenChange={(open) => {
              if (!open) command.stopCompletions()
            }}
          >
            <PopoverAnchor asChild>
              <div className="min-w-0 flex-1">
                <Input
                  ref={command.inputRef}
                  onChange={command.change}
                  onBlur={command.stopCompletions}
                  onKeyDown={command.keyDown}
                  placeholder={
                    !command.running
                      ? "Server is stopped"
                      : !command.available
                        ? "Relay disconnected — command saved as a draft"
                        : "Send a server command…"
                  }
                  role="combobox"
                  aria-label="Server command"
                  aria-autocomplete="list"
                  aria-controls="console-command-completions"
                  aria-expanded={Boolean(command.completions)}
                  aria-invalid={Boolean(command.error)}
                  aria-keyshortcuts="Tab ArrowUp ArrowDown Escape"
                  aria-activedescendant={
                    command.completions?.status === "ready"
                      ? `console-completion-${command.completions.selectedIndex}`
                      : undefined
                  }
                  disabled={!command.running}
                  title={command.error ?? undefined}
                  autoFocus
                  autoComplete="off"
                  className="h-10 border-border/80 bg-card font-mono text-base shadow-none sm:text-xs"
                />
              </div>
            </PopoverAnchor>
            <PopoverContent
              ref={command.completionListRef}
              id="console-command-completions"
              role="listbox"
              align="start"
              side="top"
              sideOffset={7}
              className="max-h-[13.25rem] w-[var(--radix-popover-trigger-width)] min-w-64 overflow-y-scroll p-1 [&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar-thumb]:bg-muted-foreground/55 [&::-webkit-scrollbar-thumb:hover]:bg-muted-foreground/75 [&::-webkit-scrollbar-track]:bg-foreground/10"
              style={{
                scrollbarColor:
                  "color-mix(in oklab, var(--muted-foreground) 55%, transparent) color-mix(in oklab, var(--foreground) 10%, transparent)",
                scrollbarGutter: "stable",
              }}
              aria-busy={command.completions?.status === "loading"}
              onOpenAutoFocus={(event) => event.preventDefault()}
              onCloseAutoFocus={(event) => event.preventDefault()}
            >
              {command.completions?.status === "loading" ? (
                <div
                  role="status"
                  className="flex items-center gap-2 px-2.5 py-2 font-mono text-xs text-muted-foreground"
                >
                  <LoaderCircle className="size-3.5 animate-spin text-primary/75" />
                  Waiting for completions…
                </div>
              ) : command.completions?.status === "empty" ? (
                <div
                  role="status"
                  className="px-2.5 py-2 font-mono text-xs text-muted-foreground"
                >
                  No completions
                </div>
              ) : command.completions?.status === "unavailable" ? (
                <div
                  role="status"
                  className="px-2.5 py-2 font-mono text-xs text-muted-foreground"
                >
                  Completions unavailable
                </div>
              ) : (
                command.completions?.suggestions.map((suggestion, index) => (
                  <button
                    id={`console-completion-${index}`}
                    role="option"
                    aria-selected={index === command.completions?.selectedIndex}
                    type="button"
                    key={suggestion.value}
                    className={`block w-full px-2.5 py-2 text-left font-mono text-xs ${
                      index === command.completions?.selectedIndex
                        ? "bg-popover-accent text-popover-accent-foreground"
                        : "text-muted-foreground hover:bg-muted/55 hover:text-foreground"
                    }`}
                    onMouseDown={(event) => event.preventDefault()}
                    onPointerMove={() => command.selectCompletion(index)}
                    onClick={() => command.applyCompletion(suggestion.value)}
                  >
                    {suggestion.label}
                  </button>
                ))
              )}
            </PopoverContent>
          </Popover>
          <Button
            ref={command.sendButtonRef}
            type="submit"
            size="sm"
            className="h-10 gap-1.5 px-4 text-xs"
            disabled={
              !command.running ||
              !command.available ||
              !command.inputRef.current?.value.trim() ||
              command.sending
            }
          >
            {command.sending ? (
              <LoaderCircle className="animate-spin" />
            ) : (
              <CornerDownLeft />
            )}
            Send
          </Button>
        </form>
      ) : (
        <div className="type-code flex h-10 items-center gap-2 text-muted-foreground">
          <EyeOff className="size-3.5" /> Read-only console access
        </div>
      )}
    </div>
  )
})
