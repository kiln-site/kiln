---
title: Copies between Relays
description: How Kiln copies a game server's files from one Relay to another, directly or through Hearth when the Relays can't reach each other.
---

When you move or duplicate a game server onto another Relay, its files go from
one Relay to the other. You start the copy from the game server's **Info** page,
with **Move or duplicate**. This page covers how the files travel and what can
stop them.

## How a copy travels

1. The source Relay packs the game server's folder into a compressed archive.
   A move stops the game server first; a duplicate stops it only if you chose
   **Stop while copying**.
2. Hearth gives the destination Relay a signed grant for that one archive, and
   the addresses it may fetch it from.
3. The destination fetches the archive straight from the source. Hearth stays
   out of the way when the Relays can reach each other.
4. The destination checks the archive against the checksum the source recorded,
   then unpacks it into the new game server's folder. Files keep their
   permissions.
5. Both Relays delete the archive.

A dropped connection, a busy source, or a restart doesn't start the copy over:
the destination picks up from what it already has. It keeps retrying for about
four minutes before it gives up.

## Relays that can't reach each other

The destination tries the source's addresses in turn: the one Hearth uses, the
one the source Relay advertises, and its public address for browsers. Last, it
tries Hearth itself, which passes the copy through to the source.

So a copy works even when the destination can't reach the source, such as two
Relays behind different home routers, as long as both reach Hearth. When the
copy goes through Hearth:

- Its bytes cross Hearth's network, and count against
  [Hearth's limits on what it carries](/relays/connections#relays-reached-through-hearth).
- Hearth passes on only requests carrying the grant it signed for that copy.
  The source Relay still checks the grant and the destination's identity itself.

## What stops a copy

Before it starts, Hearth checks both Relays and says what's wrong:

| Problem                                         | Fix                                                                    |
| ----------------------------------------------- | ---------------------------------------------------------------------- |
| A Relay is offline                              | Wait for it to reconnect, then try again.                              |
| A Relay can't copy files between Relays yet     | Update that Relay to the latest Kiln release.                          |
| Hearth isn't allowed to download or upload files on a Relay | Give Hearth's pairing on that Relay the action the message names. |
| Databases can't be copied as files              | Export the database's dump and import it on the other Relay.          |

The copy also has to fit. The destination needs room for the archive and the
unpacked files together, and the source needs room for the archive. Kiln counts
the archive at the folder's full size, since game worlds barely compress, and
checks both Relays' free disk before anything changes.

## Limits

A Relay serves at most 8 copies to other Relays at once, and 4 to any one Relay.

Cancelling a copy deletes what either Relay packed or fetched for it. Archives
nobody cleans up, as after a crash, are deleted after a day.
