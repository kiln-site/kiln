---
title: Domains and HTTPS
description: Serve an app at your own domain over HTTPS through Traefik, or redirect a domain somewhere else.
---

A **web route** serves a domain from one of an app's services over HTTPS, or
redirects it to another URL. Traefik on the app's Relay serves it.

## Before you start

Open the app's Relay and check **Mode** under **Proxy** on its **Info** page:

- **Bundled Traefik** runs Traefik on ports 80 and 443 and gets a Let's Encrypt
  certificate for each domain.
- **Coolify Traefik** or **None / existing Traefik** labels the app for a
  Traefik you run. Attach your Traefik to the network the route's status names.
- **Hearth proxy** doesn't serve websites; routes show **Unavailable**. The
  Relay that installed Kiln uses it. Change it with **Configure** under
  **Proxy**.

Kiln doesn't create DNS records for app domains. Point the domain at the
Relay's machine with an `A` (IPv4) or `AAAA` (IPv6) record. With Bundled
Traefik, the domain must reach the machine on port 80 before a certificate is
issued; **Public access** under **Proxy** shows whether it does.

## Add a route

1. On the app's **Network** page, under **Web routes**, choose **Add route**.
2. Keep **Serve** and enter the **Domain**, such as `example.com`.
3. Choose the **Service** and the **Port** it listens on inside its container.
   An image or Dockerfile app has one service, `app`.
4. Choose **Add route**.

The route shows **Live** when Traefik serves it, **Pending deploy** when the
app needs a deployment to pick it up (choose **Deploy to apply**), or
**Unavailable** when the proxy can't serve it; hover for why.

| Option | What it does |
| --- | --- |
| `www.` counterpart | **Redirects here**, **Serves the same**, or **Not routed**. |
| **Path (optional)** | Serves only requests under a path, such as `/api`. The longest match wins. |
| **Strip the path before forwarding** | The service sees `/` instead of `/api`. |
| **Redirect HTTP to HTTPS** | On by default. |

An app can have up to 16 routes. The first becomes its **Primary domain**,
shown in its header and in **Apps**; choose **Make primary** on another to
change it.

## Redirect a domain

1. Choose **Add route**, then **Redirect**.
2. Enter the **Domain** and the **Destination** URL.
3. Choose **Permanent (301)**, which browsers remember, or **Temporary (302)**.
4. Leave **Keep the path and query** on to send `/shop?id=4` to the same path at
   the destination.
5. Choose **Add route**.

For game server addresses under your domain, see
[Cloudflare](/networking#cloudflare).
