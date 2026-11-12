// Compatibility patch for the browser ESM entry of @limrun/device-install 0.1.0.
// Keep the upstream package pinned; fail closed if its implementation changes.
// usbmux window/ACK protocol reference (behavior only; no implementation copied):
// https://github.com/libimobiledevice/usbmuxd/blob/master/src/device.c
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const root = new URL(
  "../node_modules/@limrun/device-install/",
  import.meta.url,
);
const metadata = JSON.parse(
  await readFile(new URL("package.json", root), "utf8"),
);
if (metadata.version !== "0.1.0")
  throw new Error(
    "Review the device-install stream patch before upgrading the SDK",
  );
const path = new URL("dist/index-DJrAlfkC.js", root);
let source = await readFile(path, "utf8");
const originalHash =
  "da410b47f3150df18f0dab904d16d22f20f0fd2141d0846c1431d4d921375a20";
const legacyMarker = "// phone-use: device-install stream lifecycle v1";
const v2Marker = "// phone-use: device-install stream lifecycle v2";
const v3Marker = "// phone-use: device-install stream lifecycle v3";
const v4Marker = "// phone-use: device-install stream lifecycle v4";
const v5Marker = "// phone-use: device-install stream lifecycle v5";
const v6Marker = "// phone-use: device-install stream lifecycle v6";
const marker = "// phone-use: device-install stream lifecycle v7";
const streamReplacements = [
  [
    "  async handleFrame(t) {\n    switch (t.type) {",
    "  async handleFrame(t) {\n    if (this.closed) return;\n    switch (t.type) {",
  ],
  [
    "  async handleOpenStream(t, n, r) {\n    try {",
    "  async handleOpenStream(t, n, r) {\n    if (this.closed) return;\n    try {",
  ],
  ["async function Q(e, t) {", "async function Q(e, t, onCreate) {"],
  [
    "  return e.streams.set(g(t, a.sport), a), await w(a, m, new Uint8Array()), await a.opened, a;",
    `  a.opened.catch(() => {});
  e.streams.set(g(t, a.sport), a);
  onCreate?.(a);
  try {
    await w(a, m, new Uint8Array());
    await a.opened;
    if (a.closed) throw a.error;
    return a;
  } catch (error) {
    releaseDeviceStream(a);
    throw error;
  }`,
  ],
  [
    '  if (e.session.closed)\n    throw new Error("usbmux session is closed.");',
    '  if (e.closed || e.session.closed)\n    throw e.error ?? new Error("usbmux stream is closed.");',
  ],
  [
    "      if (r) {",
    `      if (!r) {
        // A cancelled SYN may still receive a late SYN/ACK. Reset it so the
        // phone does not retain a connection the server has already abandoned.
        if (!(n.flags & G)) {
          const reset = { session: e, sport: n.dport, dport: n.sport,
            seq: n.flags & f ? n.ack : 0,
            ack: n.flags & f ? 0 : n.seq + n.payload.byteLength + ((n.flags & (m | 1)) ? 1 : 0) };
          await w(reset, n.flags & f ? G : G | f, new Uint8Array());
        }
        continue;
      }
      if (r) {`,
  ],
  [
    `          for (r.error = new Error(\`Device reset stream \${r.dport}\`), r.rejectOpened(r.error); r.waiters.length > 0; )
            r.waiters.shift()(new Uint8Array());
          e.streams.delete(g(r.dport, r.sport));`,
    `          releaseDeviceStream(r, { notify: false, reason: "Device reset stream" });`,
  ],
  [
    "        n.payload.byteLength !== 0 && (r.ack = n.seq + n.payload.byteLength, await w(r, f, new Uint8Array()), r.waiters.length > 0 ? r.waiters.shift()(n.payload) : r.queue.push(n.payload));",
    `        if (n.payload.byteLength) {
          r.ack = n.seq + n.payload.byteLength;
          if (!(n.flags & 1)) await w(r, f, new Uint8Array());
          r.waiters.length ? r.waiters.shift()(n.payload) : r.queue.push(n.payload);
        }
        if (n.flags & 1) {
          r.ack = n.seq + n.payload.byteLength + 1;
          await w(r, 17, new Uint8Array()); // FIN | ACK; FIN consumes one sequence number.
          r.seq += 1;
          releaseDeviceStream(r, { notify: false, discard: false, reason: "Device finished stream" });
        }`,
  ],
  [
    '      this.closed = !0, this.log("Relay socket closed"), this.frameQueue.finally(() => {',
    '      this.closed = !0, releaseRelayStreams(this), this.log("Relay socket closed"), this.frameQueue.finally(() => {',
  ],
  [
    "    this.closed = !0, this.socket?.close();",
    "    this.closed = !0, releaseRelayStreams(this), this.socket?.close();",
  ],
  [
    `        await this.handleOpenStream(
          t.requestId,
          t.streamId,
          y(t.payload).port
        );`,
    `        void this.handleOpenStream(
          t.requestId,
          t.streamId,
          y(t.payload).port
        ).catch(error => this.log("Relay stream open failed", h(error)));`,
  ],
  [
    "        if (!n) throw new Error(`Unknown stream ${t.streamId}`);",
    "        if (!n || n.closed) break; // Late data after cancellation must not revive a stream.",
  ],
  [
    "      case s.StreamClose:\n        this.streams.delete(t.streamId);",
    `      case s.StreamClose: {
        const stream = this.streams.get(t.streamId);
        this.streams.delete(t.streamId);
        if (stream) releaseDeviceStream(stream);
      }`,
  ],
  [
    "      const a = await Q(this.session, r);\n      this.streams.set(n, a), await this.send({",
    `      const a = await Q(this.session, r, stream => this.streams.set(n, stream));
      if (this.closed || this.streams.get(n) !== a) return;
      await this.send({`,
  ],
  [
    "    } catch (a) {\n      this.log(\n        `Open device stream ${n} failed`,",
    `    } catch (a) {
      if (this.closed || !this.streams.has(n)) return;
      this.streams.delete(n);
      this.log(
        \`Open device stream \${n} failed\`,`,
  ],
  [
    "        if (this.closed) return;\n        await this.send({\n          type: s.StreamData,",
    `        if (this.closed || this.streams.get(t) !== n) return;
        if (!r.byteLength && n.error) throw n.error;
        await this.send({
          type: s.StreamData,`,
  ],
  [
    "      this.log(`Device stream ${t} closed`, r instanceof Error ? r.message : String(r)), await this.send({",
    `      if (this.closed || this.streams.get(t) !== n) return;
      this.streams.delete(t);
      releaseDeviceStream(n);
      this.log(\`Device stream \${t} closed\`, r instanceof Error ? r.message : String(r)), await this.send({`,
  ],
];

