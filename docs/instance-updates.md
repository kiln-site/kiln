# Instance updates

Kiln watches the image each instance runs and says when a newer one is out.
It is one system for every kind: an App that deploys from an image, a
database, and a game server. Each has an **Updates** row on its Info page.

## Checks

Registries have no way to subscribe to a tag, so Hearth asks. About every
hour it checks the instances that are due, sending each Relay
`instance.image.check` requests of up to 16 instances of one kind.
Instances naming the same image share one registry lookup, four at a time.
The Relay compares the digest the tag names with the one the container
runs. Docker Hub doesn't count these lookups against its pull limits.

What "the image it runs" is depends on the kind:

- **An App** deploys at a digest Kiln chose, kept on its container
  (`kiln.app.image.digest`). Hearth asks about the image its config names; a
  container running another image, or a config naming a digest, has nothing
  to compare. For a container deployed before Kiln labelled its digest, the
  Relay uses the digests Docker recorded when it pulled the image.
- **A database and a game server** run the tag their container was made
  from, which deploying again pulls. The Relay reads that tag from the
  container and compares the digests Docker recorded for the image it runs.

A Relay skips an instance that is deploying. Hearth keeps what each check
found in `instance_update`, by instance ID; what a check found counts only
until the instance's next deployment starts.

Tailscale's nodes, which a Relay runs as game servers for now, aren't
checked.

## What each instance chooses

From **Updates**, whoever may deploy the instance (`instance.deploy`)
chooses:

- **Notify**, the default: a new image notifies everyone who can deploy the
  instance, once.
- **Automatic**: also deploys the update once it's been out for the
  instance's wait, three days unless changed. Registries don't say when a
  tag moved, so the wait counts from when Kiln first saw the digest. A tag
  that moves again before then offers its newest image and waits again;
  Kiln never deploys an image the tag has moved past. While the registry
  can't be reached, the update waits for a check that gets through.
- **Off**: no checks.

**Update now** deploys the image on offer, whatever its wait. **Skip**
passes over it: it neither notifies nor deploys on its own, and the next
image the tag names is offered as usual. An automatic update isn't tried
again for the same digest once it has run, however it went.

## How an update deploys

- **An App** deploys the digest Kiln found, through its deployment queue,
  checking again when its turn comes that it's still due. It rolls over as
  any deployment does (see [App deployments](app-deployments.md)).
- **A database** deploys again as it is set up: the Relay pulls its tag and
  replaces its container over the same data volume. It is away while the
  old container stops and the new one gets ready, and the old one is started
  again if the new one never is. That recovers the container, not the data,
  so an update is no substitute for a backup.
- **A game server** deploys again as it is set up, which replaces its
  container and so restarts it.

Each is recorded as a deployment with the trigger `update`, and has a log
on the instance's Logs page. Every deployment, of any kind and for any
reason, checks the instance's image again when it ends, so the row shows
what it runs.

## Notifications

An update is one notification per instance and image, with **Deploy** and
**Skip** on it. It clears once the image is deployed, skipped, replaced by a
newer one, or no longer on offer. Its kind is still `app.image-update` in
stored notifications and preferences, from when only Apps updated.

## Not built yet

- Updates to an instance's Brick. A Brick will carry a `revision`, and an
  instance installed from an older one will be offered the newer recipe the
  same way: notify by default, automatic if chosen.
- Apps built from a Dockerfile, a Compose file or a repository aren't
  checked: they have no single tag to watch.
