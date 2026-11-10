import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";
import { createServer, preview } from "vite";
import { toPhonePoint, pointerCommand } from "../web/interaction.mjs";

let browser, dev, built, base, builtBase;
const root = new URL("..", import.meta.url).pathname;
const fixturePage = `<!doctype html>
<html lang="zh-CN">
  <head><link rel="stylesheet" href="/web/styles.css"></head>
  <body>
    <div id="root"></div>
    <script type="module" src="/__test__/fixture.mjs"></script>
  </body>
</html>`;
const fixtureScript = await readFile(
  new URL("./fixtures/browser-console.mjs", import.meta.url),
  "utf8",
);

before(async () => {
  const chrome =
    process.env.CHROME_BIN ||
    (process.platform === "darwin"
      ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
      : undefined);
  browser = await chromium.launch({
    headless: true,
    ...(chrome && existsSync(chrome) ? { executablePath: chrome } : {}),
  });
  dev = await createServer({
    root,
    configFile: new URL("../vite.config.mjs", import.meta.url).pathname,
    server: { host: "127.0.0.1", port: 0, strictPort: false },
    plugins: [
      {
        name: "explicit-browser-fixture",
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (req.url === "/__test__/fixture.mjs") {
              res.setHeader("Content-Type", "text/javascript");
              res.end(fixtureScript);
              return;
            }
            if (req.url !== "/__test__/console.html") return next();
            res.setHeader("Content-Type", "text/html");
            res.end(fixturePage);
          });
        },
      },
    ],
  });
  await dev.listen();
  base = `http://127.0.0.1:${dev.httpServer.address().port}`;
  built = await preview({
    root,
    configFile: new URL("../vite.config.mjs", import.meta.url).pathname,
    preview: { host: "127.0.0.1", port: 0, strictPort: false },
  });
  builtBase = `http://127.0.0.1:${built.httpServer.address().port}`;
});
after(async () => {
  await browser?.close();
  await dev?.close();
  if (built) await new Promise((resolve) => built.httpServer.close(resolve));
});
async function pageFor(t, fixture = true) {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1100 },
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  t.after(async () => {
    await page.close();
    assert.deepEqual(
      errors,
      [],
      "browser must have no uncaught runtime errors",
    );
  });
  if (!fixture)
    await page.route("**/api/config", (route) =>
      route.fulfill({ json: { aiReady: false, model: null, models: [] } }),
    );
  await page.goto(fixture ? base + "/__test__/console.html" : builtBase + "/");
  await page.getByRole("heading", { name: "让手机帮你做事." }).waitFor();
  return page;
}
async function connect(page, platform = "ios") {
  await page.locator("#device-platform").selectOption(platform);
  await page.locator("#server-token").fill("explicit-fixture-controller");
  await page
    .getByRole("button", {
      name: platform === "android" ? "连接 Android" : "连接 iPhone",
      exact: true,
    })
    .click();
  await page.getByRole("button", { name: "断开连接", exact: true }).waitFor();
  await page.waitForFunction(() =>
    document
      .querySelector(".connection-status")
      .textContent.includes("可以控制"),
  );
}

test("production bootstrap loads Rust WASM UI with honest empty phone and accessible offline controls", async (t) => {
  const page = await pageFor(t, false);
  await page.getByText("AI 尚未配置", { exact: true }).waitFor();
  assert.equal(await page.locator(".phone-screen").count(), 0);
  assert.equal(
    await page
      .getByRole("button", { name: "主屏幕", exact: true })
      .isDisabled(),
    true,
  );
  assert.equal(await page.locator("#task-model").isDisabled(), true);
  await page.getByRole("button", { name: "回到主屏幕", exact: false }).click();
  assert.equal(
    await page.locator("#task-instruction").inputValue(),
    "回到主屏幕",
  );
  await page.locator("#task-instruction").fill("中文😀");
  assert.match(
    await page.locator(".task-input-footer").textContent(),
    /4\/4000/,
  );
  await page.locator("#task-instruction").focus();
  await page.getByRole("button", { name: "刷新列表", exact: true }).click();
  await page.locator("#task-instruction").focus();
  await page.getByText("AI 尚未配置", { exact: true }).waitFor();
  assert.equal(
    await page
      .locator("#task-instruction")
      .evaluate((node) => node === document.activeElement),
    true,
  );
  assert.equal(await page.locator("#device-platform option").count(), 2);
});

test("Rust gestures preserve letterbox mapping and pointer gesture bounds", () => {
  const rect = { left: 20, top: 10, width: 200, height: 200 };
  assert.deepEqual(toPhonePoint(120, 110, rect, 100, 200), { x: 50, y: 100 });
  assert.equal(toPhonePoint(25, 110, rect, 100, 200), null);
  const start = { point: { x: 1, y: 2 }, x: 0, y: 0, time: 0 };
  assert.equal(
    pointerCommand(start, { point: { x: 1, y: 2 }, x: 0, y: 0, time: 20000 })
      .args.seconds,
    10,
  );
  assert.equal(
    pointerCommand(start, { point: { x: 4, y: 5 }, x: 20, y: 20, time: 300 })
      .tool,
    "iphone_swipe",
  );
});

