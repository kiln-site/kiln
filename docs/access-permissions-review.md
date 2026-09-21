# Implementation and review plan

Companion to [the main specification](access-permissions-plan.md) and
[permission catalog worksheet](access-permissions-catalog.md).

Status: implementation completed for review. The phase/checklist below records
the approved implementation approach; [validation results](access-permissions-validation.md)
record what was actually exercised. This is one PR; deployment remains a separate action.

## 1. Preparation and decision gate

Before application implementation:

- Resolve catalog granularity/default contents (R1), inviter versus assigned-preset
  management (R2), and default direct-reference behavior (R4).
- Produce the migration inventory for R3: platform-role abilities, timed bans,
  conflicting/missing owners, and unknown verification provenance. Settle mapping
  before writing a destructive/backfill step, not by guessing during migration.
- Capture representative current authorization answers and query counts. Include
  role-only checks, CLI read-only ceilings, SFTP, direct/proxied and legacy Relay
  paths, pending signup, and users with overlapping direct/Relay grants.
- Use the repository's Vite+/Effect conventions. Do not patch framework/library
  internals or edit .repos/effect.
- Before core changes, follow AGENTS.md: start pnpm dev:docker, immediately open
  the printed OrbStack URL in T3 Preview, and confirm Hearth loads. Keep Preview
  available throughout development. Do not validate against a local IP.
- Run the local intent skill check before substantial edits. The planning run on
  2026-09-08 reported no intent-enabled packages. Recheck for implementation.
- Apply the Better Auth integration/security skills for actual identity changes;
  React Doctor for React completion; CLI skill if CLI behavior changes; Sentry
  guidance when debugging. Keep the CLI skill synchronized with CLI changes.

## 2. Implementation sequence

### Phase A: catalog and pure resolution

Deliver canonical permission/collection/support metadata, implication expansion,
explicit selection parsing, and a pure additive resolver. Keep account eligibility,
resource scope, credential limits, and operation conditions explicit inputs.

- Reuse packages/contracts for shared definitions and typed validation.
- Map all current Hearth strings and Relay actions, including broad settings,
  files, schedule.write, and creator/admin-only routes.
- Preserve labels separately from identifiers. No runtime branching on an old
  Owner/Admin/Operator/Viewer label as the new resource policy.
- Reject cycles/unknown IDs and unsupported targets; preserve dynamic collection
  semantics and stable compatibility IDs for migration.

Review result: a deterministic resolution table demonstrating selected, implied,
inherited, and credential-restricted permissions without a database per check.

### Phase B: schema, identity, and verification

Deliver additive migration code and persistent invite-created identities, while
preserving existing IDs/sessions/credentials.

- Extend user status/evidence and audit storage.
- Add scoped preset/selection/assignment structures and invitation-attempt linkage.
- Remove the 24-hour unverified identity cleanup and delete/recreate email path.
- Implement claim of an existing credential-less identity, email verification,
  manual admin claim/direct verification, and explicit bootstrap provenance.
- Distinguish disabled from Better Auth bans/session revocation; gate unverified
  and disabled routes centrally while keeping allowed account operations usable.
- Preserve configured public signup; handle concurrent invite/signup/claim by
  normalized email without creating duplicate or takeover-prone accounts.

Review result: an unclaimed user is an ordinary row, can be invited repeatedly,
claims the same ID, and gets no resource authority before eligibility+acceptance.

### Phase C: access and preset mutations

Deliver transactional multi-target invitation creation and scoped preset CRUD,
direct/preset assignment changes, accept/decline/cancel/revoke, and admin acceptance.

- Validate actor status, scope, support, and expanded delegation before committing.
- Recheck authority with locking/revision guards against concurrent changes.
- Tie custom preset references to the assignment's scope.
- New attempts invalidate previous tokens; repeated decisions are idempotent and
  conflicting accept/decline/revoke outcomes cannot resurrect access.
- Deliver messages after commit with persisted retry state.
- Preserve protected ownership and independent inviter attribution.
- Record dates, actors, state changes, and preset/assignment revisions.

Review result: Bob/Billy/Tom, multiple presets, inherited Relay access, and
multi-resource pending invitations behave exactly as specified.

### Phase D: all enforcement paths and invalidation

Deliver one resource policy across Hearth and runtime transports before exposing
checkboxes that suggest more control than the backend enforces.

- Replace resource role/creator shortcuts or intentionally map their equivalent
  owner/platform authority. Preserve platform-only decisions.
- Audit every file mutation against its operation, plus uploads, URL downloads,
  archives/extract/copy, SFTP attributes, and final deletion workflows.
