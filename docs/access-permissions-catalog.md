# Permission catalog review

Companion to [the users/access specification](access-permissions-plan.md).
Status: design worksheet implemented in `packages/contracts/src/access-permissions.ts`.
That typed catalog defines the exact shipped options, implications, and defaults.
The first pass can use a few columns of ordinary checkboxes. Blocks compose from
resource capabilities; this document does not prescribe a navigation hierarchy.

## 1. Confirmed semantics

- Presets contain selected permissions/collections and belong to an instance or
  Relay. Assignments are scoped; a copied preset is an independent definition.
- Multiple sources combine additively. There are no exclusions, denies, or ranks.
- File-write includes file-read; stop includes start; invite includes view-users.
- Collections can nest. Explicit whole-collection/ALL selection includes future
  permissions added by Kiln. Individual selections remain individual.
- Both presets and direct selections use the same rules.
- Actor authority must cover expanded additions, including implied permissions.
- Global status, verification, session restrictions, and platform boundaries still
  apply regardless of how a permission was selected.

## 2. Proposed first-pass blocks

The table is a starting point for R1, deliberately smaller than the previous
exhaustive proposal. A checkbox may map to several internal operation permissions.
That mapping must be explicit so browser, CLI, and SFTP agree. Every applicable
block may also have an explicit All checkbox.

| Block | Candidate checkbox options | Proposed includes/conditions |
| --- | --- | --- |
| Overview | View resource | Basic identity/status/usage only. Other capabilities imply target visibility; no automatic console, secrets, files, or user-list access. |
| Server power | Control power; Force-stop | Control covers start/stop/restart. Force-stop includes ordinary power control. Splitting start/stop individually is optional; if exposed, stop includes start. |
| Console | View console; Send commands | Sending includes viewing. Console completion follows the needed console capability. |
| Files | View/download; Edit; Delete; SFTP | Edit includes view plus create/upload/copy/rename/move. Delete includes view. SFTP includes view and observes the same edit/delete permissions. Decide whether chmod belongs to Edit or an advanced option. |
| Logs | View saved logs; Share logs | Sharing includes viewing; does not follow automatically from ordinary resource visibility. |
| Configuration | View configuration; Manage configuration | Manage includes view/rename/startup changes. Resource-limit changes remain separately constrained; decide whether to expose a separate control. Secret variables must not leak through basic overview reads. |
| Networking | View; Manage; Assign public ports | Manage includes view. Public-port assignment includes management but never bypasses platform allocation/range policy. |
| People and access | View users; Invite; Manage access | Invite includes view users. Manage includes invite and modifying/removing assignments. All grant additions require bounded delegation. |
| Presets | View definitions; Create/copy; Manage definitions | Create/copy includes view and is available with inviting. Assigned-definition edits need management plus delegation checks. Creator history does not confer future management authority. |
| Backups | View; Create/manage; Export/download; Restore; Delete | Each operational option includes view. Create/manage covers creation/cancel/rename/exclusions. Export/copy needs source export and permitted destination. Restore is independent of arbitrary file editing. |
| Schedules | View; Create/edit; Run manually; Delete | Each includes view. Management/manual run also checks action permissions and targets. Existing background execution lifecycle is unchanged. |
| Database power | Control power | Includes basic database visibility; covers start/stop/restart. |
| Database credentials | View; Rotate | Proposed rotate includes view; confirm before implementation. Basic database visibility never reveals credentials. |
| Database networking | View; Manage | Manage includes view. Cross-resource linking also requires authority over the participating other resource. |
| Database data | Export; Import | Both include basic database visibility, independent of each other and native credential visibility. Only show for engines supporting the operation. |
| Resource deletion | Delete resource | Includes basic visibility; protected owner rules and confirmation remain separate. Deleting is not implied by routine configuration. |
| Relay configuration | View; Configure; Update; Pause/resume | Mutation capabilities include Relay visibility. Available only through Relay/platform scope. |
| Relay connections | View clients/pairings; Manage clients/pairings | Manage includes view and must not create a client with authority beyond the actor's delegation scope. |
| Relay activity | View activity | Includes Relay visibility; redact details the actor cannot see. |
| Resource creation | Create servers; Create databases | Relay/platform-scoped, includes only needed Relay/Brick visibility. No authority over unrelated existing children. |

These are checkbox presentations, not a requirement to invent a separate database
role for every option. Candidate operation IDs should preserve existing strings
where their meaning still fits. New/more precise IDs belong in the shared catalog.

