# Domains

Kiln keeps DNS records in Cloudflare for the people who connect it. Anyone
who can reach game servers or apps can open **Infrastructure → Domains** and
connect one or more Cloudflare API tokens. Each connection belongs to the
person who added it. People can't share their domains; a platform
administrator can also add connections owned by **Kiln**, whose vanity
domains are **Kiln provided**: anyone may get an address under them.

A token needs **Zone Read** and **DNS Edit** on the zones Kiln should use.
Hearth encrypts it at rest and never returns it to the browser. Every record
Kiln makes is DNS-only and carries a comment naming the game server or app it
belongs to.

## Web route hostnames

Saving a game server's or app's web routes brings its DNS records in line,
for every hostname a route answers on, its `www` counterpart included:

- a hostname in a zone on one of the person's own connections gets an `A`,
  `AAAA`, or `CNAME` record pointing at the Relay the route runs on;
- a hostname a route no longer uses loses the record Kiln made for it;
- moving a game server to another Relay, with its web routes, points their
  records at the new Relay.

Kiln never touches a record it didn't make. A hostname Cloudflare already
has a record for shows as **Existing record**, and Kiln checks it again on
the next Sync. A hostname in no connected zone is left for its owner to point
at the Relay by hand; the Domains page still lists it, as **Manual DNS**,
from what each Relay's proxy serves.

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
Relays that predate it fall back to their game servers' address, then the
address Hearth reaches them at.

## Vanity domains

In a connection, any of its zones can be marked **vanity**, and one marked
the default (★). New game servers and apps then get an address under the
default: `<name>.<domain>`, with an SRV record for game servers that support
it, and a record pointing at the Relay for an app, ready for its first web
route. An owner with vanity domains of their own uses their default;
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
its vanity addresses on its Network page, under domains its owner or they
themselves provide, or Kiln provides. A name they choose is refused the same
way as a web route's. An app's generated address stays until it is deleted
or the app is; while a web route uses it, it goes with the route instead.

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
including deletes left behind by a removed Relay.

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
- `domain_zone`: vanity domains, unique across connections.
- `hostname_claim`: the game server or app each hostname belongs to,
  lowercase, one row per name.
- `instance_domain`: game servers' vanity addresses, with the name a rename
  is moving one to.
- `web_hostname`: web route hostnames and generated app addresses, with the
  record Kiln made for each.
