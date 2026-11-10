// Compatibility patch for the browser ESM entry of @limrun/device-install 0.1.0.
// Keep the upstream package pinned; fail closed if its implementation changes.
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
const marker = "// phone-use: device-install stream lifecycle v1";
const replacements = [
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

const helpers = `
${marker}
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

function digest(text) {
  return createHash("sha256").update(text).digest("hex");
}
// Reverse our exact edits to authenticate both fresh and previously patched files.
if (source.includes(marker)) {
  if (!source.endsWith(helpers))
    throw new Error("Unexpected device-install patch contents");
  source = source.slice(0, -helpers.length);
  for (const [before, after] of [...replacements].reverse()) {
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
