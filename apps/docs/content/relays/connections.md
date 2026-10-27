---
title: Connections
description: Choose whether Hearth connects to a Relay or the Relay connects to Hearth, so machines behind a router work without forwarding ports.
---

Hearth and each Relay keep one control connection open between them. Either
side can open it:

- **Hearth connects to the Relay.** Hearth must be able to reach the Relay's
  address and port.
- **The Relay connects to Hearth.** The Relay only needs to reach Hearth's
  address, so it works behind a home router or firewall with no ports forwarded.

Each Relay prefers one side and falls back to the other. Relays added with the
install command prefer to connect to Hearth themselves. Relays paired before
Kiln could do this are still reached by Hearth. Every Relay keeps trying to
connect to Hearth as a standby, so one whose address stops working reconnects
on its own.

## See which side connected

Open the Relay's **Info** page. **Connection** says which side opened the
current connection:

- **The Relay connects to Hearth**
- **Hearth connects to the Relay**
- **Not connected**

Select it for details: which side the Relay **Prefers**, and how much traffic
Hearth is carrying for it, if any.

## Change which side connects

1. Open the Relay's **Info** page and choose **Configure**, or choose
   **Configure** in the Relay's row on the Relays page.
2. Set **Who connects** to **The Relay connects to Hearth** or **Hearth connects
   to the Relay**.
3. Choose **Save changes**.

The Relay reconnects, and the side you chose opens the next connection.

Choose **The Relay connects to Hearth** when the Relay's machine is behind a
router or firewall you can't forward ports through. Either way, when the
preferred side can't connect, the other one does.

## Relays reached through Hearth

When Hearth can't reach a Relay's machine while adding it, the Add Relay dialog
says so, and the Relay connects to Hearth instead. Your browser can't reach that
Relay either, so its consoles, file uploads and downloads, and backup downloads
go through Hearth. For each one, Hearth asks the Relay, over its connection, to
open a tunnel back to Hearth, and passes the traffic through unchanged.

This works with no ports open on the Relay's machine, with a few costs:

- **Bandwidth.** Everything you upload or download on that Relay crosses
  Hearth's network too.
- **Limits.** Hearth carries at most 8 transfers to one Relay at once, and 64
  across all Relays. Past that, a transfer waits up to 5 seconds for room, then
  fails, and you can try again. A transfer that moves nothing for 60 seconds is
  ended.
- **Websites and game ports.** Players and visitors still connect to the
  machine itself. A game server's ports and an app's domains on that machine
  need ports forwarded, as before.

The Relay's **Connection** details show what Hearth carries for it: transfers
open, bytes carried, and transfers **Turned away** while Hearth was full, since
Hearth last started.

## Settings on Hearth

These go in Hearth's environment:

| Variable                                  | What it does                                                                                       |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `KILN_RELAY_DIAL_URL`                     | The address Relays connect to, when it differs from `KILN_URL`, such as an internal address.       |
| `KILN_RELAY_PASSTHROUGH_MAX`              | How many transfers Hearth carries for all Relays at once. The default is 64.                       |
| `KILN_RELAY_PASSTHROUGH_BYTES_PER_SECOND` | Caps all transfers through Hearth together, for a Hearth on a metered or small machine. Off unless set. |

Hearth doesn't ask Relays to connect to it when `KILN_URL` is on `localhost`.
