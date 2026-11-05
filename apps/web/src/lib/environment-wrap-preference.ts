import { Result } from "effect"

const storageKey = "kiln:app-environment-wrap-lines:v1"

// Whether this browser wraps lines in an App's environment editor, kept apart
// from the file editor's. Long values read better wrapped, so it starts on.
export const environmentWrapPreference = {
  read: (): boolean =>
    Result.getOrElse(
      Result.try(() => window.localStorage.getItem(storageKey) !== "false"),
      () => true
    ),
  write: (wrapLines: boolean): void => {
    Result.try(() =>
      window.localStorage.setItem(storageKey, String(wrapLines))
    )
  },
}
