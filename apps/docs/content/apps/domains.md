---
title: Domains and HTTPS
description: Serve an app at your own domain over HTTPS through Traefik, or redirect a domain somewhere else.
---

A **web route** serves a domain from one of an app's services, over HTTPS, or
redirects the domain to another URL. Traefik on the app's Relay handles the
traffic and its certificates.

## Before you start

Web routes need Traefik in front of the app's Relay. Open the Relay and look at
**Proxy** on its **Info** page. **Mode** must be one of:

- **Bundled Traefik**: the Relay runs Traefik on ports 80 and 443 and gets a
  Let's Encrypt certificate for each domain. Routes work as soon as you save
  them.
- **Coolify Traefik**: the Relay labels the app for Coolify's Traefik.
- **None / existing Traefik**: the Relay labels the app for a Traefik you run.
  Attach your Traefik's container to the network the route's status names.

In **Hearth proxy** mode, the Relay doesn't serve websites, and the app's routes
show **Unavailable**. To change the mode, choose **Configure** in the Relay's
**Proxy** section.

## Point your DNS

Kiln doesn't create DNS records for app domains. At your DNS provider, point
the domain at the machine the app's Relay runs on: an `A` record for its IPv4
address, or `AAAA` for IPv6.

With Bundled Traefik, Let's Encrypt checks the domain over plain HTTP, so the
domain must reach the machine on port 80 before the certificate is issued. The
Relay's **Proxy** section shows under **Public access** whether the internet
reaches its Traefik.

## Add a route

1. Open the app's **Network** page. Under **Web routes**, choose **Add route**.
2. Keep **Serve**.
3. Enter the **Domain**, such as `example.com`. A pasted URL keeps only its
   hostname.
4. Choose the **Service** to reach and the **Port** it listens on inside its
   container. An image or Dockerfile app has one service, `app`. Before a
   Compose app first deploys, type the service's name.
5. Choose **Add route**.

A route's status shows beside **Web routes**:

- **Live**: Traefik serves it.
- **Pending deploy**: the app needs a deployment to pick it up, as with an
  external or Coolify Traefik, which reads labels on the app's containers.
  Choose **Deploy to apply**.
- **Unavailable**: the Relay's proxy can't serve it. Hover the status to see
  why.

An app can have up to 16 routes.

### Route options

| Option | What it does |
| --- | --- |
| `www.` counterpart | **Redirects here** sends `www.example.com` to `example.com`, or the other way round. **Serves the same** serves both. **Not routed** leaves it alone. |
| **Path (optional)** | Serves only requests under a path, such as `/api`. The longest matching path wins. |
| **Strip the path before forwarding** | The service sees `/` instead of `/api`. Only for a route with a path. |
| **Redirect HTTP to HTTPS** | On by default. Turn it off to serve plain HTTP as well. |
| **Label (optional)** | A name for the route in Hearth. |

## Redirect a domain

1. Choose **Add route**, then **Redirect**.
2. Enter the **Domain** and the **Destination** URL.
3. Choose the **Kind**: **Permanent (301)**, which browsers remember, or
   **Temporary (302)**, checked on every visit.
4. Leave **Keep the path and query** on to send `/shop?id=4` to the same path
   at the destination, or turn it off to send every page to the destination
   itself.
5. Choose **Add route**.

## The primary domain

An app's first route becomes its **Primary domain**. It shows in the app's
header, in the **Link** column of **Apps**, and first in the **Connection**
section of its **Info** page. To choose another, choose **Make primary** on its
row.

## Edit or remove a route

Choose **Edit** or **Remove** on a route's row. After a removal, **Undo** in
the notification puts it back.

## Game server domains

For a game server, Kiln can create DNS records itself, under a domain you
manage in Cloudflare. See [Cloudflare](/networking/cloudflare).
