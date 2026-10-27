---
title: Connections
description: Choose whether Hearth connects to a Relay or the Relay connects to Hearth, so machines behind a router work without forwarding ports.
---

Hearth and each Relay keep one connection open. Either side can open it:

- **The Relay connects to Hearth.** It only needs to reach Hearth, so it works
  behind a router with no ports forwarded. Relays added with the install command
  prefer this.
- **Hearth connects to the Relay.** Hearth must reach the Relay's address and
  port.

When the preferred side can't connect, the other one does.

## Change which side connects

The Relay's **Info** page shows **Connection**: which side connected, or **Not
connected**. To change it:

1. Choose **Configure** on the **Info** page or in the Relay's row.
2. Set **Who connects**.
3. Choose **Save changes**.

## Relays reached through Hearth

When your browser can't reach a Relay, its consoles, file transfers, and backup
downloads go through Hearth. That needs no open ports, but:

- Everything you transfer crosses Hearth's network too.
- Hearth carries at most 8 transfers per Relay and 64 in all. A transfer that
  can't get room in 5 seconds fails; try again. One idle for 60 seconds ends.
- Players and visitors still connect to the machine, so game server ports and app
  domains there still need forwarding.

The Relay's **Connection** details show what Hearth carries for it, including
transfers **Turned away**.

## Settings on Hearth

| Variable                                  | What it does                                                     |
| ----------------------------------------- | ---------------------------------------------------------------- |
| `KILN_RELAY_DIAL_URL`                     | The address Relays connect to, when it isn't `KILN_URL`.         |
| `KILN_RELAY_PASSTHROUGH_MAX`              | Transfers Hearth carries at once for all Relays. Default 64.     |
| `KILN_RELAY_PASSTHROUGH_BYTES_PER_SECOND` | Caps all transfers through Hearth together. Off unless set.      |

Relays don't connect to a Hearth whose `KILN_URL` is on `localhost`.
