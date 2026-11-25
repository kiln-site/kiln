import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { LoaderCircle } from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@workspace/ui/components/dialog"

import { SecretSaveOptions } from "@/components/secret-save-options"
import {
  revealBackupPassword,
  type getBackupStorage,
} from "@/server/backup-storage"

type Destination = Pick<
  Awaited<ReturnType<typeof getBackupStorage>>[number],
  "bucket" | "endpoint" | "id" | "name" | "objectPrefix"
>

const purpose =
  "Opens this destination’s incremental backups with restic, without Kiln."

/**
 * A destination's password, for its owner to keep. Mounted only while open,
 * so what it shows is gone once it closes.
 */
export function BackupPasswordDialog({
  destination,
  onClose,
}: {
  destination: Destination
  onClose: () => void
}) {
  const revealed = useQuery({
    queryFn: () => revealBackupPassword({ data: { id: destination.id } }),
    queryKey: ["backup-password", destination.id],
    gcTime: 0,
    refetchOnWindowFocus: false,
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
  })
  const password = revealed.data?.password
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Backup password for {destination.name}</DialogTitle>
          <DialogDescription>
            {purpose} Keep it somewhere safe.
          </DialogDescription>
        </DialogHeader>
        {password ? (
          <DestinationPassword destination={destination} password={password} />
        ) : revealed.error ? (
          <p role="alert" className="text-xs text-destructive">
            {revealed.error.message}
          </p>
        ) : (
          <div className="grid h-19 place-items-center">
            <LoaderCircle className="size-4 animate-spin text-muted-foreground" />
          </div>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function DestinationPassword({
  destination,
  password,
}: {
  destination: Destination
  password: string
}) {
  const { bucket, endpoint, id, name, objectPrefix } = destination
  const location = [endpoint, bucket, objectPrefix].filter(Boolean).join("/")
  const file = React.useMemo(
    () => ({
      content: [
        `Kiln backup password for ${name}`,
        "",
        password,
        "",
        purpose.replace("’", "'"),
        `Bucket: ${location}`,
        "",
      ].join("\n"),
      name: `kiln-backup-password-${id}.txt`,
    }),
    [id, location, name, password]
  )
  const onePasswordItem = React.useMemo(
    () => ({
      name,
      notes: `${purpose}\nBucket: ${location}`,
      title: `Kiln backup password (${name})`,
      url: endpoint,
    }),
    [endpoint, location, name]
  )
  return (
    <SecretSaveOptions
      file={file}
      label="Backup password"
      onePasswordItem={onePasswordItem}
      value={password}
    />
  )
}
