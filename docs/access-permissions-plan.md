# Users, access, and permissions redesign

Status: implemented for review on 2026-09-08. This preserves the approved
specification and its design rationale. See [implementation validation](access-permissions-validation.md)
for the delivered behavior, migration notes, and checks. The shared contract
`packages/contracts/src/access-permissions.ts` is the authoritative shipped catalog.

- [Permission catalog and proposed options](access-permissions-catalog.md)
- [Implementation phases and validation](access-permissions-review.md)
- [Existing Relay browser-session design](relay-browser-sessions-plan.md)

## 1. Outcome and scope

Every person is a normal user record, including someone invited before claiming
an account. Account status, verification, resource access, and permitted actions
are independent facts. Instance and Relay presets provide live, resource-owned
permission definitions. First-pass editing uses existing forms and a few columns
of checkboxes. Polished permission-editor design is unnecessary.

In scope:

- Persistent invited users, verification evidence, and global enable/disable.
- Pending/active access with accept, decline, revoke, and platform-admin acceptance.
- Multiple resources in one access-creation flow, each independently scoped.
- Direct permissions, live local presets, immutable Kiln defaults, collections,
  implications, additive Relay inheritance, and bounded delegation.
- Consistent enforcement in Hearth, browser capabilities, CLI, and SFTP.
- Minimal users/access tables, pending infrastructure rows, invitation dialogs,
  dates, Sonner feedback, and automatic updates in open tabs.
- Migration of existing identities, roles, invitations, grants, and ownership.

Explicitly deferred:

- Notifications page and bell at the upper right of the sidebar beside the logo/
  name. Preserve invitation IDs and events for future accept/decline actions there.
  Notifications about new permissions expanding selected collections are also
  deferred; collection expansion itself is part of the model.
- Platform-admin mode styling; retain an authorization-source indicator for later.
- Billing, purchases, support pages, and configurable disabled-account exceptions
  such as downloading backups.
- Schedule ownership/execution after target access changes, including Fractures
  and instance-independent schedules. Section 10 records the unresolved problem.
- Personal templates, cross-instance linked custom presets, deny rules,
  per-instance suspension, and automatic copying into a server owner's account.
- An external authorization service, arbitrary policy language, and elaborate UX.

## 2. Confirmed decisions

| Concern | Requirement |
| --- | --- |
| Account | One identity with enabled/disabled status. Pending is not a user state. |
| Verification | Email or manual verification; preserve when/how/by whom. Unverified users cannot use normal application/resource features. |
| Invited users | Create or reuse identity immediately by email. A new identity starts enabled and unverified. |
| Acceptance | New and existing users accept each new resource invitation. Only platform admins can accept for someone else. Acceptance never verifies an account. |
| Manual onboarding | Redeeming a platform-admin-issued manual claim is sufficient; no second admin approval. Admins may also manually verify directly. |
| Disabled users | Can log in; preserve sessions, credentials, and assignments while resource authority is paused. Resume without mandatory login. |
| Empty accounts | Verified users with no resources retain profile/account use and future invitation eligibility. Future purchasing is separate. |
| Resource removal | Revoke access. With no remaining source, hide the resource and make direct navigation equivalent to unknown. |
| Ownership | Exactly one resource owner. Platform admins have full resource authority. Global status/verification restrictions are separate. |
| Delegation | Actor needs invitation/management authority and cannot grant permissions they do not possess at the target. |
| Invitation history | Invited-by records history, not an access inheritance tree. Removing Billy does not remove Tom merely because Billy invited Tom. |
| Custom presets | Belong to an instance or Relay, not a person. Assignments are live. Creator attribution grants no permanent management authority. |
| Reuse | Creating from a visible other-instance preset or Kiln default produces an independent local definition. No personal templates. |
| Combination | Multiple preset/direct assignments add together. No negative permissions or deny/exclusion rules. |
| Relay inheritance | Covers current and future children. Removing direct access leaves applicable Relay authority; explain remaining sources. |
| Defaults | Kiln ships immutable definitions; customization creates a local copy. |
| Collections | Nested collections, including scope-appropriate ALL, opt into future permissions introduced by Kiln. Applies to direct selections too. |
| Implications | Confirmed examples: file write includes read; stop includes start; invite includes view users. Other edges remain review items. |
| Editor | Composable blocks from supported resource capabilities, simple checkbox columns. No mandatory four-section hierarchy. |
| Revocation | Prompt connected updates; bounded existing authorization during outages using current WebSocket policy. |