test("iPhone readiness gate, setup labels and prompt input retain current behavior", async (t) => {
  const page = await pageFor(t);
  await page.evaluate(() => (fixture.state.daemon.state.state = "needs_trust"));
  await page.locator("#server-token").fill("explicit-fixture-controller");
  await page.getByRole("button", { name: "连接 iPhone", exact: true }).click();
  await page.getByRole("button", { name: "断开连接", exact: true }).waitFor();
  await page.getByText("WDA 准备中", { exact: true }).first().waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "主屏幕", exact: true })
      .isDisabled(),
    true,
  );
  await page.getByText("向导已结束", { exact: true }).waitFor();
  await page.getByRole("button", { name: "重新启动向导", exact: true }).click();
  await page.locator("#setup-line").fill("explicit-fake-2fa");
  await page.getByRole("button", { name: "提交", exact: true }).click();
  assert.equal(await page.locator("#setup-line").inputValue(), "");
  await page.evaluate(() => (fixture.state.daemon.state.state = "ready"));
  await page.waitForFunction(
    () => !document.querySelector(".hardware-buttons button").disabled,
  );
  const choices = await page.evaluate(() =>
    fixture.calls.filter((c) => c.choose),
  );
  assert.equal(choices.length, 1);
  assert.equal(choices[0].active, true);
  assert.equal(await page.locator("#server-token").inputValue(), "");
});

test("Android ready UI provides back control and excludes Apple setup", async (t) => {
  const page = await pageFor(t);
  await connect(page, "android");
  assert.equal(
    await page.getByRole("button", { name: "返回", exact: true }).isEnabled(),
    true,
  );
  assert.equal(await page.locator(".setup-transcript").count(), 0);
  await page.getByRole("button", { name: "返回", exact: true }).click();
  await page.waitForFunction(() =>
    fixture.calls.some((c) => c.body?.args?.button === "back"),
  );
});

test("model selection, confirmation details and Stop remain independent of held confirm request", async (t) => {
  const page = await pageFor(t);
  await connect(page);
  await page.locator("#task-model").selectOption("fixture/other");
  await page.locator("#task-instruction").fill("发送前确认");
  await page.getByRole("button", { name: "开始任务", exact: false }).click();
  await page.getByText("这一步需要你的确认", { exact: true }).waitFor();
  assert.equal(await page.locator("#task-model").isDisabled(), true);
  assert.equal(
    await page
      .getByRole("button", { name: "主屏幕", exact: true })
      .isDisabled(),
    true,
  );
  assert.match(
    await page.locator(".confirmation pre").textContent(),
    /"submit": true/,
  );
  assert.match(
    await page.locator('[aria-label="最近一轮耗时"]').textContent(),
    /观察 0.10 秒.*模型 0.20 秒.*操作 0.30 秒/,
  );
  assert.match(
    await page
      .locator(".field-hint")
      .allTextContents()
      .then((x) => x.join(" ")),
    /本次任务模型：fixture\/other/,
  );
  await page.evaluate(() => (fixture.holdConfirm = true));
  await page.getByRole("button", { name: "确认这一步", exact: true }).click();
  await page.waitForFunction(() =>
    fixture.calls.some((c) => c.url?.endsWith("/confirm")),
  );
  assert.equal(
    await page
      .getByRole("button", { name: "停止任务", exact: true })
      .isEnabled(),
    true,
  );
  await page.getByRole("button", { name: "停止任务", exact: true }).click();
  await page.waitForFunction(() =>
    document.querySelector(".task-status")?.textContent.includes("任务已停止"),
  );
  assert.equal(
    await page.evaluate(
      () => fixture.calls.filter((c) => c.url?.endsWith("/stop")).length,
    ),
    1,
  );
  await page.evaluate(() => fixture.releaseConfirm());
  await page.waitForTimeout(50);
  assert.match(await page.locator(".task-status").textContent(), /任务已停止/);
});

test("screen refresh preserves image pointer capture and text focus while manual input dispatches once", async (t) => {
  const page = await pageFor(t);
  await connect(page);
  const image = page.locator(".phone-screen");
  await image.waitFor();
  await page.waitForFunction(
    () => document.querySelector(".phone-screen")?.naturalWidth === 100,
  );
  await image.evaluate((node) => (window.capturedImage = node));
  const initialSource = await image.getAttribute("src");
  await page.locator("#phone-text").fill("中文输入");
  await page.locator("#phone-text").focus();
  await page.waitForTimeout(2100);
  assert.equal(
    await image.evaluate((node) => node === window.capturedImage),
    true,
  );
  assert.notEqual(await image.getAttribute("src"), initialSource);
  assert.equal(
    await page
      .locator("#phone-text")
      .evaluate((node) => node === document.activeElement),
    true,
  );
  await page.getByRole("button", { name: "输入", exact: true }).click();
  await page.waitForFunction(() =>
    fixture.calls.some((c) => c.body?.tool === "iphone_type_text"),
  );
  assert.equal(await page.locator("#phone-text").inputValue(), "");
  assert.equal(
    await page.evaluate(
      () =>
        fixture.calls.filter((c) => c.body?.tool === "iphone_type_text").length,
    ),
    1,
  );
  await page.waitForFunction(
    () => !document.querySelector("#phone-text").disabled,
  );
  const box = await image.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  assert.notEqual(
    await page.locator(".screen-meta code").textContent(),
    "坐标随指针显示",
  );
  await page.mouse.down();
  await page.waitForTimeout(2100);
  assert.equal(
    await image.evaluate((node) => node === window.capturedImage),
    true,
  );
  await page.mouse.up();
  await page.waitForFunction(() =>
    fixture.calls.some((c) => c.body?.tool === "iphone_long_press"),
  );
});

