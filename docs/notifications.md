# Notifications

A notification tells someone about something they can act on. The inbox says
what needs attention now, not everything that happened; each kind's history
lives on its own page, such as Deployments, Activity, or Security.

Rows are kept per person. Each has a `kind`, a `source_key` naming the event so
a retry never delivers it twice, and JSON `data` that outlives a release, so
only add kinds or optional fields. Clearing a row keeps it as `dismissed_at`,
so a later announcement of the same event doesn't deliver it again.

## Merging

The same kind of notification about the same instance is one row.
`replaceNotificationEffect` delivers the new event in place of the open rows it
matches, and folds in what the unread ones said, so the count starts over once
someone has read it.

| Notification     | While it's open                                              |
| ---------------- | ------------------------------------------------------------ |
| App deployed     | One per App, counting deployments and failures               |
| Deploy failed    | The same row, until a later deployment succeeds              |
| Disk limit       | Its usage stays current; it goes away once the data fits     |
| Kiln updated     | One row for Hearth and every Relay, oldest version to newest |
| Update available | The newest replaces older ones; installing it clears it      |
| Vulnerabilities  | One report across everything, see [Security](security.md)    |

Invitations, removed access, and game server moves and copies never merge: each
is its own event, and each can need its own answer.

Someone who won't hear of an event, because they started it or turned its kind
off, keeps what they have. The exception is what it settles: a failed deployment
goes away when their own next one works.

A Relay says what version it runs when it connects, so a version newer than the
one recorded is an update, however it got there. Each sample it sends tries
again if that couldn't be recorded. It joins Hearth's update in one "Kiln has
been updated" row: platform admins hear of Hearth, those who can update a Relay
hear of it, and each person's row lists what they can update.

A disk limit warning that's settled is cleared and gives up its source key,
cleared copies included, so the next time the data outgrows the limit warns
again. The row stays, since the next push closes it on a person's devices.

## Actions

`notificationHref` says where a notification leads, and `notificationCommands`
what it offers beside that. The toast, the popover, the notifications page, and
push all use them, so a notification does the same thing wherever it appears.
Rows add the two commands that need more of the page: the confirmation for
deleting a moved server, and the menu of resources in a report for people the
Security page isn't open to.

Opening a notification reads that notification alone, including one with no
page of its own, which opens the inbox at itself. Pushes lead to
`/notifications/<id>`, which reads it and then redirects, since a device can't
tell Kiln it was tapped.

## The list

The inbox is one list, newest first. Merging is what keeps it short, so a row
moves to the top when something new happens to it, and every row names its
instance. Rows aren't gathered under their resource, which would pull them out
of time order.

A notification that replaces another keeps its toast, so another deployment
changes the toast on screen. On devices, a push closes the replaced one.

## Choosing what you hear

Settings are per person, stored as one JSON setting. Each kind has one menu
listing `notificationChannels`, so a new channel adds a line to that list rather
than a switch to every row. On top of that, two choices narrow what's about a
resource:

- **Whose instances**: everything you can access, what's yours or shared with
  you (leaving out what only a platform role reaches), or only what you own. A
  Relay's owner counts as sharing what runs on it.
- **One resource**: the Notifications card at the bottom of its Info rail.
  Settings lists what you've changed, to reset it.

`notificationAudienceEffect` applies both, in place of `resourceAudienceEffect`,
for everything sent about a resource. Someone it leaves out gets no row, so
turning a kind back on hears of what's still announced, such as an update on
offer. What they already have still settles: a failed deployment goes away when
a later one works, even on an App they've muted. The defaults leave everyone
hearing what they heard before.

Invitations, access changes, and a game server's move or copy are addressed to
one person about something they did or need to answer, so they always arrive.