Superseded ideas: personal/user-owned presets, owner-copy-on-invite, a locked
preset state, forced re-login on re-enable, and fixed top-level Instance/Access/
Schedules/Backups navigation. The old role labels are not the new authorization
model. Exact default preset labels/contents remain to be selected.

## 3. Current implementation audit

| Current behavior | Required change | Source |
| --- | --- | --- |
| Grants already live outside users and contain fixed roles. | Evolve grants into access records with permission/preset selections. | [schema](../apps/web/migrations/app.sql) |
| Existing users get immediate grants; newcomers have email-addressed invitations. | Persistent users and pending resource access for both. | [access](../apps/web/src/server/access.ts) |
| No-email creation sets emailVerified=true. | Record real manual verification rather than infer it from delivery configuration. | [auth](../apps/web/src/lib/auth.ts) |
| Selected auth requests delete unverified users older than 24 hours. | Expire challenges/attempts independently; preserve identity. | [auth](../apps/web/src/lib/auth.ts) |
| Pending email replacement deletes/recreates user identity. | Preserve IDs with an explicit email-change/claim policy. | [bootstrap](../apps/web/src/lib/auth-bootstrap.ts) |
| Ban handling differs across paths, including expiration. | One enabled/disabled policy separate from session validity. | [session](../apps/web/src/lib/auth-session.ts), [CLI](../apps/web/src/effect/cli-access.ts), [SFTP](../apps/web/src/lib/sftp-authorization.ts) |
| 38 resource permissions, 6 platform permissions, 52 overlapping Relay actions. | Shared catalog and explicit operation mappings. | [Hearth](../apps/web/src/lib/permissions.ts), [Relay](../apps/relay/src/permissions.ts) |
| Relay/resource permissions add together, but list deduplication can hide broader authority. | Show effective sources instead of a misleading single role. | [access control](../apps/web/src/lib/access-control.ts) |
| Several Relay/provisioning operations use platform role/creator checks directly. | Map scoped administration explicitly; preserve platform-only boundaries. | [Relays](../apps/web/src/server/relays.ts), [Bricks](../apps/web/src/server/bricks.ts) |
| Some requests reload grants; overview queries fan out per Relay. | Request reuse, batched authorization, and paginated lists. | [access](../apps/web/src/server/access.ts) |
| Browser capabilities already have leases, revisions, durable delivery, race guards. | Extend/reuse these mechanisms. | [issuance](../apps/web/src/server/relay-capability-service.ts), [delivery](../apps/web/src/lib/authorization-delivery.ts) |

## 4. User identity, verification, and status

### Current state and dates

Proposed user additions (field names illustrative):

| Field | Meaning |
| --- | --- |
| status | enabled or disabled; authoritative current account availability. |
| status_changed_at | When current status began. |
| status_changed_by, status_reason | Actor/explanation, nullable when actually unknown or system initiated. |
| email_verified_at | Known verification time for the current address, nullable. |
| manually_verified_at, manually_verified_by | Actual manual evidence and issuing/admin actor. |
| legacy_verification_recorded_at | Migration observation accepting pre-existing trust when original method/time is unknown; not proof of mailbox ownership. |

Keep creation/update dates. Use UTC and existing millisecond precision. Audit
every transition: status_changed_at cannot describe repeated disable/enable
cycles. Display Unverified, Email, Manual, or both where appropriate. Label legacy
trust honestly; never invent historic dates or manual/email evidence.

Account verification follows from valid evidence or the explicit legacy migration
case. Avoid another independently editable is_verified flag. Better Auth's
emailVerified can remain as an integration field; synchronize actual email
verification and preserve legacy provenance separately.

Adapt login/session eligibility for manual verification explicitly. The current
requireEmailVerification configuration must not prevent a manually verified user
from logging in merely because email delivery is enabled. Conversely, relaxing
that library check must not expose normal application access to unverified users.
Use supported Better Auth configuration/hooks and central application gates;
do not mark a manually verified mailbox proven just to satisfy a login check.

