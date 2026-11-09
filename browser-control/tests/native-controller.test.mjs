import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { NativeController } from '../src/native-controller.mjs';
import { commandRequest } from '../src/commands.mjs';

const udid = '00008110-001234567890001E';
async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ictl-test-'));
  const controller = new NativeController({ device: { serialNumber: udid }, dataDir: path.join(dir, 'data'), socketPath: path.join(dir, 'ctl'), muxAddress: '127.0.0.1:62001', command: process.execPath, commandArgs: [new URL('./fixtures/native-cli.mjs', import.meta.url).pathname], startTimeoutMs: 3000, requestTimeoutMs: 100 });
  t.after(async () => { await controller.close(); await rm(dir, { recursive: true, force: true }); });
  return controller;
}
async function waitFor(predicate) {
  for (let n = 0; n < 300; n++) { if (predicate()) return; await sleep(10); }
  assert.fail('state did not settle');
}

test('native subprocess receives isolated environment and parses fragmented NDJSON response', async t => {
  const controller = await fixture(t);
  await controller.start();
  const result = JSON.parse((await controller.request({ op: 'status' })).text);
  assert.equal(result.request.expect_udid, udid);
  assert.equal(result.request.cancel_on_close, true);
  assert.equal(result.env.IPHONE_UDID, udid);
  assert.equal(result.env.ICTL_MANAGE_USBMUXD, '0');
  assert.equal(result.env.USBMUXD_SOCKET_ADDRESS, '127.0.0.1:62001');
  assert.equal((await stat(result.env.ICTL_DATA_DIR)).mode & 0o777, 0o700);
  assert.equal(controller.state.ready, true);
  await controller.close();
  assert.equal(controller.state.ready, false);
  await assert.rejects(controller.request({ op: 'status' }), /closed/);
});

test('setup exposes bounded transcript and one-time stdin without saving secret input', async t => {
  const controller = await fixture(t);
  await controller.start();
  await controller.startSetup();
  await waitFor(() => controller.state.setup.transcript.includes('Apple account input'));
  controller.setupInput('secret-password-123');
  await waitFor(() => controller.state.setup.state === 'complete');
  assert.equal(controller.state.setup.exitCode, 0);
  assert.ok(!controller.state.setup.transcript.includes('secret-password-123'));
  assert.throws(() => controller.setupInput('second'), /running/);
});

test('sent mutation timeout is not retried and a closed owned controller leaves another alive', async t => {
  const first = await fixture(t);
  const second = await fixture(t);
  await Promise.all([first.start(), second.start()]);
  await assert.rejects(first.request({ op: 'tap', x: 999, y: 1 }), /timeout.*not retried/i);
  const result = JSON.parse((await first.request({ op: 'daemon' })).text);
  assert.equal(result.taps, 1);
  await first.close();
  assert.equal((await second.request({ op: 'status' })).kind, 'text');
});

test('setup runtime kills an unresponsive owned child and bounds output transcript', async t => {
  const controller = await fixture(t);
  controller.options.setupTimeoutMs = 300;
  controller.options.env = { FIXTURE_IGNORE_TERM: '1', FIXTURE_SETUP_BURST: '1' };
  await controller.start();
  await controller.startSetup();
  await waitFor(() => controller.state.setup.transcript.includes('Apple account input'));
  assert.ok(controller.state.setup.transcript.length <= 32768);
  await waitFor(() => controller.state.setup.state === 'failed');
  await waitFor(() => controller.children.size === 1); // The daemon survives; timed-out setup is gone.
  assert.equal((await controller.request({ op: 'status' })).kind, 'text');
});

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}
async function descendantFixture(t, controller) {
  controller.options.env = { FIXTURE_DESCENDANT: 'setup' };
  await controller.startSetup();
  await waitFor(() => /descendantPID:\d+/.test(controller.state.setup.transcript));
  const pid = Number(controller.state.setup.transcript.match(/descendantPID:(\d+)/)[1]);
  // Narrow fallback cleanup makes the RED proof safe: only this fixture's observed descendant PID.
  t.after(() => { if (alive(pid)) process.kill(pid, 'SIGKILL'); });
  return pid;
}

test('close cleans owned descendants after their group leader exits and leaves another session alive', { skip: process.platform === 'win32' }, async t => {
  const first = await fixture(t); const second = await fixture(t);
  await Promise.all([first.start(), second.start()]);
  const pid = await descendantFixture(t, first);
  assert.equal(alive(pid), true);
  await first.close();
  assert.equal(alive(pid), false, 'owned descendant survived leader exit');
  assert.equal((await second.request({ op: 'status' })).kind, 'text');
});

test('setup timeout retains group escalation after leader exits and waits for descendant cleanup', { skip: process.platform === 'win32' }, async t => {
  const controller = await fixture(t); await controller.start();
  controller.options.setupTimeoutMs = 300;
  const pid = await descendantFixture(t, controller);
  await waitFor(() => controller.state.setup.state === 'failed');
  await waitFor(() => !alive(pid));
  assert.equal((await controller.request({ op: 'status' })).kind, 'text');
});

test('command adapter matches native serde operations and validates every parameter boundary', () => {
  assert.deepEqual(commandRequest('iphone_swipe', { from_x: 1, from_y: 2, to_x: 3, to_y: 4 }), { op: 'swipe', from: [1, 2], to: [3, 4], seconds: 0.3 });
  assert.deepEqual(commandRequest('iphone_screenshot', {}), { op: 'screenshot', region: null });
  assert.deepEqual(commandRequest('iphone_type_text', { text: 'abc' }), { op: 'type_text', text: 'abc', submit: false });
  assert.deepEqual(commandRequest('iphone_wait_for', { text: 'Ready', timeout: 1.2 }), { op: 'wait_for', text: 'Ready', timeout_ms: 1200 });
  for (const [tool, args] of [
    ['iphone_tap', { x: NaN, y: 1 }], ['iphone_long_press', { x: 1, y: 2, seconds: 11 }],
    ['iphone_tap_element', { text: 'OK', index: -1 }], ['iphone_type_text', { text: 'x'.repeat(10001) }],
    ['iphone_open_url', { url: 'javascript:alert(1)' }], ['iphone_press_button', { button: 'power' }],
    ['iphone_select_device', { device: 'another' }], ['iphone_tap', { x: 1, y: 2, op: 'resign' }],
    ['iphone_screenshot', { x: 1 }], ['iphone_wait_for', { text: 'OK', timeout: Infinity }],
  ]) assert.throws(() => commandRequest(tool, args), /invalid|unknown|unsupported|requires|must/i);
});
