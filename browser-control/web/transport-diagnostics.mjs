// Metadata only. Sampling and uploads run independently of phone traffic.
export function attachTransportDiagnostics(target, relay, report) {
  const device = target.device ?? {};
  const socket = relay.socket ?? {};
  const started = performance.now();
  const stats = {
    wsSentBytes: 0, wsSentFrames: 0, wsMaxBufferedBytes: 0,
    usbReadBytes: 0, usbWriteBytes: 0, usbReadCalls: 0, usbWriteCalls: 0,
    usbReadErrors: 0, usbWriteErrors: 0, usbReadMaxMs: 0, usbWriteMaxMs: 0,
    usbReadPending: 0, usbWritePending: 0, skippedSamples: 0, uploadErrors: 0,
    usbReadHooked: 0, usbWriteHooked: 0, wsHooked: 0,
  };
  const pendingSince = {usbRead: 0, usbWrite: 0};
  const restore = [];
  let sequence = 0;
  let stopped = false;
  let upload = null;

  function install(object, key, wrapper) {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    try {
      if (!Reflect.set(object, key, wrapper)) return false;
    } catch {
      return false;
    }
    restore.push(() => {
      if (object[key] !== wrapper) return;
      if (descriptor) Object.defineProperty(object, key, descriptor);
      else delete object[key];
    });
    return true;
  }

  function instrumentUSB(method, direction) {
    const original = device[method];
    if (typeof original !== 'function') return;
    const wrapper = function(...args) {
      const at = performance.now();
      stats[direction + 'Calls']++;
      if (stats[direction + 'Pending']++ === 0) pendingSince[direction] = at;
      let result;
      try {
        result = original.apply(this, args);
      } catch (error) {
        stats[direction + 'Pending']--;
        stats[direction + 'Errors']++;
        throw error;
      }
      return Promise.resolve(result).then(value => {
        const bytes = direction === 'usbRead' ? value.data?.byteLength : value.bytesWritten;
        stats[direction + 'Bytes'] += bytes ?? 0;
        if (value.status !== 'ok') stats[direction + 'Errors']++;
        return value;
      }, error => {
        stats[direction + 'Errors']++;
        throw error;
      }).finally(() => {
        stats[direction + 'MaxMs'] = Math.max(stats[direction + 'MaxMs'], Math.round(performance.now() - at));
        stats[direction + 'Pending']--;
      });
    };
    if (install(device, method, wrapper)) stats[direction + 'Hooked'] = 1;
  }

  instrumentUSB('transferIn', 'usbRead');
  instrumentUSB('transferOut', 'usbWrite');
  const originalSend = socket.send;
  if (typeof originalSend === 'function') {
    const wrapper = function(bytes) {
      const result = originalSend.call(this, bytes);
      stats.wsSentFrames++;
      stats.wsSentBytes += bytes.byteLength ?? 0;
      stats.wsMaxBufferedBytes = Math.max(stats.wsMaxBufferedBytes, socket.bufferedAmount ?? 0);
      return result;
    };
    if (install(socket, 'send', wrapper)) stats.wsHooked = 1;
  }

  function publish(event = 'sample') {
    if (stopped) return;
    if (upload) {
      stats.skippedSamples++;
      return;
    }
    const now = performance.now();
    const metrics = {
      schema: 1, event, sequence: ++sequence,
      browserTimeMs: Date.now(), elapsedMs: Math.round(now - started),
      ...stats,
      wsBufferedBytes: socket.bufferedAmount ?? 0,
      usbReadPendingMs: stats.usbReadPending ? Math.round(now - pendingSince.usbRead) : 0,
      usbWritePendingMs: stats.usbWritePending ? Math.round(now - pendingSince.usbWrite) : 0,
      pendingMuxWrites: target.session?.pendingMuxWrites ?? 0,
      streams: [...(relay.streams?.entries() ?? [])].slice(0, 64).map(([streamId, stream]) => ({
        streamId, port: stream.dport,
        readQueuedBytes: (stream.queue ?? []).reduce((sum, bytes) => sum + bytes.byteLength, 0),
        writeQueuedBytes: stream.queuedWriteBytes ?? 0,
        peerWindowBytes: stream.peerWindow ?? 0,
      })),
    };
    const abort = new AbortController();
    upload = abort;
    const deadline = setTimeout(() => abort.abort(), 3000);
    let request;
    try {
      request = report(metrics, abort.signal);
    } catch {
      stats.uploadErrors++;
    }
    return Promise.resolve(request).catch(() => { stats.uploadErrors++; }).finally(() => {
      clearTimeout(deadline);
      if (upload === abort) upload = null;
    });
  }

  const interval = setInterval(publish, 1000);
  return () => {
    if (stopped) return;
    if (upload) upload.abort();
    else publish('stop');
    stopped = true;
    clearInterval(interval);
    for (const undo of restore.reverse()) undo();
  };
}
