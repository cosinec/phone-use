import test from "node:test";
import assert from "node:assert/strict";
import * as sdk from "@limrun/device-install";
import { fakeUSB } from "./fixtures/fake-usb.mjs";

// Synthetic usbmux peer, not a phone/WDA: exercises the published SDK's actual
// handshake, packet reader, relay and stream pumps without physical USB access.
async function fixture(t) {
  const usb = fakeUSB();
  const incoming = [],
    readers = [],
    sent = [],
    frames = [];
  const deliver = (bytes) => {
    const result = {
      status: "ok",
      data: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    };
    readers.length ? readers.shift().resolve(result) : incoming.push(result);
  };
  let receiveSeq = 0;
  const packetBytes = (
    stream,
    flags,
    payload = new Uint8Array(),
    seq = 1,
    window = 512,
    ack = stream.seq ?? 1,
  ) => {
    const bytes = new Uint8Array(36 + payload.length),
      view = new DataView(bytes.buffer);
    view.setUint32(0, 6);
    view.setUint32(4, bytes.length);
    view.setUint32(8, 0xfeedface);
    view.setUint16(14, receiveSeq++);
    view.setUint16(16, stream.dport);
    view.setUint16(18, stream.sport);
    view.setUint32(20, seq);
    view.setUint32(24, ack);
    view.setUint8(28, 0x50);
    view.setUint8(29, flags);
    view.setUint16(30, window);
    bytes.set(payload, 36);
    return bytes;
  };
  const packet = (...args) => deliver(packetBytes(...args));
  let autoOpen = true;
  usb.device.claimInterface = async () => {};
  usb.device.transferIn = async () =>
    incoming.length
      ? incoming.shift()
      : new Promise((resolve, reject) => readers.push({ resolve, reject }));
  usb.device.transferOut = async (_, data) => {
    const bytes = new Uint8Array(data);
    if (bytes.length) {
      const view = new DataView(
        bytes.buffer,
        bytes.byteOffset,
        bytes.byteLength,
      );
      if (view.getUint32(0) === 0) {
        const version = new Uint8Array(20),
          response = new DataView(version.buffer);
        response.setUint32(4, 20);
        response.setUint32(8, 2);
        deliver(version);
      } else if (view.getUint32(0) === 6) {
        const stream = { sport: view.getUint16(16), dport: view.getUint16(18) };
        sent.push({
          ...stream,
          flags: view.getUint8(29),
          seq: view.getUint32(20),
          ack: view.getUint32(24),
          window: view.getUint16(30) * 256,
          payload: bytes.slice(36),
        });
        if (view.getUint8(29) & 2 && autoOpen) packet(stream, 18, new Uint8Array(), 0);
      }
    }
    return { status: "ok", bytesWritten: bytes.length };
  };
  usb.device.close = async () => {
    for (const r of readers.splice(0))
      r.reject(new Error("fixture USB closed"));
  };
  const previousNavigator = Object.getOwnPropertyDescriptor(
    globalThis,
    "navigator",
  );
  const previousWS = globalThis.WebSocket;
  class Socket {
    static OPEN = 1;
    readyState = 1;
    constructor() {
      queueMicrotask(() => this.onopen?.());
    }
    send(bytes) {
      if (this.trackBuffer) this.bufferedAmount = (this.bufferedAmount ?? 0) + bytes.byteLength;
      const view = new DataView(
        bytes.buffer,
        bytes.byteOffset,
        bytes.byteLength,
      );
      frames.push({
        type: view.getUint8(1),
        streamId: view.getUint32(8),
        payload: bytes.slice(16),
      });
      if (view.getUint8(1) === 10) {
        const payload = new TextEncoder().encode(
          JSON.stringify({ udid: "fixture", pairRecordBase64: "fixture" }),
        );
        const response = new Uint8Array(16 + payload.length),
          head = new DataView(response.buffer);
        head.setUint8(0, 1);
        head.setUint8(1, 12);
        head.setUint32(12, payload.length);
        response.set(payload, 16);
        queueMicrotask(() => this.onmessage({ data: response.buffer }));
      }
    }
    close() {
      this.readyState = 3;
      this.onclose?.();
    }
  }
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { usb: { requestDevice: async () => usb.device } },
  });
  globalThis.WebSocket = Socket;
  const target = await sdk.requestUSBAccess();
  const { relay } = await sdk.pairDevice({
    registryApiUrl: "http://fixture.invalid",
    token: "fixture",
    target,
  });
  t.after(async () => {
    relay.close();
    await sdk.closeDeviceRelayTarget(target);
    if (previousNavigator)
      Object.defineProperty(globalThis, "navigator", previousNavigator);
    else delete globalThis.navigator;
    globalThis.WebSocket = previousWS;
  });
  const wait = async (condition) => {
    for (let i = 0; i < 100; i++) {
      if (condition()) return;
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    assert.fail("Synthetic SDK peer did not reach expected state");
  };
  const send = (type, id, payload = new Uint8Array()) => {
    const bytes = new Uint8Array(16 + payload.length),
      view = new DataView(bytes.buffer);
    view.setUint8(0, 1);
    view.setUint8(1, type);
    view.setUint32(4, id);
    view.setUint32(8, id);
    view.setUint32(12, payload.length);
    bytes.set(payload, 16);
    relay.enqueueFrame(bytes);
    return relay.frameQueue;
  };
  const open = async (id, port = 8100) => {
    await send(2, id, new TextEncoder().encode(JSON.stringify({port})));
    await wait(() => frames.some((f) => f.type === 3 && f.streamId === id));
    return [...target.session.streams.values()].find(
      (s) => s === relay.streams.get(id),
    );
  };
  return {
    target,
    relay,
    frames,
    sent,
    packet,
    packetBytes,
    deliver,
    wait,
    send,
    open,
    pauseOpen: () => {
      autoOpen = false;
    },
    failRead: () => {
      for (const reader of readers.splice(0))
        reader.reject(new Error("USB read failed"));
    },
  };
}

