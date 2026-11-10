import { AdbScrcpyOptions3_3_3 } from "@yume-chan/adb-scrcpy";
import { ScrcpyOptions3_3_3 } from "@yume-chan/scrcpy";

export function createAndroidScrcpyOptions({ video = false } = {}) {
  const options = new AdbScrcpyOptions3_3_3({
    video,
    videoCodec: "h264",
    maxSize: 1280,
    maxFps: 10,
    videoBitRate: 2_000_000,
    scid: Math.floor(Math.random() * 0x7fffffff).toString(16),
    audio: false,
    control: true,
    tunnelForward: true,
    clipboardAutosync: false,
    // Without video, the SDK does not consume the device-name header.
    sendDeviceMeta: false,
    powerOn: false,
    cleanup: true,
  });
  // SDK 2.3.0 only initializes its clipboard ACK handler when autosync is true.
  // Reuse that protocol handler while keeping clipboard subscription disabled
  // in the actual server options and device-message parser. Never sync device
  // clipboard changes just to make explicit paste commands work.
  const clipboardProtocol = new ScrcpyOptions3_3_3({
    video: false, audio: false, control: true, clipboardAutosync: true,
  });
  const ack = clipboardProtocol.deviceMessageParsers.parsers.find(parser => parser.id === 1);
  if (!ack) throw new Error("Android clipboard acknowledgement protocol unavailable");
  // The SDK's close/error loops also assume parser IDs form a dense array.
  // Reserve ID 0 without accepting clipboard-change data or creating a stream.
  options.deviceMessageParsers.add({
    id: 0,
    async parse() { throw new Error("Unsolicited Android clipboard data rejected"); },
    close() {},
    error() {},
  });
  options.deviceMessageParsers.add(ack);
  options.serializeSetClipboardControlMessage = message => clipboardProtocol.serializeSetClipboardControlMessage(message);
  return options;
}
