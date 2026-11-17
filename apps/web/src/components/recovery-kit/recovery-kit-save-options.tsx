import * as React from "react"
import { Copy, Download, Eye, EyeOff } from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import { showToast } from "@workspace/ui/components/sonner"

import { recoverPromise } from "@/effect/promise"
import {
  OnePasswordSaveButton,
  type OnePasswordSaveRequest,
} from "@/components/recovery-kit/onepassword-save-button"
import type { FirstLaunchLogin } from "@/lib/first-launch-login"
import { notALoginField } from "@/lib/not-a-login-field"
import { recoveryDocsUrl, type RecoveryKitReveal } from "@/lib/recovery-kit"

/**
 * The ways to keep Kiln's recovery kit: download it, save it in 1Password,
 * or copy its one line. Shown only while the kit is on screen.
 */
export const RecoveryKitSaveOptions = React.memo(
  function RecoveryKitSaveOptions({
    login,
    reveal,
  }: {
    /** The first administrator's new login, still in memory, if any. */
    login: FirstLaunchLogin | null
    reveal: RecoveryKitReveal
  }) {
    const [shown, setShown] = React.useState(false)
    const request = React.useMemo(
      () => onePasswordRequest(reveal, login, window.location.host),
      [reveal, login]
    )

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

    async function copy() {
      const failed = await recoverPromise(
        () => navigator.clipboard.writeText(reveal.text),
        (cause) => cause
      )
      showToast(
        failed
          ? {
              message: "Couldn't copy. Select it and copy instead.",
              type: "error",
            }
          : { message: "Recovery kit copied.", type: "success" }
      )
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
            <Button
              type="button"
              variant="outline"
              size="icon-lg"
              aria-label="Copy"
              onClick={() => void copy()}
            >
              <Copy />
            </Button>
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
 * What 1Password saves. On its own, a login item for the kit: the
 * installation ID as its username and the kit's line as its password, which
 * 1Password ties to this Hearth's address. Right after setup, while the new
 * administrator's login is still in memory, one item holds both, so 1Password
 * doesn't also ask to save the account; the sign-up form skips 1Password for
 * that reason. The button takes only the autofill names it lists, and
 * `recovery-code` isn't one, so the kit's line goes in the notes there.
 */
function onePasswordRequest(
  reveal: RecoveryKitReveal,
  login: FirstLaunchLogin | null,
  host: string
): OnePasswordSaveRequest {
  const what =
    reveal.kind === "kit"
      ? "Kiln's recovery kit"
      : "Kiln's recovery key (installation ID and platform backup key)"
  const restore =
    reveal.kind === "kit"
      ? `To restore Kiln on a new host, save ${login ? "the line below" : "this item's password"} to a file and run \`kiln-relay platform import-kit <file>\` before the new Relay's first start, then restore a platform backup.`
      : "To restore, set KILN_INSTALLATION_ID and KILN_PLATFORM_BACKUP_KEY from it, with the rest of Kiln's environment file, then restore a platform backup."
  const notes = [
    `${what} for ${host}. It's the only way to restore Kiln and read its backups if this machine is lost. Anyone holding it can read Kiln's data.`,
    "",
    restore,
    "",
    ...(login ? ["```", reveal.text, "```", ""] : []),
    `Steps: ${recoveryDocsUrl}`,
  ].join("\n")
  if (login) {
    return {
      fields: [
        { autocomplete: "username", value: login.email },
        { autocomplete: "current-password", value: login.password },
      ],
      notes,
      title: `Kiln (${host})`,
    }
  }
  return {
    fields: [
      { autocomplete: "username", value: reveal.installationId },
      { autocomplete: "current-password", value: reveal.text },
    ],
    notes,
    title: `Kiln recovery kit (${host})`,
  }
}