test("a USB read failure closes the relay and releases all native streams", async (t) => {
  const f = await fixture(t),
    stream = await f.open(1);
  f.failRead();
  await f.wait(() => f.relay.closed);
  assert.equal(f.relay.socket.readyState, 3);
  assert.equal(f.relay.streams.size, 0);
  assert.equal(f.target.session.streams.size, 0);
  assert.equal(stream.waiters.length, 0);
});

test("a USB write failure closes the relay instead of keeping a poisoned write queue", async (t) => {
  const f = await fixture(t),
    stream = await f.open(1);
  f.target.device.transferOut = async () => {
    throw new Error("USB write failed");
  };
  await f.send(4, 1, new Uint8Array([42]));
  await f.wait(() => f.relay.closed);
  assert.equal(f.relay.socket.readyState, 3);
  assert.equal(f.target.session.streams.size, 0);
  assert.equal(stream.queuedWriteBytes, 0);
});

test("a repeated SYN ACK preserves the established stream sequence", async (t) => {
  const f = await fixture(t),
    stream = await f.open(1);
  f.packet(stream, 18, new Uint8Array(), 0, 512, 1);
  await f.wait(() => f.sent.filter((packet) => packet.flags === 16).length === 2);
  assert.equal(stream.seq, 1);
  await f.send(4, 1, new Uint8Array([42]));
  await f.wait(() => f.sent.some((packet) => packet.payload.length));
  assert.equal(f.sent.find((packet) => packet.payload.length).seq, 1);
});

test("duplicate and overlapping device data is delivered exactly once and ACK never moves backwards", async (t) => {
  const f = await fixture(t),
    stream = await f.open(1);
  f.packet(stream, 16, new Uint8Array([1, 2, 3]), 1);
  await f.wait(() => stream.ack === 4);
  f.packet(stream, 16, new Uint8Array([1, 2, 3]), 1);
  f.packet(stream, 16, new Uint8Array([3, 4, 5]), 3);
  await f.wait(() => stream.ack === 6);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    f.frames.filter((frame) => frame.type === 4).flatMap((frame) => [...frame.payload]),
    [1, 2, 3, 4, 5],
  );
  assert.deepEqual(
    f.sent.filter((packet) => packet.flags === 16).map((packet) => packet.ack),
    [1, 4, 4, 6],
  );
});

test("a device sequence gap requests missing data before accepting a later FIN", async (t) => {
  const f = await fixture(t),
    stream = await f.open(1);
  f.packet(stream, 17, new Uint8Array([3, 4]), 3);
  await f.wait(() => f.sent.filter((packet) => packet.flags === 16).length === 2);
  assert.equal(stream.ack, 1);
  assert.equal(
    f.frames.filter((frame) => frame.type === 4 || frame.type === 5).length,
    0,
  );
  f.packet(stream, 16, new Uint8Array([1, 2]), 1);
  await f.wait(() => stream.ack === 3);
  f.packet(stream, 17, new Uint8Array([3, 4]), 3);
  await f.wait(() => f.frames.some((frame) => frame.type === 5));
  assert.deepEqual(
    f.frames.filter((frame) => frame.type === 4).flatMap((frame) => [...frame.payload]),
    [1, 2, 3, 4],
  );
  assert.ok(f.sent.some((packet) => packet.flags === 17 && packet.ack === 6));
});

test("device receive sequence wraps while preserving cumulative ACK and rejecting old data", async (t) => {
  const f = await fixture(t),
    stream = await f.open(1);
  stream.ack = 0xfffffffe;
  f.packet(stream, 16, new Uint8Array([1, 2, 3, 4]), 0xfffffffe);
  await f.wait(() => stream.ack === 2);
  f.packet(stream, 16, new Uint8Array([1, 2]), 0xfffffffe);
  f.packet(stream, 16, new Uint8Array([4, 5]), 1);
  await f.wait(() => stream.ack === 3);
  assert.deepEqual(
    f.frames.filter((frame) => frame.type === 4).flatMap((frame) => [...frame.payload]),
    [1, 2, 3, 4, 5],
  );
  assert.deepEqual(
    f.sent.filter((packet) => packet.flags === 16).map((packet) => packet.ack),
    [1, 2, 2, 3],
  );
});

