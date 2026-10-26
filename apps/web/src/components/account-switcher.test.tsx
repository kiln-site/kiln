import { renderToStaticMarkup } from "react-dom/server"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { expect, it, vi } from "vite-plus/test"

import { AccountSwitcherSection } from "@/components/account-switcher"
import type { AuthenticatedUser } from "@/lib/auth-session"
import {
  browserAccountsQueryKey,
  type BrowserAccount,
} from "@/lib/browser-accounts"

vi.mock("@/server/browser-accounts", () => ({
  getBrowserAccounts: vi.fn(),
  switchBrowserAccountSession: vi.fn(),
}))

it("keeps every account in its row as the active account changes", () => {
  const accounts: Array<BrowserAccount> = ["charlie", "alice", "bob"].map(
    (name) => ({
      active: false,
      email: `${name}@example.test`,
      name,
      sessionId: `session-${name}`,
      userId: name,
    })
  )

  for (const activeAccount of accounts) {
    const client = new QueryClient()
    client.setQueryData(
      browserAccountsQueryKey,
      accounts.map((account) => ({
        ...account,
        active: account.userId === activeAccount.userId,
      }))
    )
    const user: AuthenticatedUser = {
      email: activeAccount.email,
      emailVerified: true,
      id: activeAccount.userId,
      isDevelopmentBypass: false,
      name: activeAccount.name,
      role: "user",
      twoFactorEnabled: false,
    }
    try {
      const markup = renderToStaticMarkup(
        <QueryClientProvider client={client}>
          <AccountSwitcherSection user={user} onNavigate={() => {}} />
        </QueryClientProvider>
      )
      const emails = [...new Set(markup.match(/\w+@example\.test/g))]
      expect(emails).toEqual(accounts.map(({ email }) => email))
      const currentRow = markup.match(
        /<button\b[^>]*aria-current="true"[^>]*>(.*?)<\/button>/s
      )?.[1]
      expect(currentRow).toContain(activeAccount.email)
    } finally {
      client.clear()
    }
  }
})
