import { describe, expect, it } from "vite-plus/test"

import { appEnvironmentVariables, appEnvironmentWith } from "./app-environment"

const written = [
  "# Mail",
  "SMTP_HOST=mail.example.test",
  'export GREETING="hello there"',
  "not a variable",
  "MODE=staging",
  "MODE=production",
  "",
].join("\n")

describe("an App's environment", () => {
  it("is read as a Relay reads it when it deploys", () => {
    expect(appEnvironmentVariables(written)).toEqual({
      GREETING: "hello there",
      MODE: "production",
      SMTP_HOST: "mail.example.test",
    })
  })

  it("changes by variable, leaving every other line as it was written", () => {
    const changed = appEnvironmentWith(written, ["SMTP_HOST"], {
      MODE: "review",
      PADDED: " kept ",
      QUOTED: '"as is"',
    })
    expect(changed).toBe(
      [
        "# Mail",
        'export GREETING="hello there"',
        "not a variable",
        "MODE=review",
        'PADDED=" kept "',
        'QUOTED=""as is""',
        "",
      ].join("\n")
    )
    // What was set is what a container gets, whatever it holds.
    expect(appEnvironmentVariables(changed)).toEqual({
      GREETING: "hello there",
      MODE: "review",
      PADDED: " kept ",
      QUOTED: '"as is"',
    })
    expect(appEnvironmentWith("", [], {})).toBe("")
  })
})