Changing email invalidates evidence for the old address as proof of the new one.
Proposed default: keep the old address until the replacement is proven; preserve
identity and history. Account merging and aliases are outside this PR.

### Account creation and claim

1. Normalize email consistently (trim/case policy; no provider-specific dot/plus
   rewriting), then create-or-reuse under a unique database constraint.
2. New user has no usable credential until claimed. Concurrent invitations reuse
   one ID. Reusing an account never resets its status, verification, credentials,
   or platform privilege.
3. Create authorized access records and invitation attempts transactionally.
4. Recipient proves email ownership or redeems an admin-issued manual claim,
   establishes their credential, and can then accept invitations.

Invitation tokens and verification/credential-claim tokens have distinct purposes.
Inviters may see an access link; that must not prove mailbox ownership or replace
an existing account's credentials. Existing users authenticate normally.

Manual tokens are hashed, expiring, single-use, subject-bound, and tied to the
issuing platform admin. Consume atomically and record redemption/issuer. No
additional admin approval is required. Without email delivery, normal inviters
can create pending access but cannot manufacture account verification.

Bootstrap/configured-super-user setup needs an explicit trusted setup path with
recorded provenance, not an already-existing administrator. Retain public-signup
configuration. Adapt onboarding for an identity that already exists; ordinary
sign-up must not fail merely because invitation creation reserved its email.

Unverified users can reach only necessary authentication/credential setup,
verification/claim, and logout. Normal profile/resource operations remain gated.
Expire challenges and invitations independently of the persistent user.

### Disabled accounts and resume

Do not implement disabled through a Better Auth ban operation that prevents login
or deletes sessions. Do not maintain conflicting status/ban switches indefinitely.

Proposed minimal allowlist: a verified disabled user can authenticate, see a
minimal disabled-account state, manage their own profile/security credentials,
and sign out. Resource operations, inviting, and preset/access management are
unavailable. Unverified+disabled remains limited to onboarding/account status.
These routes are not the future configurable disabled-user exception system.

Preserve login sessions and CLI credential records on disable; withdraw resource
capabilities and block new resource operations. Enable restores authority from
current assignments using still-valid sessions. Explicit logout, credential
revocation, security-driven password-reset behavior, deletion, and expiry remain
separate operations with their existing security effects.

Apply eligibility gates before owner/admin authority. Protect the last usable
platform administrator against accidental lockout. Keep a minimal authenticated
account-status invalidation path so a disabled tab can learn it was re-enabled
without retaining resource subscriptions.

Do not promise automatic resumption of interrupted commands/transfers or recall
of downloaded data/native database passwords. Already committed work is not
rolled back merely because a later authorization check would fail.

## 5. Resource access and invitations

### Access records

Keep the existing target tuple (relay_id, resource_type, resource_id), where type
is relay, instance, or database. Avoid a generic resource registry solely for this
change. One access record per user/target owns direct selections and preset links.

Proposed state: pending, active, revoked. Declined/expired/cancelled describe
invitation attempts. Pending access without a valid current attempt grants nothing
and is absent from ordinary pending resource lists; admin views derive its outcome.
Re-inviting creates a fresh attempt. There is no per-resource suspended state.

Operational authority requires active access or another eligible source such as
ownership or active Relay access. Pending selections describe an offer only.
Removing direct access does not erase ownership, platform, or Relay authority.

### Invitation attempts and operations

Store access reference, recipient user binding, email snapshot, hashed token,
inviter, created_at, expires_at, accepted_at/by, acceptance_method (self/admin),
declined_at, cancelled_at/by, and delivery metadata. Terminal decisions are
mutually exclusive per attempt. Expiry is checked against time on reads/writes;
correctness does not depend on a scheduled cleanup job.

| Operation | Behavior |
| --- | --- |
| Invite | Create/reuse user; pending relationship and new attempt for a new target. |
| Self-accept | Valid current attempt, matching authenticated user, verified/enabled account; accept and activate atomically. |
| Admin accept | Enabled/verified platform admin accepts valid pending attempt; record actor/method. Recipient status and verification still gate use. |
| Decline | Recipient records declined outcome; no active access; pending row disappears. |
| Cancel | Authorized access manager cancels pending invitation. |
| Revoke | Mark active relationship revoked; withdraw authority and retain history. |
| Re-invite | New attempt/token; invalidate prior current attempt. |
| Edit active access | Authorized assignment update; no repeated invitation acceptance. |

