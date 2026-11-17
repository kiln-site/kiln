/**
 * The email and password the first administrator just chose, held in this
 * tab's memory between creating the account and saving Kiln's recovery kit,
 * so 1Password can save both as one item. Never stored, never sent: it lives
 * in this module until the step ends or the page reloads, whichever is first.
 */
export interface FirstLaunchLogin {
  readonly email: string
  readonly password: string
}

let login: FirstLaunchLogin | null = null

export function rememberFirstLaunchLogin(next: FirstLaunchLogin) {
  login = next
}

export function firstLaunchLogin(): FirstLaunchLogin | null {
  return login
}

export function forgetFirstLaunchLogin() {
  login = null
}
