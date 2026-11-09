import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { PassThrough } from 'node:stream';
import { once } from 'node:events';
import * as plist from 'plist';
import { createVirtualMux } from './reference/virtual-usbmuxd.mjs';

const device = { serialNumber: '00008110-001234567890001E', vendorId: 1452, productId: 4776 };
function packet(value, tag = 1) {
  const body = Buffer.from(plist.build(value));
  const header = Buffer.alloc(16);
  [body.length + 16, 1, 8, tag].forEach((n, i) => header.writeUInt32LE(n, i * 4));
  return Buffer.concat([header, body]);
}
function reader(socket) {
  let buffer = Buffer.alloc(0);
  const waiting = [];
  const ready = [];
  socket.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 16 && buffer.length >= buffer.readUInt32LE(0)) {
      const size = buffer.readUInt32LE(0);
      const result = { tag: buffer.readUInt32LE(12), value: plist.parse(buffer.subarray(16, size).toString()) };
      buffer = buffer.subarray(size);
      if (waiting.length) waiting.shift()(result); else ready.push(result);
    }
  });
  return () => ready.length ? Promise.resolve(ready.shift()) : new Promise(resolve => waiting.push(resolve));
}
async function connect(mux) {
  const socket = net.connect(mux.port, '127.0.0.1');
  await once(socket, 'connect');
  return socket;
}

test('mux parses fragmented and coalesced little endian plist messages and isolates device IDs', async t => {
  const mux = await createVirtualMux({ device, openStream() { throw new Error('unexpected'); } });
  t.after(() => mux.close());
  const socket = await connect(mux);
  const read = reader(socket);
  const first = packet({ MessageType: 'ListDevices' }, 81);
  socket.write(first.subarray(0, 7));
  socket.write(Buffer.concat([first.subarray(7), packet({ MessageType: 'Listen' }, 82)]));
  assert.equal((await read()).value.DeviceList[0].Properties.SerialNumber, device.serialNumber);
  assert.equal((await read()).tag, 82);
  assert.equal((await read()).value.MessageType, 'Attached');
  socket.write(packet({ MessageType: 'Connect', DeviceID: 2, PortNumber: 32498 }));
  assert.equal((await read()).value.Number, 2);
});

test('Connect converts network-order port and bridges byte-exact raw data after success', async t => {
  let openedPort;
  const relay = new PassThrough();
  const mux = await createVirtualMux({ device, openStream(port) { openedPort = port; return relay; } });
  t.after(() => mux.close());
  const socket = await connect(mux);
  socket.write(packet({ MessageType: 'Connect', DeviceID: 1, PortNumber: 32498 })); // htons(62078)
  const [result] = await once(socket, 'data');
  assert.equal(plist.parse(result.subarray(16).toString()).Number, 0);
  assert.equal(openedPort, 62078);
  const response = once(socket, 'data');
  socket.write(Buffer.from([0, 255, 1, 127]));
  assert.deepEqual((await response)[0], Buffer.from([0, 255, 1, 127]));
  const closed = once(socket, 'close');
  relay.destroy();
  await closed;
});

test('pair records preserve plist bytes, SDK payload and saved/supplied SystemBUID', async t => {
  const raw = Buffer.from(plist.build({ SystemBUID: 'initial-buid', HostID: 'host' }));
  let published;
  const mux = await createVirtualMux({ device, pairRecord: { udid: device.serialNumber, pairRecordBase64: raw.toString('base64') }, openStream() {}, onPairRecord(record) { published = record; } });
  t.after(() => mux.close());
  const socket = await connect(mux);
  const read = reader(socket);
  socket.write(packet({ MessageType: 'ReadBUID' }));
  assert.equal((await read()).value.BUID, 'initial-buid');
  socket.write(packet({ MessageType: 'ReadPairRecord', PairRecordID: device.serialNumber }));
  assert.deepEqual(Buffer.from((await read()).value.PairRecordData), raw);
  const updated = Buffer.from(plist.build({ SystemBUID: 'new-buid', HostID: 'other-host' }));
  socket.write(packet({ MessageType: 'SavePairRecord', PairRecordID: device.serialNumber, PairRecordData: updated }));
  assert.equal((await read()).value.Number, 0);
  assert.deepEqual(published, { udid: device.serialNumber, pairRecordBase64: updated.toString('base64') });
  socket.write(packet({ MessageType: 'ReadBUID' }));
  assert.equal((await read()).value.BUID, 'new-buid');
  socket.write(packet({ MessageType: 'ReadPairRecord', PairRecordID: 'another-device' }));
  assert.equal((await read()).value.Number, 2);
});

test('mux rejects oversized frames and failed opens without leaking sockets', async t => {
  const mux = await createVirtualMux({ device, openStream() { throw new Error('phone refused'); } });
  t.after(() => mux.close());
  const socket = await connect(mux);
  const read = reader(socket);
  socket.write(packet({ MessageType: 'Connect', DeviceID: 1, PortNumber: 32498 }));
  assert.equal((await read()).value.Number, 3);
  const header = Buffer.alloc(16);
  header.writeUInt32LE(1024 * 1024 + 17, 0);
  const closed = once(socket, 'close');
  socket.write(header);
  await closed;
});
