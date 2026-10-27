---
title: Tailscale
description: Connect a tailnet so devices on it reach game servers and app services by private names, with no public port.
---

Kiln can put game servers and app services on your
[Tailscale](https://tailscale.com) network, a tailnet. Devices signed in to the
tailnet reach each one at a private name, such as `survival.kiln`, and nobody
else can.

Only platform administrators can see **Tailscale** and set it up.

## How it works

On each Relay with something connected, Kiln runs a Tailscale node, a small DNS
server, and a private Docker network. The node advertises that network to your
tailnet, and Kiln approves the route. Kiln also points your tailnet's DNS for
the private domain, such as `.kiln`, at the Relay, so each game server or
service answers at `hostname.kiln`.

A Relay's Tailscale node is only set up while something on it is connected.

## Create an OAuth credential

Kiln manages the tailnet through a Tailscale OAuth client.

1. In the Tailscale admin console, add a tag for Kiln's devices, such as
   `tag:kiln`, to your tailnet policy.
2. In Hearth, open **Tailscale**, under Infrastructure, and choose **Setup
   Tailscale**. Choose **Create OAuth Credential** to open Tailscale's page for
   it.
3. Give the credential **Write** access to:
   - **General** / **DNS**
   - **Devices** / **Core**
   - **Devices** / **Routes**
   - **Keys** / **Auth Keys**
4. For **Devices** / **Core** and **Keys** / **Auth Keys**, select your tag
   under **Tags**.
5. Create it, and copy the client ID and secret.

## Connect a tailnet

In **Connect a tailnet**:

1. Enter a **Network name**, shown in Hearth.
2. Enter the **Private domain** your instances' names end in, such as `kiln`.
3. Paste the **OAuth client ID** and **OAuth client secret**.
4. Enter the **Device tag** you selected, such as `tag:kiln`.
5. Choose **Validate and connect**.

Kiln checks the credential with Tailscale before it saves. You can connect
more than one tailnet; choose between them with **Change network**.

## Connect game servers

On **Tailscale**, choose **Connect Game Servers** and pick the game servers.
Each gets a hostname from its name, and joins at `hostname.domain`.

You can also open a game server's **Network** page, find the tailnet under
**Tailscale networks**, and choose **Join**. You can change the hostname there
first.

The first game server on a Relay sets up Tailscale on that Relay, which takes a
moment. Its status moves from **Provisioning** through **Connecting** to
**Connected**.

### Pause, rename, or disconnect

On a game server's row, open its menu:

- **Configure** changes its hostname, or turns off **Connected** to pause the
  connection and keep the hostname.
- **Disconnect** removes it from the tailnet. When it was the last one
  connected on its Relay, Kiln removes Tailscale from that Relay too.

From the game server's own **Network** page, choose **Leave** instead.

## Connect an app

On an app's **Network** page, **Tailscale networks** lists each tailnet. Choose
**Join** to connect the app. A Compose app has a section per service, so each
service joins on its own. Deploy the app once before its services can join.

> [!NOTE]
> An app with a Tailscale address can't run two copies at once, so its
> deployments stop the old container before starting the new one.

## Delete a tailnet

Open the tailnet's settings with **Configure Tailnet** and choose **Delete
Tailnet**. Kiln removes Tailscale, its DNS server, and the private network from
every Relay. A Relay that's offline cleans up when it reconnects.