test("fragmented usbmux headers and large bodies arrive intact without closing other streams", async (t) => {
  const f = await fixture(t),
    stream = await f.open(1),
    other = await f.open(2);
  const expected = Uint8Array.from({ length: 24000 }, (_, i) => i % 251);
  const bytes = f.packetBytes(stream, 16, expected);
  for (const chunk of [
    bytes.slice(0, 3),
    bytes.slice(3, 11),
    bytes.slice(11, 16384),
    bytes.slice(16384),
  ]) {
    f.deliver(chunk);
  }
  await f.wait(() =>
    f.frames.some((frame) => frame.type === 4 && frame.streamId === 1),
  );
  const received = f.frames
    .filter((frame) => frame.type === 4 && frame.streamId === 1)
    .flatMap((frame) => [...frame.payload]);
  assert.deepEqual(received, [...expected]);
  assert.equal(f.target.session.closed, false);
  f.packet(other, 16, new Uint8Array([42]));
  await f.wait(() =>
    f.frames.some((frame) => frame.type === 4 && frame.streamId === 2),
  );
});

test("coalesced usbmux packets retain each stream's complete payload", async (t) => {
  const f = await fixture(t),
    first = await f.open(1),
    second = await f.open(2);
  const a = f.packetBytes(first, 16, new Uint8Array([1, 2, 3]));
  const b = f.packetBytes(second, 16, new Uint8Array([4, 5]));
  const combined = new Uint8Array(a.length + b.length);
  combined.set(a);
  combined.set(b, a.length);
  f.deliver(combined);
  await f.wait(() =>
    f.frames.some((frame) => frame.type === 4 && frame.streamId === 2),
  );
  assert.deepEqual(
    [
      ...f.frames.find((frame) => frame.type === 4 && frame.streamId === 1)
        .payload,
    ],
    [1, 2, 3],
  );
  assert.deepEqual(
    [
      ...f.frames.find((frame) => frame.type === 4 && frame.streamId === 2)
        .payload,
    ],
    [4, 5],
  );
});

test("the default 16 KiB USB read can split a large mux body without forwarding partial data", async (t) => {
  const f = await fixture(t),
    stream = await f.open(1);
  const expected = Uint8Array.from({ length: 32000 }, (_, i) => i % 251);
  const bytes = f.packetBytes(stream, 16, expected);
  f.deliver(bytes.slice(0, 16384));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    f.frames.filter((frame) => frame.type === 4).length,
    0,
    "an incomplete mux packet must not be acknowledged or delivered",
  );
  f.deliver(bytes.slice(16384));
  await f.wait(() => f.frames.some((frame) => frame.type === 4));
  assert.equal(
    Buffer.compare(
      Buffer.from(f.frames.find((frame) => frame.type === 4).payload),
      Buffer.from(expected),
    ),
    0,
  );
  assert.equal(f.target.session.closed, false);
});

test("invalid mux lengths and short TCP headers close waiting streams instead of hanging or growing buffers", async (t) => {
  for (const invalid of [7, 15, 65537, "tcp"]) {
    await t.test(String(invalid), async (t) => {
      const f = await fixture(t),
        stream = await f.open(1);
      let bytes = f.packetBytes(stream, 16);
      if (invalid === "tcp") {
        bytes = bytes.slice(0, 24);
        new DataView(bytes.buffer).setUint32(4, bytes.length);
      } else {
        bytes = bytes.slice(0, 16);
        new DataView(bytes.buffer).setUint32(4, invalid);
      }
      f.deliver(bytes);
      await f.wait(() => f.target.session.closed);
      assert.equal(f.target.session.streams.size, 0);
      assert.equal(stream.waiters.length, 0);
    });
  }
});

test("100 server stream closes release both SDK maps, readers and phone connections", async (t) => {
  const f = await fixture(t);
  for (let id = 1; id <= 100; id++) {
    const stream = await f.open(id);
    assert.equal(stream.waiters.length, 1);
    await f.send(5, id);
    await f.wait(() =>
      f.sent.some((p) => p.sport === stream.sport && p.flags === 20),
    );
    assert.equal(f.relay.streams.size, 0);
    assert.equal(f.target.session.streams.size, 0);
    assert.equal(stream.waiters.length, 0);
    await f.send(4, id, new Uint8Array([1])); // Late data and duplicate close are harmless.
    await f.send(5, id);
  }
  assert.equal(
    f.frames.filter((f) => f.type === 4).length,
    0,
    "cancelled read pumps must not emit data",
  );
});

test("device FIN delivers final data, acknowledges FIN and closes both stream maps", async (t) => {
  const f = await fixture(t),
    stream = await f.open(1);
  f.packet(stream, 17, new Uint8Array([7, 8, 9]), 1);
  await f.wait(() => f.frames.some((f) => f.type === 5));
  assert.equal(f.target.session.streams.size, 0);
  assert.equal(f.relay.streams.size, 0);
  assert.deepEqual([...f.frames.find((f) => f.type === 4).payload], [7, 8, 9]);
  assert.ok(
    f.sent.some((p) => p.flags === 17 && p.ack === 5),
    "FIN and its data consume sequence numbers",
  );
  assert.equal(
    f.sent.filter((p) => p.flags & 4).length,
    0,
    "normal remote FIN needs no reset",
  );
});

test("device RST releases a blocked reader and notifies the server without an empty data frame", async (t) => {
  const f = await fixture(t),
    stream = await f.open(1);
  f.packet(stream, 4);
  await f.wait(() => f.frames.some((f) => f.type === 5));
  assert.equal(f.target.session.streams.size, 0);
  assert.equal(f.relay.streams.size, 0);
  assert.equal(f.frames.filter((f) => f.type === 4).length, 0);
});

