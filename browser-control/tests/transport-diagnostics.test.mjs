import test from 'node:test';
import assert from 'node:assert/strict';

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
