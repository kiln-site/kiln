import * as React from "react"
import { useMutation } from "@tanstack/react-query"
import { Globe2, LoaderCircle, Sparkles } from "lucide-react"

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

// A name the way a Domains table holds one: lowercase, from a pasted URL its
// host alone.
function normalizeHostname(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//u, "")
    .replace(/[/?#:].*$/u, "")
    .replace(/\.$/u, "")
}

const hostnamePattern =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/u

/**
 * Adds a public name to a database's Domains table, or renames one there,
 * with the port all its names are reached at: under a vanity domain, a zone
 * on the Domains page, or one managed elsewhere. Its first opens it to the
 * internet.
 */
export function DomainNameDialog({
  hostname: current,
  opens,
  port: currentPort,
  portHost,
  onOpenChange,
  onSubmit,
}: {
  // The name being renamed; null to add one.
  hostname: string | null
  // Whether this is its first, which opens it.
  opens: boolean
  port: number
  portHost: string
  onOpenChange: (open: boolean) => void
  // A null hostname asks for one generated under a vanity domain.
  onSubmit: (change: { hostname: string | null; port: number }) => Promise<void>
}) {
  const [hostname, setHostname] = React.useState(current ?? "")
  const [port, setPort] = React.useState(String(currentPort))
  const host = normalizeHostname(hostname)
  const save = useMutation({
    mutationFn: (generate: boolean) =>
      onSubmit({ hostname: generate ? null : host, port: Number(port) }),
  })
  const portValid =
    /^\d{1,5}$/u.test(port) && Number(port) >= 1 && Number(port) <= 65_535
  const changed = host !== current || Number(port) !== currentPort
  const valid = hostnamePattern.test(host) && portValid && changed
  return (
    <Dialog open onOpenChange={(next) => !save.isPending && onOpenChange(next)}>
      <DialogContent className="sm:max-w-md">
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            if (valid && !save.isPending) save.mutate(false)
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {current
                ? `Change ${current}`
                : opens
                  ? "Open to the internet"
                  : "Add domain"}
            </DialogTitle>
            <DialogDescription>
              {opens
                ? "Its first domain opens it to the internet once Kiln has its certificate. MySQL and MariaDB restart once. Clients must use TLS, and anyone with its login can connect."
                : "Under one of your vanity domains, a Cloudflare zone, or a domain managed elsewhere. Kiln gets a certificate for it."}
            </DialogDescription>
          </DialogHeader>
          <label className="grid gap-1.5 text-sm">
            <span className="font-medium">Domain</span>
            <Input
              autoCapitalize="none"
              autoComplete="off"
              autoCorrect="off"
              autoFocus
              className="font-mono"
              placeholder="db.example.com"
              spellCheck={false}
              value={hostname}
              onBlur={() => setHostname(host)}
              onChange={(event) => setHostname(event.target.value)}
            />
          </label>
          <label className="grid gap-1.5 text-sm">
            <span className="font-medium">Port on {portHost}</span>
            <Input
              className="font-mono"
              inputMode="numeric"
              value={port}
              onChange={(event) => setPort(event.target.value.trim())}
            />
            <span className="text-xs text-muted-foreground">
              The same for all its domains.
            </span>
          </label>
          {save.error ? (
            <p className="text-xs text-destructive">{save.error.message}</p>
          ) : null}
          <DialogFooter className="sm:justify-between">
            {current === null ? (
              <Button
                type="button"
                variant="ghost"
                disabled={save.isPending || !portValid}
                onClick={() => save.mutate(true)}
              >
                <Sparkles />
                Generate a name
              </Button>
            ) : (
              <span />
            )}
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={save.isPending}
                onClick={() => onOpenChange(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={save.isPending || !valid}>
                {save.isPending ? (
                  <LoaderCircle className="animate-spin" />
                ) : (
                  <Globe2 />
                )}
                {current ? "Save" : opens ? "Open" : "Add"}
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
