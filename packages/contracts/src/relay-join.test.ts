import { describe, expect, it } from "vite-plus/test"

import { decodeRelayJoinLink, encodeRelayJoinLink } from "./relay-join.js"

const link = {
  hearthOrigin: "https://kiln.example.com",
  secret: "abcdefghijklmnopqrs2",
}

describe("join links", () => {
  it.each([
    ["another scheme", encodeRelayJoinLink(link).replace("https:", "ftp:")],
    [
      "credentials",
      encodeRelayJoinLink(link).replace("https://", "https://user:pass@"),
    ],
    ["a path", encodeRelayJoinLink(link).replace(".com/#", ".com/hearth/#")],
    ["a query", encodeRelayJoinLink(link).replace(".com/#", ".com/?a=1#")],
    ["another version", encodeRelayJoinLink(link).replace("#kj1.", "#kj2.")],
    ["a short code", encodeRelayJoinLink({ ...link, secret: "short" })],
    [
      "a code with other letters",
      encodeRelayJoinLink({ ...link, secret: "ABCDEFGHIJKLMNOPQRS1" }),
    ],
    ["no code at all", "https://kiln.example.com/"],
    ["a placeholder", "<link>"],
  ])("refuse a link with %s", (_case, value) => {
    expect(decodeRelayJoinLink(value)).toBeNull()
  })
})