R2 proposal: inviting includes viewing and creating/copying definitions, while
editing a live definition that affects existing members needs preset management.
An inviter can customize the proposed invitation using direct selections or a new
local preset; inviting alone need not permit rewriting every existing team preset.
Confirm this distinction because earlier discussion required inviter customization
but did not finalize local management rights.

## 3. Complete current Hearth resource-permission mapping

This lists all 38 current resource permission strings. Destination blocks above
are proposed. Read/write meanings must be checked against actual returned data and
operation payloads, not inferred from names.

| Existing permission(s) | Proposed destination / migration note |
| --- | --- |
| relay.read | Relay overview; do not imply whole-Relay visibility from one child grant. |
| relay.configure | Relay configuration; currently some endpoints also require creator/admin. |
| relay.delete | Remove Relay; preserve separate user confirmation and cleanup semantics. |
| access.invite | Invite in the actual target scope; add the confirmed view-users implication. |
| access.manage | Manage people/access; separate live-preset management decision R2. |
| instance.read | Basic server overview. Audit snapshot fields and user-list access. |
| instance.console.read | View console. |
| instance.console.write | Send commands, including console read. |
| instance.files.read | View/download files, including browse/search/stat. |
| instance.files.write | Edit files; legacy grants also cover mutations now proposed as separate Delete/attributes options. Preserve equivalence explicitly during migration. |
| instance.delete | Delete server. |
| instance.power | Normal power + force-stop for legacy equivalence; first-pass editor may separate force-stop. |
| instance.settings | Configuration; legacy meaning includes rename/startup/resource changes, so split migration must preserve these intentionally. |
| instance.logs.share | Share logs and its proposed read prerequisite. |
| instance.network.read | View server networking. |
| instance.network.write | Manage server routes/domains/ports within allowed policy. |
| instance.network.public-port.write | Public-port assignment; preserve stronger check where an external port is selected. |
| instance.sftp.connect | SFTP with effective file permissions and credential ceiling. |
| database.read | Basic database overview; no credentials. |
| database.create | Relay-scoped database creation. |
| database.credentials.read | View database credentials. |
| database.credentials.rotate | Rotate credentials; proposed read implication requires review. |
| database.power | Database power. |
| database.delete | Delete database. |
| database.network.read | View database networking. |
| database.network.write | Manage database networking. |
| database.dump.export | Export data; supported engines only. |
| database.dump.import | Import data; supported engines only. |
| backup.read | View backup metadata/status. Existing forget behavior mutates under this permission and needs explicit review. |
| backup.create | Create/manage backups; review existing cancel/rename/exclusions/copy mappings. |
| backup.download | Export/download; use for data copy to another destination as well. |
| backup.restore | Restore, with target-state and optional safety-backup conditions. |
| backup.delete | Delete backups. |
| schedule.read | View schedules within permitted targets. |
| schedule.create | Create schedules. |
| schedule.execute | Run manually, with action/target checks. |
| schedule.update | Edit schedules. |
| schedule.delete | Delete schedules. |

## 4. Complete Relay action inventory

The Relay has 52 action strings. Shared names are not proof of identical semantics:
the paired machine client is an upper bound, and user/resource authorization is
additional. The lists below cover every current action.

| Existing actions | Mapping/review |
| --- | --- |
| relay.read, relay.rename, relay.configure, relay.update, relay.audit.read | Relay overview/configuration/update/activity; user-facing scope enforcement must match. |
| relay.pairing.create, relay.pairing.list, relay.pairing.revoke | Relay connection management. Not user resource-invitation acceptance. |
| relay.clients.list, relay.clients.update, relay.clients.revoke | Relay connection management and delegation ceiling. |
| brick.read | Available Brick metadata for supported resource workflows; not platform catalog administration. |
| database.read, database.create, database.delete, database.power | Database overview/creation/deletion/power with resource scope. |
| database.credentials.rotate, database.network.write | Credential/network operations; Hearth handles credential reads separately. |
| database.dump.export, database.dump.import | Data export/import. |
| backup.read, backup.create, backup.download, backup.restore, backup.delete | Backup actions, target/destination/state checks remain distinct. |
| schedule.read, schedule.write | schedule.write currently covers apply/run/remove; align to finer user operations or explicitly enforce at trusted dispatch. |
| instance.read, instance.create, instance.delete, instance.rename | Basic lifecycle. Startup/provisioning currently map broadly to create; inspect request payloads. |
| instance.power.start, instance.power.stop, instance.power.restart, instance.power.kill | Power operations; map from selected capability/collection closure. |
| instance.console.read, instance.console.write | Console authority, including sensitive outbound stream checks. |
| instance.sftp.connect | Transport admission; file-operation checks remain required. |
| instance.files.list, instance.files.read, instance.files.download | View/download. |
| instance.files.create, instance.files.write, instance.files.rename, instance.files.upload, instance.files.upload-url | Edit; handle copy/archive/extract according to actual reads/writes. |
| instance.files.delete | Delete. |
| instance.files.chmod | Decide Edit versus separate attributes option. |
| instance.network.read, instance.network.write | Networking; distinguish public-port policy in Hearth as needed. |
| instance.logs.read, instance.logs.share | Saved log visibility and sharing. |

