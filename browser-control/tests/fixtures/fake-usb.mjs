// Fake physical peer: only USB claim, usbmux version handshake and resume pairing.
// It deliberately does NOT simulate a real iPhone, Lockdown/signing or WDA.
export function fakeUSB(allFail = false, fragmentVersion = false) {
  const claims = [],
    writes = [];
  let rejectRead;
  let readCount = 0;
  const versionReply = new Uint8Array(20);
  const versionView = new DataView(versionReply.buffer);
  versionView.setUint32(4, 20);
  versionView.setUint32(8, 2);
  const versionReads = fragmentVersion
    ? [versionReply.slice(0, 3), versionReply.slice(3, 11), versionReply.slice(11)]
    : [versionReply];
  const configurations = [6, 3].map((configurationValue) => ({
    configurationValue,
    interfaces: [
      {
        interfaceNumber: 1,
        alternates: [
          {
            alternateSetting: 0,
            interfaceClass: 255,
            interfaceSubclass: 254,
            interfaceProtocol: 2,
            endpoints: [
              {
                endpointNumber: 1,
                direction: "out",
                type: "bulk",
                packetSize: 512,
              },
              {
                endpointNumber: 2,
                direction: "in",
                type: "bulk",
                packetSize: 512,
              },
            ],
          },
        ],
      },
    ],
  }));
  const device = {
    serialNumber: "00008140001234567890abcd",
    vendorId: 1452,
    productId: 4776,
    productName: "Explicit fake USB peer",
    configurations,
    configuration: configurations[0],
    opened: false,
    open: async () => {
      device.opened = true;
    },
    close: async () => {
      device.opened = false;
      rejectRead?.(new Error("fake USB closed"));
    },
    selectConfiguration: async (n) => {
      device.configuration = configurations.find(
        (c) => c.configurationValue === n,
      );
    },
    claimInterface: async (n) => {
      claims.push([device.configuration.configurationValue, n]);
      if (allFail || device.configuration.configurationValue === 6)
        throw new Error("Unable to claim interface");
    },
    releaseInterface: async () => {},
    selectAlternateInterface: async () => {},
    transferOut: async (endpoint, data) => {
      writes.push(new Uint8Array(data));
      return { status: "ok", bytesWritten: data.byteLength };
    },
    transferIn: async () => {
      if (readCount < versionReads.length) {
        const bytes = versionReads[readCount++];
        return { status: "ok", data: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength) };
      }
      return new Promise((resolve, reject) => {
        rejectRead = reject;
      });
    },
  };
  return {
    device,
    claims,
    writes,
    failRead: () => rejectRead?.(new Error("fake physical unplug")),
  };
}
