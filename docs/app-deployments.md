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

## Recording

Hearth records a deployment once its Relay accepts it, and follows it there
until it ends. A Relay that is offline or paused is checked again when it's
back; a deployment the Relay lost track of, because it restarted mid-way,
ends as **Unknown**. Deployments a Hearth restart left running are followed
again within a minute. A push or poll the Relay refused is recorded as
failed, since nobody was watching. Each app keeps its 200 latest records.