Not every protocol operation is a human permission. Revision delivery,
proof/renewal, provisioning handshakes, and authorization resolution are internal
operations with their own authenticated protocol validation. Do not expose them
as grantable checkboxes merely because they appear in an RPC list.

## 5. Platform boundaries and role-only operations

All six existing platform strings remain platform-scoped:

| Permission | Operation |
| --- | --- |
| platform.appearance.manage-default | Platform appearance defaults. |
| platform.backups.manage-storage | Platform backup destinations. |
| platform.backups.manage-limits | Backup limits. |
| platform.bricks.add-catalog | Add Brick catalogs. |
| platform.bricks.add-custom | Add custom Bricks. |
| platform.network.override-public-port-range | Override platform public-port policy. |

Other current operations use platform role/creator/ownership checks: initial
setup, platform access assignment, Relay registration, provisioning, Relay/Hearth
updates, platform backups, global network/Tailscale management, ownership transfer,
and account security administration. Inventory these during implementation.
They must not disappear merely because the new catalog replaces accessRoles.

Platform-admin acceptance, verification, disable/enable, and platform role changes
are not granted by an instance/Relay ALL. Resource owners are protected separately;
a full preset does not transfer ownership. New permission collections do not
bypass resource limits, storage-destination checks, or platform policy.

## 6. Implication graph and operation conditions

Confirmed:

- instance.files.write -> instance.files.read.
- instance.power.stop -> instance.power.start (when individually exposed).
- access.invite -> the new scoped view-users permission.

Proposed common rules:

- Resource operations include only basic target visibility.
- Console send -> console read.
- Restart -> stop -> start; force-stop -> normal power controls.
- Network manage -> network view; public ports -> network manage.
- Backup create/export/restore/delete -> backup view.
- Schedule create/edit/run/delete -> schedule view.
- Credential rotate -> credential view (review item).

Separate conditions, not permission implications:

- Restore requires a suitable stopped target where the current implementation
  requires it. It does not grant arbitrary power or file editing.
- Optional safety-backup creation also requires backup creation.
- Schedule creation/edit/manual run requires actions on every relevant target.
  It does not automatically grant those actions.
- Backup copy requires a permitted destination; export authority does not grant
  platform storage administration.
- Resource creation/limit updates remain subject to capacity/allocation policy.
- SFTP/read-only credentials restrict operation authority rather than expanding it.

Validate the catalog graph at build/test time. Unknown input IDs are rejected.
Removed/renamed IDs require explicit compatibility mapping, never reinterpretation
of stale selections. A registry version belongs in compiled-cache identity.

## 7. Persistence and editor semantics

Illustrative selection data (names/version format are implementation proposals):

```json
{
  "selections": [
    { "kind": "collection", "key": "instance.files.all" },
    { "kind": "permission", "key": "backup.read" }
  ]
}
```

Assignments/preset scope are separate from this list. Copying retains selections,
including collection opt-in, but not live links, subject IDs, ownership, or trust.
Any future JSON import validates shape/size, catalog keys, support, and delegation.

An implied checkbox shows why it is selected. Unchecking it identifies/removes
its dependent explicit selections deliberately; it cannot leave contradictory
state. Explicit All is distinct from all current children individually checked.
Unsupported options are not silently granted; bulk editing identifies the targets
that support each option. Simple per-target blocks are adequate initially.

## 8. Defaults to review

Keep immutable Kiln defaults small and descriptive. Candidate definitions could
cover read-only inspection, routine operation, and full scoped administration;
these are permission lists, not special role branches in authorization code.
Final names and membership are R1 decisions. Do not assume the current Viewer is
safe to relabel without review: it presently includes file/backup downloads,
SFTP, and log sharing. Never migrate an old role into dynamic ALL by convenience.