test("a device FIN without data closes a blocked stream without producing empty data", async (t) => {
  const f = await fixture(t),
    stream = await f.open(1);
  f.packet(stream, 17);
  await f.wait(() => f.frames.some((f) => f.type === 5));
  assert.equal(f.target.session.streams.size, 0);
  assert.equal(f.relay.streams.size, 0);
  assert.equal(f.frames.filter((f) => f.type === 4).length, 0);
  assert.ok(f.sent.some((p) => p.flags === 17 && p.ack === 2));
});

for (const close of ["explicit", "websocket"])
  test(`${close} relay close cancels pending opens and all blocked readers`, async (t) => {
    const f = await fixture(t),
      stream = await f.open(1);
    f.pauseOpen();
    const pending = f.send(2, 2, new TextEncoder().encode('{"port":8100}'));
    await f.wait(() => f.target.session.streams.size === 2);
    if (close === "explicit") f.relay.close();
    else f.relay.socket.close();
    await pending;
    await f.wait(() => f.target.session.streams.size === 0);
    assert.equal(f.relay.streams.size, 0);
    assert.equal(stream.waiters.length, 0);
    assert.equal(
      f.frames.filter((f) => f.type === 3 && f.streamId === 2).length,
      0,
    );
  });

test(
  "a server close interrupts a pending SYN without blocking later relay frames",
  { timeout: 3000 },
  async (t) => {
    const f = await fixture(t);
    f.pauseOpen();
    const pending = f.send(2, 1, new TextEncoder().encode('{"port":8100}'));
    await f.wait(() => f.target.session.streams.size === 1);
    const stream = [...f.target.session.streams.values()][0];
    await f.send(5, 1);
    await pending;
    await f.wait(() => f.target.session.streams.size === 0);
    await f.send(8, 0);
    assert.ok(
      f.frames.some((f) => f.type === 9),
      "heartbeat still works after open cancellation",
    );
    assert.equal(f.relay.streams.size, 0);
    assert.equal(
      f.frames.filter((f) => f.type === 3).length,
      0,
      "cancelled opens must not publish a late result",
    );
    f.packet(stream, 18); // The device accepted SYN just before receiving cancellation.
    await f.wait(() =>
      f.sent.some((p) => p.flags === 4 && p.sport === stream.sport),
    );
    assert.equal(
      f.target.session.streams.size,
      0,
      "late SYN/ACK must not resurrect a cancelled stream",
    );
  },
);

test("closing one stream preserves other streams and allows new connections", async (t) => {
  const f = await fixture(t),
    first = await f.open(1),
    second = await f.open(2);
  await f.send(5, 1);
  assert.equal(f.target.session.streams.size, 1);
  assert.equal(first.waiters.length, 0);
  f.packet(second, 16, new Uint8Array([42]));
  await f.wait(() => f.frames.some((f) => f.type === 4 && f.streamId === 2));
  await f.open(3);
  assert.equal(f.target.session.streams.size, 2);
  assert.equal(f.relay.streams.size, 2);
});

test("a reset during connection setup returns failure and releases the pending stream", async (t) => {
  const f = await fixture(t);
  f.pauseOpen();
  await f.send(2, 1, new TextEncoder().encode('{"port":8100}'));
  await f.wait(() => f.target.session.streams.size === 1);
  f.packet([...f.target.session.streams.values()][0], 4);
  await f.wait(() => f.frames.some((f) => f.type === 3));
  assert.equal(
    JSON.parse(
      new TextDecoder().decode(f.frames.find((f) => f.type === 3).payload),
    ).ok,
    false,
  );
  assert.equal(f.target.session.streams.size, 0);
  assert.equal(f.relay.streams.size, 0);
});

test("an OpenStream already queued when relay closes cannot create a new SYN", async (t) => {
  const f = await fixture(t);
  const pending = f.send(2, 1, new TextEncoder().encode('{"port":8100}'));
  f.relay.close();
  await pending;
  assert.equal(f.sent.filter((p) => p.flags & 2).length, 0);
  assert.equal(f.target.session.streams.size, 0);
  assert.equal(f.relay.streams.size, 0);
});

