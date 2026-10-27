---
title: Schedules
description: Restart game servers, back them up, or run console commands on a timetable.
---

A schedule runs a list of actions on game servers at set times, such as a
nightly warning, backup, and restart. Each Relay runs its own schedules, so
they keep running while Hearth is down.

## Create a schedule

1. Open **Automations**, then **Schedules**, and select **Create schedule**.
2. Give it a **Name** and choose its **Timing**.
3. Under **Targets**, pick game servers. Databases and Relays work too.
4. Select **Add Action** for each step.
5. Select **Create schedule**.

## Timing

**Hourly**, **Daily**, **Weekly** (Sunday), and **Monthly** (the 1st) run at
the top of the hour or midnight. **Custom** takes a five-part cron expression,
and Hearth describes it in words as you type:

```text title="Every day at 4:30 in the morning"
30 4 * * *
```

> [!NOTE]
> Times are in each Relay's time zone, not your browser's.

## Actions

Each target runs the actions top to bottom; drag to reorder.

| Action      | What it does                                                         |
| ----------- | -------------------------------------------------------------------- |
| **Command** | Sends a console command. Game servers only.                          |
| **Backup**  | Backs up the target. **Configure Backup** sets its name, mode, and destination. |
| **Power**   | **Start**, **Stop**, **Restart**, or **Kill**.                       |
| **Wait**    | Pauses before the next action.                                       |

An action runs on every target unless you narrow its targets. If it fails on a
target, that target's later actions don't run, unless you turn on **Continue
on failure**.

For a nightly restart at 4:00: **Custom** `0 4 * * *`, then **Command**
`say Restarting in 5 minutes`, **Wait** 5 minutes, **Command** `save-all`,
**Backup**, and **Power** **Restart**.

## Manage schedules

Each row has **Run now**, **Edit schedule**, **Duplicate schedule**, **View
history**, **Disable schedule** or **Enable schedule**, and **Delete
schedule**. The **History** tab lists every run, and **Calendar** shows what's
due.