const framingReplacements = [
  [
    "async function J(e, t) {",
    "async function J(e, t) {\n  muxReaders.delete(e);",
  ],
  [
    "function I(e) {\n  e.closed = !0;",
    "function I(e) {\n  muxReaders.delete(e.device);\n  e.closed = !0;",
  ],
  [
    "    const r = await H(e, t), a = te(r, n);",
    "    const r = await readMuxFrame(e, t, n), a = te(r, n);",
  ],
  [
    "  const t = new DataView(e.buffer, e.byteOffset, e.byteLength), n = (t.getUint8(12) >> 4) * 4;",
    `  if (e.byteLength < 20) throw new Error("Short usbmux TCP header");
  const t = new DataView(e.buffer, e.byteOffset, e.byteLength), n = (t.getUint8(12) >> 4) * 4;
  if (n < 20 || n > e.byteLength) throw new Error("Invalid usbmux TCP header length");`,
  ],
];
const flowReplacements = [
  [
    `async function K(e, t) {
  if (e.closed || e.session.closed)
    throw e.error ?? new Error("usbmux stream is closed.");
  await w(e, f, t), e.seq += t.byteLength;
}`,
    `function K(e, t) {
  return queueDeviceWrite(e, t);
}`,
  ],
  ["async function w(e, t, n) {", "async function w(e, t, n, seq = e.seq) {"],
  [
    "a.setUint32(4, e.seq), a.setUint32(8, e.ack)",
    "a.setUint32(4, seq), a.setUint32(8, e.ack)",
  ],
  [
    "    flags: t.getUint8(13),",
    "    flags: t.getUint8(13),\n    window: t.getUint16(14),",
  ],
  [
    `  for (const t of e.streams.values())
    for (t.error = new Error("usbmux session closed"), t.rejectOpened(t.error); t.waiters.length > 0; )
      t.waiters.shift()(new Uint8Array());`,
    `  for (const t of [...e.streams.values()])
    releaseDeviceStream(t, { notify: false, reason: "usbmux session closed" });`,
  ],
  [
    "          r.seq += 1, r.ack = n.seq + 1, await w(r, f, new Uint8Array()), r.resolveOpened();",
    `          r.seq += 1;
          updateDeviceWindow(r, n);
          r.ack = n.seq + 1;
          await w(r, f, new Uint8Array());
          r.resolveOpened();`,
  ],
  [
    "        if (n.payload.byteLength) {",
    "        if (n.flags & f) updateDeviceWindow(r, n);\n        if (n.payload.byteLength) {",
  ],
  [
    `        await K(n, t.payload);
        break;`,
    `        // Each stream owns its write queue. A zero-window stream must not
        // block Ping, cancellation or an unrelated device connection.
        void K(n, t.payload).catch(error => {
          if (this.closed || this.streams.get(t.streamId) !== n) return;
          this.streams.delete(t.streamId);
          releaseDeviceStream(n);
          this.log("Device stream write failed", h(error));
          return this.send({ type: s.StreamClose, requestId: 0, streamId: t.streamId,
            payload: l({ reason: h(error) }) });
        }).catch(error => this.log("Relay stream write failed", h(error)));
        break;`,
  ],
];
const v3Replacements = [
  ...streamReplacements,
  ...framingReplacements,
  ...flowReplacements,
];

