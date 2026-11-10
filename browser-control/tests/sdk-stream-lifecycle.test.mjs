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
  const packet = (stream, flags, payload = new Uint8Array(), seq = 1) => {
    const bytes = new Uint8Array(36 + payload.length),
      view = new DataView(bytes.buffer);
    view.setUint32(0, 6);
    view.setUint32(4, bytes.length);
    view.setUint32(8, 0xfeedface);
    view.setUint16(14, receiveSeq++);
    view.setUint16(16, stream.dport);
    view.setUint16(18, stream.sport);
    view.setUint32(20, seq);
    view.setUint32(24, 1);
    view.setUint8(28, 0x50);
    view.setUint8(29, flags);
    bytes.set(payload, 36);
    deliver(bytes);
  };
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
          ack: view.getUint32(24),
          payload: bytes.slice(36),
        });
        if (view.getUint8(29) & 2 && autoOpen) packet(stream, 18);
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
  const open = async (id) => {
    await send(2, id, new TextEncoder().encode('{"port":8100}'));
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
    wait,
    send,
    open,
    pauseOpen: () => {
      autoOpen = false;
    },
  };
}

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
