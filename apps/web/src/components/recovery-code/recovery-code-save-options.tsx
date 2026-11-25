import * as React from "react"

import type { OnePasswordItem } from "@/components/onepassword-save-button"
import { SecretSaveOptions } from "@/components/secret-save-options"
import {
  recoveryCodeFile,
  recoveryCodePurpose,
  recoveryDocsUrl,
  type RecoveryCodeReveal,
} from "@/lib/recovery-code"

/** The ways to keep Kiln's recovery code. */
export const RecoveryCodeSaveOptions = React.memo(
  function RecoveryCodeSaveOptions({ reveal }: { reveal: RecoveryCodeReveal }) {
    const item = React.useMemo(() => onePasswordItem(window.location), [])
    const file = React.useMemo(
      () => recoveryCodeFile(reveal, window.location.host),
      [reveal]
    )
    return (
      <SecretSaveOptions
        file={file}
        label="Recovery code"
        onePasswordItem={item}
        value={reveal.code}
      />
    )
  }
)

/** It's named for this Hearth's address, which outlasts a restore as it does. */
function onePasswordItem({
  host,
  origin,
}: Pick<Location, "host" | "origin">): OnePasswordItem {
  return {
    name: host,
    notes: [recoveryCodePurpose, "", `Restoring: ${recoveryDocsUrl}`].join(
      "\n"
    ),
    title: `Kiln recovery code (${host})`,
    url: origin,
  }
}