test("peer zero window pauses only its stream and ACK credit bounds each subsequent write", async (t) => {
  const f = await fixture(t),
    stream = await f.open(1);
  f.packet(stream, 16, new Uint8Array(), stream.ack, 0, 1);
  await new Promise((resolve) => setImmediate(resolve));
  const expected = Uint8Array.from({ length: 1000 }, (_, i) => i % 251);
  await f.send(4, 1, expected);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    f.sent.filter((p) => p.payload.length).length,
    0,
    "zero peer credit must prevent data transmission",
  );
  await f.send(8, 0);
  assert.ok(
    f.frames.some((frame) => frame.type === 9),
    "a blocked writer cannot hold the global relay queue",
  );
  const other = await f.open(2);
  await f.send(4, 2, new Uint8Array([42]));
  await f.wait(() =>
    f.sent.some((p) => p.sport === other.sport && p.payload.length),
  );
  f.packet(stream, 16, new Uint8Array(), stream.ack, 1, 1); // 1 << 8 == 256 bytes.
  await f.wait(() =>
    f.sent.some((p) => p.sport === stream.sport && p.payload.length),
  );
  let parts = f.sent.filter(
    (p) => p.sport === stream.sport && p.payload.length,
  );
  assert.equal(parts.length, 1);
  assert.equal(parts[0].payload.length, 256);
  f.packet(stream, 16, new Uint8Array(), stream.ack, 1, 129); // Partial ACK frees 128 bytes.
  await f.wait(
    () =>
      f.sent.filter((p) => p.sport === stream.sport && p.payload.length)
        .length === 2,
  );
  parts = f.sent.filter((p) => p.sport === stream.sport && p.payload.length);
  assert.equal(parts[1].payload.length, 128);
  assert.equal(parts[1].seq, 257);
  f.packet(stream, 16, new Uint8Array(), stream.ack, 512, 385);
  await f.wait(() => stream.queuedWriteBytes === 0);
  parts = f.sent.filter((p) => p.sport === stream.sport && p.payload.length);
  assert.deepEqual(
    parts.flatMap((p) => [...p.payload]),
    [...expected],
  );
  assert.deepEqual(
    parts.map((p) => p.seq),
    [1, 257, 385],
  );
});

test("ACK emitted during a pending USB transfer uses the reserved next sequence", async (t) => {
  const f = await fixture(t),
    stream = await f.open(1);
  const device = f.target.device,
    original = device.transferOut.bind(device);
  let release, entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  device.transferOut = async (endpoint, data) => {
    const result = await original(endpoint, data);
    const bytes = new Uint8Array(data);
    if (
      bytes.length > 36 &&
      new DataView(bytes.buffer, bytes.byteOffset).getUint32(0) === 6
    ) {
      entered();
      await gate;
    }
    return result;
  };
  t.after(() => release());
  const initialAckCount = f.sent.filter(
    (p) => !p.payload.length && p.flags === 16,
  ).length;
  const pending = f.send(4, 1, new Uint8Array(100));
  await started;
  f.packet(stream, 16, new Uint8Array([7, 8, 9]), stream.ack, 512, 101);
  await new Promise((resolve) => setImmediate(resolve));
  release();
  await pending;
  await f.wait(
    () =>
      f.sent.filter((p) => !p.payload.length && p.flags === 16).length >
      initialAckCount,
  );
  const ack = f.sent.filter((p) => !p.payload.length && p.flags === 16).at(-1);
  assert.equal(
    ack.seq,
    101,
    "an ACK queued behind the 100-byte data segment must not reuse its old sequence",
  );
  assert.equal(stream.seq, 101);
});

test("closing a zero-window stream wakes queued writers and does not block other streams", async (t) => {
  const f = await fixture(t),
    stream = await f.open(1);
  f.packet(stream, 16, new Uint8Array(), stream.ack, 0, 1);
  await f.wait(() => stream.peerWindow === 0);
  await f.send(4, 1, new Uint8Array(100));
  await f.send(4, 1, new Uint8Array(100));
  await f.wait(() => stream.writeWaiters?.length === 1);
  await f.send(5, 1);
  await f.wait(() => stream.queuedWriteBytes === 0);
  assert.equal(stream.writeWaiters.length, 0);
  assert.equal(f.target.session.streams.size, 0);
  const other = await f.open(2);
  await f.send(4, 2, new Uint8Array([42]));
  await f.wait(() =>
    f.sent.some((p) => p.sport === other.sport && p.payload.length),
  );
});

test("USB session read failure wakes writers waiting on the device window", async (t) => {
  const f = await fixture(t),
    stream = await f.open(1);
  f.packet(stream, 16, new Uint8Array(), stream.ack, 0, 1);
  await f.wait(() => stream.peerWindow === 0);
  await f.send(4, 1, new Uint8Array(100));
  await f.wait(() => stream.writeWaiters?.length === 1);
  await f.target.device.close();
  await f.wait(() => stream.queuedWriteBytes === 0);
  assert.equal(stream.writeWaiters.length, 0);
  assert.equal(f.target.session.streams.size, 0);
});

test("window-blocked writes have a bounded per-stream queue", async (t) => {
  const f = await fixture(t),
    stream = await f.open(1);
  f.packet(stream, 16, new Uint8Array(), stream.ack, 0, 1);
  await f.wait(() => stream.peerWindow === 0);
  await f.send(4, 1, new Uint8Array(600000));
  await f.send(4, 1, new Uint8Array(600000));
  await f.wait(() =>
    f.frames.some((frame) => frame.type === 5 && frame.streamId === 1),
  );
  await f.wait(() => stream.queuedWriteBytes === 0);
  assert.equal(f.target.session.streams.size, 0);
  const reason = JSON.parse(
    new TextDecoder().decode(
      f.frames.find((frame) => frame.type === 5).payload,
    ),
  ).reason;
  assert.match(reason, /write queue exceeded/);
});

