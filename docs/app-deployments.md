# App deployments

An app deploys from a Docker image, a pasted Dockerfile or Compose file, or
a GitHub repository. Each deployment is recorded in Hearth
(`app_deployment`) and listed under **Infrastructure → Deployments**, across
every Relay the person can read apps on. Scoped to one app, from the
Deployment card on its Info rail, it's that app's history. The Relay keeps
the logs of each app's 20 latest deployments; the list opens them.

## GitHub sources

A GitHub app builds one branch of a repository a source can read: either a
Dockerfile, with the whole repository as its build context, or a Compose
file, whose relative paths resolve from its own folder. The repository lives
in `app_github_source`, outside the app's encrypted config, so a push can
find the apps it deploys. Choosing it needs `app.manage` on the app and the
source's owner, or an administrator, as for a sync.

For each deployment Hearth reads the branch head (or the commit a redeploy
names) and mints an installation token limited to that repository's contents,
read-only. It travels in `app.deploy`'s `github` field and is never cached,
written to disk, or logged; the Relay's operation journal keeps only a hash
of the request. It expires within the hour.

The Relay downloads the commit's tarball from GitHub and unpacks it into
`app-sources/<app>/<deployment>/` in its data directory. Only files, folders,
and links that resolve inside the checkout are kept; links are made after
every file, and each is checked on disk, so no entry can write or point
outside it. A Dockerfile build drops its checkout once it succeeds. A Compose
deployment keeps its own, since its services may bind files from it, and the
next successful deployment removes it. Configs and secrets a Compose file
reads from its folder are bound read-only from the checkout. Containers
keep nothing across deployments; data that should last belongs in a volume
mounted from the app's Volumes section, not the checkout.

Containers carry the commit they were built from in `kiln.app.commit`.

### Deploying on push

With **Deploy on push**, each new commit on the branch deploys. GitHub
delivers pushes to Hearth when `KILN_URL` is public; otherwise Hearth checks
the branch every minute. Deployments queue per app: a push while one runs
waits for it, and pushes that arrive while one waits join it, so the newest
commit deploys once. A push or poll for the branch head the app last tried
deploys nothing, so a failing commit isn't retried every minute, and a
commit deployed again from the Deployments list, as a rollback, stays until
a new commit lands. Polls skip a Relay that's offline and check again once
it's back; a pushed commit the Relay couldn't take is recorded as failed,
and deploys from the app or with the next commit.

Deploying on push hands the branch the app's trust: whoever can push to it
can run what a pasted Compose file could, host binds included. Turn it off,
or protect the branch, for repositories others can write to. An app
switched to another source keeps its repository, unused.

## Image updates

An app that deploys from an image runs it by digest. Each deployment asks
the registry what digest the tag names (Docker's `GET /distribution`, which
reads the manifest without pulling it), pulls `repository@digest`, and runs
that. The container keeps the image as its config names it in
`kiln.app.image`, and the digest in `kiln.app.image.digest`. Another app
pulling the same tag meanwhile can't change what this one starts. A
registry that can't name the digest leaves the deployment to pull the tag,
as before.

Registries have no way to subscribe to a tag, so Hearth asks. Every hour,
each Relay checks all of its image apps in one `app.image.check` request,
16 apps at a time. Apps naming the same image share one registry lookup,
four at a time. The Relay compares the digest the tag names with the one
the app's container runs. Docker Hub doesn't count these lookups against
its pull limits. A Relay skips an app that is deploying, runs another image
than its config names, or names a digest, which never moves. For a
container deployed before Kiln labelled its digest, it uses the digests
Docker recorded when it pulled the image.

Each app chooses, from **Updates** on its Deployment card:

- **Notify**, the default: a new image notifies everyone who can deploy
  the app (`app.manage` on its Relay) once.
- **Automatic**: also deploys the update once it's been out for the app's
  wait, three days unless changed. Registries don't say when a tag moved,
  so the wait counts from when Kiln first saw the digest. A tag that moves
  again before then offers its newest image and waits again; Kiln never
  deploys an image the tag has moved past. While the registry can't be
  reached, the update waits for a check that gets through.
- **Off**: no checks.

**Update now** deploys the image on offer, whatever its wait. **Skip**
passes over it: it neither notifies nor deploys on its own, and the next
image the tag names is offered as usual. An automatic update deploys the
digest Kiln found, checks again when its turn comes that it's still due,
and isn't tried again for the same digest once it has run, however it
went. Deploying an image update again from the Deployments list deploys
its digest, as a rollback, and an automatic update doesn't deploy the
image it rolled back from again. A Relay too old to deploy by digest
refuses the rollback rather than pull the tag. Unless checks are off, an
image deployment checks the app again when it ends, so the card shows what
it runs.

## Rolling deployments

