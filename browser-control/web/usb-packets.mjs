// SDK 0.1.0 expects one complete usbmux packet per read. USB transfers may split
// a packet or contain several packets. Keep its protocol and device APIs intact
// while supplying complete packets, bounded by usbmuxd's 65536-byte DEV_MRU.
const MAX_PACKET = 65536;

export function completeUsbPacketReads(device) {
  const endpoints = new Map();
  async function transferIn(endpoint, length) {
    let buffered = endpoints.get(endpoint) ?? new Uint8Array();
    while (true) {
      if (buffered.length >= 8) {
        const size = new DataView(buffered.buffer, buffered.byteOffset, buffered.byteLength).getUint32(4);
        if (size < 8 || size > MAX_PACKET) throw new Error('Invalid usbmux packet length');
        if (buffered.length >= size) {
          const packet = buffered.slice(0, size);
          endpoints.set(endpoint, buffered.slice(size));
          return { status: 'ok', data: new DataView(packet.buffer) };
        }
      }
      const result = await device.transferIn(endpoint, length);
      if (result.status !== 'ok' || !result.data) return result;
      const bytes = new Uint8Array(result.data.buffer, result.data.byteOffset, result.data.byteLength);
      if (buffered.length + bytes.length > 2 * MAX_PACKET) throw new Error('USB receive buffer exceeded');
      const combined = new Uint8Array(buffered.length + bytes.length);
      combined.set(buffered);
      combined.set(bytes, buffered.length);
      buffered = combined;
    }
  }
  return new Proxy(device, {
    get(target, property) {
      if (property === 'transferIn') return transferIn;
      // WebUSB getters and native methods require the real USBDevice receiver.
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
