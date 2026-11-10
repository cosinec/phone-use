import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  copyFile,
  readFile,
  writeFile,
  rm,
} from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("SDK patch is idempotent and refuses a changed package or modified chunk", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "sdk-patch-install-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const scripts = join(root, "scripts"),
    pkg = join(root, "node_modules/@limrun/device-install");
  await mkdir(scripts, { recursive: true });
  await mkdir(join(pkg, "dist"), { recursive: true });
  const script = join(scripts, "patch-device-install.mjs");
  const chunk = join(pkg, "dist/index-DJrAlfkC.js");
  await copyFile(
    new URL("../scripts/patch-device-install.mjs", import.meta.url),
    script,
  );
  await copyFile(
    new URL(
      "../node_modules/@limrun/device-install/dist/index-DJrAlfkC.js",
      import.meta.url,
    ),
    chunk,
  );
  await writeFile(join(pkg, "package.json"), '{"version":"0.1.0"}');
  const run = () => spawnSync(process.execPath, [script], { encoding: "utf8" });
  const before = await readFile(chunk, "utf8");
  assert.equal(run().status, 0);
  assert.equal(run().status, 0);
  assert.equal(await readFile(chunk, "utf8"), before);
  await writeFile(chunk, before + "\n// unexpected modification\n");
  const changed = run();
  assert.notEqual(changed.status, 0);
  assert.match(changed.stderr, /Unexpected device-install patch contents/);
  assert.equal(
    await readFile(chunk, "utf8"),
    before + "\n// unexpected modification\n",
    "failed verification must not write the package",
  );
  await writeFile(join(pkg, "package.json"), '{"version":"0.1.1"}');
  const upgraded = run();
  assert.notEqual(upgraded.status, 0);
  assert.match(upgraded.stderr, /before upgrading the SDK/);
});