Admin acceptance may record acceptance for an unverified/disabled recipient; it
never verifies or enables them. Explain that remaining restriction in the admin
result. Self-accept after expiry/cancellation fails. Repeating a completed action
can be idempotent; a conflicting later action cannot overwrite it.

Bind authenticated decisions to user ID. Email is delivery/history, not a mutable
identity key that transfers invitations after an email change.

### Multiple-resource submission

Proposed first pass: a bounded distinct-target list, per-target delegation and
support validation, then one transaction committing all relationships/attempts.
No remote Relay RPC in that transaction. Report existing active access rather
than silently replace it; use an explicit access-edit operation for changes.

Deliver email after commit. Persist pending/sent/failed delivery information and
retry; email failure must not delete identity or revoke unrelated access. Reuse
a durable delivery mechanism where possible, otherwise use attempt delivery state
and a retry worker. This does not require the future notifications inbox.

Each target retains independent acceptance. A single creation flow does not make
one cross-resource grant or an obligatory accept-all decision. Accepting a Relay
invitation covers its inherited scope, including future children.

## 6. Permission definitions and presets

### Catalog and selections

Define canonical permissions and collections in shared contracts with stable IDs,
labels, descriptions, block IDs, supported resource capabilities, implications,
and mappings to operations. A database engine may support different operations
from another engine. Server-side support checks remain authoritative.

Store explicit permission/collection IDs with a selection kind. Collections may
nest; validate unknown references and cycles. Dotted IDs are not an arbitrary
wildcard policy language. Scope-appropriate ALL never grants platform authority
or transfers ownership through a child assignment.

Retain collection selections so future additions expand intentionally. Selecting
all current individual permissions does not imply opting into future additions.
Apply this rule identically to direct selections and presets. Precompute the
transitive implications. See the catalog worksheet for proposed options.

### Presets and reuse

Custom preset: target tuple, name, selections, revision, creator/last-editor
attribution, dates, and optional template provenance. Ownership follows the
resource. Copy provenance is history, not an update subscription.

Custom preset assignments reference the same target scope only. Relay presets
are assigned through Relay access and inherited by children. Copying across
resources previews unsupported options and checks the destination. Never bind an
instance assignment directly to another instance's custom preset ID.

Immutable Kiln defaults are confirmed. Proposed implementation: catalog-backed
defaults may be directly referenced by scoped assignments; customization creates
a local custom preset. Creating from a default is always an independent copy.
Final default contents and direct-reference behavior remain review items.

Multiple presets/direct selections form a union, with no rank, deny, or exclusion.
Preset edits update all local assignments. Creator removal does not remove the
preset. Ownership transfer leaves local presets attached to their resource.
Proposed deletion rule: remove/replace assignments before deleting a used preset;
show its affected assignment count.

### Delegation and editing

Inviters must be able to create/copy and customize proposed local definitions.
The exact split between inviting, editing assigned presets, and managing existing
people is not yet approved; see the catalog recommendation. Creation history never
grants permanent authority after access is lost.

For assignment or assigned-preset expansion:

1. Require current eligibility and the relevant management permission.
2. Resolve the editor's current effective authority before applying the change.
3. Expand proposed collections/implications in the target scope; additions must
   be a subset of authority the editor can grant there.
4. Validate affected assignment scopes. A Relay-wide grant needs Relay-scoped
   authority, not a union of permissions on today's children.
5. Commit with concurrency/revision protection against intervening revocation.

A user cannot expand their own preset, then use its proposed authority to pass
validation. Management never grants global verification/disable/platform-role or
protected owner actions. Authorized reductions should not require possessing the
permission being removed; lost delegation authority cannot obstruct revocation.

Bob owns the server; Billy invites Tom: Tom's access is independent of Billy's
inviter attribution. Billy's loss of access does not remove Tom. Shared local
preset edits are an intentional definition change, not inviter inheritance.

## 7. Proposed storage and integrity

