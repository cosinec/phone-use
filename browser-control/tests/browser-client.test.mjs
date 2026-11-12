import test from "node:test";
import assert from "node:assert/strict";
const mod = await import("../web/client.mjs").catch(() => ({}));
const UID = "00008140-001234567890ABCD";
const target = () => ({
  hello: {
    serialNumber: "00008140001234567890abcd",
    vendorId: 1452,
    productId: 1,
    productName: "iPhone",
  },
  device: {},
});
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};
function fixture(overrides = {}) {
  assert.equal(
    typeof mod.BrowserClient,
    "function",
    "BrowserClient must exist",
  );
  const calls = [];
  const relay = { close: () => calls.push(["relay.close"]) };
  const sdk = {
    requestUSBAccess: () => {
      calls.push(["choose"]);
      return Promise.resolve(target());
    },
    getPairRecord: async (uid) => {
      calls.push(["lookup", uid]);
      return { udid: UID, pairRecordBase64: "xml" };
    },
    putPairRecord: async (record) => calls.push(["store", record]),
    pairDevice: async (options) => {
      calls.push(["pair", options]);
      return { relay, pairRecord: { udid: UID, pairRecordBase64: "xml" } };
    },
    closeDeviceRelayTarget: async () => calls.push(["usb.close"]),
    ...overrides.sdk,
  };
  const fetchImpl =
    overrides.fetchImpl ??
    (async (url, options = {}) => {
      calls.push(["fetch", url, options]);
      return {
        ok: true,
        status: 200,
        json: async () =>
          options.method === "POST"
            ? {
                id: "session",
                deviceId: UID,
                token: "SESSION_SECRET",
                relayUrl: "ws://cloud/ios/device/ws?token=SESSION_SECRET",
              }
            : { state: "connected", ready: true },
      };
    });
  return {
    client: new mod.BrowserClient({
      sdk,
      fetchImpl,
      uuid: () => "request-1",
      cleanupTimeoutMs: overrides.cleanupTimeoutMs ?? 5000,
      usbEvents: overrides.usbEvents ?? null,
    }),
    calls,
    relay,
  };
}
test('stopping continuous preview sends an authenticated DELETE without disconnecting the phone', async t => {
  const {client, calls, relay} = fixture();
  t.after(() => client.disconnect());
  await client.connect({apiBase: 'http://cloud', accessToken: 'token'});
  relay.continuousPreviewEnabled = true;
  relay.previewSuspendedUntil = 999999;
  await client.stopPreview();
  assert.equal(relay.continuousPreviewEnabled, false);
  assert.equal(relay.previewSuspendedUntil, 0);
  assert.ok(calls.some(c => c[0] === 'fetch' && c[1].endsWith('/preview/stream') && c[2].method === 'DELETE'));
  assert.ok(!calls.some(c => c[0] === 'relay.close'));
});
test('diagnostics wrap physical USB reads without recursing through the packet proxy; setup remains responsive', async t => {
  const {attachTransportDiagnostics} = await import('../web/transport-diagnostics.mjs');
  let tick;
  t.mock.method(globalThis, 'setInterval', callback => { tick = callback; return 1; });
  t.mock.method(globalThis, 'clearInterval', () => {});
  const bytes = new Uint8Array(24);
  new DataView(bytes.buffer).setUint32(4, bytes.length);
  const fragments = [bytes.slice(0, 5), bytes.slice(5)];
  let physicalReads = 0, pairedTarget, diagnosticDevice;
  const device = {
    async transferIn() {
      assert.equal(this, device);
      physicalReads++;
      const chunk = fragments.shift();
      assert.ok(chunk, 'packet reassembly must make exactly two physical reads');
      return {status: 'ok', data: new DataView(chunk.buffer)};
    },
    async transferOut(_endpoint, data) { return {status: 'ok', bytesWritten: data.byteLength}; },
  };
  const nativeRead = device.transferIn, nativeWrite = device.transferOut;
  const relay = {socket: {send() {}}, streams: new Map(), close() {}};
  const {client, calls} = fixture({sdk: {
    requestUSBAccess: async () => ({...target(), device}),
    pairDevice: async options => {
      pairedTarget = options.target;
      pairedTarget.session = {pendingMuxWrites: 0};
      return {relay, pairRecord: {udid: UID, pairRecordBase64: 'xml'}};
    },
    attachTransportDiagnostics(target, relay, report) {
      diagnosticDevice = target.device;
      return attachTransportDiagnostics(target, relay, report);
    },
  }});
  t.after(() => client.disconnect());
  await client.connect({apiBase: 'http://cloud', accessToken: 'token'});
  // Fail before invoking a broken wrapper: the old integration otherwise keeps
  // scheduling WASM promises and starves timers, clicks and session polling.
  assert.equal(diagnosticDevice, device, 'instrument the physical device, not its packet-reassembly proxy');
  assert.notEqual(pairedTarget.device, device, 'the SDK must retain complete-packet reads');
  const received = await pairedTarget.device.transferIn(2, 16384);
  assert.equal(received.data.byteLength, 24);
  assert.equal(physicalReads, 2);
  await tick();
  const sample = calls.filter(c => c[0] === 'fetch' && c[1].endsWith('/diagnostics')).at(-1);
  assert.equal(JSON.parse(sample[2].body).usbReadCalls, 2);
  assert.equal(JSON.parse(sample[2].body).usbReadBytes, 24);
  await client.startSetup();
  assert.ok(calls.some(c => c[0] === 'fetch' && c[1].endsWith('/setup') && c[2].method === 'POST'));
  await client.disconnect();
  assert.equal(device.transferIn, nativeRead);
  assert.equal(device.transferOut, nativeWrite);
});
test('task creation transmits the selected model once and keeps the omitted-model default compatible', async () => {
  const { client, calls } = fixture();
  await client.connect({ apiBase: 'http://cloud', accessToken: 'token' });
  await client.startTask('look at screen', 'other/vision');
  assert.deepEqual(JSON.parse(calls.filter(c => c[0] === 'fetch').at(-1)[2].body), { instruction: 'look at screen', model: 'other/vision' });
  await client.startTask('default task');
  assert.deepEqual(JSON.parse(calls.filter(c => c[0] === 'fetch').at(-1)[2].body), { instruction: 'default task' });
  await client.disconnect();
});
test("chooser synchronous; canonical identity and session token reach SDK pair exactly once", async () => {
  const { client, calls } = fixture();
  const pending = client.connect({
    apiBase: "http://cloud",
    accessToken: "CONTROL_SECRET",
  });
  assert.deepEqual(calls, [["choose"]]);
  await pending;
  assert.equal(calls[1][1], UID);
  assert.equal(
    JSON.parse(calls.find((c) => c[0] === "fetch")[2].body).device.serialNumber,
    UID,
  );
  const pair = calls.filter((c) => c[0] === "pair");
  assert.equal(pair.length, 1);
  assert.equal(pair[0][1].token, "SESSION_SECRET");
  assert.equal(pair[0][1].registryApiUrl, "http://cloud");
  assert.ok(!JSON.stringify(client.snapshot()).includes("SECRET"));
  await client.command("iphone_press_button", { button: "home" });
  assert.equal(
    JSON.parse(calls.filter((c) => c[0] === "fetch").at(-1)[2].body).deviceId,
    UID,
  );
  await client.disconnect();
  assert.ok(calls.some((c) => c[2]?.method === "DELETE"));
});
test("failed command sends once without automatic mutation retry", async () => {
  const { client, calls } = fixture();
  await client.connect({ apiBase: "http://cloud", accessToken: "token" });
  client.fetchImpl = async (url, options) => {
    calls.push(["failed", url, options]);
    throw new Error("network lost");
  };
  await assert.rejects(
    client.command("iphone_tap", { x: 1, y: 2 }),
    /network lost/,
  );
  assert.equal(calls.filter((c) => c[0] === "failed").length, 1);
  await client.disconnect();
});
test("pair failure closes USB and deletes session with visible claim error", async () => {
  const { client, calls } = fixture({
    sdk: {
      pairDevice: async () => {
        throw new Error("Unable to claim interface");
      },
    },
  });
  await assert.rejects(
    client.connect({ apiBase: "http://cloud", accessToken: "token" }),
    /Unable to claim interface/,
  );
  assert.match(client.snapshot().error, /Unable to claim interface/);
  assert.ok(calls.some((c) => c[0] === "usb.close"));
  assert.ok(calls.some((c) => c[2]?.method === "DELETE"));
});
test("active signing owner explains how to release the original session and closes local USB", async () => {
  const { client, calls } = fixture({
    fetchImpl: async () => ({ ok: false, status: 409, json: async () => ({ error: 'Native signing state has an active owner' }) }),
  });
  await assert.rejects(client.connect({ apiBase: 'http://cloud', accessToken: 'token' }), /另一个会话.*断开连接/);
  assert.match(client.snapshot().error, /原工作台/);
  assert.ok(calls.some(call => call[0] === 'usb.close'));
  assert.equal(calls.filter(call => call[0] === 'pair').length, 0);
});
test("cancel chooser closes its late target without creating session", async () => {
  const chooser = deferred();
  const { client, calls } = fixture({
    sdk: { requestUSBAccess: () => chooser.promise },
  });
  const pending = client.connect({
    apiBase: "http://cloud",
    accessToken: "token",
  });
  await client.disconnect();
  chooser.resolve(target());
  await pending;
  assert.equal(calls.filter((c) => c[0] === "fetch").length, 0);
  assert.ok(calls.some((c) => c[0] === "usb.close"));
  assert.equal(client.snapshot().phase, "offline");
});
test("cancel creation deletes late session without pairing", async () => {
  const creation = deferred();
  const calls = [];
  const { client } = fixture({
    fetchImpl: async (url, options) => {
      calls.push([url, options]);
      return options.method === "POST"
        ? creation.promise
        : { ok: true, json: async () => ({}) };
    },
  });
  const pending = client.connect({
    apiBase: "http://cloud",
    accessToken: "token",
  });
  await new Promise((r) => setImmediate(r));
  await client.disconnect();
  creation.resolve({
    ok: true,
    json: async () => ({ id: "late", deviceId: UID, token: "SESSION_SECRET" }),
  });
  await pending;
  assert.ok(
    calls.some((c) => c[0].endsWith("/late") && c[1]?.method === "DELETE"),
  );
  assert.equal(client.snapshot().phase, "offline");
});
test("cancel pair closes late relay and ignores stale completion", async () => {
  const pair = deferred();
  const { client, calls, relay } = fixture({
    sdk: { pairDevice: () => pair.promise },
  });
  const pending = client.connect({
    apiBase: "http://cloud",
    accessToken: "token",
  });
  await new Promise((r) => setImmediate(r));
  await client.disconnect();
  pair.resolve({ relay, pairRecord: { udid: UID, pairRecordBase64: "xml" } });
  await pending;
  assert.ok(calls.some((c) => c[0] === "relay.close"));
  assert.ok(!calls.some((c) => c[0] === "store"));
  assert.equal(client.snapshot().phase, "offline");
});
test("setup/task bodies exact; setup input absent from public state", async () => {
  const { client, calls } = fixture();
  await client.connect({ apiBase: "http://cloud", accessToken: "token" });
  await client.setupInput("secret-2fa");
  await client.startTask("打开设置");
  await client.confirmTask("task", "action", true);
  await client.stopTask("task");
  assert.deepEqual(
    calls
      .filter((c) => c[0] === "fetch" && c[2]?.method === "POST")
      .slice(1)
      .map((c) => JSON.parse(c[2].body)),
    [
      { line: "secret-2fa" },
      { instruction: "打开设置" },
      { actionId: "action", approved: true },
      {},
    ],
  );
  assert.ok(!JSON.stringify(client.snapshot()).includes("secret-2fa"));
  await client.disconnect();
});
test("late state read after cancellation cannot revive UI; unavailable read disables readiness", async () => {
  const { client } = fixture();
  await client.connect({ apiBase: "http://cloud", accessToken: "token" });
  const response = deferred();
  client.fetchImpl = async () => response.promise;
  const pending = client.refresh();
  const closing = client.disconnect();
  response.resolve({
    ok: true,
    json: async () => ({ id: "session", state: "connected", ready: true }),
  });
  await pending;
  await closing;
  assert.equal(client.snapshot().phase, "offline");
  assert.equal(client.snapshot().session, null);
});
test("session read failure marks device unavailable; SDK progress exposes no raw log details", async () => {
  const { client, calls } = fixture();
  await client.connect({ apiBase: "http://cloud", accessToken: "token" });
  calls
    .find((c) => c[0] === "pair")[1]
    .log("Claiming usbmux interface", "SECRET_RAW_SERIAL");
  assert.equal(client.snapshot().transportStatus, "正在申请 USB 接口访问");
  assert.ok(!JSON.stringify(client.snapshot()).includes("SECRET_RAW_SERIAL"));
  client.fetchImpl = async () => {
    throw new Error("server offline");
  };
  await assert.rejects(client.refresh(), /server offline/);
  assert.equal(client.snapshot().session.ready, false);
  assert.equal(client.snapshot().session.state, "unavailable");
  await client.disconnect();
});
test("failed status poll clears ready to prevent stale manual controls", async () => {
  const { client } = fixture();
  await client.connect({ apiBase: "http://cloud", accessToken: "token" });
  await client.refresh();
  client.fetchImpl = async () => {
    throw new Error("offline");
  };
  await assert.rejects(client.refresh());
  assert.equal(client.snapshot().session.ready, false);
  assert.equal(client.snapshot().session.state, "unavailable");
  await client.disconnect();
});
test("older status response cannot overwrite a newer active task", async () => {
  const { client } = fixture();
  await client.connect({ apiBase: "http://cloud", accessToken: "token" });
  const older = deferred(),
    newer = deferred();
  let n = 0;
  client.fetchImpl = async () => (++n === 1 ? older.promise : newer.promise);
  const p1 = client.refresh(),
    p2 = client.refresh();
  newer.resolve({
    ok: true,
    json: async () => ({
      id: "session",
      ready: true,
      state: "connected",
      task: { id: "active", state: "thinking" },
    }),
  });
  await p2;
  older.resolve({
    ok: true,
    json: async () => ({
      id: "session",
      ready: true,
      state: "connected",
      task: null,
    }),
  });
  await p1;
  assert.equal(client.snapshot().session.task?.id, "active");
  client.fetchImpl = async () => ({ ok: true, json: async () => ({}) });
  await client.disconnect();
});
test("disconnect publishes offline and closes USB before held DELETE; old cleanup cannot clear new session", async () => {
  const deletion = deferred();
  const { client, calls } = fixture();
  await client.connect({ apiBase: "http://cloud", accessToken: "token" });
  await client.refresh();
  const originalFetch = client.fetchImpl;
  client.fetchImpl = async (url, options) =>
    options.method === "DELETE"
      ? deletion.promise
      : originalFetch(url, options);
  const closing = client.disconnect();
  assert.equal(client.snapshot().phase, "offline");
  assert.equal(client.snapshot().session, null);
  assert.ok(calls.some((c) => c[0] === "usb.close"));
  await new Promise((r) => setImmediate(r)); // USB custody settles separately from held DELETE.
  await client.connect({ apiBase: "http://cloud", accessToken: "token" });
  assert.equal(client.snapshot().phase, "connected");
  deletion.resolve({ ok: true, json: async () => ({}) });
  await closing;
  assert.equal(client.snapshot().phase, "connected");
  assert.ok(client.snapshot().session);
  await client.disconnect();
});
test("cancelled late creation is deleted while a newer connection remains owned", async () => {
  const creation = deferred(),
    lateDeletion = deferred();
  let post = 0;
  const { client } = fixture({
    fetchImpl: async (url, options) => {
      if (options.method === "POST" && url.endsWith("/sessions"))
        return ++post === 1
          ? creation.promise
          : {
              ok: true,
              json: async () => ({
                id: "new",
                deviceId: UID,
                token: "NEW_SECRET",
              }),
            };
      if (options.method === "DELETE" && url.endsWith("/late"))
        return lateDeletion.promise;
      return { ok: true, json: async () => ({}) };
    },
  });
  const previous = client.connect({
    apiBase: "http://cloud",
    accessToken: "token",
  });
  await new Promise((r) => setImmediate(r));
  await client.disconnect();
  await client.connect({ apiBase: "http://cloud", accessToken: "token" });
  creation.resolve({
    ok: true,
    json: async () => ({ id: "late", deviceId: UID, token: "OLD_SECRET" }),
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(client.snapshot().session.id, "new");
  lateDeletion.resolve({ ok: true, json: async () => ({}) });
  await previous;
  assert.equal(client.snapshot().phase, "connected");
  assert.equal(client.snapshot().session.id, "new");
  await client.disconnect();
});
test("DELETE cleanup is bounded and attempted once even when fetch ignores abort", async () => {
  const deletion = deferred();
  let deletes = 0;
  const { client } = fixture({ cleanupTimeoutMs: 20 });
  await client.connect({ apiBase: "http://cloud", accessToken: "token" });
  client.fetchImpl = async () => {
    deletes++;
    return deletion.promise;
  };
  const closing = client.disconnect();
  try {
    assert.equal(
      await Promise.race([
        closing.then(() => true),
        new Promise((r) => setTimeout(() => r(false), 80)),
      ]),
      true,
      "cleanup must finish within its configured bound",
    );
    assert.equal(deletes, 1);
  } finally {
    deletion.resolve({ ok: true, json: async () => ({}) });
    await closing;
  }
});
test("late creation cleanup never closes an already-released USB target again", async () => {
  const creation = deferred();
  let n = 0;
  const releases = [];
  const { client } = fixture({
    sdk: {
      closeDeviceRelayTarget: async (target) => {
        if (target) releases.push(target);
      },
    },
    fetchImpl: async (url, options) =>
      options.method === "POST" && ++n === 1
        ? creation.promise
        : {
            ok: true,
            json: async () => ({ id: "new", deviceId: UID, token: "NEW" }),
          },
  });
  const previous = client.connect({
    apiBase: "http://cloud",
    accessToken: "token",
  });
  await new Promise((r) => setImmediate(r));
  await client.disconnect();
  const released = releases[0];
  creation.resolve({
    ok: true,
    json: async () => ({ id: "old", deviceId: UID, token: "OLD" }),
  });
  await previous;
  assert.equal(releases.filter((target) => target === released).length, 1);
  await client.disconnect();
});
test("fetch uses Window-compatible receiver for default and injected browser-branded functions", async (t) => {
  const original = globalThis.fetch;
  function brandedFetch() {
    assert.equal(
      this,
      globalThis,
      "native Window.fetch receiver must be globalThis",
    );
    return Promise.resolve({
      ok: true,
      json: async () => ({ aiReady: false, model: null }),
    });
  }
  globalThis.fetch = brandedFetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  assert.deepEqual(await new mod.BrowserClient().config(), {
    aiReady: false,
    model: null,
  });
  assert.deepEqual(
    await new mod.BrowserClient({ fetchImpl: brandedFetch }).config(),
    { aiReady: false, model: null },
  );
});
test("cancelled SDK pair keeps same-device custody until late pairing and final actual SDK close settle", async () => {
  const { closeDeviceRelayTarget } = await import("@limrun/device-install");
  const oldPair = deferred();
  let pairs = 0,
    choices = 0,
    closes = 0;
  const device = {
    opened: false,
    close: async () => {
      closes++;
      device.opened = false;
    },
  };
  const targets = [];
  const { client } = fixture({
    sdk: {
      requestUSBAccess: async () => {
        choices++;
        const next = { ...target(), device };
        targets.push(next);
        return next;
      },
      pairDevice: async (options) => {
        device.opened = true;
        if (++pairs === 1) return oldPair.promise;
        return {
          relay: { close() {} },
          pairRecord: { udid: UID, pairRecordBase64: "xml" },
          target: options.target,
        };
      },
      closeDeviceRelayTarget,
    },
  });
  const previous = client.connect({
    apiBase: "http://cloud",
    accessToken: "token",
  });
  await new Promise((r) => setImmediate(r));
  await client.disconnect();
  assert.equal(client.snapshot().phase, "offline");
  assert.equal(client.snapshot().session, null);
  await assert.rejects(
    client.connect({ apiBase: "http://cloud", accessToken: "token" }),
    /等待|释放|处理中/,
  );
  assert.equal(choices, 1, "unsafe reconnect must not even open chooser");
  assert.equal(client.snapshot().cleanupPending, true);
  device.opened = true;
  oldPair.resolve({
    relay: { close() {} },
    pairRecord: { udid: UID, pairRecordBase64: "xml" },
    target: targets[0],
  });
  await previous;
  assert.equal(device.opened, false);
  assert.equal(client.snapshot().cleanupPending, false);
  await client.connect({ apiBase: "http://cloud", accessToken: "token" });
  const afterNew = closes;
  await new Promise((r) => setImmediate(r));
  assert.equal(device.opened, true);
  assert.equal(
    closes,
    afterNew,
    "old cleanup cannot close new shared USBDevice",
  );
  await client.disconnect();
});
test("USB custody outlives bounded DELETE wait when SDK close is still pending", async () => {
  const usbClose = deferred();
  const { client } = fixture({
    cleanupTimeoutMs: 20,
    sdk: { closeDeviceRelayTarget: () => usbClose.promise },
  });
  await client.connect({ apiBase: "http://cloud", accessToken: "token" });
  await client.disconnect();
  assert.equal(client.snapshot().phase, "offline");
  assert.equal(client.snapshot().cleanupPending, true);
  await assert.rejects(
    client.connect({ apiBase: "http://cloud", accessToken: "token" }),
    /等待|释放|处理中/,
  );
  usbClose.resolve();
  await new Promise((r) => setImmediate(r));
  assert.equal(client.snapshot().cleanupPending, false);
  await client.connect({ apiBase: "http://cloud", accessToken: "token" });
  await client.disconnect();
});
function usbEventsFixture() {
  const listeners = new Set();
  return {
    listeners,
    addEventListener: (type, handler) => {
      if (type === "disconnect") listeners.add(handler);
    },
    removeEventListener: (type, handler) => listeners.delete(handler),
    disconnect: (device) => {
      for (const handler of [...listeners]) handler({ device });
    },
  };
}
test("USB listeners belong to selected attempts, ignore unrelated and stale events, and remove on cancel", async () => {
  const usbEvents = usbEventsFixture();
  const { client } = fixture({ usbEvents });
  assert.equal(
    usbEvents.listeners.size,
    0,
    "constructing a client must not install listeners",
  );
  await client.connect({ apiBase: "http://cloud", accessToken: "token" });
  assert.equal(usbEvents.listeners.size, 1);
  usbEvents.disconnect({ serialNumber: "00008140001234567890EEEE" });
  assert.equal(client.snapshot().phase, "connected");
  const stale = [...usbEvents.listeners][0];
  await client.disconnect();
  assert.equal(usbEvents.listeners.size, 0);
  await client.connect({ apiBase: "http://cloud", accessToken: "token" });
  stale({ device: { serialNumber: UID } });
  assert.equal(
    client.snapshot().phase,
    "connected",
    "stale callback cannot close a newer attempt",
  );
  usbEvents.disconnect({ serialNumber: "00008140001234567890abcd\0\0" });
  assert.equal(client.snapshot().phase, "offline");
  assert.equal(client.snapshot().session, null);
  assert.equal(usbEvents.listeners.size, 0);
  await new Promise((r) => setImmediate(r));
  await client.disconnect();
});
test("USB listener is removed after pairing failure and during pending cancellation", async () => {
  const events = usbEventsFixture();
  const failing = fixture({
    usbEvents: events,
    sdk: {
      pairDevice: async () => {
        throw new Error("fixture pair error");
      },
    },
  }).client;
  await assert.rejects(
    failing.connect({ apiBase: "http://cloud", accessToken: "token" }),
  );
  assert.equal(events.listeners.size, 0);
  const pair = deferred();
  const client = fixture({
    usbEvents: events,
    sdk: { pairDevice: () => pair.promise },
  }).client;
  const pending = client.connect({
    apiBase: "http://cloud",
    accessToken: "token",
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(events.listeners.size, 1);
  await client.disconnect();
  assert.equal(events.listeners.size, 0);
  pair.resolve({
    relay: { close() {} },
    pairRecord: { udid: UID, pairRecordBase64: "xml" },
  });
  await pending;
  assert.equal(events.listeners.size, 0);
});

test('task attachments are uploaded and sent by ID while text-only calls stay compatible', async () => {
  const { client, calls } = fixture();
  await client.connect({ apiBase: 'http://cloud', accessToken: 'token' });
  await client.uploadAttachment('photo.png', 'image/png', 'eA==');
  let last = calls.filter(c => c[0] === 'fetch').at(-1);
  assert.match(last[1], /\/attachments$/);
  assert.deepEqual(JSON.parse(last[2].body), { name: 'photo.png', mimeType: 'image/png', dataBase64: 'eA==' });
  await client.startTask('use this picture', undefined, ['image-id']);
  last = calls.filter(c => c[0] === 'fetch').at(-1);
  assert.deepEqual(JSON.parse(last[2].body), { instruction: 'use this picture', attachments: ['image-id'] });
  await client.deleteAttachment('image-id');
  last = calls.filter(c => c[0] === 'fetch').at(-1);
  assert.match(last[1], /\/attachments\/image-id$/); assert.equal(last[2].method, 'DELETE');
  await client.disconnect();
});