test("device write sequence and cumulative ACK wrap without accepting stale or future ACKs", async (t) => {
  const f = await fixture(t),
    stream = await f.open(1);
  stream.seq = 0xfffffffe;
  stream.peerAck = stream.seq;
  stream.peerWindow = 256;
  await f.send(4, 1, new Uint8Array([1, 2, 3, 4]));
  await f.wait(() => stream.queuedWriteBytes === 0);
  assert.equal(stream.seq, 2);
  assert.equal(f.sent.find((p) => p.payload.length).seq, 0xfffffffe);
  f.packet(stream, 16, new Uint8Array(), stream.ack, 1, 2);
  await f.wait(() => stream.peerAck === 2);
  f.packet(stream, 16, new Uint8Array(), stream.ack, 65535, 0xfffffffd);
  f.packet(stream, 16, new Uint8Array(), stream.ack, 65535, 1000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stream.peerAck, 2);
  assert.equal(stream.peerWindow, 256);
  await f.send(4, 1, new Uint8Array([5]));
  await f.wait(() => stream.queuedWriteBytes === 0);
  assert.equal(f.sent.filter((p) => p.payload.length).at(-1).seq, 2);
});

test("per-stream queued writes preserve FIFO and respect the USB maximum payload", async (t) => {
  const f = await fixture(t),
    stream = await f.open(1);
  f.packet(stream, 16, new Uint8Array(), stream.ack, 0, 1);
  await f.wait(() => stream.peerWindow === 0);
  const a = new Uint8Array(400).fill(1),
    b = new Uint8Array(400).fill(2);
  await f.send(4, 1, a);
  await f.send(4, 1, b);
  f.packet(stream, 16, new Uint8Array(), stream.ack, 1, 1);
  await f.wait(() => stream.seq === 257);
  f.packet(stream, 16, new Uint8Array(), stream.ack, 512, 257);
  await f.wait(() => stream.queuedWriteBytes === 0);
  assert.deepEqual(
    f.sent.filter((p) => p.payload.length).flatMap((p) => [...p.payload]),
    [...a, ...b],
  );
  const large = new Uint8Array(100000).fill(3);
  await f.send(4, 1, large);
  await f.wait(() => stream.queuedWriteBytes === 0);
  const parts = f.sent.filter((p) => p.payload.length && p.payload[0] === 3);
  assert.equal(
    parts.reduce((sum, p) => sum + p.payload.length, 0),
    large.length,
  );
  assert.ok(parts.every((p) => p.payload.length <= 3 * 16384 - 36));
});

test("a stalled USB ACK keeps receiving other streams and coalesces later ACKs", async (t) => {
  const f = await fixture(t);
  const first = await f.open(1);
  const other = await f.open(2);
  await f.target.session.writeChain;
  const device = f.target.device;
  const original = device.transferOut.bind(device);
  let release;
  let entered;
  const gate = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { entered = resolve; });
  let blocked = false;
  device.transferOut = async (endpoint, data) => {
    if (!blocked && data.byteLength) {
      blocked = true;
      entered();
      await gate;
    }
    return original(endpoint, data);
  };
  t.after(() => release());
  const before = f.sent.filter((p) => p.sport === first.sport && p.flags === 16).length;
  f.packet(first, 16, new Uint8Array([7]), 1);
  await started;
  // A physical OUT transfer is pending, but IN can still deliver bytes from
  // both connections. The receiver must not wait for its own queued ACK.
  for (let index = 0; index < 64; index++) {
    f.packet(first, 16, new Uint8Array([index]), index + 2);
  }
  f.packet(other, 16, new Uint8Array([42]), 1);
  await f.wait(() => f.frames.some((frame) => frame.type === 4 && frame.streamId === 2));
  await f.wait(() => first.ack === 66);
  assert.equal(f.relay.closed, false);
  release();
  await f.wait(() => f.sent.some((p) => p.sport === first.sport && p.ack === 66));
  const acks = f.sent.filter((p) => p.sport === first.sport && p.flags === 16).slice(before);
  assert.ok(acks.length <= 2, "pending ACKs must coalesce instead of growing with every received packet");
  const payload = f.frames.filter((frame) => frame.type === 4 && frame.streamId === 1)
    .flatMap((frame) => [...frame.payload]);
  assert.deepEqual(payload, [7, ...Array.from({ length: 64 }, (_, i) => i)]);
});

test("an empty USB TCP keepalive is acknowledged without delivering application bytes", async (t) => {
  const f = await fixture(t);
  const stream = await f.open(1);
  await f.target.session.writeChain;
  const before = f.sent.length;
  f.packet(stream, 16, new Uint8Array(), stream.ack - 1);
  await f.wait(() => f.sent.length > before);
  const ack = f.sent.at(-1);
  assert.equal(ack.flags, 16);
  assert.equal(ack.ack, stream.ack);
  assert.equal(ack.seq, stream.seq);
  assert.equal(f.frames.some((frame) => frame.type === 4), false);
});

test("a reset flood behind a stalled USB write has a bounded output queue", async (t) => {
  const f = await fixture(t);
  const stream = await f.open(1);
  await f.target.session.writeChain;
  const device = f.target.device;
  const original = device.transferOut.bind(device);
  let release;
  let entered;
  const gate = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { entered = resolve; });
  let blocked = false;
  device.transferOut = async (endpoint, data) => {
    if (!blocked && data.byteLength) {
      blocked = true;
      entered();
      await gate;
    }
    return original(endpoint, data);
  };
  t.after(() => release());
  f.packet(stream, 16, new Uint8Array([7]), 1);
  await started;
  // Late packets from retired streams need a reset, but an unresponsive
  // physical endpoint must not allow an unlimited global write chain.
  const retired = { sport: 65000, dport: 8100, seq: 1 };
  for (let index = 0; index < 300; index++) {
    f.packet(retired, 16, new Uint8Array(), 1);
  }
  await f.wait(() => f.relay.closed);
  assert.ok(f.target.session.pendingMuxWrites <= 256);
  release();
  await f.target.session.writeChain.catch(() => {});
  await f.wait(() => f.target.session.pendingMuxWrites === 0);
});