Names below are illustrative; use existing prefixed-table conventions.

| Record | Fields/constraints |
| --- | --- |
| user | Existing identity plus section 4 status/evidence; normalized email unique. |
| access_grant | User, target tuple, state, current attempt reference if needed, acceptance/revocation/status dates, attribution, revision; unique user+target. Replaces fixed role. |
| access_selection | access_id, selection_kind/key; unique composite key. |
| permission_preset | Target, name, revision, template provenance, attribution, dates. Custom definitions if defaults remain catalog-backed. |
| preset_selection | preset_id, selection_kind/key; unique composite key. |
| access_preset | access_id, custom_preset_id or builtin_key, assignment actor/date; exactly one reference kind and unique assignment. |
| invitation | Attempts from section 5; recipient/access/token/expiry indexes. |
| verification challenge | Better Auth email mechanism; purpose-bound manual claims with issuer/expiry/consumption. Reuse verification storage only if its semantics fit. |
| auth/access audit | Reuse/extend kiln_auth_audit with unambiguous actor, subject, target, old/new revision or values, timestamp. No raw tokens/credentials. |
| authorization_subject / authorization_delivery | Existing durable revisions/delivery; extend only when measured fanout requires it. |

Selection rows support one joined/batched read, not one query per permission.
Foreign-key selections/assignments to parents. The target tuple cannot use one
ordinary FK to three resource tables: validate target existence and same-scope
binding transactionally and clean up on resource deletion. Use concrete user/Relay
FKs where existing types/collations permit; verify before generating SQL.

Instances already have owner_id. Relay/database created_by and legacy owner-role
grants need an explicit migration policy, not accidental privilege elevation.

Index candidates, subject to EXPLAIN on actual query shapes:

- Access unique (user_id, relay_id, resource_type, resource_id); scoped list index
  (relay_id, resource_type, resource_id, state, user_id).
- Recipient pending lookup (user_id, state, target) and attempt recipient/access
  plus expiry/terminal filters; stable list pagination.
- Presets by target; reverse assignments (preset_id, access_id) for invalidation;
  selections by parent composite key.
- User email lookup and genuine status/date list filters; avoid LOWER(email)
  scans for authentication when normalized/indexed lookup is available.
- Audit subject/target plus timestamp/ID; never reconstruct authority from events.

## 8. Enforcement, freshness, and performance

### Evaluation order

1. Authenticate the session/credential; load current account policy.
2. Apply verification/status gates for the action class.
3. Resolve real target and supported operations.
4. Resolve eligible admin/owner, active direct, and active Relay sources.
5. Expand/union applicable preset and direct selections.
6. Apply credential restrictions and paired Relay-client ceilings. Do not re-expand
   in a way that restores removed authority; deny dependent operations when their
   required implications are unavailable under the credential ceiling.
7. Check operation permission plus separate target/state/destination conditions.

Use typed internal decisions/source explanations where useful. Externally,
unknown/unauthorized targets are equivalent. Invitation metadata is a separate,
minimal read. Do not disclose unrelated targets through explanation APIs.

Apply the model to server functions, CLI, direct/proxied browser capabilities,
files, SFTP, resource lists, activity, and schedule management/manual execution.
Audit role/creator checks and broad payloads as well as named permission helpers.
Machine-client credentials remain a separate upper bound. Native passwords and
published links have independent lifecycles; account disable is not their rotation.

### Leases and invalidation

Retain current browser read/write maximum leases (60/30 seconds), revision floors,
proof binding, and issuer generation. Current SFTP refresh is 15 seconds; retain
initially with corrected policy checks. Do not introduce the earlier proposed
two-minute lease. Review legacy/fallback transports separately before claiming
one common revocation guarantee.

Status/verification, access, ownership, preset changes, and explicit session
revocation invalidate the appropriate scope. Pause/resume preserves identity
sessions; explicit revocation still uses the session-specific path.

Commit policy, authorization revision, and durable delivery intent together;
notify after commit and retry until acknowledged. Capability issuance must detect
concurrent account, access, and preset mutations. Push blocks newly admitted work
promptly while connected; lease expiry bounds old authority during partitions.
Existing access may continue during an outage within those bounds.

