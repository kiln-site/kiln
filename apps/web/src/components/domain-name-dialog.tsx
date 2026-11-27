import * as React from "react"
import { useMutation } from "@tanstack/react-query"
import { Globe2, LoaderCircle } from "lucide-react"

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
 * Adds a name to a database's Domains table, or renames one there: under a
 * vanity domain, a zone on the Domains page, or one managed elsewhere.
 */
export function DomainNameDialog({
  hostname: current,
  onOpenChange,
  onSubmit,
}: {
  // The name being renamed; null to add one.
  hostname: string | null
  onOpenChange: (open: boolean) => void
  onSubmit: (hostname: string) => Promise<void>
}) {
  const [hostname, setHostname] = React.useState(current ?? "")
  const host = normalizeHostname(hostname)
  const save = useMutation({ mutationFn: () => onSubmit(host) })
  const valid = hostnamePattern.test(host) && host !== current
  return (
    <Dialog open onOpenChange={(next) => !save.isPending && onOpenChange(next)}>
      <DialogContent className="sm:max-w-md">
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            if (valid && !save.isPending) save.mutate()
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {current ? `Rename ${current}` : "Add domain"}
            </DialogTitle>
            <DialogDescription>
              A name under one of your vanity domains, a Cloudflare zone, or a
              domain managed elsewhere on the Domains page. While it&apos;s open
              to the internet, its certificate is asked for again with every
              name.
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
          {save.error ? (
            <p className="text-xs text-destructive">{save.error.message}</p>
          ) : null}
          <DialogFooter>
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
              {current ? "Rename" : "Add"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
