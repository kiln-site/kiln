---
title: Deploy from GitHub
description: Connect a GitHub account as a source, build a repository branch on a Relay, and deploy each new commit.
---

A GitHub app builds one branch of a repository on its Relay, from a Dockerfile
or a Compose file in it. With **Deploy on push**, each new commit deploys.

## Connect GitHub

Kiln reads repositories through a **source**: a private GitHub App that Kiln
creates for your account or organization, so you never paste keys.

1. Open **Sources**, under Infrastructure, and choose **Add source**.
2. Under **Where are your repositories?**, choose **Personal account** or
   **Organization**. For an organization, enter its name as in
   `github.com/name`. Creating an app for an organization needs one of its
   owners.
3. Enter an **App name**. It must be unique on GitHub.
4. Choose **Continue to GitHub** and confirm the app there.
5. Install the app on GitHub, and choose the repositories Kiln may read.

GitHub sends you back to **Sources**, where the source shows **Connected**.

A source belongs to the person who created it. You can connect several
accounts; each is its own GitHub App. A source marked **Not installed** needs
**Install on GitHub** before you can pick its repositories, and one marked
**Suspended** was suspended on GitHub.

### Pushes or polling

GitHub only delivers push notifications to a public HTTPS address. When Hearth
has one, Kiln hears about each push as it happens. Otherwise, as on a private
address or over Tailscale, Kiln checks the branch for a new commit every
minute.

## Create a GitHub app

1. Open **Apps** and choose **Add App**.
2. Under **Type**, keep **GitHub**.
3. Enter a **Name** and choose the **Relay**.
4. Choose the **Source**, **Repository**, and **Branch**. If a repository is
   missing, choose **Give the app access on GitHub** in the list.
5. Under **Build**, choose one:
   - **Dockerfile** builds one container, with the whole repository as its
     build context.
   - **Docker Compose** runs every service in a Compose file. Paths in the file
     are relative to its folder.
6. Change the **Dockerfile** or **Compose file** path if it isn't `Dockerfile`
   or `compose.yaml` at the repository's root.
7. Leave **Deploy on push** on to deploy each new commit on the branch.
8. Choose **Create and deploy**.

Hearth opens the app while the Relay downloads the commit, builds it, and
starts it.

To change the repository, branch, or build later, choose **Configure** in the
app's **Brick** section on its **Info** page.

## Deploy on push

With **Deploy on push** on, each new commit on the branch deploys. If a push
arrives while a deployment runs, it waits; pushes that arrive while one waits
join it, so only the newest commit deploys.

Kiln won't retry the same commit on its own. A commit that failed stays failed
until a new one lands or you deploy it by hand. If the Relay is offline when a
push arrives, the push is recorded as failed, and the next commit or a
**Deploy** picks it up.

> [!CAUTION]
> Deploy on push lets anyone who can push to the branch run code on your
> Relay, with everything a Compose file can do, including mounting paths on the
> machine. Turn it off, or protect the branch, for repositories other people can
> write to.

## What the app runs

The app's **Brick** section shows its **Repo** and branch, and the file it
builds under **Build Strategy**. Choose the file to read it.

The **Deployment** card shows the commit the running containers were built
from under **Running**, and when the last deployment started.

Containers start fresh from the checkout on each deployment. Files the app
writes are gone after the next one unless they're in a volume. See
[Volumes](/apps/settings#volumes).

## Roll back

Open **History** on the app's **Deployment** card. On an older deployment,
open **More actions** and choose **Deploy this commit again**. The app stays on
that commit until a new commit lands on the branch.

See [Deployment history](/apps#deployment-history).
