import { Adb, AdbDaemonTransport } from "@yume-chan/adb";
import AdbWebCredentialStore from "@yume-chan/adb-credential-web";
import { AdbScrcpyClient } from "@yume-chan/adb-scrcpy";
import { ReadableStream } from "@yume-chan/stream-extra";
import { AndroidCommands, inputViewport } from "./core.mjs";
import { AndroidVideoCapture } from "./video.mjs";
import { createAndroidScrcpyOptions } from "./options.mjs";
import { AndroidRelay, encodeFrame } from "./relay.mjs";

const SERVER_HASH = "7e70323ba7f259649dd4acce97ac4fefbae8102b2c6d91e2e7be613fd5354be0";
const SERVER_PATH = "/data/local/tmp/ictl-scrcpy-3.3.3.jar";
const decoder = new TextDecoder();
export async function readBytes(stream, max) {
  const reader = stream.getReader(); const chunks = []; let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > max) { await reader.cancel(); throw new Error("Android response too large"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const data = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length; }
  return data;
}
export async function runShell(adb, command, signal, timeout = 5000, binary = false) {
  signal.throwIfAborted();
  if (!adb.subprocess.shellProtocol) throw new Error("Android 8 or newer with shell v2 is required");
  const abort = new AbortController();
  const cancel = () => abort.abort(signal.reason);
  signal.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => abort.abort(new Error("Android shell timed out; sent actions are not retried")), timeout);
  let process;
  try {
    process = await adb.subprocess.shellProtocol.spawn(command, abort.signal);
    if (abort.signal.aborted) { await process.kill(); abort.signal.throwIfAborted(); }
    const [stdout, stderr, code] = await Promise.all([
      readBytes(process.stdout, binary ? 32 * 1024 * 1024 : 2 * 1024 * 1024), readBytes(process.stderr, 16384), process.exited,
    ]);
    abort.signal.throwIfAborted();
    if (code !== 0) throw new Error(`Android shell failed (${code}): ${decoder.decode(stderr).slice(0, 500)}`);
    return binary ? stdout : decoder.decode(stdout);
  } finally {
    clearTimeout(timer); signal.removeEventListener("abort", cancel);
    // Closing shell-v2's socket also terminates the associated process.
    if (process) await process.kill();
  }
}
async function capture(adb, signal, region, previous, video) {
  let bitmap, viewport, sourceBytes, sourceFormat;
  if (video && !video.closed && !video.mailbox.error) {
    try { ({ bitmap, viewport, sourceBytes, sourceFormat } = await video.snapshot(signal)); }
    catch { signal.throwIfAborted(); }
  }
  if (!bitmap) {
    const before = inputViewport(await runShell(adb, "dumpsys input", signal, 3000));
    const bytes = await runShell(adb, "screencap -p", signal, 6000, true);
    const after = inputViewport(await runShell(adb, "dumpsys input", signal, 3000));
    if (before && after && (before.orientation !== after.orientation || before.width !== after.width || before.height !== after.height))
      throw new Error("Android rotated while taking screenshot; refresh and try again");
    bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
    viewport = after?.width === bitmap.width && after?.height === bitmap.height ? after : null;
    sourceBytes = bytes.length; sourceFormat = "png";
  }
  try {
    signal.throwIfAborted();
    const scale = Math.min(1, 1280 / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const orientation = viewport?.orientation ?? null;
    const view = { width, height, nativeWidth: viewport?.width || bitmap.width, nativeHeight: viewport?.height || bitmap.height, orientation };
    let source = [0, 0, bitmap.width, bitmap.height]; let outWidth = width; let outHeight = height;
    let caption = `Android full screen ${width}x${height}. Coordinates use these screenshot pixels (native ${view.nativeWidth}x${view.nativeHeight}).`;
    if (region) {
      if (!previous || previous.nativeWidth !== view.nativeWidth || previous.nativeHeight !== view.nativeHeight || previous.orientation !== orientation)
        throw new Error("Android display changed; take a full screenshot before requesting a region");
      const [x, y, w, h] = region;
      if (![x, y, w, h].every(Number.isFinite) || x < 0 || y < 0 || w <= 0 || h <= 0 || x + w > previous.width || y + h > previous.height)
        throw new Error("Screenshot region outside Android screen");
      source = [x * bitmap.width / previous.width, y * bitmap.height / previous.height, w * bitmap.width / previous.width, h * bitmap.height / previous.height];
      outWidth = Math.round(w); outHeight = Math.round(h);
      if (!outWidth || !outHeight) throw new Error("Screenshot region too small");
      caption = `Android crop at x=${x}, y=${y}, width=${w}, height=${h} in full screenshot ${previous.width}x${previous.height}. Add this origin to crop pixel coordinates.`;
    }
    const canvas = new OffscreenCanvas(outWidth, outHeight);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Screenshot canvas unavailable");
    context.drawImage(bitmap, ...source, 0, 0, outWidth, outHeight);
    let jpeg;
    // Reserve headroom for base64, JSON escaping, UI text and the 1 MiB relay limit.
    for (const quality of [0.78, 0.65, 0.5, 0.35]) {
      jpeg = await canvas.convertToBlob({ type: "image/jpeg", quality });
      if (jpeg.size <= 480 * 1024) break;
    }
    if (jpeg.size > 480 * 1024) throw new Error("Android screenshot exceeds relay limit");
    const data = new Uint8Array(await jpeg.arrayBuffer());
    let binary = "";
    for (let offset = 0; offset < data.length; offset += 8192) binary += String.fromCharCode(...data.subarray(offset, offset + 8192));
    return { imageBase64: btoa(binary), caption, view, sourceBytes, sourceFormat, uploadedBytes: jpeg.size };
  } finally { bitmap.close(); }
}
function ensureOpen(target) { if (target.closed) throw new Error("Android connection cancelled"); }
export async function pairDevice({ registryApiUrl, token, target, log = () => {} }) {
  try {
    ensureOpen(target); log("Claiming usbmux interface");
    const connection = await target.selected.connect();
    ensureOpen(target); log("Claimed usbmux interface");
    log("Android authorization");
    const transport = await AdbDaemonTransport.authenticate({ serial: target.selected.serial, connection, credentialStore: new AdbWebCredentialStore("Phone Control") });
    target.adb = new Adb(transport);
    ensureOpen(target);
    const signal = target.abort.signal;
    const version = await target.adb.getProp("ro.build.version.sdk");
    ensureOpen(target);
    if (Number(version) < 26 || !Number.isFinite(Number(version))) throw new Error("当前 Android 控制需要 Android 8 或更高版本");
    const response = await fetch(new URL("./vendor/scrcpy-server-v3.3.3.bin", import.meta.url), { signal });
    if (!response.ok) throw new Error("无法读取 Android 控制组件");
    const server = new Uint8Array(await response.arrayBuffer());
    const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", server))].map((n) => n.toString(16).padStart(2, "0")).join("");
    if (hash !== SERVER_HASH) throw new Error("Android 控制组件校验失败");
    ensureOpen(target);
    log("Android control startup");
    for (const video of AndroidVideoCapture.isSupported ? [true, false] : [false]) {
      ensureOpen(target);
      const options = createAndroidScrcpyOptions({ video });
      const path = SERVER_PATH.replace(".jar", `-${options.value.scid}.jar`);
      try {
        await AdbScrcpyClient.pushServer(target.adb, new ReadableStream({ start(controller) { controller.enqueue(server); controller.close(); } }), path);
        ensureOpen(target);
        target.scrcpy = await AdbScrcpyClient.start(target.adb, path, options);
        ensureOpen(target);
        if (!target.scrcpy.controller) throw new Error("Android 输入控制通道不可用");
        void target.scrcpy.output.pipeTo(new WritableStream({ write() {} })).catch(() => {});
        if (video) {
          const stream = await target.scrcpy.videoStream;
          target.video = new AndroidVideoCapture({ video: stream, controller: target.scrcpy.controller,
            readViewport: async abort => inputViewport(await runShell(target.adb, "dumpsys input", abort, 3000)), signal });
          await target.video.ready(signal);
          log("Android video ready");
        }
        break;
      } catch (error) {
        target.video?.close(); target.video = null;
        await target.scrcpy?.close(); target.scrcpy = null;
        ensureOpen(target);
        if (!video) throw error;
        console.warn("Android hardware capture fallback:", String(error?.message || "unavailable").slice(0, 240));
        log("Android video fallback");
      }
    }
    const commands = new AndroidCommands({ deviceId: target.hello.serialNumber, shell: (command, abort, timeout) => runShell(target.adb, command, abort, timeout), capture: (abort, region, previous) => capture(target.adb, abort, region, previous, target.video), controller: target.scrcpy.controller });
    const url = new URL("/device/ws", registryApiUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("token", token);
    const socket = new WebSocket(url);
    const relay = new AndroidRelay(socket, target.hello.serialNumber, (request, abort) => commands.execute(request, abort), { log, onClose: () => void closeDeviceRelayTarget(target) });
    target.relay = relay;
    socket.addEventListener("open", () => {
      if (target.closed) { relay.close(); return; }
      socket.send(encodeFrame(1, 0, target.hello)); log("Connected WebSocket relay");
    }, { once: true });
    void target.adb.disconnected.then(() => relay.close(), () => relay.close());
    void target.scrcpy.exited.then(() => relay.close(), () => relay.close());
    await relay.ready;
    ensureOpen(target);
    log("Android ready");
    return { relay };
  } catch (error) {
    await closeDeviceRelayTarget(target);
    throw error;
  }
}
export async function closeDeviceRelayTarget(target) {
  target.closed = true;
  target.abort.abort(); target.relay?.close(); target.video?.close();
  await Promise.allSettled([target.device?.close(), target.adb?.close(), target.scrcpy?.close()]);
}
