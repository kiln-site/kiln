# Access control

Every person in Kiln is one user record, created the first time someone
invites their address. Whether the account is verified, whether it is
enabled, which resources it can reach, and what it may do there are separate
facts. The permission catalog, its collections, the Kiln presets, and the
implications between permissions live in
[`packages/contracts/src/access-permissions.ts`](../packages/contracts/src/access-permissions.ts);
Hearth, the CLI, and Relays all read that one list.

## Accounts

Addresses are trimmed and lowercased, and each belongs to one account.
Inviting an address that has no account creates one, enabled and unverified,
with no way to sign in yet. Inviting it again, or to more resources, reuses
the same account and never changes its status, verification, credentials, or
platform role.

**Verification** follows only from recorded evidence (`account-policy.ts`):

- **Email**: `emailVerifiedAt`, set by Better Auth's email verification or by
  redeeming an emailed claim.
- **Manual**: `manuallyVerifiedAt` and `manuallyVerifiedBy`, set when a
  platform administrator verifies the account, when someone redeems a claim
  an administrator issued, or, with no actor, when public sign-up is on and
  email delivery is not, since nobody can prove a mailbox then.
- **Legacy**: `legacyVerificationRecordedAt`, for accounts verified before
  Kiln recorded how.

Better Auth's `emailVerified` flag alone proves nothing. Changing an
account's email clears all three.

**Status** is `enabled` or `disabled`, with who changed it, when, and why.
Only platform administrators change it. A disable with an expiry lapses on
its own; setting status from the Users page clears any expiry. Kiln keeps at
least one enabled, verified platform administrator: it refuses to disable,
demote, or remove the last one.

An **unverified** account can only sign in, sign out, verify, reset its
password, switch to another signed-in account, and read its own status.
Better Auth refuses every other endpoint for it.

A **disabled** account keeps its sessions and CLI credentials and can still
sign in. If it is verified, it can still manage its own profile, security,
sessions, linked CLIs (except approving a new link), and appearance. It can't
reach resources, invite people, or use any administrator authority. Every
resource and administration server function first requires an enabled,
verified account (`requireEligibleResourceUser`), and this check comes before
the platform administrator bypass. Enabling the account restores its access
on the sessions it already has.

### Setting up an invited account

An account with no password or passkey is set up with a **claim**: a
single-use link that expires after 30 minutes. The person can request one by
email while email delivery is configured, at most once a minute. A platform
administrator can also issue one and share it by hand. Redeeming a claim sets
the password and records email or manual verification, depending on which
kind it was. Issuing a claim invalidates the account's earlier ones. Redeeming
one doesn't accept any invitation. With public sign-up off, Better Auth's
sign-up endpoint refuses new accounts, so invited people use their claim
instead.

## Invitations

People are invited to a Relay, a game server, or a database. An App can't be
shared directly: people reach it through its Relay or by owning it. One
invitation can name up to 25 distinct resources, each with its own
permissions and presets. Kiln checks each one against the inviter's authority
and commits them all in one transaction. Each resource gets its own access
grant (`access_grant`, state `pending`, `active`, or `revoked`) and its own
invitation attempt (`invitation`), which expires after seven days. A resource
where the person already has active access, or which they own, is reported as
existing and left unchanged.

| Action       | Who                                       | Effect                                                                                                       |
| ------------ | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Accept       | The invited account, enabled and verified | Grant becomes `active`. Acceptance never verifies the account.                                               |
| Admin accept | A platform administrator                  | Same, recorded as `acceptance_method = 'admin'`. The recipient needs an enabled, verified account to use it. |
| Decline      | The invited account                       | Attempt declined; the grant grants nothing.                                                                  |
| Cancel       | Anyone with `access.manage` there         | Attempt cancelled; the grant grants nothing.                                                                 |
| Revoke       | Anyone with `access.manage` there         | Grant becomes `revoked` and its open attempts are cancelled.                                                 |
| Re-invite    | Anyone with `access.invite` there         | Replaces the pending grant's permissions and cancels the old attempt. Revoked access becomes pending again.  |

Each decision is bound to the account the invitation was made for, never to
an email address. Expiry is checked against the clock whenever an invitation
is read or used, so no cleanup job is needed. Repeating an accept or a
decline that already happened succeeds; any other decision on a finished
attempt fails. A pending grant with no live attempt grants nothing.

Email goes out after the transaction commits, as a durable operation
(`access-invitation-delivery.ts`). It retries after 2, 10, and 30 minutes,
then 2 hours, then every 6 hours, and stops once the invitation is answered,
revoked, or expired. The emailed link names the invitation by ID, so the
recipient must sign in as the invited account to answer it. The inviter gets
a token link they can share themselves. A failed email never undoes the
account or the invitation.

Platform administrators give platform roles. An account picked on the Users
page, or any account that can already sign in, gets the role at once. Any
other address gets a platform invitation instead. It expires after seven
days and is accepted by token from the invited account. Kiln emails it once
when it's made, with no retries.

## Permissions

An account's authority on a resource is the union of everything that applies
to it. Nothing subtracts from it: there are no deny rules.

