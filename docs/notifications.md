# Notifications

A notification tells someone about something they can act on. The inbox says
what needs attention now, not everything that happened; each kind's history
lives on its own page, such as Deployments, Activity, or Security.

Rows are kept per person. Each has a `kind`, a `source_key` naming the event so
a retry never delivers it twice, and JSON `data` that outlives a release, so
only add kinds or optional fields. Clearing a row keeps it as `dismissed_at`,
so a later announcement of the same event doesn't deliver it again.

## Merging

One thing that keeps happening has one row. `replaceNotificationEffect` delivers
the new event in place of the open rows it matches, and folds in what the
unread ones said, so the count starts over once someone has read it.

| Notification     | While it's open                                           |
| ---------------- | --------------------------------------------------------- |
| App deployed     | One per App, counting deployments and failures            |
| Deploy failed    | The same row, until a later deployment succeeds           |
| Disk limit       | Its usage stays current; it goes away once the data fits  |
| Kiln updated     | One row, from the first unread version to the newest      |
| Update available | The newest replaces older ones; installing it clears it   |
| Vulnerabilities  | One report across everything, see [Security](security.md) |

Someone who won't hear of an event, because they started it or turned its kind
off, keeps what they have. The exception is what it settles: a failed deployment
goes away when their own next one works.

A disk limit warning that's settled is cleared and gives up its source key,
cleared copies included, so the next time the data outgrows the limit warns
again. The row stays, since the next push closes it on a person's devices.