const legacyHelpers = `
${legacyMarker}
// Close both bookkeeping layers and wake readers BEFORE any asynchronous USB write.
// Local cancellation uses RST|ACK so a peer cannot retain an abandoned connection.
function releaseDeviceStream(stream, { notify = true, discard = true, reason = "Stream closed" } = {}) {
  if (stream.closed) return;
  stream.closed = true;
  stream.error = new Error(reason);
  stream.session.streams.delete(g(stream.dport, stream.sport));
  if (discard) stream.queue.length = 0;
  stream.rejectOpened(stream.error);
  while (stream.waiters.length) stream.waiters.shift()(new Uint8Array());
  if (notify && !stream.session.closed) {
    // Consume write failures: cleanup must finish even if the USB device is gone.
    void w(stream, 20, new Uint8Array()).catch(() => {});
  }
}
function releaseRelayStreams(relay) {
  for (const stream of relay.streams.values()) releaseDeviceStream(stream);
  relay.streams.clear();
  relay.pairRecordWaiter?.reject(new Error("Relay socket closed"));
  relay.pairRecordWaiter = undefined;
}
`;
const v2Helpers =
  legacyHelpers.replace(legacyMarker, v2Marker) +
  `
// USB bulk-read boundaries are not usbmux packet boundaries. Retain partial
// headers/bodies and surplus packets, bounded by the 64 KiB usbmux receive limit.
const muxReaders = new WeakMap();
async function readMuxFrame(device, endpoint, version) {
  let endpoints = muxReaders.get(device);
  if (!endpoints) muxReaders.set(device, endpoints = new Map());
  let reader = endpoints.get(endpoint.endpointNumber);
  if (!reader) endpoints.set(endpoint.endpointNumber, reader = { buffer: new Uint8Array() });
  const headerLength = version >= 2 ? 16 : 8;
  for (;;) {
    const buffer = reader.buffer;
    if (buffer.byteLength >= 8) {
      const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
      const length = view.getUint32(4);
      if (length < headerLength || length > 65536) throw new Error("Invalid usbmux packet length: " + length);
      if (buffer.byteLength >= length) {
        const packet = buffer.slice(0, length);
        reader.buffer = buffer.slice(length);
        return packet;
      }
    }
    const chunk = await H(device, endpoint);
    if (!chunk.byteLength) continue; // A USB zero-length packet carries no mux data.
    const combined = new Uint8Array(reader.buffer.byteLength + chunk.byteLength);
    combined.set(reader.buffer);
    combined.set(chunk, reader.buffer.byteLength);
    reader.buffer = combined;
  }
}
`;
const v3Helpers =
  v2Helpers
    .replace(v2Marker, v3Marker)
    .replace(
      "  stream.error = new Error(reason);",
      "  stream.error = new Error(reason);\n  wakeDeviceWriters(stream);",
    ) +
  `
// usbmux's TCP window is scaled by 256 (unlike ordinary unnegotiated TCP).
// Peer ACK/window credit is local USB flow control, separate from tunneled jktcp.
function seqAtOrBefore(a, b) { return ((b - a) >>> 0) < 0x80000000; }
function wakeDeviceWriters(stream) {
  for (const wake of stream.writeWaiters?.splice(0) ?? []) wake();
}
function updateDeviceWindow(stream, packet) {
  const previous = stream.peerAck ?? 1;
  if (!seqAtOrBefore(previous, packet.ack) || !seqAtOrBefore(packet.ack, stream.seq)) return;
  stream.peerAck = packet.ack;
  stream.peerWindow = packet.window * 256;
  wakeDeviceWriters(stream);
}
function queueDeviceWrite(stream, bytes) {
  if (stream.closed || stream.session.closed) return Promise.reject(stream.error ?? new Error("usbmux stream is closed."));
  // WebSocket has no receive backpressure API. Bound the per-stream queue and
  // fail this connection explicitly rather than retaining unlimited app data.
  const queued = (stream.queuedWriteBytes ?? 0) + bytes.byteLength;
  if (queued > 1024 * 1024) return Promise.reject(new Error("usbmux stream write queue exceeded"));
  stream.queuedWriteBytes = queued;
  const data = bytes.slice();
  const send = async () => {
    let offset = 0;
    while (offset < data.byteLength) {
      if (stream.closed || stream.session.closed) throw stream.error ?? new Error("usbmux stream is closed.");
      const inFlight = (stream.seq - (stream.peerAck ?? 1)) >>> 0;
      const available = Math.max(0, (stream.peerWindow ?? 0) - inFlight);
      if (!available) {
        await new Promise(resolve => (stream.writeWaiters ??= []).push(resolve));
        continue;
      }
      const length = Math.min(data.byteLength - offset, available, 3 * 16384 - 36);
      const part = data.subarray(offset, offset + length);
      const seq = stream.seq;
      // Reserve sequence space BEFORE the asynchronous USB write. A concurrent
      // peer data ACK must carry the sequence after all previously queued data.
      stream.seq = (seq + length) >>> 0;
      await w(stream, f, part, seq);
      offset += length;
    }
  };
  const pending = (stream.deviceWriteChain ?? Promise.resolve()).then(send);
  stream.deviceWriteChain = pending;
  return pending.finally(() => { stream.queuedWriteBytes -= data.byteLength; });
}
`;

