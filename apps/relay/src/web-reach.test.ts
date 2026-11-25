import { expect, it } from "vite-plus/test"

import { isPublicAddress, webReachable } from "./web-reach.js"

// A host comes from another Relay, so asking about one must never open a
// connection into this Relay's own network.
it("never asks an address inside its own network", async () => {
  for (const address of [
    "127.0.0.1",
    "10.0.0.5",
    "172.16.4.1",
    "192.168.1.1",
    "100.64.0.1",
    "169.254.169.254",
    "0.0.0.0",
    "::1",
    "fd00::1",
    "fe80::1",
    "::ffff:127.0.0.1",
    "::ffff:169.254.169.254",
  ]) {
    expect(isPublicAddress(address), address).toBe(false)
  }
  expect(isPublicAddress("51.81.86.11")).toBe(true)
  expect(await webReachable("127.0.0.1")).toBe(false)
  expect(await webReachable("localhost")).toBe(false)
})
