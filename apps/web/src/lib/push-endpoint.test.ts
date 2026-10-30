import { describe, expect, it } from "vite-plus/test"

import { isPushServiceEndpoint } from "@/lib/push-endpoint"

// Hearth posts to whatever endpoint a browser hands it, so only real push
// services may get through.
describe("isPushServiceEndpoint", () => {
  it("refuses anything that could reach another host", () => {
    for (const endpoint of [
      "http://fcm.googleapis.com/fcm/send/abc",
      "https://fcm.googleapis.com:8443/fcm/send/abc",
      "https://user:pass@fcm.googleapis.com/fcm/send/abc",
      "https://fcm.googleapis.com.attacker.test/fcm/send/abc",
      "https://attackerpush.apple.com/abc",
      "https://notify.windows.com.attacker.test/w",
      "https://127.0.0.1/abc",
      "https://[::1]/abc",
      "https://localhost/abc",
      "https://mysql:3306/",
      // Escapes in the host that WHATWG URL decodes into an allowed host, but
      // Node's legacy parser, which web-push uses, stops at.
      "https://127.0.0.1%2eweb.push.apple.com/probe",
      "https://mysql%2enotify.windows.com/probe",
      "https://FCM.googleapis.com/fcm/send/abc",
      "https://fcm.googleapis.com./fcm/send/abc",
      "https://fcm.googleapis.com\\@127.0.0.1/abc",
      "file:///etc/passwd",
      "not a url",
      "",
    ])
      expect(isPushServiceEndpoint(endpoint), endpoint).toBe(false)
  })
})
