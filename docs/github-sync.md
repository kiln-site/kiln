# GitHub sync

People keep config files in a GitHub repository and Kiln copies them into a
game server or app. Accounts are added as **sources** under
**Infrastructure → Sources**, and syncs that read from them live under
**Automations → Sync**. Sources are meant to feed auto deployments too, and
other providers later; the code still calls them GitHub connections.

## Adding a GitHub source

Each connection is a private GitHub App that Kiln creates from a
[manifest](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest),
so nobody pastes keys:

1. **Add source** posts the manifest to GitHub for a personal account or
   an organization. The person confirms the app's name there.
2. GitHub redirects to `/api/github/manifest` with a code. Hearth exchanges it
   for the app's ID, private key, client secret, and webhook secret, stores
   them encrypted (`kiln-github-app-credentials`), and sends the person on to
   install the app.
3. After installing, GitHub redirects to `/api/github/setup` with the
   installation ID. Hearth looks it up with the app's own credentials, so an
   installation ID from someone else's app is refused, and the person lands
   back on Sources.

A signed, expiring state value ties both redirects to the person who started
the flow. Someone can connect several accounts; each is its own app. A
connection belongs to the person who created it. Platform administrators see
and can use every connection.

The app asks for repository contents (read and write) and metadata (read).
Kiln only reads today; write access is there so saving an edit can later
commit it back without asking everyone to approve new permissions.

### Webhooks or polling

GitHub only delivers webhooks to a public HTTPS address. When `KILN_URL` is
one, the app subscribes to `push` and `/api/github/webhook` syncs on every
push, verifying each delivery with that app's secret. Otherwise (localhost,
`.local`, private addresses, Tailscale) the app is created without webhooks
and Hearth checks each automatic sync's branch for a new commit every minute.

## Syncs

A sync copies one folder of one branch into a folder of an instance: a game
server, an app, or a Relay's host files. The destination is relative to the
top of the instance's Files tab. For a game server, that's the folder it runs
from. Databases have no file root, so they can't be synced into. A sync can
be limited to glob patterns; a pattern without a slash matches a file name at
any depth, as in `.gitignore`. Creating or editing a sync needs permission to
edit that instance's files, and the source's owner (or an administrator).

Each run:

1. Reads the branch head and its recursive tree.
2. For every included file, compares its blob SHA with the one Kiln last
   wrote to that path (`synced_files`), and writes only changed files through
   the Relay's `instance.files.put` operation (`files-put-v1`). Files are
   written atomically and parent folders are created.
3. Unless **Replace existing files** is on, a file is only written if it's
   absent or unchanged since Kiln wrote it. The put carries the modification
   time Kiln recorded (or none), and the Relay checks it as it commits the
   upload: a new file is linked into place, which fails if one appeared, and
   a replacement re-checks the time just before its rename. When that check
   fails, the Relay reports the file's Git blob ID. Content Kiln is writing,
   last wrote, or set out to write is still Kiln's file; anything else is
   someone's file or edit, so it's kept and counted in the sync's warning.
   Kiln records each write just before attempting it (`pending` in
   `synced_files`, up to 20 per file until one is confirmed), so a write
   that landed with its reply lost is still recognized on a later run, even
   after the branch moves on or back. A file with unconfirmed writes is
   checked again even when GitHub's copy matches its record.

Files deleted from the repository stay on the instance. Files larger than
512 KB are skipped with a warning, since each write is one Relay control
frame. A sync stops at 2,000 files.

Each finished run is recorded (`github_sync_run`, the latest 50 per sync)
and listed with schedule runs in Automations → History. A poll that finds no
new commit isn't a run, and a failure the sync already shows isn't recorded
again.

Runs are serialized per sync. A trigger arriving while another waits joins
it, upgrading a waiting poll to the stronger trigger, so an edit or **Sync
now** is never swallowed. Polls don't mark a sync as running; a poll that
finds the branch still at the synced commit clears a failure that has
passed, such as an offline Relay.

A sync's target is checked against its kind: game servers and apps are
addressed by their 40-character IDs, and a Relay's host files only by that
Relay's own ID, because the Relay picks a file root by the ID's shape.

A poll that fails the same way again leaves the row alone and records no
run, so a broken sync doesn't notify every browser each minute.

## Not done yet

- **Saving back to GitHub.** When a synced file is saved in the editor, offer
  to commit it to the branch (Contents API, with the blob SHA Kiln last wrote
  as the expected base so a newer commit isn't overwritten).
- **Drift.** A file edited on the instance after it synced is only looked at
  again when GitHub's copy changes. A "Restore from GitHub" action could
  rewrite every file.
- **Restarting.** Restarting a running game server after its files change
  was cut for now.
- **Mirroring.** Optionally delete files that were removed from the
  repository.
- Polling issues one request per automatic sync each minute. Syncs that share
  a repository and branch could share that request.