Use reverse preset assignments to discover affected subjects. Initially prefer
existing subject revisions with set-based writes and batched delivery. Never
expand a Relay grant into all child rows. Updating a preset then asynchronously
invalidating users without a freshness guard is insufficient: stale caches could
mint new leases during fanout. Either commit affected revisions with the edit or
add an authoritative scope/preset revision check before acknowledging the change.
Measure large Relay-preset edits to choose the smallest correct implementation.

### Scale and targets

One Hearth replica initially. Planning envelope: 100 Relays x 1,000 instances =
100,000 instances, with 25,000 running at 250 per Relay. Twenty users each means
up to 2,000,000 direct relationships, not necessarily distinct users. Five active
users each means 500,000 active relationships across all instances, or 125,000
across running instances. Relationships are not a measured socket count.

- Authenticate once; reuse relevant authorization within a request.
- Local set checks after resolution; no database query per permission/frame.
- Batched resource-list authorization; no query per displayed row.
- No child rows for Relay inheritance or copied permission rows per preset user.
- Bounded active-context caches, including negative entries; not all possible pairs.
- Start with request reuse and immutable definition caches. Cross-request effective
  caches require account/access/preset/catalog freshness and reliable invalidation.
- Paginate lists, limit bulk inputs, and bound fanout/renewal work.
- Measure SQL count/rows, cold/warm p50/p95 latency, memory, edit fanout, and
  revocation delay while connected/disconnected, including renewal bursts.

Upper-envelope capacity is a benchmark goal, not a verified claim. Do not add
Redis, bitsets, or an external engine without evidence they are needed.

## 9. Minimal UX

### Users and access lists

Platform users appear as normal rows from invitation creation onward: identity,
enabled/disabled, verification, access summary, and relevant dates. Resource
managers see only scoped people/metadata. Pending applies to each relationship,
not to the whole person. Platform admins can disable/enable, manually verify,
issue manual claims, and accept for recipients, with actor/time recorded.

Scoped lists show pending/active people, protected owner, presets/direct access,
and inherited sources. Revoking direct access explains any remaining Relay,
owner, or platform access instead of reporting complete removal incorrectly.

### Checkbox editor

Select recipient and one or more targets. Each target has local/default preset
selections and/or direct selections in a responsive few-column checkbox grid.
Per-target forms are sufficient; mixed-value bulk editing is optional.

Resource capabilities supply blocks such as power, files, database credentials,
networking, access, schedules, and backups. No fixed four-section navigation.
Implied permissions show their source; incompatible unchecking explains what
must also be removed. Distinguish ALL from today's individually selected members.
Show delegation limits using shared tooltips; validate everything server-side.

Preset UI can be a simple local list/editor: blank/from-template creation,
checkbox edits, affected assignment count, copy, and unused deletion/replacement.
Defaults cannot be edited in place. JSON import/export is optional follow-up;
local template copying suffices for the first pass.

### Invitation interactions

| Interaction | Result |
| --- | --- |
| Infrastructure table | Pending target row with invitation marker and minimum display metadata. |
| Click pending row | Accept/decline dialog on that infrastructure page. |
| Direct pending-target URL | Redirect to respective infrastructure page and open its dialog. |
| Accept | Commit, update relevant access/list state, navigate immediately to the target, Sonner confirmation. Remove current arbitrary success delay. |
| Decline | Commit, remain on current page, remove pending row, Sonner confirmation. |
| Revoked/unknown URL | Equivalent unavailable behavior; no invitation dialog without a valid invitation. |
| Unverified recipient | Verification first, preserving intended invitation destination. |
| Disabled recipient | Account-disabled state; no normal resource access. |

Authenticated recipients accept/decline by invitation ID; token links resolve to
the same subject-bound operations. Future notifications reuse these APIs. An
email-link token must not be the only way to accept a listed invitation.

If Relay authority already grants access, keep one accessible resource row and
show any additional pending direct assignment without blocking existing access.
Accepted navigation chooses an actually authorized destination. Console is not
always permitted; a minimal overview/fallback must work with basic visibility.

### Open tabs and rendering

Invalidate affected user/scope/preset/list records only. Keep checkbox draft state
local, subscriptions narrow, and row identities stable. Do not put a changing
whole-fleet permission object in app-wide React context or refetch every Relay for
one checkbox/accept/decline.

