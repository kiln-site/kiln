# App deployments

An app deploys from a Docker image, a pasted Dockerfile or Compose file, or
a GitHub repository. Each deployment is recorded in Hearth (`deployment`)
and listed under **Infrastructure → Deployments**, across every Relay the
person can read apps on, beside game servers' deployments (see
[Game server deployments](#game-server-deployments)). Scoped to one app, from the
Deployment card on its Info rail, it's that app's history. The Relay keeps
the logs of each app's 20 latest deployments. They open on the app's Logs
page, which lists them beside its containers: the one the Relay is on is
followed live, and any other reads the log the Relay saved. It keeps the
images of each app's 5 newest successful deployments, and any build for a
day; older ones are removed (see
[Relay runtime](relay-runtime.md#docker-cleanup)). Deploying an older one
again builds or pulls it again.

## GitHub sources

A GitHub app builds one branch of a repository a source can read: either a
Dockerfile, with the whole repository as its build context, or a Compose
file, whose relative paths resolve from its own folder. The repository lives
in `app_github_source`, outside the app's encrypted config, so a push can
find the apps it deploys. Choosing it needs `app.manage` on the app and the
source's owner, or an administrator, as for a sync.

For each deployment Hearth resolves the commit to build: the branch head, a
push's pinned commit, or the commit a redeploy names. It mints an installation token limited to that repository's contents,
read-only. It travels in the `github` field of the App's `instance.deploy` and is never cached,
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
the branch every minute. Pushes queue like any other ask (see
[How deployments queue](#how-deployments-queue)), so the newest commit
deploys once. A push or poll for the branch head the app last tried
deploys nothing, so a failing commit isn't retried every minute, and a
commit deployed again from the Deployments list, as a rollback, stays until
a new commit lands.

Deploying on push hands the branch the app's trust: whoever can push to it
can run what a pasted Compose file could, host binds included. Turn it off,
or protect the branch, for repositories others can write to. An app
switched to another source keeps its repository, unused.

## Image updates

Every instance that runs an image by tag is checked for a newer one: an App
that deploys from an image, a database, and a game server. See
[Instance updates](instance-updates.md) for the checks, what each instance
chooses to do about them, and how an update deploys.

An App runs its image by digest. Each deployment asks the registry what
digest the tag names (Docker's `GET /distribution`, which reads the manifest
without pulling it), pulls `repository@digest`, and runs that. The container
keeps the image as its config names it in `kiln.app.image`, and the digest
in `kiln.app.image.digest`. Another app pulling the same tag meanwhile can't
change what this one starts. A registry that can't name the digest leaves
the deployment to pull the tag.

Deploying an image update again from the Deployments list deploys its
digest, as a rollback, and an automatic update doesn't deploy the image it
rolled back from again.

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

A Compose project replaced this way deploys under the app's own project name, so Compose keeps its volumes. While both copies run, the node
reserves both copies' memory.

## Volumes

The Relay manages one kind of Docker named volume: a **Kiln volume**, with
an ID that backups and deletion name it by. No app owns one, and any app
may mount it. It comes to be one of three ways, and is the same thing each
time:

- made on the Relay's Volumes page or while adding one to an app, and
  mounted from the app's Volumes section, which also reads a line from a
  Compose file such as `site-data:/var/www/data:ro`;
- made when an app is installed from a Brick that keeps a folder
  ([Bricks](../apps/bricks/docs/brick-v2.md));
- declared in the app's Compose file. When the app deploys, the Relay
  makes a Kiln volume for each volume a service mounts that the file leaves
  to Compose to make, named after the app and the file's key, and points
  the file at it as `external`. The volume's ID comes from the app's ID and
  the key, so every deployment finds the same one, whatever the app is
  called by then.

A volume the file names itself (`name:`), marks `external`, or gives a
driver or driver options is the file's own: it stays as the file says, and
Kiln neither manages nor backs it up.

The Relay keeps which Kiln volumes an app's Compose file declares, as it
keeps what each Hearth says an app's configuration mounts, so one is in use,
and can't be deleted, whether or not a container mounts it. It names them
before a deployment starts, names exactly the file's once one has taken
over, and none once the app deploys from something else. A volume a file
stops declaring stays, no app's. One the Relay has deployed before that is
gone refuses the deployment, since making another would start the app empty
without saying so: restore it, or take the key out of the file.

### Volumes made by Compose

Before Compose files' volumes were Kiln volumes, Compose made them itself,
as `<project>_<key>`. Kiln no longer manages those. An app that still has
one for a key its file declares is refused its deployment, which names the
old volume and the new one, since deploying would start it empty beside its
data. To carry the data over, with the app stopped:

```sh
docker run --rm -v <old volume>:/from:ro -v <new volume>:/to alpine \
  sh -c 'cp -a /from/. /to/ && ls -la /to'
docker volume rm <old volume>
```

Check what was copied before removing the old volume. The deployment goes
ahead once it is gone. An app with nothing to keep there needs only the
`docker volume rm`.

A volume an app uses opens in that app's Files page, as a file root of its
own, `app:<app ID>:volume:<volume ID>`. It takes the app's file
permissions, and the Relay refuses any volume the app doesn't use. Docker
keeps volumes on the host, so this needs the Relay's host files mounted, as
the Relay's own Files page does.

A Compose file that keeps data in a named volume never rolls: two copies
can't share it, so it deploys under the app's own project, stopping the
running containers first.

An app **uses** a volume when its configuration mounts it or its Compose
file declares it, deployed or not, or one of its containers mounts it now. Configurations live in Hearth, so
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

Deleting an app never removes a volume. The volumes it used stay, with
their data, and are deleted from Volumes by whoever decides to; the Relay
forgets that the app named them, so nothing keeps one from being deleted
once no other app uses it.

An app's Volumes section says nothing of what Kiln keeps and backs up: a
Kiln volume, mounted in Hearth or declared in the Compose file. Only
volumes are backed up, and a row speaks up where what is written there may
be lost:

| Row | It says |
| --- | --- |
| A relative path in a repository's Compose file | Not kept: each deployment replaces the checkout |
| A volume with no name in a Compose file | Not kept: Docker makes a new one on every deploy |
| A relative path in a Compose file written in Hearth | Not backed up: it is kept on the node, beside the file |
| A path on the node | Not backed up |
| A volume the Compose file names or configures itself | Not backed up |
| A typed file the app may write to | Changes not kept: it is written again on each deploy |

Below the rows it lists each path the app's image declares as a volume
with nothing mounted there, which starts empty on every deploy. It can't
see other paths a container writes to; what isn't in a volume or the app's
folder isn't kept.

On the Backups page a volume's backups show the volume's name, read from
its Relay, and its ID while the Relay can't be asked.

What an app's containers mount that no managed volume or the app's folder
holds isn't covered by its backups, and the Relay's volume listing reports
it per app: volumes Docker named itself, such as those an image declares,
named volumes Kiln doesn't manage, and paths on the node outside the app's
folder. Files an app's configuration mounts and a repository checkout don't
count; each deployment writes them again.

## Starting with a database

**Add App** can start an app connected to a database: a new one on its Relay,
or one already there. Connecting to an existing database copies its
credentials, so it takes that database's `database.network.write` and
`database.credentials.read`; creating one takes `database.create`.

Hearth creates a new database first, so one that can't be made leaves no app,
then records the app with the connection's variables in its environment:
`DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASS`, and `DB_NAME`, which Redis and
Valkey don't have. They're an ordinary part of the environment, copied once:
edit them like any other, and change `DB_PASS` after rotating the password.

The Relay saves the connection when the app's provisioning job runs, whether
or not the database exists yet. A deployment waits while a database the app
is connected to is still provisioning, since its containers couldn't join a
network that isn't there; one whose provisioning failed doesn't hold it up.

## How deployments queue

An app deploys the same way whatever asked: a push, a poll that found a new
commit, an image check, or a person's Deploy, save-and-deploy, update or
redeploy. Each ask queues the app's deployment, a durable `app.deploy`
operation (see [Hearth operations](hearth-operations.md#durable-operations))
whose input is the ask, or joins the one waiting there. Asks while a
deployment runs make one deployment after it, of the newest ask:

- a push pins the commit from its webhook, with the repository and branch it
  came from;
- a redeploy pins its commit, or its digest and the image it was of, and is
  refused once the app deploys from another;
- anything else asks for the newest.

A poll never replaces an ask that waits. A person's ask stays theirs while it
waits: it builds even a commit already live and deploys an update whatever
its wait, and they're checked again when it runs, so one who may no longer
manage the app is refused, though a push that joined their ask deploys as
Kiln's own. A person asks in an ordinary operation holding the app shared,
so it returns at once, and a deletion or restore turns it away. A deploy
still waiting can be cancelled.

The deployment holds the app's `#deploy` from its start until its Relay
says the build ended, so the next waits its turn behind it. It starts only
when its turn comes and its Relay is connected and not paused, with the
databases it keeps for the app handed over (an operation of its own,
started then if it hasn't run). Until then it waits holding nothing, so
what's asked meanwhile joins it, it can be cancelled, and a deletion of the
app isn't kept waiting. The app's saved configuration, which holds its
secrets, is read as it's sent, and the token that checks out a GitHub commit
is made then; neither is kept in the operation's steps, which are stored in
the clear.

Deleting an app first asks its Relay to stop a running build
(`app.deployment.abort`), then queues the deletion behind the deployment,
which ends once its Relay sees the build stopped. A deployment won't send
once the deletion began.

## Recording

Hearth records a deployment as running before sending it to the Relay, and
records the Relay's deployment ID once the Relay accepts it. A send that
fails marks the record failed. Hearth follows the deployment there until it
ends: a Relay that is offline or paused is checked again when it's back,
and a deployment the Relay lost track of, because it restarted mid-way,
ends as **Unknown**. A Hearth restart resumes a deployment's operation where
it left off; every minute Hearth also settles a running record that no
operation follows. A poll that fails to prepare its ask is logged, not
recorded. Each app keeps its 200 latest records.

## Game server deployments

A game server's first install, whether a create or a copy provisions it,
each redeploy, and each change of its Brick are deployments too, recorded
in the same table by the server's instance ID and listed on the
Deployments page for whoever can read the server, naming the Brick it
installed. Starting, stopping, restarting, crash recovery, and saving
startup settings without a new Brick aren't. A redeploy is recorded under
the trigger `reinstall`, its name before every kind deployed again.

Hearth records an install as running before it claims the server's
provisioning job, sending the deployment's ID with the claim; a create
retried while it runs resumes the same one. The post-provisioning worker,
which watches the Relay's snapshot, ends it: succeeded once the server's
provisioning clears, failed with its error once it fails. A redeploy or
change of Brick is recorded before Hearth asks the Relay, with the
deployment's ID in the request, and ends as the Relay answers. A Hearth restart
mid-way leaves a record running; the minute sweep ends it as **Unknown**
once nothing can still follow it: a redeploy or change of Brick after 15
minutes, an install after 10 minutes without a post-provisioning job, or a
day with one.

The Relay logs each phase and how it ended under the deployment's ID, in
`server-deployments/<server>/<deployment>.json` in its data directory,
keeping each server's 20 latest and removing them with the server. The
server's Logs page lists its deployments and shows each one's log, for
whoever can read the server's logs (`instance.deployment.read`, which takes
`instance.logs.read`), and a deployment's row on the Deployments page opens
it there. A redeploy takes whoever asked for it to that page to follow it.
The server's own output stays on its Console page. Deleting an instance of
any kind removes its deployment records.

## Database deployments

A database deploys again as it is set up: the Relay pulls the image tag it
was made from and replaces its container over the same data volume, so it
runs whatever release that tag names now. The pull comes first, so a
registry that can't be reached leaves the database running. It is away
while the old container stops and the new one gets ready.

When the new container never gets ready, the old one is started again,
running if it was. That recovers the container, not the data: the new
release opened the same volume, and what it changed there before failing
stays changed. Whether the old release still reads it is up to the engine,
so a redeploy is no substitute for a backup. The deployment's log says
which image the database ran and which it pulled, by ID.

A redeploy is recorded in the same table by the database's ID, before
Hearth asks the Relay, and ends as the Relay answers; the minute sweep ends
one a Hearth restart cut off as **Unknown** after 15 minutes. The Relay
logs it as it does a game server's, in a store of its own
(`database-deployments`), so a log is only read as the kind it was written
for. The database's Logs page lists its
deployments beside its container's output, as an App's does, and whoever
reads the database's logs (`database.logs.read`) reads each one's log
there.
