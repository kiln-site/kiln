---
title: Activity history
description: See who did what on your Relays, game servers, databases, and apps, from Hearth or the CLI, and who can read that history.
---

The **Activity** page lists the actions taken on your Relays and the instances
on them: power changes, console commands, file changes, network changes,
updates, and more. Each entry shows when it happened, where, who did it, and
the action.

## What's recorded

Each Relay records the actions it carries out in its own database. Hearth asks
every Relay for its history when you open the page, so the list covers all
your Relays at once.

Entries are grouped by type, which you can filter on:

| Type            | Covers                                                                    |
| --------------- | ------------------------------------------------------------------------- |
| **Game Server** | Creating, renaming, reconfiguring, and deleting game servers.             |
| **Power**       | Starting, stopping, restarting, and killing game servers.                 |
| **Console**     | Commands sent to a game server's console.                                 |
| **Files**       | File uploads, downloads, and edits, and file transfers between Relays.    |
| **Network**     | Game server networking, and the Relay's networking, proxy, and Tailscale. |
| **Access**      | Relay pairing invitations and the Hearth clients paired with a Relay.     |
| **Relay**       | Other changes to the Relay, such as renaming it.                          |
| **Updates**     | Relay and system updates.                                                 |
| **System**      | Everything else.                                                          |

Each entry also records its source: **Web** for Hearth, **CLI** for the
[kiln CLI](/cli).

A game server copied with its history shows what happened to the server it
was copied from, up until the copy finished.

## Find an entry

- Choose an instance, or **All instances**, with the picker at the top.
- Search for an action, person, or instance.
- Open **Filters** to narrow by **Type**, **Source**, or **User**.
- Choose a date range from the calendar.

Open the menu on an entry to copy its timestamp, action, IDs, or the email of
the person who did it.

Each Relay returns at most 2,000 entries for a date range. When one hits that
limit, the page says so; choose a shorter range to see everything.

## Who can see it

| Who                                      | Sees                                                       |
| ---------------------------------------- | ---------------------------------------------------------- |
| Kiln Admins                              | Everything on every Relay.                                 |
| People with **View Relay activity**      | Everything on that Relay, including its databases and apps. |
| People with **View server**              | The game servers they can see.                             |

Entries on resources you can't see are left out, so the list may not show
everything that happened on a Relay. See
[Roles and permissions](/access/permissions).

## When a Relay is offline

The history lives on each Relay, so Hearth can only show it while the Relay is
connected. When it can't reach one, the page shows **Could not reach** with
the Relay's name, and lists the rest.

## From the CLI

```sh
kiln activity list --limit 200
```

The CLI shows the same history your account can see. See
[CLI commands](/cli/commands#activity).