On access loss, withdraw affected streams and clear unauthorized cached content.
Keep a permitted account-status channel for enable/resume. Reconcile on reconnect
and focus as appropriate; normal resume must not require a page refresh. Sonner
feedback should survive navigation without duplicate action notifications.

## 10. Deferred schedule authority

Example: a schedule targets Survival and Creative, then its creator loses access
to Creative. Future work must define ownership, visibility, editing, manual runs,
and background execution authority for partially accessible targets, including
Fractures and instance-independent schedules.

This PR does not add automatic cancellation, target removal, ownership transfer,
or stopping because a creator is disabled/revoked. Preserve appropriate current
management/manual-execution checks while adapting representation. An existing
background schedule does not give its former creator interactive authority over
unauthorized resources. Record the issue; do not solve its lifecycle in this PR.

## 11. Migration and compatibility

Follow existing additive schema and repeatable backfill conventions. Updating
CREATE TABLE alone does not upgrade an installation. Rehearse against a restored
fixture; no real migration is authorized by this planning document.

1. Inventory identities, bans/expiry, owner fields/roles, scoped/platform invites,
   credentials, and missing/conflicting targets.
   Preflight normalized-email collisions and differing existing email column
   lengths/collations before creating identities from invitation rows. Report
   incompatible records rather than truncating or merging them silently.
2. Add columns/tables/indexes; remove unverified identity cleanup before creating
   persistent invited users. Preserve user IDs, credentials, and valid sessions.
3. Preserve unknown verification method/time as legacy provenance, not fabricated
   email/manual proof. Map known evidence only when actually available.
4. Backfill one user per invited email. Preserve valid old token hashes/expiry,
   bind attempts to identities/access, and create no usable placeholder passwords.
5. Map role grants to equivalent explicit selections or immutable versioned
   compatibility definitions. Do not turn legacy roles into dynamic ALL without
   approval. Splitting files/settings/power must account for all old operations.
6. Resolve ownership from authoritative records. Report conflicting owner grants,
   missing owners, and Relay/database creator semantics instead of arbitrarily
   elevating/removing authority.
7. Map current bans consistently. Expired bans must not become permanent disabled
   accounts. Preserve intent of future timed restrictions through an explicit
   migration decision rather than silently ignoring expiration.
8. Preserve platform-admin/Relay-creation abilities and platform invitations.
   Platform invitations are platform assignments, not instance presets. Replace
   existing exclusivity with scoped access only after equivalent rights are mapped.
9. Differentially compare old/new decisions, including read-only credentials and
   fallback paths. Report every changed answer, separating approved implications
   and intentional corrections from accidental privilege changes.
10. Cut over all readers/writers; publish revisions. Prevent old broad endpoints
    or incompatible Relays from bypassing fine-grained checks; use protocol support
    checks/minimum versions where necessary.
11. Retain legacy data until validation. Once granular grants exist, rollback
    cannot silently map them back to broad roles: use a verified restore or an
    explicitly reviewed reverse migration. Re-run migration tests for idempotency.

No reset, destructive migration, production operation, application commit/push,
or runtime implementation is part of this planning task.

## 12. Review decisions resolved during implementation

| ID | Decision | Recommended starting point |
| --- | --- | --- |
| R1 | First-pass checkbox granularity, implications, defaults. | Shipped typed atomic permissions, composable blocks, explicit dynamic collections, and immutable Observer/Operator/Administrator defaults. |
| R2 | Invite authority versus managing assigned local presets. | Invite includes viewing users/presets and creating/copying definitions; assigned edits require explicit preset management and bounded delegation. |
| R3 | Legacy platform roles, ownership inconsistencies, timed-ban mapping. | Preserve existing authority/intent with a migration report; explicitly map Relay creation and remaining timed restrictions. |
| R4 | Defaults directly assignable as well as copy sources. | Support immutable catalog references within scoped assignments; editing creates a local copy. |

These are unresolved product/compatibility details, not missing conversation
history. Resolve table names, query shape, and bounded batch sizes through current
conventions and measurements. Do not reopen confirmed personal-preset, acceptance,
disabled-session, or additive-inheritance decisions.
