import { WebCodecsVideoDecoder } from "@yume-chan/scrcpy-decoder-webcodecs";
import { WritableStream } from "@yume-chan/stream-extra";

// Only decoded device frames enter this mailbox. Callers wait for a new frame,
// never treat a placeholder or a frame retained after an error as an observation.
export class FrameMailbox {
  sequence = 0;
  epoch = 0;
  epochFrames = 0;
  latest = null;
  error = null;
  waiters = new Set();
  configure() { this.epoch++; this.epochFrames = 0; }
  publish(canvas) {
    if (this.error) return;
    this.latest = { canvas, width: canvas.width, height: canvas.height, sequence: ++this.sequence, epoch: this.epoch, epochFrames: ++this.epochFrames };
    for (const wake of this.waiters) wake();
  }
  fail(error) {
    if (this.error) return;
    this.error = error instanceof Error ? error : new Error("Android video stream unavailable");
    this.latest = null;
    for (const wake of this.waiters) wake();
  }
  wait({ after = this.sequence, epoch = this.epoch, minFrames = 1, signal, timeoutMs = 1200 } = {}) {
    return new Promise((resolve, reject) => {
      let timer;
      const cleanup = () => { clearTimeout(timer); this.waiters.delete(check); signal?.removeEventListener("abort", check); };
      const check = () => {
        if (signal?.aborted || this.error) { cleanup(); reject(signal?.reason || this.error); return; }
        if (this.latest && this.latest.sequence > after && this.latest.epoch >= epoch && this.latest.epochFrames >= minFrames) { cleanup(); resolve(this.latest); }
      };
      timer = setTimeout(() => { cleanup(); reject(new Error("No fresh Android video frame; using screenshot fallback")); }, timeoutMs);
      this.waiters.add(check); signal?.addEventListener("abort", check, { once: true }); check();
    });
  }
}
export const sameViewport = (a, b) => !!a && !!b && a.width === b.width && a.height === b.height && a.orientation === b.orientation;

export class AndroidVideoCapture {
  static get isSupported() {
    return WebCodecsVideoDecoder.isSupported && typeof OffscreenCanvas !== "undefined" && typeof createImageBitmap === "function";
  }
  constructor({ video, controller, readViewport, signal }) {
    this.mailbox = new FrameMailbox();
    this.controller = controller; this.readViewport = readViewport;
    this.viewport = null; this.bytes = 0; this.previousBytes = 0; this.closed = false;
    this.abort = new AbortController();
    this.onAbort = () => this.close(); this.signal = signal;
    signal.addEventListener("abort", this.onAbort, { once: true });
    this.canvas = new OffscreenCanvas(1, 1);
    const context = this.canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("Android video canvas unavailable");
    this.decoder = new WebCodecsVideoDecoder({ codec: video.metadata.codec,
      hardwareAcceleration: "prefer-hardware",
      renderer: {
        setSize: (width, height) => {
          if (!width || !height || width > 4096 || height > 4096) throw new Error("Invalid Android video size");
          if (this.canvas.width !== width) this.canvas.width = width;
          if (this.canvas.height !== height) this.canvas.height = height;
        },
        draw: (frame) => { context.drawImage(frame, 0, 0); this.mailbox.publish(this.canvas); },
      },
    });
    const writer = this.decoder.writable.getWriter();
    this.pump = video.stream.pipeTo(new WritableStream({ write: async packet => {
      this.bytes += packet.data.byteLength;
      if (packet.type === "configuration") this.mailbox.configure();
      await writer.write(packet);
    } }), { signal: this.abort.signal, preventCancel: true }).then(
      () => this.mailbox.fail(new Error("Android video stream ended")),
      error => {
        this.mailbox.fail(error);
        // A failed decoder must not stall multiplexed ADB, including input.
        // Keep consuming the encoded socket while requests use the PNG fallback.
        if (!this.closed) void video.stream.pipeTo(new WritableStream({ write() {} }), { signal: this.abort.signal }).catch(() => {});
      },
    ).finally(() => { writer.releaseLock(); });
  }
  async ready(signal) { await this.mailbox.wait({ after: 0, epoch: 1, signal, timeoutMs: 2500 }); }
  async snapshot(signal) {
    signal.throwIfAborted();
    const before = await this.readViewport(signal);
    if (!before) throw new Error("Android video display geometry unavailable");
    const sequence = this.mailbox.sequence;
    let epoch = this.mailbox.epoch;
    const changed = !sameViewport(before, this.viewport);
    if (changed) {
      // Bind the first capture and every orientation/size change to a new
      // encoder configuration. This also distinguishes 180 degree rotations.
      epoch++;
      await this.controller.resetVideo();
    }
    const frame = await this.mailbox.wait({ after: sequence, epoch, minFrames: changed ? 2 : 1, signal, timeoutMs: 1800 });
    if (Math.abs(frame.width / frame.height - before.width / before.height) > 0.03)
      throw new Error("Android video orientation is still changing");
    const bitmap = await createImageBitmap(frame.canvas);
    try {
      const after = await this.readViewport(signal);
      signal.throwIfAborted();
      if (!sameViewport(before, after) || bitmap.width !== frame.width || bitmap.height !== frame.height)
        throw new Error("Android rotated during capture; refresh before acting");
      this.viewport = after;
      const sourceBytes = this.bytes - this.previousBytes;
      this.previousBytes = this.bytes;
      return { bitmap, viewport: after, sourceBytes, sourceFormat: "h264-stream" };
    } catch (error) { bitmap.close(); throw error; }
  }
  close() {
    if (this.closed) return;
    this.closed = true; this.abort.abort();
    this.signal.removeEventListener("abort", this.onAbort);
    this.mailbox.fail(new Error("Android video closed"));
    this.decoder?.dispose();
  }
}
