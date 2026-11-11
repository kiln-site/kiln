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

A database's or a game server's update is the operation a redeploy is,
holding the instance whole. **Update now** is the person's own operation:
it waits its turn like any change they start, and their page follows the
deployment. One Kiln takes on its own starts from a check that found it
due, only if nothing else holds the instance then, and decides again once
it holds it: it deploys nothing if the instance is no longer set to update
on its own, the update was skipped or replaced, or its wait was made
longer. A busy instance is tried again by the next check that finds the
update due. Kiln's own updates deploy apart from the checks that found
them, two at a time on each Relay, so one that takes minutes doesn't hold
up checking the rest. Those waiting their turn there are held in memory
only: there is no durable queue, so a restart loses nothing that the next
check won't find due again, and a change of mind has nothing to chase. Someone's own **Check now** only
records what it finds.

Deploying again pulls the tag, so these two kinds take whatever it names
at that moment: a tag that moved in the hour since the last check is
deployed without having waited.

Each is recorded as a deployment with the trigger `update`, and has a log
on the instance's Logs page. Every deployment, of any kind and for any
reason, checks the instance's image again when it ends, so the row shows
what it runs.

## Notifications

An image update is one notification per instance and image
(`instance.image-update`), with **Deploy** and **Skip** on it. A Brick
revision is one per instance and revision (`instance.brick-update`), which
opens the instance's page, where what it would install is shown. Each
clears once it is deployed, skipped, replaced by a newer one, or no longer
on offer.

## Brick revisions

A Brick says which revision of its recipe it is (`metadata.revision`, a
whole number its author raises; see the
[Brick format](../apps/bricks/docs/brick-v2.md#metadata)). An instance
keeps the revision it was installed from on its container
(`kiln.brick.revision`; 1 for one made before revisions), and the Relay
says it, with the Brick's source, in every answer to a check. What a check
found of its Brick counts only until the instance's next deployment, which
may have changed the Brick it runs, as a change of Brick does: nothing is
offered or installed from what was seen before one. Hearth
compares it with the newest revision of that Brick in the catalogs it
holds. A catalog in a GitHub repository is read at a commit, which its
Bricks' sources name, so a Brick is known by its repository and path
whatever the commit (`brickSourceLineage`); any other source is itself.
Where several catalogs hold the Brick, read at different times, the newest
revision any of them has is the one offered. A newer one is offered
the way an image is, under the same choice: a notification by default,
installed on its own after the wait if the instance is set to Automatic,
nothing when checks are off. **Skip** passes over one revision, not the
next.

**Update Brick** installs the recipe the catalog has now, at the same
source, with the answers the instance already has:

- **A game server** takes it as a change of Brick: the Relay resolves the
  new recipe with its saved startup answers, pins the new copy, and
  replaces the container, running again if it was.
- **A database** deploys with the new recipe: the Relay resolves it with the
  database's saved answers, such as its version, and replaces the container
  over the same data volume. Its login stays exactly as the engine was
  first given it: the variables it takes its name, user, password and root
  password from are carried over, never made again. The Relay refuses a
  revision that keeps its data somewhere else, listens on another port, or
  is another engine, and changes nothing.

A recipe the saved answers no longer fit is refused the same way before
anything stops: a new question with no default, or an answer the Brick no
longer offers. So a Brick's author gives a new input a default, and keeps
the options instances already chose. The saved answers are every input's
value as it was resolved at install, defaults included: a revision that
changes a default changes it for new installs only, so a database never
moves to another version because its Brick's default did.

Kiln's own install is of the revision that waited. If the catalog has a
newer one by the time it starts, it installs nothing, and the newer one is
offered and waits in its turn. A revision due on its own goes
before an image due at the same time: installing it replaces the container
and may run another image, so the image is judged again once it has
deployed.

A revision is published once. Raising it is what offers a change, so its
author raises it for every change instances should take, and doesn't
change what a revision already published deploys.

The image and the Brick are separate offers on one instance: a newer
image under the same recipe, and a newer recipe. Each is a deployment with
the trigger `update`.

Kiln's own catalog is read from its source every few minutes. A catalog
someone added is as current as its last sync.

## Not built yet

- Apps aren't installed from Bricks yet, so they have no revision. Apps
  built from a Dockerfile, a Compose file or a repository aren't checked
  for images either: they have no single tag to watch.
- A changelog or a view of what a revision changes in the recipe.
- Keeping some of a Brick's own lines changed by hand across a revision.
  An App will follow its Brick or be detached from it.
