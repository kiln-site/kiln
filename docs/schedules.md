# Schedules

A schedule runs an ordered list of steps on a cron timetable, on any number
of game servers, databases, and Apps, and on Kiln itself for its own
backups. People make and edit them under **Automations → Schedules**;
**Calendar** shows when they'll run and **History** what they did. Hearth
keeps each schedule and sends every Relay the part that runs there; the
Relay runs it on its own clock, so schedules keep running while Hearth is
away.

## What a schedule holds

A name, a cron expression, its targets, up to 32 steps, whether it's
enabled, and **Continue on failure**. Cron takes five fields, or `hourly`,
`daily`, `weekly`, or `monthly`, which Hearth saves as their five-field
forms. A schedule has up to 2,000 targets, and each step can be limited to
some of them.

Steps, each run on every target it supports:

- **Command**: on a game server, typed into its console; on a database, run
  with `sh -c` in its container; on an App, the same in the service the step
  names for it. Hearth asks the App's Relay for its services when the
  schedule is saved.
- **Power**: start, stop, restart, or kill a game server, database, or App.
- **Backup**: a full backup of any target, to the Relay or an S3
  destination, or an incremental one of a game server. An App's backs up its
  folder and every volume only it uses, live or stopped; Kiln's is a
  platform bundle. See [Backups](backups.md#scheduled-backups) for how
  scheduled backups are admitted, named, and cataloged.
- **Wait**: pauses the whole sequence, from milliseconds to days.

A step on a target it doesn't support, such as a command on Kiln or an
incremental backup of a database, is recorded as `skipped_unsupported`; one
limited to other targets as `skipped_policy`. Neither fails the target. A
command or kill reaches a database or App only when the step names it among
its targets, which the editor does when one is selected.

## Who may do what

Schedule permissions are checked on every target a schedule has, through a
grant on its Relay or on the target itself; see
[Access control](access-control.md) for how grants work. Only platform
administrators may schedule Kiln's backups.

- Seeing a schedule takes `schedule.read` on all of its targets.
- Creating one takes `schedule.create`, and each step's own permission on
  each target it reaches: `instance.console.write` for a game server's
  command, `relay.terminal` for a database's, and `app.terminal` for an
  App's; `instance.power.<action>`, `database.power`, or `app.manage` for
  power; `backup.create` for a backup, or `app.files.read` for an App's.
- Editing takes `schedule.update` and every step permission of both the
  stored schedule and the new one, so removing a step nobody let you run
  doesn't let you edit around it. An edit made after someone else's is
  refused; refresh and try again.
- Deleting takes `schedule.delete` on every target and no step permission,
  so someone allowed to stop a schedule can do so without being able to run
  what it does.
- **Run now** takes `schedule.execute` and every step permission.

A schedule belongs to whoever created it, and its backups run as theirs
whoever last edited it. A personal S3 destination must be the owner's, and
whoever saves the schedule must own it too or hold
`platform.backups.manage-storage`; it also takes
`backup.download` on each target backed up there. A stopped App backup
stops and starts the App and every App using its volumes, so saving one
takes `app.manage` on each; the Relay must be online to say which Apps
those are, unless the schedule already had that step.

## Where it runs

Saving, deleting and running a schedule are operations on its
`schedule:<id>` lane ([Hearth operations](hearth-operations.md)): saves
wait for each other and for a **Run now** being sent, and a deletion turns
away either while it runs.

Saving a schedule raises its revision and sends each Relay with a target
the schedule's steps and that Relay's targets, with each backup step already
admitted per target. Relays it no longer reaches, and every Relay when it's
deleted, are sent its removal. A Relay keeps the newest revision it has
been sent and ignores an older one that arrives late; a removal leaves a
tombstone so a late send can't bring it back. Hearth shows each Relay's
part as pending, applied, or failed with its error, and the next run the
Relay reports.

Whenever Hearth lists schedules for someone, at most once a minute, it asks
each Relay what it holds and what it has run, and sends again any part the
Relay is missing or holds an older version of; the backup sweep does the
same every ten minutes. Until a change arrives, the Relay runs what it last
had, so a change made while a Relay is unreachable, a deletion included,
takes effect when it's back. A backup step to S3, or an incremental one,
carries its destination's keys or repository password, which the Relay
keeps with the schedule so its backups run without Hearth.

The Relay reads cron in its own time zone: its process's `TZ`, which a
container that doesn't set it leaves at UTC. The time zone saved with a
schedule doesn't change when it runs; Hearth shows the schedule's times in
it, UTC for schedules created in the editor.

A fresh installation starts with a daily **Kiln backups** schedule; see
[Kiln's own backups](backups.md#kilns-own-backups).

## How an occurrence runs

A Relay checks every second for schedules that are due and runs up to 32
occurrences at once; more wait for a free one. Each step runs on all of the
Relay's targets, eight at a time, before the next step starts, so a slow
backup on one game server holds back the next step on the others. Relays
don't wait for each other: each runs its own targets.

Every step is an ordinary Relay operation in the
[operation lanes](relay-operations.md#schedules): Command and Power steps
take the locks the same request from Hearth would, so they wait behind
conflicting work and later work waits for them, and a Backup step joins the
Relay's backup queue as a manual backup does and waits up to six hours for
it to finish. Before any step runs, the Relay notes each target's
power intent. A later power step gives way, recorded as `not_run`, if
someone has changed the target's power or replaced it since, so a schedule's
Start can't undo a Stop someone made during its Wait. A step is also
`not_run` while the Relay is paused, when the target is being deleted, or
when Hearth refused the backup as it would a manual one.

A target is reserved for the whole occurrence, Waits included. When it's
still running another occurrence, of this schedule or any other, it's
recorded as `skipped_overlap` for this one and the other targets run.

A failed step stops that target's later steps, which are recorded as
`not_run`. With **Continue on failure** on, they run anyway, and the target
keeps its first failure as its error. A target that no longer exists has
every step recorded as `skipped_missing` and fails. A Wait runs once for the
occurrence, unless no target can continue.

## Commands in containers

A database's or App's command runs as a one-off Docker exec in the current
container, in the resource's lifecycle lane, so it waits for power changes
and deployments and they wait for it. It has 10 minutes to exit, and the step
keeps its exit code and the last 4 KiB of its output; a non-zero code fails
the step. A missing or stopped container, a service a deployment has since
renamed or removed, or a container without `sh` fails the step without
running the command.

A command is never run twice. Its step is recorded as unknown before it's
sent, and the command isn't sent unless that record is written. A command
that outlives its timeout, loses Docker's stream, or is cut short by a Relay
restart stays `unknown` and is not retried; the target fails, or is
`interrupted` after a restart. Commands run only in schedules; running one
by hand is what the terminal is for.

## Results

Each target finishes as `succeeded`, `noop` (nothing ran), `failed`,
`interrupted`, or `skipped_overlap`. The occurrence is `succeeded`, `noop`,
`partial` when some targets failed, or `failed` when all did. A step
recorded as `not_run` or skipped doesn't fail its target.

Occurrences that fell due while a Relay was down are not caught up: on
start it records one `missed` run per schedule and runs the next one on
time. Occurrences running when the Relay stopped are marked `interrupted`
and never run again, keeping what they had recorded of their commands.

Hearth collects runs when it lists schedules, as above, and right after
**Run now**. While a Relay is unreachable, Hearth keeps the last next run and
history it had, and records nothing as failed.

## Run now

**Run now** asks every Relay with a target to run the schedule at once, even
when it's disabled, and reports how many started. A Relay refuses when it
doesn't hold the schedule's current revision or is already running 32
occurrences. A manual run is reserved, ordered, and recorded as a scheduled
one is.

## Storage

- Hearth: `schedule` (with `created_by`, its owner), `schedule_action`,
  `schedule_target`, `schedule_deployment` (per Relay: the revision and
  generation sent and acknowledged, status, error, next run), and
  `schedule_run`, the runs collected from Relays.
- Relay SQLite: `relay_schedules`, what Hearth last sent;
  `relay_schedule_tombstones`; and `relay_schedule_runs`, the 1,000 most
  recently finished runs.
