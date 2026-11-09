import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import * as plist from "plist";
import * as sdk from "@limrun/device-install";
import { BrowserClient } from "../web/client.mjs";
import { createGateway } from "../src/gateway.mjs";
// Fake physical peer: only USB claim, usbmux version handshake and resume pairing.
// It deliberately does NOT simulate a real iPhone, Lockdown/signing or WDA.
function fakeUSB(allFail = false) {
  const claims = [],
    writes = [];
  let rejectRead;
  let readCount = 0;
  const configurations = [6, 3].map((configurationValue) => ({
    configurationValue,
    interfaces: [
      {
        interfaceNumber: 1,
        alternates: [
          {
            alternateSetting: 0,
            interfaceClass: 255,
            interfaceSubclass: 254,
            interfaceProtocol: 2,
            endpoints: [
              {
                endpointNumber: 1,
                direction: "out",
                type: "bulk",
                packetSize: 512,
              },
              {
                endpointNumber: 2,
                direction: "in",
                type: "bulk",
                packetSize: 512,
              },
            ],
          },
        ],
      },
    ],
  }));
  const device = {
    serialNumber: "00008140001234567890abcd",
    vendorId: 1452,
    productId: 4776,
    productName: "Explicit fake USB peer",
    configurations,
    configuration: configurations[0],
    opened: false,
    open: async () => {
      device.opened = true;
    },
    close: async () => {
      device.opened = false;
      rejectRead?.(new Error("fake USB closed"));
    },
    selectConfiguration: async (n) => {
      device.configuration = configurations.find(
        (c) => c.configurationValue === n,
      );
    },
    claimInterface: async (n) => {
      claims.push([device.configuration.configurationValue, n]);
      if (allFail || device.configuration.configurationValue === 6)
        throw new Error("Unable to claim interface");
    },
    releaseInterface: async () => {},
    selectAlternateInterface: async () => {},
    transferOut: async (endpoint, data) => {
      writes.push(new Uint8Array(data));
      return { status: "ok", bytesWritten: data.byteLength };
    },
    transferIn: async () => {
      if (readCount++ === 0) {
        const bytes = new Uint8Array(20),
          view = new DataView(bytes.buffer);
        view.setUint32(4, 20);
        view.setUint32(8, 2);
        return { status: "ok", data: view };
      }
      return new Promise((resolve, reject) => {
        rejectRead = reject;
      });
    },
  };
  return {
    device,
    claims,
    writes,
    failRead: () => rejectRead?.(new Error("fake physical unplug")),
  };
}
for (const allFail of [false, true])
  test(`published SDK ${allFail ? "all claim failures close USB and delete session" : "falls back current cfg6→cfg3 and pairs through real gateway"} (explicit fake USB/native)`, async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sdk-webusb-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const usb = fakeUSB(allFail);
    const originalNavigator = Object.getOwnPropertyDescriptor(
      globalThis,
      "navigator",
    );
    const originalWS = globalThis.WebSocket;
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { usb: { requestDevice: async () => usb.device } },
    });
    globalThis.WebSocket = class extends WebSocket {
      constructor(url) {
        super(url, { origin: "http://localhost" });
      }
    };
    t.after(() => {
      if (originalNavigator)
        Object.defineProperty(globalThis, "navigator", originalNavigator);
      else delete globalThis.navigator;
      globalThis.WebSocket = originalWS;
    });
    const record = {
      udid: "00008140-001234567890ABCD",
      pairRecordBase64: Buffer.from(
        plist.build({ SystemBUID: "fake-browser-buid", HostID: "fake" }),
      ).toString("base64"),
    };
    const gateway = createGateway({
      accessToken: "fake-controller-token",
      allowedOrigins: ["http://localhost"],
      runtimeDir: root,
      controllerFactory: () => ({
        state: {
          ready: true,
          daemon: null,
          setup: { state: "idle", transcript: "", exitCode: null },
        },
        start: async () => {},
        close: async () => {},
        request: async () => ({ kind: "text", text: "{}" }),
      }),
    });
    await gateway.listen("127.0.0.1", 0);
    t.after(() => gateway.close());
    const base = `http://127.0.0.1:${gateway.server.address().port}`;
    let stored;
    const client = new BrowserClient({
      sdk: {
        ...sdk,
        getPairRecord: async () => record,
        putPairRecord: async (value) => {
          stored = value;
        },
      },
    });
    t.after(() => client.disconnect());
    if (allFail) {
      await assert.rejects(
        client.connect({ apiBase: base, accessToken: "fake-controller-token" }),
        /Unable to claim interface/,
      );
      assert.equal(client.snapshot().phase, "error");
      assert.equal(gateway.sessions.size, 0);
      assert.equal(usb.device.opened, false);
      assert.deepEqual(usb.claims, [
        [6, 1],
        [6, 1],
        [3, 1],
        [3, 1],
      ]);
    } else {
      await client.connect({
        apiBase: base,
        accessToken: "fake-controller-token",
      });
      assert.equal(client.snapshot().phase, "connected");
      assert.equal(stored.udid, record.udid);
      assert.deepEqual(usb.claims, [
        [6, 1],
        [6, 1],
        [3, 1],
      ]);
      assert.equal(usb.writes.length, 2);
      assert.equal(new DataView(usb.writes[0].buffer).getUint32(8), 2);
      await client.disconnect();
      assert.equal(gateway.sessions.size, 0);
      assert.equal(usb.device.opened, false);
    }
  });