test('a slow preview upload closes only its receive window; control and heartbeat continue, then bytes resume intact', async t => {
  const f = await fixture(t);
  const preview = await f.open(1, 9100), control = await f.open(2);
  f.relay.socket.bufferedAmount = 128 * 1024;
  f.relay.socket.trackBuffer = true;
  const expected = Uint8Array.from({length: 128 * 1024}, (_, i) => i % 251);
  for (let offset = 0; offset < expected.length; offset += 32768) {
    f.packet(preview, 16, expected.slice(offset, offset + 32768), offset + 1);
  }
  await f.wait(() => f.sent.some(p => p.sport === preview.sport && p.window === 0));
  assert.equal(preview.readRetainedBytes, expected.length);
  assert.equal(preview.queue.reduce((sum, bytes) => sum + bytes.length, 0), 96 * 1024);
  assert.equal(f.frames.filter(frame => frame.type === 4 && frame.streamId === 1).length, 0);
  f.packet(preview, 16, new Uint8Array([99]), expected.length + 1);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(preview.closed, undefined, 'a legal zero-window probe must not reset the preview');
  assert.equal(preview.ack, expected.length + 1, 'do not acknowledge probe data until credit recovers');
  f.packet(control, 16, new Uint8Array([42]));
  await f.wait(() => f.frames.some(frame => frame.type === 4 && frame.streamId === 2));
  await f.send(8, 0);
  assert.ok(f.frames.some(frame => frame.type === 9));
  assert.ok(f.relay.socket.bufferedAmount < 384 * 1024);
  // Simulate downstream progress. Do not hide a second unbounded SDK queue.
  f.relay.socket.trackBuffer = false;
  f.relay.socket.bufferedAmount = 0;
  await f.wait(() => preview.readRetainedBytes === 0);
  await f.wait(() => f.sent.some(p => p.sport === preview.sport && p.ack === expected.length + 1 && p.window === expected.length));
  const actual = Buffer.concat(f.frames.filter(frame => frame.type === 4 && frame.streamId === 1).map(frame => frame.payload));
  assert.deepEqual(actual, Buffer.from(expected));
  f.packet(preview, 16, new Uint8Array([99]), expected.length + 1);
  await f.wait(() => preview.ack === expected.length + 2 && preview.readRetainedBytes === 0);
  assert.deepEqual([...f.frames.filter(frame => frame.type === 4 && frame.streamId === 1).at(-1).payload], [99]);
  assert.equal(f.relay.closed, false);
  assert.equal(f.relay.uplinkWaiters, 0);
  assert.ok(f.relay.uplinkWaitCount >= 1);
});

test('the native WebSocket queue stays within its preview budget under continuous upload', async t => {
  const f = await fixture(t), stream = await f.open(1, 9100);
  f.relay.socket.trackBuffer = true;
  f.relay.socket.bufferedAmount = 0;
  for (let i = 0; i < 5; i++) f.packet(stream, 16, new Uint8Array(32768).fill(i), 1 + i * 32768);
  await f.wait(() => stream.readRetainedBytes >= 64 * 1024);
  assert.ok(f.relay.socket.bufferedAmount <= 128 * 1024);
  assert.ok(stream.readRetainedBytes <= 128 * 1024);
  assert.equal(f.relay.closed, false);
});

test('sustained preview congestion resets the preview, enforces cooldown, and preserves the control connection', async t => {
  const f = await fixture(t), preview = await f.open(1, 9100), control = await f.open(2);
  f.relay.continuousPreviewEnabled = true;
  let now = 100;
  t.mock.method(performance, 'now', () => now);
  f.relay.socket.bufferedAmount = 128 * 1024;
  f.packet(preview, 16, new Uint8Array([1]));
  await f.wait(() => f.relay.uplinkWaiters === 1);
  now += 2001;
  await f.wait(() => f.frames.some(frame => frame.type === 5 && frame.streamId === 1));
  assert.equal(f.relay.previewPauses, 1);
  assert.equal(preview.readRetainedBytes, 0);
  assert.equal(f.relay.streams.get(2), control);
  assert.equal(f.target.session.closed, false);
  assert.ok(f.sent.some(p => p.sport === preview.sport && p.flags === 20));
  const synCount = f.sent.filter(p => p.flags & 2).length;
  assert.equal(await f.open(3, 9100), undefined);
  assert.equal(f.sent.filter(p => p.flags & 2).length, synCount, 'cooldown must not open another USB preview');
  assert.equal(JSON.parse(new TextDecoder().decode(f.frames.find(frame => frame.type === 3 && frame.streamId === 3).payload)).ok, false);
  f.packet(control, 16, new Uint8Array([42]));
  await f.wait(() => f.frames.some(frame => frame.type === 4 && frame.streamId === 2));
  now += 30001;
  assert.ok(await f.open(4, 9100));
});

