---
title: Schedules
description: Restart game servers, back them up, or run console commands on a timetable, with steps that run in order.
---

A schedule runs a list of actions on one or more game servers at set times,
such as a nightly warning, backup, and restart. Schedules live under
**Automations** in the sidebar, on the **Schedules** tab.

Each Relay runs its own game servers' schedules, so they keep running while
Hearth is down.

## Create a schedule

1. Open **Automations**, then **Schedules**, and select **Create schedule**.
2. Give it a **Name**.
3. Choose its **Timing**. See [Timing](#timing).
4. Under **Targets**, pick the game servers it runs on. A schedule can also
   target databases and Relays.
5. Select **Add Action** and choose what it does. Add as many actions as you
   need. See [Actions](#actions).
6. Select **Create schedule**.

A new schedule is **Enabled**. Select **Enabled** at the bottom of the editor
to save it disabled instead.

## Timing

| Timing      | When it runs                                       |
| ----------- | -------------------------------------------------- |
| **Hourly**  | At the start of every hour.                        |
| **Daily**   | Every day at midnight.                             |
| **Weekly**  | Every Sunday at midnight.                          |
| **Monthly** | At midnight on the first of every month.           |
| **Custom**  | Whenever a five-part cron expression says.         |

A **Custom** cron expression has five parts: minute, hour, day of the month,
month, and day of the week. Hearth describes it in words as you type, so you
can check it. For example:

```text title="Every day at 4:30 in the morning"
30 4 * * *
```

```text title="Every 6 hours, on the hour"
0 */6 * * *
```

> [!NOTE]
> Times are in the Relay's own time zone, not your browser's. A schedule that
> targets game servers on Relays in different time zones runs at each Relay's
> local time.

## Actions

Each target runs the actions in order, top to bottom. Drag an action to
reorder it.

| Action      | What it does                                                                                                        |
| ----------- | ------------------------------------------------------------------------------------------------------------------- |
| **Command** | Sends a command to the game server's console, such as `say Restarting in 5 minutes`. Game servers only.             |
| **Backup**  | Backs up the target. Select **Configure Backup** to choose its name, mode, and destination. See [Backups](/backups). |
| **Power**   | **Start**, **Stop**, **Restart**, or **Kill** the target.                                                          |
| **Wait**    | Pauses before the next action, for a number of milliseconds, seconds, minutes, hours, or days.                      |

By default, an action runs on every target in the schedule. To run one only on
some of them, change that action's targets.

If an action fails on a target, that target's remaining actions don't run. Turn
on **Continue on failure** to run them anyway.

### A nightly restart

This schedule warns players, backs up, and restarts every night at 4:00:

1. **Timing**: **Custom**, `0 4 * * *`.
2. **Command**: `say Restarting in 5 minutes for a backup.`
3. **Wait**: 5 minutes.
4. **Command**: `save-all`
5. **Backup**.
6. **Power**: **Restart**.

## Manage schedules

Each schedule's row in the list has:

- **Run now**: run it once, right away.
- **Edit schedule**: change it, then select **Save changes**.
- **Duplicate schedule**: make a copy to start from.
- **View history**: see its past runs and what happened on each target.
- **Disable schedule** or **Enable schedule**: pause it or start it again
  without deleting it.
- **Delete schedule**.

The **History** tab lists every schedule's runs, and the **Calendar** tab shows
when they're due.
