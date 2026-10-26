# Domains

Kiln keeps DNS records in Cloudflare for the people who connect it. Anyone
who can reach game servers or apps can open **Infrastructure → Domains** and
connect one or more Cloudflare API tokens. Each connection belongs to the
person who added it; a platform administrator can also add Kiln-provided
connections, marked _Everyone_.

A token needs **Zone Read** and **DNS Edit** on the zones Kiln should use.
Hearth encrypts it at rest and never returns it to the browser. Every record
Kiln makes is DNS-only and carries a comment naming the game server or app it
belongs to.

## Web route hostnames

Saving a game server's or app's web routes brings its DNS records in line:

- a hostname in a zone on one of the person's own connections gets an `A`,
  `AAAA`, or `CNAME` record pointing at the Relay the route runs on;
- a hostname a route no longer uses loses the record Kiln made for it;
- moving a game server to another Relay, with its web routes, points their
  records at the new Relay.

Kiln never touches a record it didn't make. A hostname Cloudflare already
has a record for shows as **Existing record**, and Kiln checks it again on
the next Sync. A hostname in no connected zone is left for its owner to point
at the Relay by hand.

Which connections a hostname may use is a security boundary:

- the person's own connections, for any name in their zones;
- the resource owner's connections only when the person is that owner, so
  someone an app is shared with can't publish names in its owner's zones;
- the Kiln-provided connections' whole zones only for platform
  administrators;
- anyone may take a single name under a vanity domain they may use (below),
  unless the domain's owner reserved it.

The Relay reports where web traffic reaches it as `publicHost` in its
snapshot, the same address game servers advertise (`KILN_RELAY_GAME_HOST`).
Relays that predate it fall back to their game servers' address, then the
address Hearth reaches them at.

## Vanity domains

In a connection, any of its zones can be marked **vanity**. New game servers
and apps then get an address under one: `<name>.<domain>`, with an SRV record
for game servers that support it, and a record pointing at the Relay for an
app, ready for its first web route. An owner with vanity domains of their own
uses those, picked by their settings (default only, random, or spread
evenly); everyone else gets the Kiln-provided ones. Turning automatic
addresses off stops new ones without touching existing addresses.

Platform administrators can reserve names on Kiln-provided domains with
case-insensitive regular expressions.

People with a game server's network permission can add, rename, and remove
its vanity addresses under domains its owner, the platform, or they
themselves provide. An app's generated address stays until it is released or
the app is deleted.

## Storage

- `domain_integration`: one row per connection, with `owner_id` (NULL for
  Kiln-provided), its encrypted token, and the zones it reached when last
  checked.
- `domain_zone`: vanity domains, unique across connections.
- `domain_owner_settings`: how each owner's vanity domains are handed out;
  `''` is the platform.
- `instance_domain`: game servers' vanity addresses.
- `web_hostname`: web route hostnames and generated app addresses, unique by
  hostname, with the record Kiln made for each.