- Audit broad read payloads: overview data must not expose startup credentials,
  files, user email lists, or unrelated resources without appropriate permissions.
- Apply to CLI, direct/proxied browser access, capability renewal, SFTP, backup
  destinations, database networking, activity, and schedule management/manual run.
- Keep existing browser lease bounds and SFTP refresh initially.
- Commit policy and revision/delivery intent together; protect issuance from
  concurrent preset/account/access changes and cache-fanout races.
- Preserve sessions on disable. Withdraw resource streams, keep the account-state
  channel, and reacquire capabilities on enable without mandatory sign-in.
- Reconcile dropped delivery/reconnect, acknowledgements, and versioned Relay
  compatibility; do not let fallback endpoints use broader authority silently.

Review result: a UI/CLI bypass cannot gain capabilities; connected revocation is
prompt, disconnected authority expires, and re-enable restores current access.

### Phase E: minimal UI

Deliver functional forms and tables using shared primitives, tooltips, and Sonner.

- Normal user rows with status/verification/access/date data.
- Scoped people lists showing pending, owner, and inherited sources honestly.
- Multi-target access form with simple per-target checkbox columns and local
  preset selectors. No elaborate layout or mixed-value bulk editor required.
- Local preset create/copy/edit with affected assignment count; immutable defaults.
- Pending resources in existing infrastructure tables, ID-based invitation dialog,
  direct-link redirection, immediate accepted navigation, declined row removal.
- Account-disabled/verification gating and authorized navigation fallback.
- Narrow reactive subscriptions; checkbox drafts must not repaint unrelated lists.
- No notification bell/page, administrative theme, or future billing/support UI.

Review result: validate the required flows in collaborative T3 Preview at the
OrbStack URL, including two simultaneous sessions and an open disabled tab.

### Phase F: migration, measurements, and final review

- Rehearse fresh install and upgrade on representative database fixtures.
- Compare old/new effective decisions and explain every delta.
- Verify repeatable backfills, existing invitation links, mixed ownership cases,
  legacy verification, bans/expiry, and platform-role compatibility.
- Verify rollback using a restore/reverse-mapping plan appropriate to granular
  assignments; do not treat old role columns as a safe rollback after new writes.
- Run targeted deterministic tests, required type/lint/build checks, React Doctor,
  and browser validation. Broaden testing when changes/failures justify it.
- Measure realistic query/latency/memory/renewal/fanout cases; record evidence and
  limits instead of claiming the upper envelope is supported without a load test.
- Once implementation is authorized and complete, follow repository policy:
  commit, push, and open a ready-for-review PR. Do not merge it.

## 3. Critical deterministic checks

These are behavioral/security boundaries worth tests; avoid tests that merely
repeat implementation details or snapshot cosmetic checkbox layout.

| Area | Required case |
| --- | --- |
| Identity | Concurrent invitations create one user; subsequent claim retains ID and all pending invitations. |
| Verification | Unverified accounts cannot use browser/CLI/SFTP resources; no-email configuration alone never verifies. |
| Manual claim | Correct admin issuer/recipient/purpose, single use, expiry, and no credential replacement for another existing account. |
| Acceptance | New/existing verified users remain pending until acceptance; admin acceptance records actor but does not verify/enable recipient. |
| Invitation races | Accept versus decline/cancel/revoke; replay; resend followed by old-link use; deleted target. No resurrection. |
| Multi-target | Scope/authority validated for every target, independent acceptance, documented all-or-nothing creation transaction. |
| Status | Disable preserves sessions/credentials but blocks resource use; enable restores current access without login. Explicit logout/revocation still works. |
| Presets | Only same-scope custom references; copying independent; updates affect local assignments; departed creator loses management. |
| Delegation | Reject unauthorized preset/direct additions, including implied permissions, ALL, and self-preset elevation. Permit authorized reductions. |
| Inheritance | Union of direct and Relay sources, current/future children, no child-to-parent expansion, no direct-removal exclusion. |
| Ownership/platform | One owner; transfer independent of preset labels; instance/Relay ALL never confers platform-admin actions. |
| Credential ceiling | Read-only CLI and paired-client limits cannot be expanded by implication closure or transport fallback. |
| Sensitive operations | Specific file mutation/SFTP/network/backup/data conditions enforce the resolved policy. |
| Visibility | Pending metadata minimal; no unauthorized rows/details; inherited sources don't duplicate/obstruct a resource row. |
| Freshness | Concurrent preset edit/revoke/disable and capability issuance; dropped delivery; reconnect; lease expiry; fanout cache freshness. |
| Catalog | Cycles, invalid selections, supported operations, explicit collection future additions versus individual selections. |
| Migration | Fresh/upgraded/rerun fixtures, equivalent legacy role mapping, evidence provenance, owner conflicts, timed restrictions, valid old links. |

