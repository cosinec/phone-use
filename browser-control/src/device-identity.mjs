// usbmuxd inserts a hyphen in modern 24-hex USB serials before exposing the UDID.
export function canonicalUID(value) {
  if (typeof value !== 'string') throw new Error('Invalid device UID');
  if (/^[a-fA-F0-9]{40}$/.test(value)) return value.toLowerCase();
  if (/^[a-fA-F0-9]{24}$/.test(value)) return `${value.slice(0, 8)}-${value.slice(8)}`.toUpperCase();
  if (/^[a-fA-F0-9]{8}-[a-fA-F0-9]{16}$/.test(value)) return value.toUpperCase();
  throw new Error('Invalid device UID');
}