const recoveryReplacements = [
  [
    "  e.streams.clear();\n}",
    "  e.streams.clear();\n  const onClose = e.onClose;\n  e.onClose = undefined;\n  onClose?.();\n}",
  ],
  [
    "    this.webSocketUrl = t, this.session = n, this.deviceHello = r, this.log = a;",
    `    this.webSocketUrl = t, this.session = n, this.deviceHello = r, this.log = a;
    n.onClose = () => { this.log("USB transport closed"); this.close(); };`,
  ],
  [
    "  async connect() {\n    const t = new WebSocket(this.webSocketUrl);",
    `  async connect() {
    if (this.session.closed) throw new Error("USB transport is closed.");
    const t = new WebSocket(this.webSocketUrl);`,
  ],
  [
    "    await U(e.device, e.outEndpoint, r);\n  }), e.writeChain;",
    `    await U(e.device, e.outEndpoint, r);
  }).catch(error => {
    if (!e.closed) I(e);
    throw error;
  }), e.writeChain;`,
  ],
  [
    `          r.seq += 1;
          updateDeviceWindow(r, n);
          r.ack = n.seq + 1;
          await w(r, f, new Uint8Array());
          r.resolveOpened();`,
    `          if (!r.established) {
            r.seq = (r.seq + 1) >>> 0;
            r.ack = (n.seq + 1) >>> 0;
            r.established = true;
          }
          updateDeviceWindow(r, n);
          await w(r, f, new Uint8Array());
          r.resolveOpened();`,
  ],
  [
    `        if (n.payload.byteLength) {
          r.ack = n.seq + n.payload.byteLength;
          if (!(n.flags & 1)) await w(r, f, new Uint8Array());
          r.waiters.length ? r.waiters.shift()(n.payload) : r.queue.push(n.payload);
        }
        if (n.flags & 1) {
          r.ack = n.seq + n.payload.byteLength + 1;
          await w(r, 17, new Uint8Array()); // FIN | ACK; FIN consumes one sequence number.
          r.seq += 1;
          releaseDeviceStream(r, { notify: false, discard: false, reason: "Device finished stream" });
        }`,
    `        if (n.payload.byteLength || (n.flags & 1)) await receiveDeviceData(r, n);`,
  ],
];
const v4Replacements = [...v3Replacements, ...recoveryReplacements];
const v4Helpers = v3Helpers.replace(v3Marker, v4Marker) + `
// Only acknowledge contiguous bytes. Retransmitted or overlapping segments must
// not corrupt Lockdown TLS, HTTP or the tunneled TCP byte stream.
async function receiveDeviceData(stream, packet) {
  if (!stream.established) return;
  if (!seqAtOrBefore(packet.seq, stream.ack)) {
    await w(stream, f, new Uint8Array());
    return;
  }
  const consumed = (stream.ack - packet.seq) >>> 0;
  const payload = packet.payload.subarray(Math.min(consumed, packet.payload.byteLength));
  if (payload.byteLength) {
    stream.ack = (stream.ack + payload.byteLength) >>> 0;
    stream.waiters.length ? stream.waiters.shift()(payload) : stream.queue.push(payload);
  }
  const finished = (packet.flags & 1) && ((packet.seq + packet.payload.byteLength) >>> 0) === stream.ack;
  if (finished) {
    stream.ack = (stream.ack + 1) >>> 0;
    await w(stream, 17, new Uint8Array());
    stream.seq = (stream.seq + 1) >>> 0;
    releaseDeviceStream(stream, { notify: false, discard: false, reason: "Device finished stream" });
  } else {
    await w(stream, f, new Uint8Array());
  }
}
`;

