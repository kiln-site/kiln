import { describe, expect, it } from "vite-plus/test"

import {
  decodeRelayJoinLink,
  encodeRelayJoinLink,
  redactRelayJoinLink,
} from "./relay-join.js"

const link = {
  clientId: "c".repeat(43),
  expiresAt: 1_792_840_577_622,
  hearthOrigin: "https://kiln.example.com",
  joinId: "0e0f6703-46db-4677-b84c-138997bc25a9",
  secret: "s".repeat(43),
}

describe("join links", () => {
  it("carry Hearth's origin, the join, its secret, its client, and its expiry", () => {
    const encoded = encodeRelayJoinLink(link)

    expect(decodeRelayJoinLink(encoded)).toEqual(link)
    expect(decodeRelayJoinLink(`  ${encoded}\n`)).toEqual(link)
    expect(
      decodeRelayJoinLink(
        encodeRelayJoinLink({
          ...link,
          hearthOrigin: "http://203.0.113.7:3000",
        })
      )
    ).toEqual({ ...link, hearthOrigin: "http://203.0.113.7:3000" })
    expect(redactRelayJoinLink(link)).not.toContain(link.secret)
  })

  it.each([
    ["another scheme", encodeRelayJoinLink(link).replace("https:", "ftp:")],
    [
      "credentials",
      encodeRelayJoinLink(link).replace("https://", "https://user:pass@"),
    ],
    ["a path", encodeRelayJoinLink(link).replace(".com/#", ".com/hearth/#")],
    ["a query", encodeRelayJoinLink(link).replace(".com/#", ".com/?a=1#")],
    ["another version", encodeRelayJoinLink(link).replace("=v1.", "=v2.")],
    ["a part too many", `${encodeRelayJoinLink(link)}.extra`],
    ["a short secret", encodeRelayJoinLink({ ...link, secret: "short" })],
    [
      "a bad client",
      encodeRelayJoinLink({ ...link, clientId: "c/".repeat(22) }),
    ],
    ["a bad join", encodeRelayJoinLink({ ...link, joinId: "not-a-uuid" })],
    [
      "an expiry that isn't a number",
      encodeRelayJoinLink(link).replace(/\d+$/u, "soon"),
    ],
    ["no join at all", "https://kiln.example.com/"],
  ])("refuse a link with %s", (_case, value) => {
    expect(decodeRelayJoinLink(value)).toBeNull()
  })
})
