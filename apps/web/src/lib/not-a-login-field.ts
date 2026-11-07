/**
 * Spread onto a field that holds something other than the user's Kiln login,
 * like a provider secret, a Mac account, or a name, so password managers
 * neither fill it nor offer to save it. There's no standard for this:
 * browsers ignore `autocomplete="off"` on login-looking fields, so the vendor
 * attributes cover 1Password, Bitwarden, Dashlane, and LastPass.
 */
export const notALoginField = {
  autoComplete: "off",
  "data-1p-ignore": "true",
  "data-bwignore": "true",
  "data-form-type": "other",
  "data-lpignore": "true",
} as const
