/**
 * The signed-in account's email as a hidden username, placed just before a
 * field that asks for the account password again. Password managers pair a
 * password with the text field before it; without this they take whatever
 * comes first, like a typed name, and offer to save it as a new login.
 */
export function AccountUsernameField({ email }: { email: string }) {
  return (
    <input
      type="text"
      name="username"
      autoComplete="username"
      value={email}
      readOnly
      hidden
    />
  )
}