When an app is running, a deployment starts its new containers beside the
old ones. Each new container must stay up past a short settle and pass its
Docker health check (`HEALTHCHECK` or Compose's `healthcheck`), within ten
minutes. Only then does it take the app's name on its network, where
bundled Traefik reaches it, and the old containers stop. If the new ones
fail, they're removed and the old ones keep serving. An external Traefik
reads the containers' labels and leaves out those that aren't healthy yet.
Without a health check, a container counts as ready once it settles, so
give apps one for deployments without downtime.

A Compose project rolls over as a whole, in a project of its own named for
the deployment, with its own networks. Every service must be healthy, or
have exited cleanly, before any traffic moves.

The old containers stop first instead when two copies can't run together:

- the app publishes ports on the Relay, or has a Tailscale address;
- the app mounts a volume or a path on the node read-write, from its
  Volumes section: two copies would write to the same data;
- a Compose service keeps data in a volume, named or declared by its image,
  as databases do: two copies would share or lose it;
- a Compose service uses another network mode;
- the node hasn't the memory to hold both copies at once.

The deployment log says which. Copies share nothing else, so an app whose
data lives only in its containers loses it on every deployment. A Relay
that restarts mid-way leaves both copies running until the next deployment
replaces them.

A Compose project replaced this way deploys as before, under the app's own
project name, so Compose keeps its volumes. While both copies run, the node
reserves both copies' memory.

## Volumes

The Relay manages two kinds of Docker named volume, each with an ID that
backups and deletion name it by:

- **Kiln volumes**, made on the Relay's Volumes page and mounted from an
  app's Volumes section. A Kiln volume's ID is the one it was made with. No
  app owns one: any app's configuration may mount it.
- **An app's Compose volumes**, those its Compose file declares. The app
  owns them, and their ID is the app's ID and the volume's key in the file,
  `<app ID>/<key>`. Compose labels each volume with its project and key, and
  the Relay reads the owner from those labels, so the ID holds whatever
  Docker name the file gives the volume.

A redeploy keeps an app's Compose volumes: Compose runs under the app's own
project name and finds them again. A rolled deployment runs as a project of
its own, `<project>-<deployment>`, which would make new volumes, so a
Compose file that keeps data in a volume never rolls; it deploys under the
app's own project, as above. A rolled deployment therefore makes no volume
an app's services use, and the app's volumes keep their data and IDs
across deployments of either kind. If a file renames a volume's Docker name
(its `name:`), the key's ID goes to the volume the app's containers mount,
and the old one stays listed as the app's, without an ID, until the app is
deleted.

An app **uses** a volume when its configuration mounts it, deployed or not,
or one of its containers mounts it now. Configurations live in Hearth, so
the Relay keeps which Kiln volumes each app's configuration names, as each
paired Hearth says. Each message replaces an app's whole set: before saving
a configuration that mounts a new volume, Hearth sends the old and new
configurations' volumes together, and a Relay that can't take them keeps
the configuration from saving; after every save it sends the saved one's.
Whenever Hearth connects to the Relay it sends every app's again, retrying
with backoff until the Relay takes them, so a message a save couldn't
deliver arrives. An app whose configuration Hearth can't read, as when the
secret it was saved with is gone, is sent as unresolved. Any paired Hearth
may send these, whatever its grant: they only add protection, and a Hearth's
message replaces only what it sent itself. A read-only Hearth may still keep
configurations from before its grant changed.

A Kiln volume can't be deleted while any container mounts it or any app's
configuration names it, nor while the Relay can't tell: until every paired
Hearth has sent its apps' configurations on its current control connection,
with none unresolved. What a Hearth sent counts only for the connection it
sent it on, so its database changing under it, as a restore does, can't
leave the Relay counting configurations it no longer holds: a Hearth
restored offline connects anew. One that imports a Kiln database while
running first tells every Relay to stop counting what it sent
(`relay.volumes.references.hold`, which waits for deletions under way and
works while the Relay is paused), refuses the import if any Relay can't be
told, sends nothing while the import runs, and then reconnects to every
Relay, which counts its configurations again once a new connection sends
them. Deleting an App forgets only what its own Hearth said of it. After the Relay restarts, every Hearth
owes them again. A Hearth paired since owes them before deletion works
again; a revoked one no longer counts, nor does what it sent. The volumes
page says what the Relay waits for.

Deleting an app with its data removes only the volumes its own Compose
projects made, never a Kiln volume, and never one of its volumes another
container mounts, as another app's file can by naming it `external`.

What an app's containers mount that no managed volume or the app's folder
holds isn't covered by its backups, and the Relay's volume listing reports
it per app: volumes Docker named itself, such as those an image declares,
named volumes Kiln doesn't manage, and paths on the node outside the app's
folder. Files an app's configuration mounts and a repository checkout don't
count; each deployment writes them again.

## Recording

Hearth records a deployment once its Relay accepts it, and follows it there
until it ends. A Relay that is offline or paused is checked again when it's
back; a deployment the Relay lost track of, because it restarted mid-way,
ends as **Unknown**. Deployments a Hearth restart left running are followed
again within a minute. A push or poll the Relay refused is recorded as
failed, since nobody was watching. Each app keeps its 200 latest records.