test('a blocked control upload cannot hold incoming heartbeat or cancellation and never replays cancelled bytes', async t => {
  const f = await fixture(t), stream = await f.open(1);
  f.relay.socket.bufferedAmount = 384 * 1024;
  f.packet(stream, 16, new Uint8Array([42]));
  await f.wait(() => f.relay.uplinkWaiters === 1);
  await f.send(8, 0);
  await f.wait(() => f.frames.some(frame => frame.type === 9));
  await f.send(5, 1);
  await f.wait(() => f.relay.uplinkWaiters === 0);
  f.relay.socket.bufferedAmount = 0;
  assert.equal(stream.readRetainedBytes, 0);
  assert.equal(f.frames.filter(frame => frame.type === 4).length, 0);
  assert.equal(f.relay.closed, false);
});

test('a peer exceeding receive credit resets that stream without retaining unbounded bytes', async t => {
  const f = await fixture(t), stream = await f.open(1);
  f.relay.socket.bufferedAmount = 384 * 1024;
  for (let i = 0; i < 4; i++) f.packet(stream, 16, new Uint8Array(32768), 1 + i * 32768);
  await f.wait(() => stream.readRetainedBytes === 128 * 1024);
  f.packet(stream, 16, new Uint8Array([42, 43]), 1 + 128 * 1024);
  await f.wait(() => f.frames.some(frame => frame.type === 5 && frame.streamId === 1));
  assert.equal(stream.readRetainedBytes, 0);
  assert.equal(stream.queue.length, 0);
  assert.equal(f.relay.closed, false);
});

test('remote FIN during upload backpressure drains its final bytes once before notifying close', async t => {
  const f = await fixture(t), stream = await f.open(1);
  f.relay.socket.bufferedAmount = 384 * 1024;
  f.packet(stream, 17, new Uint8Array([1, 2, 3]), 1);
  await f.wait(() => stream.closed);
  assert.equal(f.frames.filter(frame => frame.type === 4 || frame.type === 5).length, 0);
  assert.equal(stream.readRetainedBytes, 3);
  f.relay.socket.bufferedAmount = 0;
  await f.wait(() => f.frames.some(frame => frame.type === 5));
  assert.deepEqual(f.frames.filter(frame => frame.type === 4).map(frame => [...frame.payload]), [[1, 2, 3]]);
  assert.equal(stream.readRetainedBytes, 0);
  assert.equal(f.sent.filter(packet => packet.flags & 4).length, 0);
});

test('a permanently stalled uplink closes the relay and releases all waiting uploads', async t => {
  const f = await fixture(t), first = await f.open(1), second = await f.open(2);
  let now = 100;
  t.mock.method(performance, 'now', () => now);
  f.relay.socket.bufferedAmount = 512 * 1024;
  f.packet(first, 16, new Uint8Array([1]));
  f.packet(second, 16, new Uint8Array([2]));
  await f.wait(() => f.relay.uplinkWaiters === 2);
  await f.send(8, 0);
  await f.wait(() => f.relay.uplinkWaiters === 3);
  now += 20001;
  await f.wait(() => f.relay.closed && f.relay.uplinkWaiters === 0);
  assert.equal(f.relay.streams.size, 0);
  assert.equal(f.target.session.streams.size, 0);
  assert.equal(first.readRetainedBytes + second.readRetainedBytes, 0);
  assert.equal(f.frames.filter(frame => frame.type === 4).length, 0);
});

test('the stream count bounds total receive retention and refuses excess opens explicitly', async t => {
  const f = await fixture(t);
  const streams = await Promise.all(Array.from({length: 64}, (_, i) => f.open(i + 1)));
  assert.ok(streams.every(Boolean));
  assert.equal(await f.open(65), undefined);
  assert.equal(f.sent.filter(packet => packet.flags & 2).length, 64);
  assert.equal(f.relay.streams.size, 64);
  assert.equal(f.target.session.streams.size, 64);
  assert.equal(JSON.parse(new TextDecoder().decode(f.frames.find(frame => frame.type === 3 && frame.streamId === 65).payload)).ok, false);
});


test('one-frame captures bypass viewer cooldown, retain media limits and do not pause subsequent screenshots', async t => {
  const f = await fixture(t);
  let now = 100;
  t.mock.method(performance, 'now', () => now);
  f.relay.previewSuspendedUntil = 30100;
  f.relay.continuousPreviewEnabled = false;
  const screenshot = await f.open(1, 9100), control = await f.open(2);
  assert.ok(screenshot, 'a viewer cooldown must not block task observations');
  f.relay.socket.bufferedAmount = 128 * 1024;
  f.packet(screenshot, 16, new Uint8Array([1]));
  await f.wait(() => f.relay.uplinkWaiters === 1);
  now += 2001;
  f.packet(control, 16, new Uint8Array([42]));
  await f.wait(() => f.frames.some(frame => frame.type === 4 && frame.streamId === 2));
  assert.equal(f.frames.filter(frame => frame.type === 4 && frame.streamId === 1).length, 0);
  assert.equal(f.relay.previewPauses ?? 0, 0);
  now += 6000;
  await f.wait(() => f.frames.some(frame => frame.type === 5 && frame.streamId === 1));
  assert.equal(f.relay.closed, false);
  assert.equal(f.relay.streams.get(2), control);
  assert.ok(await f.open(3, 9100));
});
