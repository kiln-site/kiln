# Access model implementation and validation

Implemented 2026-09-08 from the approved [specification](access-permissions-plan.md).

## Delivered behavior

- Inviting an email creates/reuses a persistent enabled user. Verification evidence,
  account status, and resource invitation state are independent. Credential-less
  users claim the same identity through a single-use email or admin-shared manual link.
- Disabled users retain sessions and account-management access. Resource requests
  fail while disabled; open tabs resume when enabled without another sign-in.
- Resource assignments combine direct selections, multiple live local presets,
  immutable Kiln defaults, and additive Relay inheritance. Revoking an inviter
  does not revoke people they invited. Owners and platform authority are protected.
- Custom presets belong to one resource; copying produces an independent local
  definition. Mutations validate expanded additions against the actor's current
  authority under locks and revision checks. Unsupported engine operations are rejected.
- Shared operation permissions cover Hearth, CLI ceilings, Relay transports,
  browser leases, and SFTP. Existing authorization revision/delivery mechanisms
  handle live changes; existing bounded outage behavior remains in place.
- Pending invitations appear in infrastructure tables. Resource links lead to
  accept/decline dialogs; accepting navigates to the resource, declining stays put.
  Platform admins can accept for someone without verifying their account.
- The first editor uses checkbox columns and template search. Account administration
  shows verification/status evidence and dates. Notification inbox, billing/support
  exceptions, and schedule lifecycle after loss of access remain out of scope.

## Migration and rollout

Deploy Hearth and Relay from the same release so both understand the shared
permission catalog. Normal startup runs the additive, idempotent schema/backfill.
Take the normal database backup before an upgrade: a code rollback alone does
not revert the new authorization model.

The migration preserves user IDs, credentials, sessions, invitation subjects,
timed restrictions, and existing resource authority. Legacy roles become frozen
explicit selections, never dynamic ALL. Existing verification of unknown origin
is marked as legacy trust rather than invented email/manual evidence. Preflight
reports ambiguous normalized emails/ownership rather than choosing an identity.
Rerun markers prevent old roles from resurrecting revoked permissions. A separate
one-time projection removes unsupported direct dump permissions on Redis/Valkey.
No cleanup deletes ordinary unverified users.

New MySQL connections and migration sessions use UTC. Existing timestamp values
are not guessed or rewritten. Invitation delivery occurs after commit with stored
retry state; failed email delivery cannot undo the identity or invitation.

## Automated validation

- Full workspace typecheck and production build pass (Hearth, Relay, CLI, contracts).
- `vp check` passes with two existing array-sort warnings in the runtime-manifest test.
- Full workspace tests pass: Hearth 710, CLI 70; host Relay 445 pass/22 Docker-only
  skips. The Relay Docker suite separately passed all 467 tests.
- Shared contracts suite separately passed all 23 tests.
- Root migration/environment/boundary tests: 13 pass, two opt-in fixtures skipped
  in the default run. The actual MySQL legacy upgrade fixture was explicitly run
  against an isolated database and passed, including evidence preservation,
  normalized-email handling, timed status, Redis projection, and rerun behavior.
- Deterministic regressions cover implication/delegation, unsupported and cross-scope
  presets, fresh disabled status, CLI restrictions, protected ownership, secret-free
  overview projections, realtime authorization races, and independent Startup
  configuration/limits/network/power permissions.
- React Doctor changed-scope scan: 88/100, no errors. Rendering work removes new
  unstable arrays/callbacks and keeps pending invitation state outside active table models.

## Collaborative Preview validation

Used the worktree's OrbStack Hearth/Relay environment and a real stopped Paper
server, with an administrator, Billy, and Tom as disposable development identities.

- New invitation created an enabled/unverified ordinary identity; pending access
  did not authorize the resource API.
- Admin-shared manual claim established credentials and verification on the same
  identity without accepting its invitation.
- Pending server row and offered preset/permission details displayed correctly.
  Accept navigated immediately to the server's read-only console.
- Read-only configuration access showed Startup without editable fields or power.
- A linked preset update granted power; removing it removed Start from the open tab.
  Attempted self-escalation was denied.
- Disabling Billy moved the open tab to account status and denied resource requests;
  profile/security remained available. Enabling resumed the same tab/session.
- An existing verified user's new Relay invitation remained pending. Decline removed
  the row while preserving the current page and other server access.
- Admin-forced acceptance activated Tom's assignment while verification evidence
  remained empty.
- Revoking direct server access preserved effective Relay access and reported the
  inherited source. Overlapping pending access uses one inventory row with a review action.
- Delivered invitation IDs route credential-less recipients to account setup;
  signup preflight distinguishes reserved, claimed, and new addresses. Email claim
  tests cover one-time proof and portable, same-origin invitation return links.
- Platform administrator promotion and demotion work in the user table. Platform
  invitation creation/cancellation and immutable recipient binding have dedicated checks.

## Query fixture

Measured on MySQL 8.4.10 in an isolated local Docker database, one client, one Relay,
1,000 instances, 20 users, 20,000 relationships, 1,000 eight-permission presets,
40,000 direct selections, and 5,997 invitation attempts. The measured user had 848
active grants. SQL warmed three times, then sampled 30 times; expansion sampled
separately. These observations exclude HTTP/Effect overhead and are not throughput guarantees.

| Operation | Median | p95 |
| --- | ---: | ---: |
| Targeted resource + inherited Relay resolution, three SQL queries | 0.706 ms | 1.094 ms |
| Targeted in-memory grouping/expansion | 0.068 ms | 1.025 ms |
| Entire Relay resolution, same three query shapes | 42.158 ms | 135.962 ms |
| Entire Relay grouping/expansion | 7.259 ms | 9.929 ms |
| 99 pending scopes | 0.991 ms | 1.221 ms |
| Authorized directory, first 51 rows | 0.755 ms | 1.343 ms |

Targeted authorization reads only the target and its Relay. Broad inventory reads
scale with assignments; they are not substituted for each action check. Scoped SQL
filters run before pagination, including inherited membership. EXPLAIN checks led
to access-ID invitation and owner indexes: invitation lookup fell from scanning
5,997 attempts to an indexed three-row lookup (1.879 ms to 0.092 ms median).
The broad directory still materializes/sorts authorized resources for pagination;
substring search is not an index seek. No speculative distributed cache was added.

## Independent review corrections

The first streamed Cursor Grok 4.6 High Fast review identified four issues. Follow-up
changes bind platform invitations to immutable user IDs (including reissue/cancel),
restore platform role and pending-invitation controls, route reserved identities
through account setup, and remove a dangling SQL alias from the legacy owner query.
Regression tests cover email reuse by a different user, changed subject email,
expired/cancelled platform invitations, fresh account eligibility, and email claims.

Additional review cleanup removes the unused role-grant helper, deletes scoped
presets with their resource, projects Redis/Valkey engine support into effective
permissions, and corrects realtime invitation query keys. Invitation refresh uses
the existing stream; resource-access changes target relevant Relays instead of
invalidating every signed-in user's queries.

The second Grok review approved commit `d38b1429`. Its remaining signup-policy
observation was also closed: when public signup is disabled, the Better Auth
signup endpoint rejects new accounts without a historical invitation-email
exception. Invited identities use claim instead; trusted bootstrap still uses
its existing guarded internal path. An unauthenticated HTTP check confirmed the
closed signup response. Platform invitation pages now also refresh through the
access realtime topic rather than polling.
