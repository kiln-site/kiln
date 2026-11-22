// A Relay's answer to `backup.task.list` holding all of `tasks` on one page,
// as a Relay with that journal gives it: every task changed, and those still
// queued or running, or asked after by ID, as current.
export function relayBackupTaskPage<TTask extends object>(
  tasks: ReadonlyArray<TTask>,
  payload?: unknown
) {
  const asked = new Set(
    (payload as { taskIds?: ReadonlyArray<string> } | undefined)?.taskIds ?? []
  )
  return {
    changed: tasks,
    current: tasks.filter((task) => {
      const { status, taskId } = task as { status?: unknown; taskId?: unknown }
      return (
        status === "queued" ||
        status === "running" ||
        (typeof taskId === "string" && asked.has(taskId))
      )
    }),
    next: null,
  }
}
