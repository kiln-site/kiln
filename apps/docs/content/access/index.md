---
title: Users and access
description: Invite people to your Kiln, choose what they can do on each Relay, game server, and database, and secure their accounts.
---

Everyone who uses Hearth signs in with their own account. What they can see
and do comes from three places, which add together:

- Their **platform role**, which applies across all of Kiln.
- **Permissions** on a Relay, game server, or database, given when they're
  invited.
- **Ownership** of the Relays they paired and the instances they created.

You manage all three on the **Access** page.

## Platform roles

Every account has one platform role. Kiln Admins set it.

| Role              | What it allows                                                                                 |
| ----------------- | ---------------------------------------------------------------------------------------------- |
| **Kiln Admin**    | Everything in Kiln: every Relay, game server, app, and database, every user, and Hearth itself. |
| **Relay Creator** | Pair new Relays. They own each Relay they pair and hold every permission on it.                 |
| **User**          | Only the access granted to them.                                                               |

The person who sets up a new Kiln is its first Kiln Admin.

## Owners

Every Relay, game server, database, and app has an owner: the person who
paired the Relay or created the resource. The owner of a Relay, game server,
or database holds every permission on it, whatever their other access says.

An app's owner can see the app and its logs, delete it, and transfer it.
Configuring and deploying an app, opening its shell, and editing its files
take app permissions on its Relay, because those can reach the Relay's host.

To hand a resource to someone else, open the resource on the **Access** page,
open the **More actions** menu on their row, and choose **Transfer ownership**.
Only the owner or a Kiln Admin can transfer, and only to someone who already
has access there.

## Invite someone

1. Open **Access**.
2. Use the picker to choose the game server, database, or Relay you want to
   share.
3. Click **Add user**.
4. Enter their email address. Kiln Admins also choose a platform role here.
5. Add permissions or a preset for the resource. To share more resources in
   the same invitation, click **Add resource**. See
   [Roles and permissions](/access/permissions).
6. Click **Send invitation**.

Access granted on a Relay applies to all current and future game servers and
databases on that Relay.

The person gets an invitation for each resource. Nothing is granted until they
accept it, and an invitation expires after 7 days.

- If Hearth can send email, they get a link by email.
- If they already have an account, the invitation also appears in their
  notifications, with **Accept** and **Decline**.
- You can copy the link yourself: open the **More actions** menu on their row
  and choose **Invitation Link**.

Kiln Admins can also accept an invitation on someone's behalf with **Accept
invitation for them** on their row.

> [!NOTE]
> Hearth sends email only when it's set up with a Resend API key
> (`RESEND_API_KEY` and `RESEND_FROM_EMAIL`). Without one, share the invitation
> link yourself.

### See every user

Kiln Admins can list every account: open **Access**, open the picker, and
choose **Platform users**. The list shows each person's role and how many
instances they can reach.

## Accept an invitation

Open the invitation link, sign in, and click **Accept invitation**.

If you're signed in as someone else, Hearth says so and offers **Sign out and
continue**.

### Claim an invited account

Inviting someone who has no account creates one for their email address,
waiting to be claimed. Claiming it sets your name and password.

- If Hearth can send email, it sends you an account setup link. Verify your
  email, then choose your name and password.
- If it can't, ask a Kiln Admin for your account setup link. They open
  **Access**, choose **Platform users**, open you, and on the **Account** tab
  click **Issue claim link**.

Your invitations wait for you while you claim the account.

## Account verification

An account must be verified before it can use anything it was granted. Until
then, Hearth shows **Verify your account**.

- With email set up, Hearth sends a six-digit code to confirm the address.
- Redeeming a claim link from a Kiln Admin verifies the account.
- A Kiln Admin can also open the person from **Platform users** and click
  **Verify manually** on the **Account** tab.

Public sign-up is off. People join a Kiln by invitation unless the operator
sets `KILN_ENABLE_SIGNUPS=true` on Hearth.

## Change or remove access

On the **Access** page, choose the resource, then use the row's actions:

- **Edit permissions** changes what they can do there.
- **Revoke access** removes them from that resource. For a pending invitation
  it's **Cancel invitation**.

Someone with access through the Relay shows **From Relay** on a game server or
database. Revoking their direct access there leaves the Relay's access in
place.

Kiln Admins manage whole accounts from **Platform users**:

- **Disable account** signs the person out and blocks sign-in. Their access is
  kept, and **Enable account** restores it.
- **Remove from Kiln** cancels their invitations and removes them from the
  list. Transfer what they own first.
- On the **Account** tab, **Platform role** changes their role.

## Secure your account

Open **Settings → Account**.

- **Password**: change your password. Your other sessions are signed out.
- **Authenticator app**: click **Set up**, confirm your password, scan the QR
  code, save your recovery codes, and enter the current six-digit code. After
  that, every sign-in asks for a code. If you lose your device, sign in with a
  recovery code instead.
- **Passkeys**: add a passkey to sign in with your device instead of a
  password.
- **Active sessions**: see where you're signed in, revoke one, or **Log out
  everywhere**.
- **Linked CLIs**: see each [linked CLI](/cli/authentication) and **Unlink** it.