// ACKs use the existing serialized USB writer, but never hold the receive loop.
// At most one write and one cumulative update can be pending per stream.
const v5Replacements = [
  ...v4Replacements,
  [
    "  return e.writeChain = e.writeChain.then(async () => {",
    `  if ((e.pendingMuxWrites ?? 0) >= 256) {
    I(e);
    throw new Error("USB output queue exceeded");
  }
  e.pendingMuxWrites = (e.pendingMuxWrites ?? 0) + 1;
  return e.writeChain = e.writeChain.then(async () => {`,
  ],
  [
    `    if (!e.closed) I(e);
    throw error;
  }), e.writeChain;`,
    `    if (!e.closed) I(e);
    throw error;
  }).finally(() => { e.pendingMuxWrites -= 1; }), e.writeChain;`,
  ],
  [
    "          await w(reset, n.flags & f ? G : G | f, new Uint8Array());",
    "          void w(reset, n.flags & f ? G : G | f, new Uint8Array()).catch(() => {});",
  ],
  [
    "          await w(r, f, new Uint8Array());\n          r.resolveOpened();",
    "          queueDeviceAck(r);\n          r.resolveOpened();",
  ],
  [
    "        if (n.payload.byteLength || (n.flags & 1)) await receiveDeviceData(r, n);",
    `        if (n.payload.byteLength || (n.flags & 1)) receiveDeviceData(r, n);
        else if (n.seq === ((r.ack - 1) >>> 0)) queueDeviceAck(r);`,
  ],
];
const v5Helpers = v4Helpers
  .replace(v4Marker, v5Marker)
  .replace("async function receiveDeviceData(stream, packet)", "function receiveDeviceData(stream, packet)")
  .replaceAll("await w(stream, f, new Uint8Array());", "queueDeviceAck(stream);")
  .replace("await w(stream, 17, new Uint8Array());", "void w(stream, 17, new Uint8Array()).catch(() => {});") + `
function queueDeviceAck(stream) {
  if (stream.closed || stream.session.closed) return;
  stream.ackNeeded = true;
  if (stream.ackWriting) return;
  stream.ackWriting = true;
  void (async () => {
    try {
      while (stream.ackNeeded && !stream.closed && !stream.session.closed) {
        stream.ackNeeded = false;
        await w(stream, f, new Uint8Array());
      }
    } catch {
      // P closes the USB session and relay on a failed physical write.
    } finally {
      stream.ackWriting = false;
    }
  })();
}
`;

