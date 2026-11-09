import test from "node:test";
import assert from "node:assert/strict";
import { BrowserClient } from "../web/client.mjs";
const mod = await import("../web/task-actions.mjs").catch(() => ({}));
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};
const task = (state) => ({
  id: "task",
  instruction: "fixture",
  state,
  steps: [],
  confirmation: { actionId: "action" },
});
for (const heldRoute of ["confirm", "status"])
  test(`independent Stop dispatches immediately behind held ${heldRoute} response and deduplicates pending stop`, async () => {
    assert.equal(
      typeof mod.createTaskActions,
      "function",
      "UI task action coordinator must exist",
    );
    const held = deferred(),
      stopReply = deferred(),
      calls = [];
    let busy = false;
    let stopKey = null;
    let holding = true;
    let stopped = false;
    const client = new BrowserClient({
      sdk: {
        requestUSBAccess: async () => ({
          hello: {
            serialNumber: "00008140001234567890ABCD",
            vendorId: 1452,
            productId: 1,
          },
        }),
        getPairRecord: async () => undefined,
        pairDevice: async () => ({
          relay: { close() {} },
          pairRecord: {
            udid: "00008140-001234567890ABCD",
            pairRecordBase64: "fake",
          },
        }),
        putPairRecord: async () => {},
        closeDeviceRelayTarget: async () => {},
      },
      fetchImpl: async (url, options) => {
        calls.push([url, options.method]);
        if (url === "http://cloud/api/sessions")
          return {
            ok: true,
            json: async () => ({
              id: "session",
              deviceId: "00008140-001234567890ABCD",
              token: "fixture",
            }),
          };
        if (url.endsWith("/stop")) {
          stopped = true;
          return stopReply.promise;
        }
        if (
          holding &&
          ((heldRoute === "confirm" && url.endsWith("/confirm")) ||
            (heldRoute === "status" && options.method === "GET"))
        )
          return held.promise;
        return {
          ok: true,
          json: async () =>
            options.method === "GET"
              ? { id: "session", task: task(stopped ? "stopped" : "executing") }
              : { ...task("executing") },
        };
      },
    });
    await client
      .connect({ apiBase: "http://cloud", accessToken: "fixture" })
      .catch((e) => {
        throw e;
      });
    client.update({
      session: {
        ...client.snapshot().session,
        task: task("awaiting_confirmation"),
      },
    });
    const actions = mod.createTaskActions(client, {
      onBusy: (value) => (busy = value),
      onError: () => {},
      onStopBusy: (value) => {
        stopKey = value;
      },
    });
    const confirmation = actions.run(() =>
      client.confirmTask("task", "action", true),
    );
    await new Promise((r) => setImmediate(r));
    assert.equal(busy, true);
    const stop = actions.stop("session", "task");
    const duplicate = actions.stop("session", "task");
    assert.equal(
      stopKey,
      "session/task",
      "Stop pending state is scoped to this session/task",
    );
    assert.equal(
      calls.filter((c) => c[0].endsWith("/stop")).length,
      1,
      "Stop dispatches before held confirmation/status resolves",
    );
    stopReply.resolve({ ok: true, json: async () => task("stopped") });
    await Promise.all([stop, duplicate]);
    assert.equal(client.snapshot().session.task.state, "stopped");
    holding = false;
    held.resolve({
      ok: true,
      json: async () =>
        heldRoute === "status"
          ? { id: "session", task: task("executing") }
          : task("executing"),
    });
    await confirmation;
    assert.equal(client.snapshot().session.task.state, "stopped");
    client.update({
      session: {
        ...client.snapshot().session,
        task: { ...task("thinking"), id: "new-task" },
      },
    });
    await actions.stop("session", "task");
    assert.equal(
      calls.filter((c) => c[0].endsWith("/stop")).length,
      1,
      "stale task ID never dispatches",
    );
    await client.disconnect();
  });
