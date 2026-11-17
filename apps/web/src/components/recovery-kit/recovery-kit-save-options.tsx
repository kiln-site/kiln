import * as React from "react"
import { Check, Copy, Download, Eye, EyeOff } from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"

import {
  OnePasswordSaveButton,
  type OnePasswordSaveRequest,
} from "@/components/recovery-kit/onepassword-save-button"
import { notALoginField } from "@/lib/not-a-login-field"
import { useCopyFeedback } from "@/components/workspace-header"
import { recoveryDocsUrl, type RecoveryKitReveal } from "@/lib/recovery-kit"

/**
 * The ways to keep Kiln's recovery kit: download it, save it in 1Password,
 * or copy its one line. Shown only while the kit is on screen.
 */
export const RecoveryKitSaveOptions = React.memo(
  function RecoveryKitSaveOptions({ reveal }: { reveal: RecoveryKitReveal }) {
    const [shown, setShown] = React.useState(false)
    const request = React.useMemo(
      () => onePasswordRequest(reveal, window.location.host),
      [reveal]
    )
    const { copied, copy } = useCopyFeedback(reveal.text)

    function download() {
      const { file } = reveal
      const url = URL.createObjectURL(
        new Blob([file.content], { type: file.type })
      )
      const link = document.createElement("a")
      link.href = url
      link.download = file.name
      link.click()
      URL.revokeObjectURL(url)
    }

    return (
      <div className="grid gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" onClick={download}>
            <Download />
            Download
          </Button>
          <OnePasswordSaveButton request={request} />
        </div>
        <label className="grid gap-1.5" htmlFor="recovery-kit-text">
          <span className="type-control-sm">
            {reveal.kind === "kit" ? "Recovery kit" : "Recovery key"}, as one
            line
          </span>
          <div className="flex gap-2">
            <Input
              {...notALoginField}
              id="recovery-kit-text"
              readOnly
              type={shown ? "text" : "password"}
              value={reveal.text}
              onFocus={(event) => event.currentTarget.select()}
              className="h-9 min-w-0 flex-1 font-mono text-xs"
            />
            <Button
              type="button"
              variant="outline"
              size="icon-lg"
              aria-label={shown ? "Hide" : "Show"}
              onClick={() => setShown((value) => !value)}
            >
              {shown ? <EyeOff /> : <Eye />}
            </Button>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  size="icon-lg"
                  aria-label={copied ? "Copied" : "Copy"}
                  className={
                    copied
                      ? "text-emerald-400 transition-colors hover:text-emerald-400"
                      : "transition-colors"
                  }
                  onClick={() => void copy()}
                >
                  {copied ? <Check /> : <Copy />}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top">
                {copied ? "Copied" : "Copy"}
              </TooltipContent>
            </Tooltip>
          </div>
        </label>
        {reveal.kind === "key" ? (
          <p className="type-meta text-muted-foreground">
            This Kiln takes its other secrets from your own environment file,
            which you manage. Keep that too: this key and that file restore it
            together.
          </p>
        ) : null}
      </div>
    )
  }
)

/**
 * What 1Password saves: a login item for the kit, its line as the password,
 * the one field its save dialog always keeps (it drops notes), with the
 * installation ID as its username. 1Password ties it to this Hearth's
 * address. The administrator's own login is 1Password's to save as they
 * create the account, as on any site.
 */
function onePasswordRequest(
  reveal: RecoveryKitReveal,
  host: string
): OnePasswordSaveRequest {
  const what =
    reveal.kind === "kit"
      ? "Kiln's recovery kit"
      : "Kiln's recovery key (installation ID and platform backup key)"
  const restore =
    reveal.kind === "kit"
      ? "To restore Kiln on a new host, save this item's password to a file and run `kiln-relay platform import-kit <file>` before the new Relay's first start, then restore a platform backup."
      : "To restore, set KILN_INSTALLATION_ID and KILN_PLATFORM_BACKUP_KEY from it, with the rest of Kiln's environment file, then restore a platform backup."
  return {
    fields: [
      { autocomplete: "username", value: reveal.installationId },
      { autocomplete: "current-password", value: reveal.text },
    ],
    notes: [
      `${what} for ${host}. It's the only way to restore Kiln and read its backups if this machine is lost. Anyone holding it can read Kiln's data.`,
      "",
      restore,
      "",
      `Steps: ${recoveryDocsUrl}`,
    ].join("\n"),
    title: `Kiln recovery kit (${host})`,
  }
}
