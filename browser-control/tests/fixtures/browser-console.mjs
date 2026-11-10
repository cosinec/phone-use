import init, { mount } from "/pkg/ictl_web.js";
await init();
const UID = "00008140-001234567890ABCD";
const canvas = document.createElement("canvas");
canvas.width = 100;
canvas.height = 200;
canvas.getContext("2d").fillRect(0, 0, 100, 200);
const fixture = (window.fixture = {
  calls: [],
  ai: {
    aiReady: true,
    model: "fixture/default",
    models: ["fixture/default", "fixture/other"],
  },
  state: {
    id: "session",
    deviceId: UID,
    state: "connected",
    ready: true,
    daemon: { state: { state: "ready" } },
    setup: {
      state: "complete",
      transcript: "Fixture setup output",
      exitCode: 0,
    },
    task: null,
  },
  image: {
    deviceId: UID,
    imageBase64: canvas.toDataURL("image/jpeg").split(",")[1],
    caption: "Explicit fixture",
    timings: { screenshotMs: 123 },
    elementsError: "Fixture tree unavailable",
  },
});
let releaseConfirm, releasePair;
fixture.releaseConfirm = () => releaseConfirm?.();
fixture.releasePair = () => releasePair?.();
const sdk = {
  requestUSBAccess() {
    fixture.calls.push({
      choose: true,
      active: navigator.userActivation.isActive,
    });
    return Promise.resolve({
      hello: {
        serialNumber: UID,
        vendorId: 1452,
        productId: 4776,
        productName: "Explicit browser fixture",
      },
      device: {},
    });
  },
  getPairRecord: async () => undefined,
  putPairRecord: async () => {},
  async pairDevice() {
    fixture.pairStarted = true;
    if (fixture.holdPair)
      await new Promise((resolve) => (releasePair = resolve));
    return { relay: { close() {} } };
  },
  closeDeviceRelayTarget: async () => {},
};
const fetchImpl = async (url, options = {}) => {
  const body = options.body ? JSON.parse(options.body) : null;
  fixture.calls.push({ url, method: options.method, body });
  const reply = (data) =>
    new Response(JSON.stringify(data), {
      headers: { "Content-Type": "application/json" },
    });
  if (url.endsWith("/api/config")) return reply(fixture.ai);
  if (url.endsWith("/api/sessions") && options.method === "POST") {
    fixture.state.platform = body.device.platform || "ios";
    fixture.state.deviceId = body.device.serialNumber;
    fixture.image.deviceId = body.device.serialNumber;
    return reply({
      id: "session",
      deviceId: body.device.serialNumber,
      token: "explicit-fixture-token",
    });
  }
  if (url.endsWith("/preview")) {
    fixture.frames = (fixture.frames || 0) + 1;
    canvas.getContext("2d").fillStyle = fixture.frames % 2 ? "#234" : "#567";
    canvas.getContext("2d").fillRect(0, 0, 100, 200);
    fixture.image.imageBase64 = canvas.toDataURL("image/jpeg").split(",")[1];
    return reply(fixture.image);
  }
  if (url.endsWith("/command")) return reply({ kind: "text", text: "{}" });
  if (url.endsWith("/setup/input")) return reply({});
  if (url.endsWith("/setup")) {
    fixture.state.setup.state = "running";
    return reply(fixture.state.setup);
  }
  if (url.endsWith("/tasks")) {
    fixture.state.task = {
      id: "task",
      instruction: body.instruction,
      model: body.model,
      state: "awaiting_confirmation",
      steps: [
        {
          id: "step",
          tool: "iphone_type_text",
          reason: "Explicit fixture confirmation",
          state: "awaiting_confirmation",
        },
      ],
      timings: { observationMs: 100, modelMs: 200, actionMs: 300 },
      confirmation: {
        actionId: "action",
        tool: "iphone_type_text",
        args: { text: "消息", submit: true },
        reason: "发送前确认",
      },
    };
    return reply(fixture.state.task);
  }
  if (url.endsWith("/confirm")) {
    if (fixture.holdConfirm)
      await new Promise((resolve) => (releaseConfirm = resolve));
    return reply(fixture.state.task);
  }
  if (url.endsWith("/stop")) {
    fixture.state.task = {
      ...fixture.state.task,
      state: "stopped",
      confirmation: null,
    };
    return reply(fixture.state.task);
  }
  if (options.method === "DELETE") return reply({});
  return reply(fixture.state);
};
mount({
  sdk,
  androidSdk: {
    ...sdk,
    requestUSBAccess() {
      fixture.calls.push({
        choose: true,
        active: navigator.userActivation.isActive,
      });
      return Promise.resolve({
        hello: {
          serialNumber: "fixture-android",
          vendorId: 1256,
          productId: 1,
          productName: "Explicit Android fixture",
        },
        device: {},
      });
    },
  },
  fetchImpl,
});
