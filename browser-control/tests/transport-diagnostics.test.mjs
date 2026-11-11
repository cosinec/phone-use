import test from 'node:test';
import assert from 'node:assert/strict';

test('an ignored forwarding-proxy assignment is undone before diagnostics can poison physical reads', async t => {
  const {attachTransportDiagnostics} = await import('../web/transport-diagnostics.mjs');
  const {completeUsbPacketReads} = await import('../web/usb-packets.mjs');
  let tick;
  t.mock.method(globalThis, 'setInterval', callback => { tick = callback; return 1; });
  t.mock.method(globalThis, 'clearInterval', () => {});
  const bytes = new Uint8Array(24);
  new DataView(bytes.buffer).setUint32(4, bytes.length);
  let reads = 0;
  const device = {async transferIn() {
    reads++;
    return {status: 'ok', data: new DataView(bytes.buffer)};
  }};
  const nativeRead = device.transferIn;
  const proxy = completeUsbPacketReads(device);
  const samples = [];
  const stop = attachTransportDiagnostics({device: proxy}, {streams: new Map()}, async sample => samples.push(sample));
  t.after(stop);
  assert.equal(device.transferIn, nativeRead, 'ignored proxy writes must be restored immediately');
  const packet = await proxy.transferIn(2, 16384);
  assert.equal(packet.data.byteLength, 24);
  assert.equal(reads, 1);
  await tick();
  assert.equal(samples[0].usbReadHooked, 0, 'a rejected hook must not claim to be active');
});

test('transport diagnostics preserve USB results and persist bounded numeric metrics', async t => {
  const {attachTransportDiagnostics} = await import('../web/transport-diagnostics.mjs').catch(() => ({}));
  assert.equal(typeof attachTransportDiagnostics, 'function');
  let tick;
  const intervals = [];
  t.mock.method(globalThis, 'setInterval', callback => { tick = callback; return 42; });
  t.mock.method(globalThis, 'clearInterval', id => intervals.push(id));
  const incoming = {data: new DataView(new Uint8Array(128).buffer), status: 'ok'};
  const failure = new Error('PRIVATE_USB_ERROR');
  const device = {
    transferIn: async () => incoming,
    transferOut: async () => { throw failure; },
  };
  const read = device.transferIn, write = device.transferOut;
  const socket = {bufferedAmount: 1024, send(bytes) { this.bufferedAmount += bytes.byteLength; }};
  const send = socket.send;
  const stream = {dport: 9100, queue: [new Uint8Array(50)], queuedWriteBytes: 100, peerWindow: 4096};
  const samples = [];
  const stop = attachTransportDiagnostics({device, session: {pendingMuxWrites: 2}}, {socket, streams: new Map([[7,stream]])}, async value => { samples.push(value); });
  assert.equal(await device.transferIn(1, 128), incoming);
  await assert.rejects(device.transferOut(2, new Uint8Array(64)), error => error === failure);
  socket.send(new Uint8Array(256));
  await tick();
  await Promise.resolve();
  const sample = samples.find(value => value.event === 'sample');
  assert.equal(sample.wsBufferedBytes, 1280);
  assert.equal(sample.wsSentBytes, 256);
  assert.equal(sample.usbReadBytes, 128);
  assert.equal(sample.usbWriteErrors, 1);
  assert.equal(sample.pendingMuxWrites, 2);
  assert.equal(sample.streams[0].readQueuedBytes, 50);
  assert.equal(sample.streams[0].port, 9100);
  assert.ok(!JSON.stringify(samples).includes('PRIVATE'));
  stop();
  stop();
  assert.equal(device.transferIn, read);
  assert.equal(device.transferOut, write);
  assert.equal(socket.send, send);
  assert.deepEqual(intervals, [42]);
});

test('diagnostic uploads allow one pending request and abort on cleanup', async t => {
  const {attachTransportDiagnostics} = await import('../web/transport-diagnostics.mjs').catch(() => ({}));
  assert.equal(typeof attachTransportDiagnostics, 'function');
  let tick;
  t.mock.method(globalThis, 'setInterval', callback => { tick = callback; return 1; });
  t.mock.method(globalThis, 'clearInterval', () => {});
  let calls = 0, signal;
  const stop = attachTransportDiagnostics({device: {}, session: {}}, {socket: {}, streams: new Map()}, (_, abort) => {
    calls++;
    signal = abort;
    return new Promise((resolve, reject) => abort.addEventListener('abort', () => reject(new Error('aborted')), {once:true}));
  });
  tick(); tick(); tick();
  assert.equal(calls, 1);
  stop();
  assert.equal(signal.aborted, true);
  await new Promise(resolve => setImmediate(resolve));
});

test('samples distinguish exhausted credit from USB backpressure and track recovery across sequence wrap', async t => {
  const {attachTransportDiagnostics} = await import('../web/transport-diagnostics.mjs');
  let tick, now = 100;
  t.mock.method(globalThis, 'setInterval', callback => { tick = callback; return 1; });
  t.mock.method(globalThis, 'clearInterval', () => {});
  t.mock.method(performance, 'now', () => now);
  const stream = {
    dport: 8100, seq: 32, peerAck: 0xfffffff0, peerWindow: 48,
    queuedWriteBytes: 128, queue: [], writeWaiters: [() => {}], ackWriting: true,
  };
  const samples = [];
  const stop = attachTransportDiagnostics(
    {device: {}, session: {closed: false}},
    {socket: {readyState: 1}, streams: new Map([[7, stream]])},
    async metrics => samples.push(metrics),
  );
  t.after(stop);
  await tick();
  now += 1500;
  await tick();
  const blocked = samples.at(-1).streams[0];
  assert.equal(blocked.inFlightBytes, 48);
  assert.equal(blocked.availableWindowBytes, 0);
  assert.equal(blocked.windowBlocked, 1);
  assert.equal(blocked.windowBlockedMs, 1500);
  assert.equal(blocked.peerAckUnchangedMs, 1500);
  assert.equal(blocked.writeWaiters, 1);
  assert.equal(blocked.ackPending, 1);
  assert.equal(samples.at(-1).wsReadyState, 1);
  stream.peerAck = 32;
  stream.writeWaiters = [];
  now += 1000;
  await tick();
  const recovered = samples.at(-1).streams[0];
  assert.equal(recovered.inFlightBytes, 0);
  assert.equal(recovered.availableWindowBytes, 48);
  assert.equal(recovered.windowBlocked, 0);
  assert.equal(recovered.windowBlockedMs, 0);
  assert.equal(recovered.peerAckUnchangedMs, 0);
  // Outstanding app data with available credit points to another stage, such as
  // a pending physical USB write; it must not be labelled a window stall.
  assert.equal(recovered.writeQueuedBytes, 128);
  stream.queuedWriteBytes = 0;
  await tick();
  now += 10000;
  stream.queuedWriteBytes = 128;
  await tick();
  assert.equal(samples.at(-1).streams[0].peerAckUnchangedMs, 0, 'idle time must not be counted as an ACK stall');
});