// Keep the v5 layout above intact so existing installations can be authenticated
// and migrated. Bound the opposite (phone -> browser -> VPS) direction as well.
const v6Replacements = [
  ...v5Replacements,
  [
    '  let n, r;\n  const a = {',
    '  if (e.streams.size >= 64) throw new Error("USB stream limit exceeded");\n  let n, r;\n  const a = {',
  ],
  ['a.setUint16(14, 512)', 'a.setUint16(14, deviceReceiveWindow(e))'],
  [
    '    if (this.closed) return;\n    try {\n      const a = await Q(this.session, r, stream => this.streams.set(n, stream));',
    `    if (this.closed) return;
    if (this.streams.size >= 64) {
      await this.send({ type: s.OpenResult, requestId: t, streamId: n,
        payload: l({ ok: false, error: "USB stream limit exceeded" }) });
      return;
    }
    if (r === 9100 && performance.now() < (this.previewSuspendedUntil ?? 0)) {
      await this.send({ type: s.OpenResult, requestId: t, streamId: n,
        payload: l({ ok: false, error: "Preview paused for uplink congestion" }) });
      return;
    }
    try {
      const a = await Q(this.session, r, stream => this.streams.set(n, stream));`,
  ],
  [
    `        await this.send({
          type: s.StreamData,
          requestId: 0,
          streamId: t,
          payload: r
        });`,
    `        try {
          await this.send({ type: s.StreamData, requestId: 0, streamId: t, payload: r });
        } finally {
          consumeDeviceRead(n, r.byteLength);
        }`,
  ],
  [
    '        await this.send({\n          type: s.Pong,',
    '        void this.send({\n          type: s.Pong,',
  ],
  [
    '          payload: new Uint8Array()\n        });\n        break;',
    '          payload: new Uint8Array()\n        }).catch(error => this.log("Relay heartbeat send failed", h(error)));\n        break;',
  ],
  [
    `  async send(t) {
    if (!this.closed) {
      if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
        this.closed = !0;
        return;
      }
      this.socket.send(_(t));
    }
  }`,
    `  async send(t) { await sendBoundedRelayFrame(this, t); }`,
  ],
];
const v6Helpers = v5Helpers.replace(v5Marker, v6Marker)
  .replace('  if (discard) stream.queue.length = 0;', `  if (discard) {
    stream.queue.length = 0;
    stream.readRetainedBytes = 0;
    stream.readDiscarded = true;
  }`)
  .replace('  if (payload.byteLength) {\n    stream.ack =', `  if (payload.byteLength) {
    const retained = (stream.readRetainedBytes ?? 0) + payload.byteLength;
    if (retained > DEVICE_READ_LIMIT) {
      // A one-byte zero-window probe is legal. Keep the cumulative ACK fixed
      // so the peer retries this byte after the consumer releases credit.
      if ((stream.readRetainedBytes ?? 0) === DEVICE_READ_LIMIT && payload.byteLength === 1) {
        queueDeviceAck(stream);
        return;
      }
      releaseDeviceStream(stream, { reason: "USB receive window exceeded" });
      return;
    }
    stream.readRetainedBytes = retained;
    stream.ack =`) + `
// Credit includes the chunk held by the relay pump until WebSocket accepts it.
// Shrinking only this stream's advertised window leaves USB demux/ACKs running.
const DEVICE_READ_LIMIT = 128 * 1024;
function deviceReceiveWindow(stream) {
  return Math.floor(Math.max(0, DEVICE_READ_LIMIT - (stream.readRetainedBytes ?? 0)) / 256);
}
function consumeDeviceRead(stream, length) {
  const before = deviceReceiveWindow(stream);
  stream.readRetainedBytes = Math.max(0, (stream.readRetainedBytes ?? 0) - length);
  // Update promptly on zero-window recovery; batch small credit changes to avoid
  // doubling USB ACK traffic for every tiny control response.
  const after = deviceReceiveWindow(stream);
  if ((!before && after) || after - before >= 64) queueDeviceAck(stream);
}
async function sendBoundedRelayFrame(relay, frame) {
  const data = frame.type === s.StreamData;
  const stream = data ? relay.streams.get(frame.streamId) : null;
  if (data && !stream) return;
  const preview = stream?.dport === 9100;
  // Reserve room for control responses, then a further reserve for protocol
  // messages. All checks and socket.send are synchronous once credit is free.
  const limit = preview ? 128 * 1024 : data ? 384 * 1024 : 512 * 1024;
  const bytes = _(frame);
  const started = performance.now();
  let waiting = false;
  try {
    for (;;) {
      if (relay.closed || !relay.socket || relay.socket.readyState !== WebSocket.OPEN) return;
      if (data && (relay.streams.get(frame.streamId) !== stream || stream.readDiscarded)) return;
      if ((relay.socket.bufferedAmount ?? 0) + bytes.byteLength <= limit) {
        relay.socket.send(bytes);
        return;
      }
      if (!waiting) {
        waiting = true;
        relay.uplinkWaiters = (relay.uplinkWaiters ?? 0) + 1;
        relay.uplinkWaitCount = (relay.uplinkWaitCount ?? 0) + 1;
      }
      const elapsed = performance.now() - started;
      if (preview && elapsed >= 2000) {
        relay.previewPauses = (relay.previewPauses ?? 0) + 1;
        relay.previewSuspendedUntil = performance.now() + 30000;
        relay.log("Preview paused for uplink congestion", relay.socket.bufferedAmount ?? 0);
        throw new Error("Preview paused for uplink congestion");
      }
      if (elapsed >= 20000) {
        relay.log("Relay uplink stalled", relay.socket.bufferedAmount ?? 0);
        relay.close();
        throw new Error("Relay uplink stalled");
      }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  } finally {
    if (waiting) {
      relay.uplinkWaiters--;
      relay.uplinkWaitMaxMs = Math.max(relay.uplinkWaitMaxMs ?? 0, Math.round(performance.now() - started));
    }
  }
}
`;

