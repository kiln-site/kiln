import { BrickBrowserDialog } from "@/components/brick-selector"
import {
  DatabaseBrickBrowser,
  NewDatabaseForm,
  type NewDatabaseValues,
} from "@/components/database/new-database-form"

// A database described now and created later, with whatever it's for: the
// same Bricks and questions as adding one on its own, without the Relay,
// which is that thing's.
export function NewDatabaseDialog({
  initial,
  nameFallback,
  note,
  onClose,
  onSubmit,
  submitLabel,
  title,
}: {
  initial?: NewDatabaseValues | undefined
  /** Stands in for a blank name. */
  nameFallback: string
  /** Where and when it's created. */
  note: string
  onClose: () => void
  onSubmit: (values: NewDatabaseValues) => void
  submitLabel: string
  title: string
}) {
  return (
    <BrickBrowserDialog
      open
      title={title}
      description={note}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DatabaseBrickBrowser initialBrick={initial?.brick}>
        {(brick) => (
          <NewDatabaseForm
            brick={brick}
            initial={initial}
            nameFallback={nameFallback}
            submitLabel={submitLabel}
            onClose={onClose}
            onSubmit={onSubmit}
          >
            <p className="text-xs leading-relaxed text-muted-foreground">
              {note}
            </p>
          </NewDatabaseForm>
        )}
      </DatabaseBrickBrowser>
    </BrickBrowserDialog>
  )
}
