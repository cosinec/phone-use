// usbmux send-window regression for the build-time patch of @limrun/device-install
// (vite.config.mjs). Uses an explicit fake usbmux peer that advertises a receive window
// and acks with a delay, the way an iPhone does. It does NOT simulate a real iPhone.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import config from "../vite.config.mjs";

const require = createRequire(import.meta.url);
const sdkDir = join(dirname(require.resolve("@limrun/device-install/package.json")), "dist");
const chunkPath = join(sdkDir, "index-DJrAlfkC.js");
const plugin = config.plugins.find((p) => p.name === "device-install-usbmux-flow-control");
const CHUNK = 49116; // gateway MAX_USB_DATA

// The usbmux helpers are internal to the published bundle. Expose them by their (pinned
// 0.1.0) minified names: createUsbmuxSession=J, openStream=Q, sendStreamData=K, close=I.
async function loadUsbmux(patched) {
  let code = await readFile(chunkPath, "utf8");
  if (patched) code = plugin.transform(code, chunkPath).code;
  const dir = await mkdtemp(join(tmpdir(), "usbmux-fc-"));
  const file = join(dir, `usbmux-${patched ? "patched" : "original"}.mjs`);
  await writeFile(file, `${code}\nexport { J as createSession, Q as openStream, K as sendStreamData, I as closeSession };\n`);
  try {
    return await import(pathToFileURL(file).href);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function fakeUsbmuxPeer({ rawWindow, ackDelayMs = 2, resetAfterBytes = Infinity }) {
  const windowBytes = rawWindow << 8;
  const inbox = [];
  let wake;
  const push = (bytes) => {
    inbox.push(bytes);
    wake?.();
  };
  const stats = { violations: 0, maxInflight: 0, received: [], bytes: 0 };
  let host, devicePort, deviceSeq = 5000, expected = 0, acked = 0, reset = false;
  const tcp = (flags, ack) => {
    const out = new Uint8Array(36), v = new DataView(out.buffer);
    v.setUint32(0, 6), v.setUint32(4, 36), v.setUint32(8, 0xfeedface);
    v.setUint16(16, devicePort), v.setUint16(18, host), v.setUint32(20, deviceSeq), v.setUint32(24, ack);
    v.setUint8(28, 0x50), v.setUint8(29, flags), v.setUint16(30, rawWindow);
    return out;
  };
  const device = {
    async transferOut(_endpoint, data) {
      if (data.byteLength === 0) return { status: "ok" };
      const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
      const protocol = v.getUint32(0);
      if (protocol === 0) {
        const reply = new Uint8Array(20), rv = new DataView(reply.buffer);
        rv.setUint32(4, 20), rv.setUint32(8, 2); // usbmux version 2
        push(reply);
      }
      if (protocol !== 6 || reset) return { status: "ok" };
      const seg = data.subarray(16), sv = new DataView(seg.buffer, seg.byteOffset, seg.byteLength);
      const seq = sv.getUint32(4), flags = sv.getUint8(13), payload = seg.subarray(20);
      if (flags & 2) {
        host = sv.getUint16(0), devicePort = sv.getUint16(2), expected = acked = seq + 1;
        push(tcp(0x12, expected));
        deviceSeq += 1;
        return { status: "ok" };
      }
      if (payload.byteLength === 0) return { status: "ok" };
      assert.equal(seq, expected, "segments arrive in order");
      expected += payload.byteLength;
      const inflight = expected - acked;
      stats.maxInflight = Math.max(stats.maxInflight, inflight);
      if (inflight > windowBytes) stats.violations += 1;
      stats.received.push(payload.slice());
      stats.bytes += payload.byteLength;
      if (stats.bytes >= resetAfterBytes) {
        reset = true;
        push(tcp(0x04, expected));
        return { status: "ok" };
      }
      const ackTo = expected;
      setTimeout(() => {
        if (reset) return;
        acked = Math.max(acked, ackTo);
        push(tcp(0x10, ackTo));
      }, ackDelayMs);
      return { status: "ok" };
    },
    async transferIn() {
      while (inbox.length === 0) await new Promise((r) => (wake = r));
      const bytes = inbox.shift();
      return { status: "ok", data: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength) };
    },
  };
  const candidate = {
    configurationValue: 3,
    interfaceNumber: 1,
    alternateSetting: 0,
    endpoints: [
      { endpointNumber: 1, direction: "out", type: "bulk", packetSize: 512 },
      { endpointNumber: 2, direction: "in", type: "bulk", packetSize: 512 },
    ],
  };
  return { device, candidate, stats };
}

async function upload(usbmux, peer, total) {
  const session = await usbmux.createSession(peer.device, peer.candidate);
  const stream = await usbmux.openStream(session, 62078);
  const data = Uint8Array.from({ length: total }, (_, i) => i % 251);
  try {
    for (let o = 0; o < total; o += CHUNK) await usbmux.sendStreamData(stream, data.subarray(o, o + CHUNK));
  } finally {
    usbmux.closeSession(session);
  }
  return data;
}

test("patch anchors match the installed @limrun/device-install exactly once", async () => {
  const code = await readFile(chunkPath, "utf8");
  assert.doesNotThrow(() => plugin.transform(code, chunkPath));
  assert.equal(plugin.transform(code, `${sdkDir}/react.js`), null);
});

test("unpatched SDK overruns the device receive window (explicit fake usbmux peer)", async () => {
  const peer = fakeUsbmuxPeer({ rawWindow: 0x80 }); // 32 KiB
  await upload(await loadUsbmux(false), peer, 300_000);
  assert.ok(peer.stats.violations > 0, "original SDK should exceed the window; otherwise this test proves nothing");
});

for (const rawWindow of [0x200, 0x80, 0x10]) {
  test(`patched SDK stays within a ${rawWindow << 8}-byte window and delivers every byte in order`, async () => {
    const peer = fakeUsbmuxPeer({ rawWindow });
    const sent = await upload(await loadUsbmux(true), peer, 300_000);
    assert.equal(peer.stats.violations, 0);
    assert.ok(peer.stats.maxInflight <= rawWindow << 8);
    assert.deepEqual(Buffer.concat(peer.stats.received), Buffer.from(sent));
  });
}

test("patched SDK fails the pending send instead of hanging when the device resets the stream", async () => {
  const peer = fakeUsbmuxPeer({ rawWindow: 0x80, resetAfterBytes: 20_000 });
  const usbmux = await loadUsbmux(true);
  const result = await Promise.race([
    upload(usbmux, peer, 300_000).then(
      () => "completed",
      (error) => error.message,
    ),
    new Promise((r) => setTimeout(() => r("hung"), 3000).unref()),
  ]);
  assert.match(result, /reset stream/);
});
