import { copyToClipboard } from "@/components/console/console-toolbar-actions"
import { useMclogsShareAction } from "@/components/use-mclogs-share-action"

// What the demos' mclo.gs buttons upload in place of a log or a file, which
// are made up and of no use to mclo.gs.
const shareContent = "https://www.youtube.com/watch?v=dQw4w9WgXcQ"

// The link this visit's upload made, shared by every demo. Buttons are off
// while they upload, so only one is ever in flight.
let sharedUrl: string | null = null

// Hearth's mclo.gs share, uploading `shareContent`. One upload serves the
// whole visit, so sharing again copies the same link.
export function useDemoShare() {
  return useMclogsShareAction(async () => {
    sharedUrl ??= await uploadShareContent()
    await copyToClipboard(sharedUrl)
    return sharedUrl
  })
}

// A form post, which mclo.gs answers to any origin without a preflight.
async function uploadShareContent(): Promise<string> {
  const response = await fetch("https://api.mclo.gs/1/log", {
    method: "POST",
    body: new URLSearchParams({ content: shareContent }),
  })
  const result: unknown = await response.json()
  if (
    !response.ok ||
    typeof result !== "object" ||
    result === null ||
    !("url" in result) ||
    typeof result.url !== "string"
  ) {
    throw new Error(`mclo.gs returned HTTP ${response.status}`)
  }
  return result.url
}