test("selected USB disconnect revokes live published SDK WS and closes real NativeController fixture process", async (t) => {
  const { NativeController } = await import("../src/native-controller.mjs");
  const root = await mkdtemp(path.join(os.tmpdir(), "sdk-unplug-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const usb = fakeUSB();
  class USBEvents extends EventTarget {
    listeners = new Set();
    addEventListener(type, handler, ...args) {
      if (type === "disconnect") this.listeners.add(handler);
      super.addEventListener(type, handler, ...args);
    }
    removeEventListener(type, handler, ...args) {
      this.listeners.delete(handler);
      super.removeEventListener(type, handler, ...args);
    }
    disconnect(device) {
      const event = new Event("disconnect");
      Object.defineProperty(event, "device", { value: device });
      this.dispatchEvent(event);
    }
  }
  const events = new USBEvents();
  events.requestDevice = async () => usb.device;
  const originalNavigator = Object.getOwnPropertyDescriptor(
      globalThis,
      "navigator",
    ),
    originalWS = globalThis.WebSocket;
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { usb: events },
  });
  globalThis.WebSocket = class extends WebSocket {
    constructor(url) {
      super(url, { origin: "http://localhost" });
    }
  };
  t.after(() => {
    if (originalNavigator)
      Object.defineProperty(globalThis, "navigator", originalNavigator);
    else delete globalThis.navigator;
    globalThis.WebSocket = originalWS;
  });
  let controller;
  const gateway = createGateway({
    accessToken: "fixture-controller-token",
    allowedOrigins: ["http://localhost"],
    runtimeDir: root,
    controllerFactory: (session) =>
      (controller = new NativeController({
        ...session,
        command: process.execPath,
        commandArgs: [
          new URL("./fixtures/native-cli.mjs", import.meta.url).pathname,
        ],
        startTimeoutMs: 3000,
      })),
  });
  await gateway.listen("127.0.0.1", 0);
  t.after(() => gateway.close());
  const base = `http://127.0.0.1:${gateway.server.address().port}`;
  const record = {
    udid: "00008140-001234567890ABCD",
    pairRecordBase64: Buffer.from(
      plist.build({ SystemBUID: "fake-buid", HostID: "fake" }),
    ).toString("base64"),
  };
  const client = new BrowserClient({
    sdk: {
      ...sdk,
      getPairRecord: async () => record,
      putPairRecord: async () => {},
    },
  });
  t.after(() => client.disconnect());
  await client.connect({
    apiBase: base,
    accessToken: "fixture-controller-token",
  });
  const waitFor = async (condition) => {
    const until = Date.now() + 3000;
    while (!condition()) {
      if (Date.now() > until) throw new Error("fixture wait timeout");
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  await waitFor(() => controller?.state.ready);
  const session = [...gateway.sessions.values()][0],
    id = session.id,
    token = session.token,
    pid = [...controller.children][0].pid;
  events.disconnect({ serialNumber: "00008140001234567890FFFF" });
  assert.equal(client.snapshot().phase, "connected");
  assert.equal(gateway.sessions.size, 1);
  usb.failRead();
  await new Promise((r) => setImmediate(r));
  assert.equal(
    client.snapshot().phase,
    "connected",
    "SDK mux read failure alone does not revoke the WS",
  );
  events.disconnect(usb.device);
  assert.equal(client.snapshot().phase, "offline");
  assert.equal(client.snapshot().session, null);
  await waitFor(
    () =>
      gateway.sessions.size === 0 &&
      controller.closed &&
      controller.children.size === 0,
  );
  assert.equal(events.listeners.size, 0);
  assert.equal(
    (
      await fetch(`${base}/api/sessions/${id}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
    ).status,
    404,
  );
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});