Schedule tests in this PR validate adapted management/manual-action checks only.
Do not accidentally assert a new background execution lifecycle policy.

## 4. Browser acceptance scenarios

Use T3 Preview and controlled local fixture accounts/resources; no messages to
real users or production changes are needed for validation.

1. Admin invites a new email to Survival and a database. One normal user row,
   enabled/unverified; two pending relationships, no operational access.
2. Complete email or admin-issued manual claim. Verify date/method shown. Recipient
   now sees pending target rows with their own accept/decline dialogs.
3. Open a pending resource through a direct URL. It lands on the correct infra
   page with the dialog. Accept navigates immediately with Sonner feedback.
4. Decline the other resource. Remain on the page; row disappears; other access
   and account identity remain intact.
5. Invite an already verified user. It still requires acceptance. Exercise admin
   acceptance separately, including an unverified recipient with no resulting use.
6. Assign two local presets and a Relay preset. Show combined permissions and
   automatic implications. Remove direct access and show why Relay access remains.
7. Edit a local preset in another session. Only affected people's access/UI changes;
   copied presets on other instances remain independent.
8. Bob removes Billy after Billy invited Tom. Tom retains access; instance presets
   persist; Billy cannot continue management through a stale tab.
9. Disable/re-enable the recipient with their tab open. Resources become unavailable,
   account session remains, and eligible current access resumes without sign-in.
10. Inspect a zero-resource verified account, database-specific blocks, read-only
    credentials, expired invitation, and a resource with no console permission.

## 5. Performance evidence to record

| Workload | Evidence |
| --- | --- |
| Single action, cold/warm authorization | Authentication/grant query counts, rows examined, p50/p95 resolution latency. |
| Large resource list | Paginated SQL plan and stable count of authorization queries rather than per-row queries. |
| Instance preset edit | Assigned-subject discovery, transaction time, delivery lag, affected renders. |
| Relay preset edit with many users/children | No materialized child grants; bounded processing; no stale authorization during fanout. |
| Active console/resource streams | No SQL/policy graph walk per frame; memory/queue bounds; renewal request rate. |
| Disable/revoke during normal connectivity and outage | Connected admission cutoff, acknowledgement lag, actual lease-expiry cutoff, reconnect behavior. |
| Checkbox editing and list refresh | Narrow rerenders and targeted query invalidation; use React profiling if regression suspected. |

Record tested scale and environment. One replica and the planning envelope do
not imply that all 125,000-500,000 active relationships were load-tested. Do not
invent timing targets or test results in the PR description.

## 6. Likely code touchpoints

| Area | Existing locations |
| --- | --- |
| Shared catalog/types | packages/contracts/src; apps/web/src/lib/permissions.ts; apps/relay/src/permissions.ts |
| Schema/backfill | apps/web/migrations/auth.sql; apps/web/migrations/app.sql; apps/web/scripts/migrate-app.mjs; migration tests |
| Identity | apps/web/src/lib/auth.ts; auth-bootstrap.ts; auth-session.ts; server/auth.ts; auth UI/routes |
| Access/presets/invites | apps/web/src/lib/access-control.ts; server/access.ts; invitation-auth.ts; access/invitation components |
| Resource enforcement | server/relay.ts, databases.ts, backups.ts, schedules.ts, relays.ts, bricks.ts, updates.ts; domain/Tailscale/activity handlers |
| Navigation/lists | route-access.ts; navigation-destinations.ts; infrastructure collections/pages and scoped users lists |
| Freshness | authorization-revision.ts; authorization-delivery.ts; server/relay-capability-service.ts; realtime sources |
| Relay transports | control-socket.ts; browser-socket.ts; browser-session-registry.ts; browser-security.ts; SFTP handlers |
| CLI | apps/web/src/effect/cli-access.ts; API handlers; apps/cli behavior/types if affected |

## 7. Completion criteria

The implementation is ready to review when all confirmed requirements have an
observable behavior/test or an explicitly documented migration constraint, every
permission option is enforced across applicable entry points, and the browser
scenarios pass. Provide migration and performance evidence with remaining limits.

The current planning deliverable is complete when the three documents are
consistent, local references resolve, all original permission strings are
accounted for, and open decisions are clearly separated from confirmed ones.
No application tests or Preview validation are claimed for documentation-only work.
