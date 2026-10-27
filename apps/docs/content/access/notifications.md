---
title: Notifications
description: Get told in Hearth and on your devices about invitations, updates, deployments, disk limits, and vulnerabilities, and choose which ones reach you.
---

Kiln tells you about things that need your attention in two places: the
inbox in Hearth, and push notifications on your devices.

## The inbox

The bell in Hearth's toolbar shows how many notifications you haven't read.
Click it to see the latest, or **View all notifications** to open the
**Notifications** page.

- Clear one notification with its clear button, or all of them with **Clear
  all**.
- Invitations have **Accept** and **Decline** buttons, so you can answer them
  from the inbox.
- A vulnerability report's **Review** button opens the Security page. If you
  aren't a Kiln Admin, the report links to the resources it names instead.
  See [Vulnerability scanning](/access/security).

## What sends a notification

| Group         | Notification                     | Sent when                                                                                     |
| ------------- | -------------------------------- | --------------------------------------------------------------------------------------------- |
| **Kiln**      | **Update available**             | A new stable Kiln release is out. Kiln Admins only.                                           |
| **Kiln**      | **Updated**                      | Kiln was updated to a newer version. Kiln Admins only.                                        |
| **Apps**      | **Update available**             | An app's image tag points at a newer image than the one it runs.                              |
| **Apps**      | **Deployments**                  | An app finished deploying, and someone else, or Kiln itself, started the deployment.          |
| **Security**  | **Vulnerability reports**        | Kiln found new vulnerabilities in something you can update.                                   |
| **Resources** | **Disk limit warnings**          | A database outgrew its disk limit. Databases keep running past it, so Kiln warns you instead. |
| **Resources** | **Game Server moves and copies** | A game server copy or move finished, failed, or was cancelled.                                |
| **Access**    | **Invitations**                  | Someone invited you to a resource.                                                            |
| **Access**    | **Access removed**               | Someone removed your access to a resource.                                                    |

After a game server moves, its notification offers to delete the server it
left behind.

## Choose what reaches you

Open **Settings → Notifications**, or click the settings button in the inbox.
Each notification has two switches:

- **In Kiln** puts it in your inbox.
- **Push** also sends it to your devices. It needs **In Kiln** on.

Everything starts on. **Invitations** and **Game Server moves and copies**
always reach your inbox, because they wait there for you to act on them.

For vulnerability reports, the **Security** section also has:

- **Least severe**: the lowest severity that notifies you. The default is
  **High and critical**. Vulnerabilities known to be exploited notify at any
  severity.
- **Only when an update fixes it**: leave out vulnerabilities nobody has
  released a fix for. On by default.

## Push notifications

Push notifications reach your device even while Kiln is closed. When you
install Kiln as an app, it asks once whether to turn them on. Otherwise, turn
them on yourself:

1. Open **Settings → Notifications**.
2. Under **Delivery**, click **Enable push** beside **Push to this device**.
3. Allow notifications when your browser asks.

Push is set up per device and browser. Turn it on in each one you want
notifications on.

> [!NOTE]
> On iPhone and iPad, push works only from the Home Screen app. In Safari, tap
> **Share**, then **Add to Home Screen**, and open Kiln from there.

If your browser blocks notifications for Kiln, Hearth can't turn push on.
Allow notifications for Kiln in the browser's site settings, then try again.

### Skip push while you're using Kiln

**Skip push while I'm active** is on by default: a notification you already
saw in Hearth isn't pushed to your devices too. **Away after** sets how long
without input before Hearth counts you as away and pushes anyway, from 1 to
30 minutes. The default is 5 minutes.
