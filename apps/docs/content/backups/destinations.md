---
title: Backup destinations
description: Add S3-compatible storage for backups, keep its keys safe, and remove a destination you no longer use.
---

A destination is where a backup is stored. Every Relay can keep backups on its
own disk, as **Local Relay storage**. To keep copies off the machine, add an
S3-compatible bucket, such as Amazon S3, Backblaze B2, MinIO, or Ceph.

## Add an S3 destination

1. Open **Backups → Destinations** and choose **Add S3 destination**.
2. Fill in the bucket's details:

   | Field                 | What to enter                                                                    |
   | --------------------- | -------------------------------------------------------------------------------- |
   | **Name**              | A name you'll recognize in pickers.                                              |
   | **Region**            | The bucket's region, such as `us-east-1`.                                        |
   | **Endpoint**          | The provider's S3 endpoint, such as `https://s3.example.com`.                    |
   | **Bucket**            | The bucket's name.                                                               |
   | **Object prefix**     | Optional. A folder inside the bucket for Kiln's backups, such as `kiln/backups`. |
   | **Access key ID**     | The key's ID.                                                                    |
   | **Secret access key** | The key's secret.                                                                |

3. Set the switches you need:
   - **Enabled** lets new backups choose this destination.
   - **Path-style URLs** addresses objects as `endpoint/bucket/object`. Turn it
     on for MinIO and other providers that don't use the bucket name as a
     subdomain.
4. Choose **Verify and save**.

Hearth checks the key before it saves anything: it writes a small test object
to the bucket, reads it back, and deletes it. If that fails, the destination
isn't saved and the error says why.

## Personal and platform destinations

A destination you add is **Personal**: only you can choose it for your backups.

Kiln Admins see two more switches:

- **Platform destination** makes it available to every user, and to Kiln's own
  backups. Kiln's backups can only go to platform destinations. You choose this
  when you add the destination; it can't change afterwards.
- **Private network** lets the endpoint be a private or loopback address, for a
  MinIO or Ceph deployment on your own network. Without it, Kiln refuses
  endpoints that resolve to private addresses, on every connection.

## Keys and permissions

Hearth encrypts the access key and secret, and never sends a saved secret back
to the browser. To change a key, edit the destination and enter both fields;
leave them blank to keep the current one.

Give Kiln a key that can only reach its own bucket, or its own prefix:

- Full archives upload with short-lived requests Hearth signs, so the Relay
  doesn't see the key.
- Incremental backups need the key itself. Hearth sends it to the Relay with the
  backup, and the Relay keeps it while the backup is queued or running.

> [!WARNING]
> A key that can reach other buckets lets a compromised Relay reach them too.
> Use a key limited to Kiln's bucket for any destination that takes incremental
> backups.

If you rotate a key, backups already queued with the old one fail. Run them
again once the destination has the new key.

## How backups are stored

Kiln names every object itself, under your object prefix:

```text
<prefix>/kiln/<installation>/<relay>/<target-kind>/<target-id>/<backup-id>/<file>
```

Incremental backups keep a repository per game server, under
`<prefix>/kiln/<installation>/<relay>/restic/instance/`.

A full archive uploaded to S3 can be at most 5 GiB. Incremental backups have no
such limit.

### When the bucket refuses writes

When a bucket stops accepting writes, as when it reaches the provider's storage
cap or the key is read-only, new backups and deletes fail until it accepts them
again. Existing backups stay restorable and downloadable.

## Delete a destination

1. Open **Backups → Destinations**.
2. Choose the destination's delete button, then **Delete destination**.

You can only delete a destination when no retained backups use it. Deleting one
purges the incremental backup repositories in it. Full-archive objects already
in the bucket stay there.

If purging fails, the destination stays listed as **Deleting** with the error.
Fix the cause, such as updating its key, then choose **Retry delete**.

> [!NOTE]
> On a bucket with versioning, deleted objects keep their old versions, and the
> provider may still bill for them. Add a lifecycle rule to the bucket to expire
> old versions.
