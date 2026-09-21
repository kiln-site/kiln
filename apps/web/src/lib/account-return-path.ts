import { Result } from "effect"

export function accountReturnPath(value: string | undefined): string {
  if (!value?.startsWith("/")) return "/"
  return Result.try(() => new URL(value, "https://kiln.invalid")).pipe(
    Result.match({
      onFailure: () => "/",
      onSuccess: (parsed) =>
        parsed.origin === "https://kiln.invalid"
          ? `${parsed.pathname}${parsed.search}${parsed.hash}`
          : "/",
    })
  )
}
