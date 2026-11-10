import { AdbDaemonWebUsbDeviceManager } from "@yume-chan/adb-daemon-webusb";
import { androidUID } from "./core.mjs";
export async function requestUSBAccess({ log = () => {} } = {}) {
  const manager = AdbDaemonWebUsbDeviceManager.BROWSER;
  if (!manager) throw new Error("请在 HTTPS 或 localhost 使用支持 WebUSB 的 Chrome");
  log("Selecting USB device");
  // No await before invoking the chooser: preserve the click's user activation.
  const selected = await manager.requestDevice();
  if (!selected) throw new Error("未选择 Android USB 调试设备");
  const raw = selected.raw;
  const serialNumber = androidUID(selected.serial);
  log("Selected USB device");
  return { selected, device: raw, hello: { platform: "android", serialNumber, vendorId: raw.vendorId, productId: raw.productId, productName: selected.name || "Android" }, closed: false, abort: new AbortController() };
}
export const getPairRecord = async () => undefined;
export const putPairRecord = async () => {};
export async function pairDevice(options) {
  const sdk = await import("./sdk.mjs");
  options.target.sdk = sdk;
  return sdk.pairDevice(options);
}
export async function closeDeviceRelayTarget(target) {
  target.closed = true; target.abort.abort();
  if (target.sdk) await target.sdk.closeDeviceRelayTarget(target);
  else await target.device.close();
}
