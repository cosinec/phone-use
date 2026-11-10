// Status must keep updating while a device screenshot is slow or stalled.
export function startSessionPolling(client, { onScreen, onError, schedule = setTimeout, unschedule = clearTimeout }) {
  const sessionId = client.snapshot().session?.id;
  let stopped = false;
  const timers = new Set();
  const current = () => !stopped && client.snapshot().session?.id === sessionId;
  const ready = () => {
    const session = client.snapshot().session;
    return current() && session?.ready && session.daemon?.state?.state === "ready";
  };
  const later = (fn, ms) => {
    if (!current()) return;
    const timer = schedule(() => { timers.delete(timer); void fn(); }, ms);
    timers.add(timer);
  };
  const status = async () => {
    try {
      await client.refresh();
      if (current() && !ready()) onScreen(null);
    } catch (error) {
      if (current()) onError(error instanceof Error ? error.message : "无法读取设备状态");
    } finally {
      later(status, 1000);
    }
  };
  const preview = async () => {
    try {
      if (ready()) {
        const image = await client.screen();
        if (ready() && image?.deviceId === client.snapshot().session.deviceId) onScreen(image);
      }
    } catch (error) {
      if (current()) onError(error instanceof Error ? error.message : "无法读取设备画面");
    } finally {
      later(preview, 1800);
    }
  };
  void status();
  void preview();
  return () => {
    stopped = true;
    for (const timer of timers) unschedule(timer);
    timers.clear();
  };
}
