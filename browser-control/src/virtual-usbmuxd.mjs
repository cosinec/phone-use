import net from 'node:net';
import { randomUUID } from 'node:crypto';
import * as plist from 'plist';
import { canonicalUID } from './device-identity.mjs';

const MAX_PACKET = 1024 * 1024;
function packet(value, tag) {
  const body = Buffer.from(plist.build(value));
  const header = Buffer.alloc(16);
  [16 + body.length, 1, 8, tag].forEach((n, i) => header.writeUInt32LE(n, i * 4));
  return Buffer.concat([header, body]);
}

export function readPairRecord(record, udid) {
  if (!record || canonicalUID(record.udid) !== canonicalUID(udid) || typeof record.pairRecordBase64 !== 'string'
      || record.pairRecordBase64.length > MAX_PACKET || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(record.pairRecordBase64)) {
    throw new Error('Invalid pair record');
  }
  const bytes = Buffer.from(record.pairRecordBase64, 'base64');
  if (!bytes.length) throw new Error('Empty pair record');
  const value = plist.parse(bytes.toString('utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.SystemBUID !== 'string' || !value.SystemBUID.length) {
    throw new Error('Pair record needs SystemBUID');
  }
  return { bytes, buid: value.SystemBUID };
}

// openStream(port) resolves a Duplex whose readable side is device -> native.
export async function createVirtualMux({ device, openStream, onPairRecord = () => {}, pairRecord, timeoutMs = 30_000 }) {
  device = { ...device, serialNumber: canonicalUID(device.serialNumber) };
  let stored = pairRecord ? readPairRecord(pairRecord, device.serialNumber) : undefined;
  let buid = stored?.buid ?? randomUUID();
  const sockets = new Set();
  const attached = { MessageType: 'Attached', DeviceID: 1, Properties: {
    DeviceID: 1, SerialNumber: device.serialNumber, ProductID: device.productId,
    ConnectionType: 'USB', LocationID: 1,
  } };
  const server = net.createServer(socket => {
    if (sockets.size >= 64) { socket.destroy(); return; }
    sockets.add(socket);
    let buffer = Buffer.alloc(0);
    let mode = 'plist';
    let busy = false;
    let relay;
    socket.setTimeout(timeoutMs, () => { if (mode !== 'raw') socket.destroy(); });
    socket.on('error', () => socket.destroy());
    socket.on('close', () => { sockets.delete(socket); relay?.destroy(); });
    const send = (value, tag) => socket.write(packet(value, tag));
    const result = (number, tag) => send({ MessageType: 'Result', Number: number }, tag);
    const recordMatches = value => { try { return canonicalUID(value) === device.serialNumber; } catch { return false; } };
    async function handle(value, tag) {
      switch (value.MessageType) {
        case 'ListDevices': send({ DeviceList: [attached] }, tag); break;
        case 'Listen': result(0, tag); send(attached, tag); break;
        case 'ReadBUID': send({ BUID: buid }, tag); break;
        case 'ReadPairRecord':
          if (!recordMatches(value.PairRecordID) || !stored) result(2, tag);
          else send({ PairRecordData: stored.bytes }, tag);
          break;
        case 'SavePairRecord': {
          if (!recordMatches(value.PairRecordID) || !(value.PairRecordData instanceof Uint8Array)) { result(2, tag); break; }
          const record = { udid: device.serialNumber, pairRecordBase64: Buffer.from(value.PairRecordData).toString('base64') };
          try { stored = readPairRecord(record, device.serialNumber); } catch { result(1, tag); break; }
          buid = stored.buid;
          result(0, tag);
          onPairRecord(record);
          break;
        }
        case 'Connect': {
          if (value.DeviceID !== 1) { result(2, tag); break; }
          const encoded = value.PortNumber;
          if (!Number.isInteger(encoded) || encoded < 1 || encoded > 65535) { result(1, tag); break; }
          mode = 'opening';
          try {
            relay = await openStream(((encoded & 255) << 8) | (encoded >>> 8));
            if (socket.destroyed) { relay.destroy(); return; }
            relay.on('error', () => socket.destroy());
            relay.on('close', () => socket.destroy());
            result(0, tag);
            mode = 'raw';
            socket.setTimeout(0);
            relay.pipe(socket);
            if (buffer.length) relay.write(buffer);
            buffer = Buffer.alloc(0);
            socket.pipe(relay);
          } catch { mode = 'plist'; result(3, tag); }
          break;
        }
        default: result(1, tag);
      }
    }
    async function drain() {
      if (busy || mode === 'raw') return;
      busy = true;
      try {
        while (mode === 'plist' && buffer.length >= 16) {
          const size = buffer.readUInt32LE(0);
          if (size < 16 || size > MAX_PACKET || buffer.readUInt32LE(4) !== 1 || buffer.readUInt32LE(8) !== 8) throw new Error('Invalid usbmuxd frame');
          if (buffer.length < size) break;
          const tag = buffer.readUInt32LE(12);
          const value = plist.parse(buffer.subarray(16, size).toString('utf8'));
          buffer = buffer.subarray(size);
          await handle(value, tag);
        }
      } catch { socket.destroy(); }
      finally { busy = false; }
    }
    socket.on('data', chunk => {
      if (mode === 'raw') return;
      if (buffer.length + chunk.length > MAX_PACKET) { socket.destroy(); return; }
      buffer = Buffer.concat([buffer, chunk]);
      void drain();
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  let closing;
  return {
    address: `127.0.0.1:${port}`, port,
    get pairRecord() { return stored ? { udid: device.serialNumber, pairRecordBase64: stored.bytes.toString('base64') } : undefined; },
    close() {
      closing ??= new Promise(resolve => { for (const socket of sockets) socket.destroy(); server.close(resolve); });
      return closing;
    },
  };
}
