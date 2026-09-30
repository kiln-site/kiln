import { kilnCliPackageName } from "@workspace/contracts"

export const cliPackageName = kilnCliPackageName(process.env.KILN_CLI_PACKAGE)
export const cliDefaultUrl =
  process.env.KILN_CLI_DEFAULT_URL ?? "https://kiln.site"
