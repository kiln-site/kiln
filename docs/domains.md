# Domains

Kiln keeps DNS records in Cloudflare for the people who connect it. Anyone
who can reach game servers or apps can open **Infrastructure → Domains** and
connect one or more Cloudflare API tokens. Each connection belongs to the
person who added it. People can't share their domains; a platform
administrator can also add connections owned by **Kiln**, whose vanity
domains are **Kiln provided**: anyone may get an address under them.

A token needs **Zone Read** and **DNS Edit** on the zones Kiln should use.
Hearth encrypts it at rest and never returns it to the browser. Every record
Kiln makes carries a comment naming the game server or app it belongs to.
Records are DNS-only unless a web route turns on Cloudflare's proxy (below);
a game server's address always is, since players connect to it directly.

## On an instance's Network page

Every instance's Network page has one **Domains** table: each name the
instance holds and where it goes, a port or a redirect to another URL. Each
row is a web route, served through the Relay's proxy, and one of them is an
App's primary domain (★), the one its header and lists show. A
name nothing serves yet, such as a new App's own address, is a row too,
which says so and offers to point it somewhere.

A game server also has **Join address** above it: the addresses players
type, which go straight to its game port and not through the proxy. Each
shows what to type, its port left out when an SRV record carries it, and
one is its primary (★).