- **Platform administrator**: everything, everywhere.
- **Ownership**: see [Ownership](#ownership).
- **Relay grant**: applies to the Relay and to every game server, database,
  and App on it, including ones added later. Kiln never writes per-child rows
  for it.
- **Direct grant**: applies to one game server or database.

Each grant holds direct selections and preset assignments. A selection names
either a permission or a collection. Collections are generated from the
catalog: one `<block>.all` per editor block, one `<scope>.all` per resource
kind, and `all`. Kiln stores the collection key, not its members, so
selecting a collection includes permissions Kiln adds to it later. Selecting
every current member one by one does not. Stored permissions that the catalog
or a database's engine no longer supports grant nothing; they don't cause
errors. New input that names them is rejected.

Implications are transitive and listed in the contract, for example: file
write includes file read, kill includes restart, stop, and start, and
`access.invite` includes `access.read` and `preset.create`. Every Relay, game
server, database, or App permission also includes its kind's `.read`. Shared
permissions (people, presets, backups, schedules) reveal only the resource
they're granted on. At Relay scope, backup and schedule permissions also
reveal that Relay's game servers and databases, but people and preset
permissions don't. Any Relay grant reveals the Relay.

**Presets** come in two kinds:

- Kiln's built-in Observer, Operator, and Administrator presets, which can't
  be edited and are assigned by key.
- Custom presets that belong to one Relay, game server, or database. They can
  be assigned only on that resource. To reuse one elsewhere, copy it.

Assignments are live: editing a custom preset changes everyone it's assigned
to. A preset that's still assigned can't be deleted. Creating a preset takes
`preset.create`; editing or deleting one takes `preset.manage`. Edits are
checked against the preset's revision.

**Delegation**: adding access, editing it, or saving a preset expands the
proposed selections, implications included. Every permission that change adds
must be one the actor holds on that resource right now, checked again inside
the transaction (`assertDelegation`). Removing permissions needs no such
check. A Relay-wide grant takes authority from Relay grants only, never from
access to its game servers. Who invited whom confers nothing: revoking an
inviter leaves the people they invited alone.

**Ceilings** limit credentials further but never add authority. A read-only
CLI link refuses every mutation, and a link with no expiry must be read-only.
SFTP gives each game server only the file actions its effective permissions
allow, minus the writes a read-only CLI token can't make. To create a Relay
machine client, a person must hold, on that Relay, every permission the
client's role or actions map to (`permissionsForRelayClientPolicy`). The
Relay enforces the read-only action list itself.

## Ownership

Each resource has exactly one owner. A Relay's owner is the person who paired
it (`relay.created_by`). A game server's, database's, or App's owner is its
creator (`owner_id`). A game server whose creator is unknown is owned
provisionally by its Relay's owner, until the Relay's audit log names who
created it. Owners of a Relay, game server, or database hold `all` there;
on a Relay, that covers everything on it. An App's owner holds only
`app.read`, `app.logs.read`, and `app.delete`.
Configuring and deploying an App, opening its shell, and using its files can
reach the Relay's host, so those still take App permissions on the Relay.

Only the owner or a platform administrator can transfer ownership, to an
enabled, verified account that already has access there: an active grant on
the Relay or the resource, ownership of the Relay, or the platform
administrator role. Transfers other than an App's also take `access.manage`
on the resource. The owner's own grant on a resource can't be edited until
ownership moves. The Users page won't remove someone who still owns
something. Removing a person revokes their grants, cancels their platform
invitations, and drops their platform role; the account itself stays.

## Platform roles

Platform authority comes from the role, `admin` or `relay_creator`, shown as
Kiln Admin and Relay Creator. No grant, collection, or preset carries it,
and a resource's `all` never does. Relay creators can pair Relays and add
Brick catalogs and custom Bricks. Only platform administrators can manage
accounts (status, verification, claims, platform roles, platform
invitations), accept invitations for others, update Hearth, reach Kiln's own
services, schedule Kiln's backups, and use the remaining platform permissions
in `apps/web/src/lib/permissions.ts`: backup storage and limits, the default
appearance, and overriding the public-port range.

## Enforcement

Checks run on the server, in Hearth's server functions and the CLI API, and
in the Relay for its actions. Resolving a scope loads the account's grants
for that resource and its Relay once per request, then checks permissions
against that local set. Resource lists, the Access page directory, and
schedule targets show only what those grants reach; the Access directory
filters in SQL before paginating. A resource the account can't reach looks
the same as one that doesn't exist.

Browser capabilities for consoles, files, and usage are issued only after
Hearth reads the account, session, and authorization revision again. If the
revision keeps changing during issuance, the capability is refused. Relays
bound each capability with a lease of at most 60 seconds for reads and 30
seconds for writes; see [Relay browser sessions](relay-browser-sessions.md).

Any change to someone's authority advances that person's revision
(`authorization_subject`) and records a delivery intent for the affected
Relays, both in the change's own transaction. This covers status,
verification, platform roles, grants, accepted invitations, presets,
ownership, deleting a resource, and revoking a session or CLI link. After
commit, Hearth pushes the new revision to those Relays, which drop what they
cached for that person. Open tabs refresh through the `access` realtime topic. Deleting a
game server or database removes its grants, presets, and open invitations.

## Known limits

- Schedules have no owner with authority over their targets. Seeing a
  schedule takes `schedule.read` on every target; editing or running it takes
  the matching schedule permission and each action's permission on every
  target, so a schedule with any target someone can't reach is hidden from
  them. Schedules keep running in the background whatever their creator's
  current access, and nothing defines who controls a schedule whose targets
  only some people can reach.
- Apps can't be shared on their own; App permissions are Relay-wide.
- Custom presets can't be shared across resources, only copied.
