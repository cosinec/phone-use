import test from 'node:test';
import assert from 'node:assert/strict';
import { completeUsbPacketReads } from '../web/usb-packets.mjs';

function packet(size, fill = 7) {
  const bytes = new Uint8Array(size).fill(fill);
  new DataView(bytes.buffer).setUint32(4, size);
  return bytes;
}
function fakeDevice(reads) {
  const calls = [];
  const device = {
    get opened() { assert.equal(this, device); return true; },
    async transferIn(endpoint, length) {
      assert.equal(this, device);
      calls.push([endpoint, length]);
      const value = reads.shift();
      if (value instanceof Error) throw value;
      if (value?.status) return value;
      assert.ok(value, 'unexpected physical USB read');
      return { status: 'ok', data: new DataView(value.buffer, value.byteOffset, value.byteLength) };
    },
    async close() { assert.equal(this, device); calls.push(['close']); },
  };
  return { device, calls };
}

test('split USB headers and payloads become complete packets, preserving the requested physical read size', async () => {
  const bytes = packet(65536);
  const { device, calls } = fakeDevice([
    bytes.slice(0, 3), bytes.slice(3, 9), bytes.slice(9, 16384),
    bytes.slice(16384, 32768), bytes.slice(32768, 49152), bytes.slice(49152),
  ]);
  const wrapped = completeUsbPacketReads(device);
  const result = await wrapped.transferIn(2, 16384);
  assert.deepEqual(new Uint8Array(result.data.buffer), bytes);
  assert.ok(calls.every(call => call[0] === 2 && call[1] === 16384));
  assert.equal(wrapped.opened, true);
  await wrapped.close();
  assert.deepEqual(calls.at(-1), ['close']);
});

test('coalesced USB packets and offset DataViews retain the next packet without another physical read', async () => {
  const first = packet(20), second = packet(28, 9);
  const backing = new Uint8Array(first.length + second.length + 6);
  backing.set(first, 3); backing.set(second, 3 + first.length);
  const { device, calls } = fakeDevice([backing.subarray(3, backing.length - 3)]);
  const wrapped = completeUsbPacketReads(device);
  assert.deepEqual(new Uint8Array((await wrapped.transferIn(2, 16384)).data.buffer), first);
  assert.deepEqual(new Uint8Array((await wrapped.transferIn(2, 16384)).data.buffer), second);
  assert.equal(calls.length, 1);
});

test('packet buffers are isolated between USB endpoints', async () => {
  const first = packet(20), second = packet(28), other = packet(24);
  const { device } = fakeDevice([Buffer.concat([first, second]), other]);
  const wrapped = completeUsbPacketReads(device);
  assert.equal((await wrapped.transferIn(2, 16384)).data.byteLength, first.length);
  assert.equal((await wrapped.transferIn(3, 16384)).data.byteLength, other.length);
  assert.equal((await wrapped.transferIn(2, 16384)).data.byteLength, second.length);
});

test('empty USB transfers are skipped and native failures propagate', async () => {
  const { device } = fakeDevice([new Uint8Array(), packet(20), { status: 'stall' }, new Error('device disconnected')]);
  const wrapped = completeUsbPacketReads(device);
  assert.equal((await wrapped.transferIn(2, 16384)).data.byteLength, 20);
  assert.equal((await wrapped.transferIn(2, 16384)).status, 'stall');
  await assert.rejects(wrapped.transferIn(2, 16384), /device disconnected/);
});

for (const size of [0, 7, 65537]) {
  test(`invalid usbmux packet size ${size} is rejected before unbounded buffering`, async () => {
    const invalid = new Uint8Array(8);
    new DataView(invalid.buffer).setUint32(4, size);
    const { device } = fakeDevice([invalid]);
    await assert.rejects(completeUsbPacketReads(device).transferIn(2, 16384), /Invalid usbmux packet length/);
  });
}