// Port 9100 also serves one-frame task observations. Only an explicitly enabled
// continuous viewer may impose its cooldown on subsequent stream opens.
const replacements = v6Replacements.map(([before, after]) => [before,
  after.replace('r === 9100 && performance.now()',
    'r === 9100 && this.continuousPreviewEnabled === true && performance.now()')]);
const helpers = v6Helpers.replace(v6Marker, marker)
  .replace('const preview = stream?.dport === 9100;',
    'const preview = stream?.dport === 9100; // Reserve control capacity for ALL media, including single frames.')
  .replace('if (preview && elapsed >= 2000)',
    'if (preview && relay.continuousPreviewEnabled === true && elapsed >= 2000)')
  .replace('      if (elapsed >= 20000) {', `      if (preview && relay.continuousPreviewEnabled !== true && elapsed >= 8000) {
        throw new Error("Screenshot uplink congested");
      }
      if (elapsed >= 20000) {`);

function digest(text) {
  return createHash("sha256").update(text).digest("hex");
}
// Reverse our exact edits to authenticate both fresh and previously patched files.
const applied = source.includes(marker)
  ? { helpers, replacements }
  : source.includes(v6Marker)
    ? { helpers: v6Helpers, replacements: v6Replacements }
  : source.includes(v5Marker)
    ? { helpers: v5Helpers, replacements: v5Replacements }
  : source.includes(v4Marker)
    ? { helpers: v4Helpers, replacements: v4Replacements }
  : source.includes(v3Marker)
    ? { helpers: v3Helpers, replacements: v3Replacements }
  : source.includes(v2Marker)
    ? {
        helpers: v2Helpers,
        replacements: [...streamReplacements, ...framingReplacements],
      }
    : source.includes(legacyMarker)
      ? { helpers: legacyHelpers, replacements: streamReplacements }
      : null;
if (applied) {
  if (!source.endsWith(applied.helpers))
    throw new Error("Unexpected device-install patch contents");
  source = source.slice(0, -applied.helpers.length);
  for (const [before, after] of [...applied.replacements].reverse()) {
    if (source.split(after).length !== 2)
      throw new Error("Unexpected device-install patched code");
    source = source.replace(after, before);
  }
}
if (digest(source) !== originalHash)
  throw new Error("Unexpected device-install 0.1.0 ESM checksum");
for (const [before, after] of replacements) {
  if (source.split(before).length !== 2)
    throw new Error(`device-install patch target must occur once: ${before}`);
  source = source.replace(before, after);
}
source += helpers;
await writeFile(path, source);
console.log("Verified device-install 0.1.0 browser stream lifecycle patch");
