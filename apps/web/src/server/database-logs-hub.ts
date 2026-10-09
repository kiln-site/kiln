import type { HearthDatabaseLogsOutput } from "@workspace/contracts"

// Database log lines arrive from Relays as pushes for an attachment; each
// attachment is one open browser stream in this Hearth process.

interface Attachment {
  deliver: (output: HearthDatabaseLogsOutput) => void
  relayId: string
}

const globalHub = globalThis as typeof globalThis & {
  kilnDatabaseLogsAttachments?: Map<string, Attachment>
}

// Kept on globalThis so development reloads don't orphan open streams.
const attachments = (globalHub.kilnDatabaseLogsAttachments ??= new Map())

export function registerDatabaseLogsAttachment(
  attachmentId: string,
  relayId: string,
  deliver: Attachment["deliver"]
): () => void {
  const attachment = { deliver, relayId }
  attachments.set(attachmentId, attachment)
  return () => {
    if (attachments.get(attachmentId) === attachment) {
      attachments.delete(attachmentId)
    }
  }
}

// Answers the Relay: an unaccepted push tells it the page is gone.
export function deliverDatabaseLogsOutput(
  relayId: string,
  output: HearthDatabaseLogsOutput
): { accepted: boolean } {
  const attachment = attachments.get(output.attachmentId)
  // Another Relay can't write into a stream it didn't attach.
  if (!attachment || attachment.relayId !== relayId) {
    return { accepted: false }
  }
  attachment.deliver(output)
  return { accepted: true }
}
