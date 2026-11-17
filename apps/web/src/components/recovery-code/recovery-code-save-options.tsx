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
} from "@/components/recovery-code/onepassword-save-button"
import { useCopyFeedback } from "@/components/workspace-header"
import { notALoginField } from "@/lib/not-a-login-field"
import {
  recoveryCodeFile,
  recoveryCodePurpose,
  recoveryDocsUrl,
  type RecoveryCodeReveal,
} from "@/lib/recovery-code"

/**
 * The ways to keep Kiln's recovery code: copy it, download it, or save it in
 * 1Password. It's masked until asked, and shown only while it's on screen.
 */
export const RecoveryCodeSaveOptions = React.memo(
  function RecoveryCodeSaveOptions({ reveal }: { reveal: RecoveryCodeReveal }) {
    const [shown, setShown] = React.useState(false)
    const request = React.useMemo(
      () => onePasswordRequest(reveal, window.location),
      [reveal]
    )
    const { copied, copy } = useCopyFeedback(reveal.code)

    function download() {
      const file = recoveryCodeFile(reveal, window.location.host)
      const url = URL.createObjectURL(
        new Blob([file.content], { type: "text/plain" })
      )
      const link = document.createElement("a")
      link.href = url
      link.download = file.name
      link.click()
      URL.revokeObjectURL(url)
    }

    return (
      <div className="grid gap-4">
        <div className="flex gap-2">
          <Input
            {...notALoginField}
            aria-label="Recovery code"
            readOnly
            type={shown ? "text" : "password"}
            value={reveal.code}
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
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" onClick={download}>
            <Download />
            Download
          </Button>
          <OnePasswordSaveButton request={request} />
        </div>
        {reveal.scope === "environment" ? (
          <p className="type-meta text-muted-foreground">
            Keep your environment file too: Kiln needs both to restore.
          </p>
        ) : null}
      </div>
    )
  }
)

/**
 * What 1Password saves: an API Credential item, which it never offers to
 * fill a sign-in, so it stays apart from the administrator's own login. Its
 * key name and hostname are this Hearth's address, which outlasts a restore
 * as the code does, its masked credential the code, and its notes how to
 * restore.
 */
function onePasswordRequest(
  reveal: RecoveryCodeReveal,
  location: Pick<Location, "host" | "origin">
): OnePasswordSaveRequest {
  const { host, origin } = location
  return {
    fields: [
      { autocomplete: "username", value: host },
      { autocomplete: "current-password", value: reveal.code },
      { autocomplete: "url", value: origin },
    ],
    notes: [
      recoveryCodePurpose,
      ...(reveal.scope === "environment"
        ? ["Keep Kiln's environment file too: restoring needs both."]
        : []),
      "",
      `Restoring: ${recoveryDocsUrl}`,
    ].join("\n"),
    title: `Kiln recovery code (${host})`,
  }
}