Either star is the instance's one primary address, which Hearth keeps in
one row per instance, naming a join address or a web route. Until one is
chosen, or when the one chosen is gone, the first that serves stands in.
See [Instances](instances.md#one-primary-address).

## Web route hostnames

A game server's and an App's web routes are the same thing, read and saved
the same way: one request to the Relay that keeps them, and one operation in
Hearth, which takes `instance.network.write` of whoever saves them, whatever
kind of instance they belong to.

Saving a game server's or app's web routes brings its DNS records in line,
for every hostname a route answers on, its `www` counterpart included:

- a hostname in a zone on one of the person's own connections gets an `A`,
  `AAAA`, or `CNAME` record pointing at the Relay the route runs on;
- a hostname a route no longer uses loses the record Kiln made for it;
- moving a game server to another Relay, with its web routes, points their
  records at the new Relay.

Kiln never touches a record it didn't make on its own. A hostname
Cloudflare already has a record for shows as **Existing record**, and Kiln
checks it again on the next Sync, remembering the one `A`, `AAAA`, or
`CNAME` record there, if there's exactly one.

The owner of the hostname's Cloudflare connection (an administrator, for
Kiln's), who may also change the route, gets **Allow Kiln to manage** on the
Domains page and in the route's row, in place of its edit and remove buttons.
They see what the record points at now, and it stays proxied or DNS-only as
it was. Kiln then reads Cloudflare again under the resource's DNS lock and
refuses, changing nothing,
if that record is gone or changed or the name has several address records.
Otherwise it keeps the record's ID as one it made, so the next sync points it
at the Relay and marks it with Kiln's comment, and removing the route deletes
it. Other records under the name, such as `TXT`, are left alone. Being able
to change a resource's routes isn't enough: taking someone's record in a zone
takes owning that zone's connection.

A hostname in no connected zone is left for its owner to point at the Relay
by hand; the Domains page still lists it, as **Manual DNS**, from what each
Relay's proxy serves.

## Domains managed elsewhere

A domain whose DNS someone keeps outside Kiln can be added on the Domains
page, under **Managed elsewhere**: the person's own, or Kiln's for an
administrator. A web route's hostname under one is held like any other name
Kiln keeps, so no other game server or app takes it, and Kiln writes no
record for it: its row says to point it at the Relay, and the certificate
status shows whether it resolves yet. Who may put a name under one follows
the rule for a connection's zones: its owner, the resource owner's domains
only for that owner, and Kiln's for administrators. The most specific domain
holding a hostname wins, a zone or one managed elsewhere. Cloudflare's proxy
doesn't apply.

Adding one takes in the hostnames Relays already route under it, each for the
instance whose routes serve it. A name more than one instance routes, or one
another already holds, stays as it was and is reported, for someone to keep
on one instance. A Relay that couldn't be read then is named, and takes in
its names as it next connects. A domain managed elsewhere can be removed once
no name is under it.

Any eligible person may add one, with nothing proving the domain is theirs,
and a domain is one Kiln has once: on a shared install, someone could hold a
domain they don't own. Whether to verify ownership or leave adding them to
administrators is #964.

Which connections a hostname may use is a security boundary:

- the person's own connections, for any name in their zones;
- the resource owner's connections only when the person is that owner, so
  someone an app is shared with can't publish names in its owner's zones;
- Kiln's connections' whole zones only for platform administrators;
- anyone may take a single name under a vanity domain they may use (below),
  and its `www` counterpart with it.

A save claims its new hostnames before anything reaches the Relay, so two
saves can't both take one. If the Relay write fails, the Relay may have taken
the routes anyway, so the names stay claimed, without records, until the
next save of those routes uses them or lets them go. It's refused
when a hostname is already held by another game server or app ("already in
use by" names it when the person can see it). Under a vanity domain someone
else owns, such as a Kiln provided one, it's also refused when the name is
reserved or Cloudflare already has a record for it. Names are compared
case-insensitively.

The Relay reports where web traffic reaches it as `publicHost` in its
snapshot, the same address game servers advertise (`KILN_RELAY_GAME_HOST`).
If the Relay reports none, Hearth uses a game server's reported public host,
then the address Hearth reaches the Relay at.

## Cloudflare's proxy

Each web route hostname Kiln keeps a record for is DNS-only or proxied
(Cloudflare's orange cloud). The route dialog's **Proxy through Cloudflare**
switch sets it for the route's hostname and its `www` counterpart, and the
save marks a record that changes for the next sync, like a new one. Kiln
keeps the records it manages that way, so Sync turns back a change made in
Cloudflare's dashboard. The Domains page and each web route show it; an
existing record shows how Cloudflare had it when Kiln last looked. A game
server's own address can't be proxied, so a route on it refuses the switch.

The Relay doesn't need to know: Traefik still gets each certificate over
HTTP-01, which Cloudflare passes through to it, and the Relay only checks
that the name resolves. Use Cloudflare's **Full (strict)** SSL mode with a
proxied hostname; **Flexible** sends plain HTTP to Traefik, which redirects
it back to HTTPS in a loop.

## Certificates

A Relay running bundled Traefik gets each web route hostname's certificate
from Let's Encrypt (`apps/relay/src/web-certificates.ts`). Traefik asks for
one when a route naming it first appears, and again only when its
configuration next changes. Asked before the hostname's record exists, Let's
Encrypt answers NXDOMAIN and may remember that answer, and the route would
serve Traefik's default certificate until some other route changed. So:

- Traefik asks for a hostname's certificate only once its name resolves,
  asked of its zone's own nameservers rather than a resolver, which could
  itself remember the name as missing. A route's other names don't wait for
  it. When the nameservers can't be reached or don't answer, Traefik asks
  anyway.
- Until the name resolves, the Relay checks it again: after 15 and 30
  seconds, 1, 2 and 5 minutes, then every 10 minutes. That costs nothing at
  Let's Encrypt.
- Once Traefik has asked, the Relay doesn't ask again on its own. If Let's
  Encrypt doesn't issue it, as when the name points elsewhere or port 80 is
  closed, someone fixing that clicks the hostname's status to have Traefik
  ask again. That changes Traefik's configuration, so Traefik asks again for
  every certificate it lacks, not just that one; the Relay does this at most
  four times an hour in all. Other route changes, and restarts, also have
  Traefik ask again, so this keeps Kiln's own asks down without promising
  to stay within Let's Encrypt's limits. Retrying on its own is left for
  later.

The Relay reports the hostnames still waiting in its snapshot. Hearth shows
them on the Domains page and beside each web route: **Verifying** while it
checks and asks, **Waiting for DNS** while the name doesn't resolve, and
**Unverified** when Traefik asked over two minutes ago and still has no
certificate, which most likely means Let's Encrypt refused. Whoever may
change the route can click the status to have the Relay check again now.

## Vanity domains

In a connection, any of its zones can be marked **vanity**, and one marked
the default (★). New game servers and apps then get an address under the
default, at a name Kiln makes from two words, like `deep-moon.<domain>`,
with an SRV record for game servers that support it, and a record pointing
at the Relay for an app. An App whose Brick says
which port its website answers on is served there from the start: making it
saves its first web route, from that address to the port, before its first
deployment, so a Relay behind someone else's proxy carries the route in the
containers it starts. That route takes what making the App does, not
`instance.network.write`, and is then the App's like any other. Making an
App waits up to eight seconds for that, since Cloudflare is asked along the
way; a route saved later than the App's containers shows, on a Relay behind
someone else's proxy, as waiting for a deployment.

An App that doesn't say has the address ready for a route. Its row in the
Domains table offers one while it has none: each port its running services
say they listen on that could be a website's, of any service, as a button
that points the address at it. Ports of other protocols (a database's,
SSH, 443) aren't offered. Nothing is routed until someone picks one: a port
an image exposes says it listens there, not that it is a website or meant
to be public, and several candidates, or a Compose project's services,
can't be told apart from their ports. The ports come from what each
container exposes, published or not; Kiln doesn't check that anything
answers HTTP on them.

An owner with
vanity domains of their own uses their default;
everyone else gets Kiln's default. With no vanity domain at all, nothing
is assigned. Unmarking a domain stops new addresses under it without
touching existing ones.

A connection with vanity domains can reserve names on them with
case-insensitive regular expressions, so nobody else takes `admin` or `www`.
A `{{bad-words}}` line reserves profanity, from the English list in the
[`obscenity`](https://github.com/jo3-l/obscenity) package Kiln ships with,
however it's disguised (`sh1t`, `f-u-c-k`). Reserved names bind everyone but
the domain's owner (Kiln's administrators, for Kiln's), and Kiln never
generates one. New connections start with both.

People with a game server's network permission can add, rename, and remove
its join addresses on its Network page, and choose its primary one, under
domains its owner or they themselves provide, or Kiln provides. A name they
choose is refused the same way as a web route's. An App's generated address
stays, as a row of its Domains table, until it is deleted there or the App
is; removing the route that serves it leaves the address pointing nowhere.

## Who holds a hostname

Every hostname Kiln keeps belongs to exactly one game server or app, in
`hostname_claim`, whether a vanity address or a web route uses it. A name is
claimed in the same transaction as the row that uses it, and let go in the
one that stops using it, so a game server's address and another resource's
web route can never share one, whichever comes first. A game server's own
web route on its domain's name holds the name too, with no record of its
own while the domain keeps one, and makes one when the domain is renamed or
removed. Moving a game server moves its claims with it; a name both its
domains and its web routes use moves with the domains. A connection can't be
removed while game server domains, web routes, or app addresses use it, so
none lets go of a name it still serves; removing a Relay marks everything
on it for deletion first, so the DNS worker finishes any delete Cloudflare
refuses.

A name stays claimed until its DNS records are gone. Removing a route or a
domain marks it for deletion; renaming a game server's domain claims the new
name beside the old one, moves Cloudflare's records, and only then lets go
of the old name. Nothing is rolled back: a rename or delete Cloudflare
refuses is finished later.

## Finishing DNS work

Requests change Cloudflare themselves, and record what they're doing in
MySQL first. Hearth's DNS worker (`Domains.dns`) finishes whatever they
left: records Cloudflare refused, renames and deletes cut short by an outage
or a restart. A row still waiting is retried after 30 seconds, then twice as
long each time, up to an hour; saving it again or Sync tries it at once,
including deletes left behind by a removed Relay. Sync also asks Cloudflare
about every record Kiln keeps, a game server's address and its SRV record
like a web route's, and makes one deleted there again.

Kiln can't make MySQL, the Relays, and Cloudflare change together. MySQL
decides who holds a name; Cloudflare allows several records under one name,
so it can't. Every record Kiln makes carries a comment naming its game
server or app, with a marker for the domain or hostname it belongs to that
stays the same when the game server moves. A record Kiln made but never heard
back about, as when Hearth stopped mid-request, is found by that marker: taken
up again instead of treated as someone else's, and deleted with its
hostname.

## Storage

- `domain_integration`: one row per connection, with `owner_id` (NULL for
  Kiln's), its encrypted token, its reserved names in
  `blacklist_patterns`, and the zones it reached when last checked.
- `domain`: every domain, unique across Kiln, with its provider
  (`cloudflare`, `manual`, `tunnel`). A Cloudflare domain is a vanity domain,
  with its connection and zone.
- `hostname_claim`: the game server or app each hostname belongs to,
  lowercase, one row per name.
- `instance_address`: one row per hostname a game server or app holds,
  whatever uses it, with the record Kiln made for it. `game` marks a game
  server's vanity address, which points at its game port and keeps its SRV
  record and the name a rename is moving it to. `routed` says web routes
  answer on it, and `is_generated` that Kiln made it as an app's address;
  for those it also keeps whether the record is proxied and, while one is
  `external`, the address record Cloudflare already had. A game server's web
  route on its own address is that address's row, with both.

## Where this is going: one model for every name

Planned; built in the steps below. Today Kiln keeps names three ways:
Cloudflare names in `instance_address`, hostnames outside every connected
zone only on the Relays that route them, and tunnel names in `tunnel_name`
under a tunnel's TLDs (see [Tunnels](instances.md#tunnels)). They become one
model: a **domain** says who writes its DNS, a **name** (an address) sits
under a domain and belongs to an instance, and where the name points follows
from its domain.

### Domains

A TLD is a domain like any other: `paper.kiln` and `paper.example.com` are
both a name under a domain. What differs is the domain's provider:

| Provider                         | Who writes the records                                                    | Names point at                                                           | A name is unique   |
| -------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------ |
| A DNS service (Cloudflare today) | Kiln, through the service's API                                           | the Relay (web routes, through its proxy) or a game server's public port | across every Relay |
| Managed elsewhere                | the domain's owner, by hand                                               | the Relay or a public port, like a DNS service's                         | across every Relay |
| A tunnel                         | Kiln, in its gateways' CoreDNS, with split DNS sending the domain to them | the member's own address on its gateway, every port, no proxy            | within the tunnel  |

- One `domain` table replaces `domain_zone` and `tunnel_domain`. A row has
  the domain, its provider, the connection (with its zone) or tunnel behind
  it, whether it offers generated names, which one is the default, and
  whether it takes new names. A connection's and a tunnel's domains take
  their owner from them; a managed-elsewhere domain keeps its own.
- Public domains (a DNS service's and managed elsewhere) are unique among
  themselves. Tunnel domains stay unique across Kiln too, until Hearth knows
  which tailnet each tunnel's login belongs to: split DNS is one map per
  tailnet, so two tunnels on one would overwrite each other's. A tunnel
  domain can't equal, sit under, or contain a public one, since on the
  tailnet it would answer for every public name beneath it.
- **Managed elsewhere** domains are added on the Domains page. Their names
  are real addresses: held, unique across Relays, and shown with the record
  to create, with the same resolve check the Relay makes before asking for a
  certificate. A hostname a Relay already routes outside every domain is
  attached to a managed-elsewhere domain someone adds; Kiln never guesses a
  parent domain, and a name two Relays both route is shown as a conflict.
- A connection is a provider's credentials, and says which service it is
  (`domain_integration.provider`). Cloudflare's API sits in one module
  (`effect/cloudflare-api.ts`); another service gets its own module beside
  it when people ask for one, and the connection's provider picks it. Record
  columns (ID, type, proxied, SRV) stay as they are.

### Names

- A public name is an `instance_address` row, unique across every Relay. A
  tunnel name stays a `tunnel_name` row, unique within its tunnel: the two
  share a hostname, an owner, being generated, and the primary address, but
  not who writes their DNS, their locks, their uniqueness, or their status,
  so one table would only add a filter to every public query. What makes
  them one model is the domain each sits under, the one Domains list, and
  the one primary address.
- `hostname_claim` stays as the reservation of every public name held,
  current or a rename's next; who holds it is the address.
- A member has one generated name per tunnel, which can be renamed but not
  removed.
- Generated public names are `adjective-noun`; tunnel names stay made from
  the instance's name (`survival.kiln`), since they only need to be unique in
  their tunnel and people type them.
- The primary address points at a public address, a web route (which can
  carry a path, until routes move to Hearth), or a tunnel name.
- Public names keep their status and retries per name in the DNS worker. A
  tunnel's DNS is one hosts file per gateway: a change rewrites it right
  away, each gateway records whether it has the latest, and the worker brings
  one that missed it up to date, never sending a file that leaves out an away
  gateway's members. The stopgap that undoes an alias whose DNS failed goes.
- An instance's Network page shows its names in one Domains list, each
  marked public or on a tunnel, with its provider's mark.

### Who may use a domain

Unchanged by the move, written down here so each provider keeps its rule:

- A DNS service's domain: a single name under one offering generated names
  for anyone who may use it (the owner's, or Kiln's for everyone), with
  reserved names and its `www` counterpart; any name in its zone for the
  connection's owner, the resource's owner's only for that owner, and Kiln's
  whole zones only for platform administrators.
- A managed-elsewhere domain: its owner, and platform administrators for
  Kiln's.
- A tunnel's domain: names there take the tunnel's manager and the member's
  network permission; aliases can be several labels deep; the generated
  name can't be removed.

### Steps

Each step is its own PR in one stack; every migration keeps row IDs, since
Cloudflare records carry `kiln:<id>` and primaries point at IDs, and fails
on a collision rather than skipping a row. The Relay protocol doesn't
change.

1. One address shape in the code: `WebHostname` and
   `InstanceDomainAssignment` fold into `Address`, and status means the same
   for a game address and a web name. Operation names stay, since the audit
   log keeps them. Done.
2. Domains get a provider: `domain_zone` becomes `domain` with its
   provider. Done.
3. Managed elsewhere: added on the Domains page, its names held; hostnames
   Relays route under it are taken in when it's added. Done.
4. Tunnel TLDs are domains: `tunnel_domain` rows become domains whose
   provider is their tunnel, in order, the first its default. Done.
5. Tunnel DNS with retries: each gateway records the hosts file it has, the
   DNS worker brings one that missed a change up to date, and the undo
   stopgap goes.
6. One Domains list: an instance's Network page lists its public and tunnel
   names together, marked by where they live.

Upgrading: migration 0087 moves each tunnel's TLDs into `domain` and stops
if one is already a domain there, a vanity domain by the same name, rather
than drop it. Before upgrading, this lists any (`kiln_` is the table prefix;
on a Hearth that stopped at 0087, the second table is already `kiln_domain`):

```sql
SELECT t.domain FROM kiln_tunnel_domain t JOIN kiln_domain_zone d USING (domain);
```

Renaming the tunnel's TLD or removing the vanity domain, then starting Hearth
again, finishes it; the migration picks up where it stopped.

Not in this: HTTPS for tunnel names, Hearth owning web routes, DNS
following a Relay's proxy mode, and tunnel domains shared per tailnet.
