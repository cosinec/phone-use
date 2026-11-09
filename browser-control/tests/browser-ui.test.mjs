import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "vite";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
const mod = await import("../web/interaction.mjs").catch(() => ({}));
test("pointer math uses JPEG native point dimensions with object-fit letterboxing and gesture bounds", () => {
  assert.equal(typeof mod.toPhonePoint, "function");
  const rect = { left: 20, top: 10, width: 200, height: 200 };
  assert.deepEqual(mod.toPhonePoint(120, 110, rect, 100, 200), {
    x: 50,
    y: 100,
  });
  assert.equal(mod.toPhonePoint(25, 110, rect, 100, 200), null);
  assert.deepEqual(
    mod.pointerCommand(
      { point: { x: 1, y: 2 }, x: 0, y: 0, time: 0 },
      { point: { x: 1, y: 2 }, x: 1, y: 1, time: 100 },
    ),
    { tool: "iphone_tap", args: { x: 1, y: 2 } },
  );
  assert.equal(
    mod.pointerCommand(
      { point: { x: 1, y: 2 }, x: 0, y: 0, time: 0 },
      { point: { x: 2, y: 3 }, x: 1, y: 1, time: 20000 },
    ).args.seconds,
    10,
  );
  assert.deepEqual(
    mod.pointerCommand(
      { point: { x: 1, y: 2 }, x: 0, y: 0, time: 0 },
      { point: { x: 4, y: 5 }, x: 20, y: 20, time: 300 },
    ),
    {
      tool: "iphone_swipe",
      args: { from_x: 1, from_y: 2, to_x: 4, to_y: 5, seconds: 0.3 },
    },
  );
});
test("UI renders honest empty phone, manual-disabled state and AI unconfigured", async (t) => {
  const server = await createServer({
    optimizeDeps: { noDiscovery: true },
    server: { middlewareMode: true },
    appType: "custom",
  });
  t.after(() => server.close());
  const { PhonePreview } = await server.ssrLoadModule(
    "/web/components/PhonePreview.tsx",
  );
  const { TaskPanel } = await server.ssrLoadModule(
    "/web/components/TaskPanel.tsx",
  );
  const phone = renderToStaticMarkup(
    createElement(PhonePreview, {
      screen: null,
      status: "未连接设备",
      canControl: false,
      busy: false,
      onCommand: () => {},
      onRefresh: () => {},
    }),
  );
  assert.match(phone, /未连接设备/);
  assert.ok(!phone.includes("<img"));
  assert.match(phone, /disabled/);
  const task = renderToStaticMarkup(
    createElement(TaskPanel, {
      ai: { aiReady: false, model: null },
      task: null,
      canRun: false,
      busy: false,
      onStart: () => {},
      onConfirm: () => {},
      onStop: () => {},
    }),
  );
  assert.match(task, /AI 尚未配置/);
  assert.match(task, /disabled/);
});
test("native transport ready alone cannot enable manual control; active AI disables manual controls and keeps stop/confirmation visible", async (t) => {
  const server = await createServer({
    optimizeDeps: { noDiscovery: true },
    server: { middlewareMode: true },
    appType: "custom",
  });
  t.after(() => server.close());
  const { App } = await server.ssrLoadModule("/web/App.tsx");
  const state = {
    phase: "connected",
    device: { productName: "Real session label" },
    error: null,
    session: {
      id: "fixture",
      deviceId: "fixture",
      state: "connected",
      ready: true,
      daemon: { state: { state: "needs_trust" } },
      setup: { state: "idle", transcript: "", exitCode: null },
      task: null,
    },
  };
  const client = { snapshot: () => state, subscribe: () => () => {} };
  let html = renderToStaticMarkup(createElement(App, { client }));
  assert.match(html, /WDA 准备中/);
  assert.match(html, /<button disabled=""[^>]*><span>⌂/);
  state.session.daemon.state.state = "ready";
  html = renderToStaticMarkup(createElement(App, { client }));
  assert.match(html, /可以控制/);
  assert.ok(!html.includes('<button disabled=""><span>⌂'));
  state.session.task = {
    id: "task",
    instruction: "发送前确认",
    state: "awaiting_confirmation",
    steps: [],
    confirmation: {
      actionId: "a",
      tool: "iphone_type_text",
      args: { text: "消息", submit: true },
      reason: "发送消息需要确认",
    },
  };
  html = renderToStaticMarkup(createElement(App, { client }));
  assert.match(html, /<button disabled=""[^>]*><span>⌂/);
  assert.match(html, /停止任务/);
  assert.match(html, /拒绝并停止/);
  assert.match(html, /确认这一步/);
  assert.match(html, /手动操作已暂停/);
});
test("Stop stays enabled during unrelated busy confirmation/status requests", async (t) => {
  const server = await createServer({
    optimizeDeps: { noDiscovery: true },
    server: { middlewareMode: true },
    appType: "custom",
  });
  t.after(() => server.close());
  const { TaskPanel } = await server.ssrLoadModule(
    "/web/components/TaskPanel.tsx",
  );
  const html = renderToStaticMarkup(
    createElement(TaskPanel, {
      ai: { aiReady: true, model: "fixture" },
      task: {
        id: "task",
        instruction: "fixture",
        state: "executing",
        steps: [],
        confirmation: null,
      },
      canRun: false,
      busy: true,
      onStart: () => {},
      onConfirm: () => {},
      onStop: () => {},
    }),
  );
  const stop = html.match(/<button[^>]*>停止任务<\/button>/)?.[0];
  assert.ok(stop);
  assert.ok(!stop.includes("disabled"), "Stop must bypass unrelated busy flag");
});
