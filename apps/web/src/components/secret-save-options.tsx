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
  type OnePasswordItem,
} from "@/components/onepassword-save-button"
import { useCopyFeedback } from "@/components/workspace-header"
import { notALoginField } from "@/lib/not-a-login-field"

/**
 * The ways to keep a secret that opens backups: copy it, download it, or save
 * it in 1Password. It's masked until asked, and shown only while it's on
 * screen.
 */
export const SecretSaveOptions = React.memo(function SecretSaveOptions({
  file,
  label,
  onePasswordItem,
  value,
}: {
  file: { readonly content: string; readonly name: string }
  label: string
  onePasswordItem: OnePasswordItem
  value: string
}) {
  const [shown, setShown] = React.useState(false)
  const { copied, copy } = useCopyFeedback(value)

  function download() {
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
          aria-label={label}
          readOnly
          type={shown ? "text" : "password"}
          value={value}
          onFocus={(event) => event.currentTarget.select()}
          className="h-9 min-w-0 flex-1 font-mono text-xs"
        />
        <Button
          type="button"
          variant="outline"
          size="icon-lg"
          aria-label={shown ? "Hide" : "Show"}
          onClick={() => setShown((current) => !current)}
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
        <OnePasswordSaveButton item={onePasswordItem} secret={value} />
      </div>
    </div>
  )
})