test("cancelled pending pairing shows USB custody wait until the SDK settles", async (t) => {
  const page = await pageFor(t);
  await page.evaluate(() => (fixture.holdPair = true));
  await page.locator("#server-token").fill("explicit-fixture-controller");
  await page.getByRole("button", { name: "连接 iPhone", exact: true }).click();
  await page.waitForFunction(() => fixture.pairStarted);
  await page.getByRole("button", { name: "取消连接", exact: true }).click();
  await page
    .getByRole("button", { name: "等待 USB 释放", exact: true })
    .waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "等待 USB 释放", exact: true })
      .isDisabled(),
    true,
  );
  await page.evaluate(() => fixture.releasePair());
  await page
    .getByRole("button", { name: "连接 iPhone", exact: true })
    .waitFor();
});

test("setup transcript preserves user scroll on status polls and follows actual new output", async (t) => {
  const page = await pageFor(t);
  await page.evaluate(
    () =>
      (fixture.state.setup.transcript = Array.from(
        { length: 100 },
        (_, i) => `line ${i}`,
      ).join("\n")),
  );
  await connect(page);
  const transcript = page.locator(".setup-transcript");
  await page.waitForFunction(() =>
    document
      .querySelector(".setup-transcript")
      ?.textContent.includes("line 99"),
  );
  await transcript.evaluate((node) => (node.scrollTop = 0));
  await page.waitForTimeout(1300);
  assert.equal(
    await transcript.evaluate((node) => node.scrollTop),
    0,
    "unchanged polling must preserve the user's scroll position",
  );
  await page.evaluate(
    () => (fixture.state.setup.transcript += "\nnew fixture output"),
  );
  await page.waitForFunction(() =>
    document
      .querySelector(".setup-transcript")
      ?.textContent.includes("new fixture output"),
  );
  await page.waitForFunction(() => {
    const node = document.querySelector(".setup-transcript");
    return (
      node.scrollTop > 0 &&
      Math.abs(node.scrollHeight - node.clientHeight - node.scrollTop) <= 1
    );
  });
});

test("a manual preview from a previous session cannot replace a reconnected same-device screen", async (t) => {
  const page = await pageFor(t);
  await connect(page);
  await page.locator(".phone-screen").waitFor();
  await page.evaluate(() => (fixture.holdNextPreview = true));
  await page.getByRole("button", { name: "刷新屏幕", exact: true }).click();
  await page.waitForFunction(() => fixture.heldPreview);
  await page.getByRole("button", { name: "断开连接", exact: true }).click();
  await connect(page);
  await page.locator(".phone-screen").waitFor();
  assert.equal(await page.evaluate(() => fixture.state.id), "session-2");
  await page.evaluate(() => fixture.releasePreview());
  await page.waitForFunction(
    () => !document.querySelector("#phone-text").disabled,
  );
  assert.equal(
    await page
      .locator(".phone-screen")
      .evaluate((node) => node.src === fixture.staleSource),
    false,
  );
});

test("a delayed command from a previous session cannot start a screenshot request in the new session", async (t) => {
  const page = await pageFor(t);
  await connect(page);
  await page.locator(".phone-screen").waitFor();
  await page.evaluate(() => (fixture.holdNextCommand = true));
  await page.getByRole("button", { name: "主屏幕", exact: true }).click();
  await page.waitForFunction(() => fixture.heldCommand);
  await page.getByRole("button", { name: "断开连接", exact: true }).click();
  await connect(page);
  await page.locator(".phone-screen").waitFor();
  const countBefore = await page.evaluate(
    () =>
      fixture.calls.filter(
        (c) => c.url?.includes("/session-2/") && c.url.endsWith("/preview"),
      ).length,
  );
  await page.evaluate(() => fixture.releaseCommand());
  await page.waitForFunction(
    () => !document.querySelector("#phone-text").disabled,
  );
  assert.equal(
    await page.evaluate(
      () =>
        fixture.calls.filter(
          (c) => c.url?.includes("/session-2/") && c.url.endsWith("/preview"),
        ).length,
    ),
    countBefore,
  );
});
