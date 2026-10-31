---
title: Users and access
description: Invite people, choose what they can do on each Relay, game server, and database, and see who did what.
---

Everyone signs in to Hearth with their own account. What they can do adds up
from their platform role, the permissions they're granted, and what they own.
You manage all three on the **Access** page.

## Invite someone

1. Open **Access** and pick the game server, database, or Relay to share.
2. Click **Add user** and enter their email. Kiln Admins also choose a
   platform role.
3. Add [permissions](#permissions) or a preset. **Add resource** shares more
   in the same invitation.
4. Click **Send invitation**.

Nothing is granted until they accept, within 7 days. The invitation reaches
them by email, and in their notifications if they have an account. You can
also copy it with **Invitation Link** in the row's **More actions** menu.

> [!NOTE]
> Hearth sends email only with a Resend API key (`RESEND_API_KEY` and
> `RESEND_FROM_EMAIL`). Without one, share the links yourself.

To accept, open the link, sign in, and click **Accept invitation**. Inviting a
new email creates an account to claim from the emailed setup link, or from a
link a Kiln Admin makes with **Issue claim link** on the person's **Account**
tab. The account must be verified, by the emailed code, a claim link, or a
Kiln Admin's **Verify manually**, before it can use anything. Public sign-up
is off unless Hearth sets `KILN_ENABLE_SIGNUPS=true`.

## Roles and owners

| Platform role     | Allows                                                                                  |
| ----------------- | --------------------------------------------------------------------------------------- |
| **Kiln Admin**    | Everything: every Relay, game server, app, and database, every user, and Hearth itself. |
| **Relay Creator** | Pairing new Relays, which they then own.                                                |
| **User**          | Only what's granted to them.                                                            |

Whoever sets up Kiln is its first Kiln Admin.

The owner of a Relay, game server, or database holds every permission on it.
An app's owner can see, delete, and transfer it; changing it takes app
permissions on its Relay. To hand something over, choose **Transfer
ownership** in the row's **More actions** menu. Only the owner or a Kiln Admin
can, and only to someone with access.

## Permissions

Granted on a Relay, permissions cover it and every current and future game
server, database, and app on it. Granted on a game server or database, they
cover only that one. Permissions from different places add together.

In the invitation or **Edit permissions** dialog, search by name or key, such
as `instance.files`, and pick a permission, a preset, or an **All** group,
which also covers permissions Kiln adds later. The dialog shows what each
choice **Also grants**. You can only grant what you hold.

Kiln's presets are **Observer** (look, but no downloads or credentials),
**Operator** (run things, but not manage people or delete), and
**Administrator** (everything on the resource, but not ownership). Save your
own with **Create preset** on the **Presets** tab. Editing a preset changes
everyone it's assigned to.

| Area (keys)                         | Granted on          | Permissions                                                                                                                                                                                                                                                                                                                                       |
| ----------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Relay (`relay.*`)                   | Relay               | View Relay, Configure Relay, Update Relay, Pause or resume Relay, Remove Relay, View Relay connections, Manage Relay connections, View Relay activity, View Relay logs, Open host terminal, View Relay database, View host files, Edit host files, Mount host files, Create servers, Create databases, Create apps                                   |
| Game server (`instance.*`)          | Relay, game server  | View server, Start server, Stop server, Restart server, Force stop server, View console, Send commands, View and download files, Edit files, Delete files, Change file permissions, Connect using SFTP, View configuration, Manage configuration, Manage resource limits, View saved logs, Share logs, View server network, Manage server network, Assign public ports, Delete server |
| Database (`database.*`)             | Relay, database     | View database, Control database power, View database credentials, Reset database password, View database network, Manage database network, Export database data, Import database data, Browse database tables, Edit database tables, Use database terminal, View database logs, Manage resource limits, Delete database                            |
| Apps (`app.*`)                      | Relay, for all apps | View apps, Configure and deploy apps, View app logs, Open app shells, View app files, Edit app files, Delete apps                                                                                                                                                                                                                                  |
| People (`access.*`, `preset.*`)     | Any                 | View users, Invite users, Manage access, View presets, Create or copy presets, Manage presets                                                                                                                                                                                                                                                     |
| Backups, schedules (`backup.*`, `schedule.*`) | Any       | View backups, Create backups, Download backups, Restore backups, Delete backups, View schedules, Create schedules, Edit schedules, Run schedules, Delete schedules                                                                                                                                                                                 |

A schedule also needs permission for its action on each target. The
[CLI](/cli) and SFTP use the same permissions.

> [!CAUTION]
> Hearth marks **Open host terminal**, **View host files**, **Edit host
> files**, **Mount host files**, **View Relay database**, **Configure and
> deploy apps**, and **Open app shells** as **Host access**. Grant them only to
> people you'd trust with root on the Relay's machine.

## Change or remove access

On **Access**, use the row's **Edit permissions** or **Revoke access**.
Revoking someone marked **From Relay** on a game server or database leaves
their Relay access.

Kiln Admins manage accounts under **Platform users** in the picker:
**Disable account** blocks sign-in and keeps their access, **Remove from
Kiln** removes them (transfer what they own first), and **Platform role** on
the **Account** tab changes their role.

In **Settings → Account**, you can change your password, add an
**Authenticator app** or **Passkeys**, end **Active sessions**, and
**Unlink** a linked CLI.

## Activity history

The **Activity** page lists who did what on your Relays and instances, from
Hearth (**Web**) or the **CLI**. Filter by instance, **Type**, **Source**,
**User**, and date, or search.

Kiln Admins see everything, **View Relay activity** shows a whole Relay, and
**View server** shows that game server. History lives on each Relay, so an
offline one shows **Could not reach**. Each Relay returns up to 2,000 entries
per date range; the page says when to narrow it. `kiln activity list` shows
the same.

## Notifications

The bell in Hearth's toolbar opens your notifications. Kiln notifies you
when:

- Kiln has an update, or was updated (Kiln Admins only).
- An app's image tag points at a newer image, or someone else or Kiln deployed
  an app.
- Kiln finds [vulnerabilities](/access/security) in something you can update.
- A database outgrows its disk limit. It keeps running, so Kiln warns you.
- A game server move or copy ends. After a move, it offers to delete the old
  one.
- Someone invites you, or removes your access.

In **Settings → Notifications**, turn each one's **In Kiln** and **Push**
switches on or off. Under **Security**, choose the **Least severe**
vulnerability that notifies you (**High and critical** by default).

### Push notifications

Push is per device and browser. Under **Delivery**, click **Enable push** and
allow notifications. If the browser blocks them, allow Kiln in its site
settings first. **Skip push while I'm active** holds back what you already
saw in Hearth.

> [!NOTE]
> On iPhone and iPad, push works only from the Home Screen app. In Safari, tap
> **Share**, then **Add to Home Screen**, and open Kiln from there.
