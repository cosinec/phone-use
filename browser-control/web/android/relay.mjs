// Same bounded binary framing as the iOS relay; browser-safe (no Node Buffer).
const MAX = 1024 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
export function encodeFrame(type, requestId = 0, value = null) {
  if (!Number.isInteger(type) || type < 0 || type > 255 || !Number.isInteger(requestId) || requestId < 0 || requestId > 0xffffffff)
    throw new Error("Invalid relay header");
  const payload = encoder.encode(JSON.stringify(value));
  if (payload.length > MAX) throw new Error("Android relay payload too large");
  const bytes = new Uint8Array(16 + payload.length);
  const view = new DataView(bytes.buffer);
  bytes[0] = 1; bytes[1] = type;
  view.setUint32(4, requestId); view.setUint32(12, payload.length);
  bytes.set(payload, 16);
  return bytes;
}
export function decodeFrame(data) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.byteLength < 16) throw new Error("Short relay frame");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const length = view.getUint32(12);
  if (bytes[0] !== 1 || bytes[2] || bytes[3] || view.getUint32(8) || length > MAX || bytes.length !== 16 + length)
    throw new Error("Invalid Android relay frame");
  return { type: bytes[1], requestId: view.getUint32(4), value: JSON.parse(decoder.decode(bytes.subarray(16))) };
}
// Serial command execution, cancellation before dispatch, and bounded replay protection.
export class AndroidRelay {
  constructor(socket, deviceId, execute, { log = () => {}, onClose = () => {} } = {}) {
    this.socket = socket; this.deviceId = deviceId; this.execute = execute;
    this.pending = new Map(); this.lastId = 0; this.closed = false;
    this.chain = Promise.resolve();
    this.ready = new Promise((resolve, reject) => { this.resolve = resolve; this.reject = reject; });
    this.timer = setTimeout(() => this.fail(new Error("Android relay handshake timed out")), 10000);
    socket.binaryType = "arraybuffer";
    socket.addEventListener("message", (event) => {
      try { this.receive(decodeFrame(event.data)); } catch (e) { this.fail(e); }
    });
    socket.addEventListener("error", () => this.fail(new Error("Android relay unavailable")));
    socket.addEventListener("close", () => { this.close(); log("Relay socket closed"); onClose(); });
  }
  fail(error) { this.reject(error); this.close(); }
  receive({ type, requestId, value }) {
    if (this.closed) return;
    if (type === 17 && !requestId && value?.ready === true && value.deviceId === this.deviceId) {
      clearTimeout(this.timer); this.resolve(); return;
    }
    if (type === 7) throw new Error("Android relay rejected the connection");
    if (type === 16) { this.pending.get(requestId)?.abort(); return; }
    if (type !== 14 || requestId <= this.lastId || value?.deviceId !== this.deviceId || !value.request || this.pending.size >= 64)
      throw new Error("Invalid Android command");
    this.lastId = requestId;
    const abort = new AbortController();
    this.pending.set(requestId, abort);
    this.chain = this.chain.then(async () => {
      let result, timedOut = false;
      try {
        abort.signal.throwIfAborted();
        let timer;
        const cancelled = new Promise((_, reject) => {
          const stop = () => { clearTimeout(timer); reject(new Error("Android operation cancelled; sent actions are not retried")); };
          abort.signal.addEventListener("abort", stop, { once: true });
          timer = setTimeout(() => { timedOut = true; abort.abort(); }, 40000);
          this.removeAbort = () => { clearTimeout(timer); abort.signal.removeEventListener("abort", stop); };
        });
        try { result = await Promise.race([this.execute(value.request, abort.signal), cancelled]); }
        finally { this.removeAbort?.(); this.removeAbort = null; }
        abort.signal.throwIfAborted();
      } catch (error) {
        result = { kind: "error", message: String(error?.message || "Android operation failed").slice(0, 1600) };
      } finally { this.pending.delete(requestId); }
      if (this.closed || (abort.signal.aborted && !timedOut)) return;
      try {
        this.socket.send(encodeFrame(15, requestId, { deviceId: this.deviceId, result }));
      } catch (error) { this.fail(error); }
    });
  }
  close() {
    if (this.closed) return;
    this.closed = true; clearTimeout(this.timer);
    this.reject(new Error("Android relay closed"));
    for (const abort of this.pending.values()) abort.abort();
    this.pending.clear(); this.socket.close();
  }
}
