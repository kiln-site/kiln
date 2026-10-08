import type { HearthDatabaseTerminalOutput } from "@workspace/contracts"

// Database terminal output arrives from Relays as pushes for an attachment;
// each attachment is one open browser stream in this Hearth process.

interface Attachment {
  deliver: (output: HearthDatabaseTerminalOutput) => void
  relayId: string
}

const globalHub = globalThis as typeof globalThis & {
  kilnDatabaseTerminalAttachments?: Map<string, Attachment>
}

// Kept on globalThis so development reloads don't orphan open streams.
const attachments = (globalHub.kilnDatabaseTerminalAttachments ??= new Map())

export function registerDatabaseTerminalAttachment(
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

// Answers the Relay: an unaccepted push tells it the viewer is gone.
export function deliverDatabaseTerminalOutput(
  relayId: string,
  output: HearthDatabaseTerminalOutput
): { accepted: boolean } {
  const attachment = attachments.get(output.attachmentId)
  // Another Relay can't write into a stream it didn't attach.
  if (!attachment || attachment.relayId !== relayId) {
    return { accepted: false }
  }
  attachment.deliver(output)
  return { accepted: true }
}
