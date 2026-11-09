// UI request coordination. Stop owns its own pending request and never waits for
// a confirmation, command or follow-up state read held by the shared action path.
export function createTaskActions(client, { onBusy, onError, onStopBusy }) {
  let actionInFlight = false;
  const stops = new Map();
  const currentTask = (sessionId, taskId) => {
    const session = client.snapshot().session;
    return session?.id === sessionId && session.task?.id === taskId;
  };
  const publishStopBusy = () => {
    const session = client.snapshot().session;
    const key = session ? `${session.id}/${session.task?.id}` : null;
    onStopBusy(key && stops.has(key) ? key : null);
  };
  return {
    async run(operation) {
      if (actionInFlight) return;
      actionInFlight = true;
      onBusy(true);
      onError("");
      const sessionId = client.snapshot().session?.id;
      try {
        await operation();
        if (client.snapshot().session?.id === sessionId) await client.refresh();
      } catch (error) {
        if (client.snapshot().session?.id === sessionId)
          onError(error instanceof Error ? error.message : "操作失败");
      } finally {
        actionInFlight = false;
        onBusy(false);
      }
    },
    stop(sessionId, taskId) {
      const key = `${sessionId}/${taskId}`;
      if (!currentTask(sessionId, taskId)) return Promise.resolve();
      if (stops.has(key)) return stops.get(key);
      const task = client.snapshot().session.task;
      if (["completed", "failed", "stopped"].includes(task.state))
        return Promise.resolve();
      onError("");
      const pending = (async () => {
        try {
          await client.stopTask(taskId);
        } catch (error) {
          if (currentTask(sessionId, taskId))
            onError(error instanceof Error ? error.message : "停止请求失败");
        } finally {
          stops.delete(key);
          publishStopBusy();
        }
      })();
      stops.set(key, pending);
      publishStopBusy();
      return pending;
    },
  };
}
