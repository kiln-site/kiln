import * as React from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Download, HardDriveDownload, LoaderCircle, Upload } from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@workspace/ui/components/dialog"
import { showToast } from "@workspace/ui/components/sonner"

import {
  RestoreBackupLink,
  SqlImportDropZone,
} from "@/components/database/database-settings"
import { InfoSection, InfoSectionLink } from "@/components/info-page"
import { importKilnDatabase } from "@/server/kiln-database"
import type { KilnPlatformHost } from "@/server/platform"

// Hearth's own database, as a managed database's Data section offers it:
// export it as SQL, browse it, restore a backup, or import a SQL file.
// Export and import go through Hearth's own login; browsing goes through
// the Relay on its host.

// As `KILN_DATABASE_IMPORT_LIMIT_BYTES`, which the server enforces.
const IMPORT_LIMIT_BYTES = 32 * 1024 * 1024

export function KilnDataSection({ host }: { host: KilnPlatformHost }) {
  const [file, setFile] = React.useState<File | null>(null)
  return (
    <InfoSection
      icon={<HardDriveDownload />}
      title="Data"
      content
      action={
        <>
          <Button asChild size="sm" variant="outline">
            {/* A download, so the browser streams it to disk. */}
            <a download href="/api/kiln/database-export">
              <Download />
              Export SQL
            </a>
          </Button>
          {host.database ? (
            <InfoSectionLink to="/kiln/viewer">View Data</InfoSectionLink>
          ) : null}
          <RestoreBackupLink
            emptyMessage="No backups of Kiln yet"
            relayId={host.relayId}
            search={{
              kind: "relay",
              relay: host.relayId,
              server: host.relayId,
            }}
            target={{ id: host.relayId, kind: "platform" }}
          />
        </>
      }
    >
      <SqlImportDropZone
        disabledReason={undefined}
        label="Upload a Kiln SQL export to import"
        limit="32 MB Limit"
        onFile={setFile}
      />
      {file ? (
        <KilnImportDialog file={file} onClose={() => setFile(null)} />
      ) : null}
    </InfoSection>
  )
}

function KilnImportDialog({
  file,
  onClose,
}: {
  file: File
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const tooLarge = file.size > IMPORT_LIMIT_BYTES
  const upload = useMutation({
    mutationFn: async () => {
      const bytes = new Uint8Array(await file.arrayBuffer())
      if (bytes.includes(0)) throw new Error("This file isn't a text SQL dump")
      return importKilnDatabase({
        data: { content: new TextDecoder().decode(bytes) },
      })
    },
    onSuccess: async () => {
      showToast({ message: `Imported ${file.name}`, type: "success" })
      onClose()
      // Whatever Hearth shows may have changed underneath it.
      await queryClient.invalidateQueries()
    },
  })

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !upload.isPending) onClose()
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Import into Kiln&apos;s database</DialogTitle>
          <DialogDescription>
            {file.name} replaces every table it holds, including sign-ins,
            settings, and the catalog, while Hearth serves. It must be a whole
            export from this version of Kiln, and it needs a Kiln backup from
            the last day to come back to.
          </DialogDescription>
        </DialogHeader>
        {tooLarge || upload.error ? (
          <p className="text-xs text-destructive">
            {tooLarge
              ? "SQL files are limited to 32 MB"
              : upload.error?.message}
          </p>
        ) : null}
        <DialogFooter>
          <Button
            disabled={upload.isPending}
            type="button"
            variant="ghost"
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button
            disabled={tooLarge || upload.isPending}
            type="button"
            variant="destructive"
            onClick={() => upload.mutate()}
          >
            {upload.isPending ? (
              <LoaderCircle className="animate-spin" />
            ) : (
              <Upload />
            )}
            Import
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
