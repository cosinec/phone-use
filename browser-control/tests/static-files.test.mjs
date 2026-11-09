import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, symlink, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createGateway } from "../src/gateway.mjs";
const mod = await import("../src/static-files.mjs").catch(() => ({}));
test("GET/HEAD SPA through same handler; auth preserved; traversal and missing assets rejected", async (t) => {
  assert.equal(
    typeof mod.createStaticFiles,
    "function",
    "static module must exist",
  );
  const root = await mkdtemp(path.join(os.tmpdir(), "web-static-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "assets"));
  await writeFile(path.join(root, "index.html"), "<title>Console</title>");
  await writeFile(path.join(root, "assets", "app.js"), "export {}");
  await symlink("/etc/passwd", path.join(root, "leak.txt"));
  const gateway = createGateway({
    accessToken: "test",
    allowedOrigins: ["http://localhost"],
    staticFiles: mod.createStaticFiles(root),
    runtimeDir: path.join(root, "runtime"),
  });
  await gateway.listen("127.0.0.1", 0);
  t.after(() => gateway.close());
  const base = `http://127.0.0.1:${gateway.server.address().port}`;
  for (const route of ["/", "/console/session"]) {
    const res = await fetch(base + route);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /Console/);
  }
  const head = await fetch(base + "/", { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  assert.equal(
    (await fetch(base + "/assets/app.js")).headers.get("content-type"),
    "text/javascript; charset=utf-8",
  );
  for (const route of [
    "/assets/missing.js",
    "/leak.txt",
    "/%2e%2e%2fsecret",
    "/api/missing",
    "/ios/device/ws",
  ])
    assert.equal((await fetch(base + route)).status, 404, route);
  assert.equal(
    (await fetch(base + "/api/sessions", { method: "POST", body: "{}" }))
      .status,
    401,
  );
  assert.equal((await fetch(base + "/api/config")).status, 200);
});
