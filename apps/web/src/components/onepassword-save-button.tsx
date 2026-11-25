import * as React from "react"

import { cn } from "@workspace/ui/lib/utils"

import { recoverPromise } from "@/effect/promise"

/** What names a secret saved in 1Password. */
export interface OnePasswordItem {
  /** The item's key name: what the secret belongs to. */
  readonly name: string
  readonly notes: string
  readonly title: string
  /** The item's hostname. */
  readonly url: string
}

/**
 * A 1Password save request; see `@1password/save-button`. It makes an API
 * Credential item, which 1Password never offers to fill a sign-in, so it stays
 * apart from the person's own login, with the secret as its masked
 * credential. 1Password reads only its title, notes and fields, each field an
 * HTML autofill name it places in the item's own fields: it takes no labels of
 * ours, and no websites.
 */
function saveRequest(
  { name, notes, title, url }: OnePasswordItem,
  secret: string
) {
  return {
    fields: [
      { autocomplete: "username", value: name },
      { autocomplete: "current-password", value: secret },
      { autocomplete: "url", value: url },
    ],
    notes,
    title,
  }
}

/**
 * 1Password's own "Save in 1Password" button. Its script loads only once
 * this mounts, in the browser, and the button stays out of sight until the
 * 1Password extension enables it: without the extension there's nothing to
 * see, rather than a button that does nothing.
 *
 * The element draws itself once, from the attributes it's connected with,
 * so it's made here with its final request, and made again for a new one.
 */
export const OnePasswordSaveButton = React.memo(function OnePasswordSaveButton({
  item,
  secret,
}: {
  item: OnePasswordItem
  secret: string
}) {
  const container = React.useRef<HTMLDivElement>(null)
  const [enabled, setEnabled] = React.useState(false)
  const requestJson = JSON.stringify(saveRequest(item, secret))

  React.useEffect(() => {
    let cancelled = false
    let element: HTMLElement | null = null
    let observer: MutationObserver | null = null
    // Without its script (offline, blocked), there's simply no button.
    void recoverPromise(
      async () => {
        const { activateOPButton, encodeOPSaveRequest } =
          await import("@1password/save-button")
        const host = container.current
        // Its types list the autofill names as a const enum, which can't be
        // named across modules, and leave out `recovery-code`.
        const value = encodeOPSaveRequest(
          JSON.parse(requestJson) as Parameters<typeof encodeOPSaveRequest>[0]
        )
        if (cancelled || !host || !value) return
        element = document.createElement("onepassword-save-button")
        element.setAttribute("data-onepassword-type", "api-key")
        element.setAttribute("value", value)
        element.setAttribute(
          "data-theme",
          document.documentElement.classList.contains("light")
            ? "light"
            : "dark"
        )
        element.setAttribute("padding", "compact")
        host.replaceChildren(element)
        const button = element.shadowRoot?.querySelector(
          "button[data-onepassword-save-button]"
        )
        if (!button) return
        const check = () => setEnabled(!button.hasAttribute("disabled"))
        observer = new MutationObserver(check)
        observer.observe(button, {
          attributeFilter: ["disabled"],
          attributes: true,
        })
        // A page that adds the button after loading tells 1Password so.
        activateOPButton()
        check()
      },
      () => undefined
    )
    return () => {
      cancelled = true
      observer?.disconnect()
      element?.remove()
      setEnabled(false)
    }
  }, [requestJson])

  return (
    <div
      ref={container}
      aria-hidden={!enabled}
      inert={!enabled}
      className={cn(
        "flex",
        !enabled &&
          "pointer-events-none absolute size-px overflow-hidden opacity-0"
      )}
    />
  )
})
