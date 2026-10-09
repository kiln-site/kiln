import { describe, expect, it } from "vite-plus/test"

import { parseReleaseNotes } from "@/lib/release-notes"

const pull = (number: number) =>
  `https://github.com/kiln-site/kiln/pull/${number}`

describe("parseReleaseNotes", () => {
  it("reads GitHub generated notes and counts maintenance work", () => {
    const parsed = parseReleaseNotes(
      [
        "## What's Changed",
        `* feat(web): in-app notifications by @QarthO in ${pull(348)}`,
        `* fix(relay): keep SFTP sessions alive by @QarthO in ${pull(345)}`,
        `* fix(relay): keep SFTP sessions alive by @QarthO in ${pull(345)}`,
        `* ci(repo): update agent skills by @QarthO in ${pull(346)}`,
        `* @someone made their first contribution in ${pull(340)}`,
        "* Upgraded the base image",
        "",
        "**Full Changelog**: https://github.com/kiln-site/kiln/compare/a...b",
      ].join("\r\n")
    )

    expect(parsed).toEqual({
      changes: [
        {
          group: "new",
          key: "pr:348",
          pullRequest: 348,
          scope: "web",
          title: "In-app notifications",
        },
        {
          group: "fixed",
          key: "pr:345",
          pullRequest: 345,
          scope: "relay",
          title: "Keep SFTP sessions alive",
        },
        {
          group: "other",
          key: "text:Upgraded the base image",
          pullRequest: null,
          scope: null,
          title: "Upgraded the base image",
        },
      ],
      hiddenCount: 1,
    })
  })

  it("only takes pull request numbers from GitHub pull request links", () => {
    const parsed = parseReleaseNotes(
      "* fix(web): escape titles by @QarthO in javascript:alert(1)"
    )

    expect(parsed.changes).toEqual([
      {
        group: "fixed",
        key: "text:fix(web): escape titles by @QarthO in javascript:alert(1)",
        pullRequest: null,
        scope: "web",
        title: "Escape titles by @QarthO in javascript:alert(1)",
      },
    ])
  })
})
