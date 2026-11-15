import test from 'node:test';
import { fixtureImageBase64 } from './fixtures/screen-image.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import http from 'node:http';
import * as plist from 'plist';
import WebSocket from 'ws';
import { encodeFrame, decodeFrame, FrameType as F, jsonPayload } from '../src/relay-protocol.mjs';

const binary = process.env.RUST_GATEWAY_BIN;
const device = { serialNumber: '00008110-001234567890001E', vendorId: 1452, productId: 4776 };
const origin = 'http://localhost:5173';
const token = 'rust-contract-controller';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, attempts = 250) {
  for (let i = 0; i < attempts; i++) { if (await check()) return; await pause(20); }
  throw new Error('condition timed out');
}
async function harness(t, env = {}, fileEnv = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'rust-gateway-contract-'));
  await writeFile(path.join(dir, '.env'), Object.entries(fileEnv).map(([key, value]) => `${key}=${value}`).join('\n'));
  const native = path.join(dir, 'native');
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  await writeFile(native, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fileURLToPath(new URL('./fixtures/native-cli.mjs', import.meta.url)))} "$@"\n`, { mode: 0o700 });
  const child = spawn(binary, [], { cwd: dir, env: { ...process.env, HOST: '127.0.0.1', PORT: '0', CONTROL_ACCESS_TOKEN: token,
    ALLOWED_ORIGINS: origin, RUNTIME_DIR: path.join(dir, 'runtime'), ICTL_BIN: native,
    WEB_DIST_DIR: fileURLToPath(new URL('../dist', import.meta.url)), LLM_BASE_URL: '', LLM_MODEL: '', LLM_API_KEY: '',
    AI_OBSERVATION: 'ocr', OCR_PYTHON: process.execPath, OCR_WORKER: fileURLToPath(new URL('./fixtures/ocr-worker.mjs', import.meta.url)), ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', errors = '', startupError;
  child.on('error', error => { startupError = error; });
  child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { errors += chunk; });
  t.after(async () => { child.kill('SIGTERM'); await Promise.race([once(child, 'exit'), pause(5000)]); if (child.exitCode === null) child.kill('SIGKILL'); await rm(dir, { recursive: true, force: true }); });
  await until(() => { if (startupError) throw startupError; if (child.exitCode !== null) throw new Error(errors); return /Gateway listening http:\/\/[^\s]+/.test(output); });
  const base = output.match(/Gateway listening (http:\/\/[^\s]+)/)[1];
  const api = (route, key = token, body, headers = {}, method = body === undefined ? 'GET' : 'POST') => fetch(base + route, {
    method, headers: { Authorization: `Bearer ${key}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const session = async (extra = {}) => { const response = await api('/api/sessions', token, { device, ...extra }); assert.equal(response.status, 201, await response.clone().text()); return response.json(); };
  return { api, session, base, dir, logs: () => errors };
}
async function peer(t, session, selected = device) {
  const ws = new WebSocket(session.relayUrl, { origin });
  const chunks = [];
  ws.on('message', bytes => {
    const f = decodeFrame(bytes);
    if (f.type === F.OpenStream) ws.send(encodeFrame({ type: F.OpenResult, requestId: f.requestId, streamId: f.streamId, payload: jsonPayload({ ok: true }) }));
    if (f.type === F.StreamData) { chunks.push(f.payload.length); ws.send(encodeFrame({ type: F.StreamData, streamId: f.streamId, payload: f.payload })); }
  });
  await once(ws, 'open');
  ws.send(encodeFrame({ type: F.DeviceHello, payload: jsonPayload(selected) }));
  t.after(() => ws.terminate());
  return { ws, chunks };
}
async function ready(app, session) {
  let state;
  await until(async () => { state = await (await app.api(`/api/sessions/${session.id}`, session.token)).json(); return state.ready; });
  return state;
}
const contract = (name, fn) => test(name, { skip: !binary }, fn);

contract('transport diagnostics accept all 64 enriched streams and reject unauthenticated or private payloads', async t => {
  const app = await harness(t);
  const session = await app.session();
  const route = `/api/sessions/${session.id}/diagnostics`;
  const metrics = {schema: 1, event: 'sample', uplinkWaiters: 1, uplinkWaitCount: 3,
    uplinkWaitMaxMs: 2001, previewPauses: 1, previewCooldownMs: 29999,
    streams: Array.from({length: 64}, (_, i) => ({
    streamId: i + 1, port: 8100, readQueuedBytes: 1024, writeQueuedBytes: 1048576,
    peerWindowBytes: 131072, readQueuedFrames: 10, sendSeq: 0xffffffff, peerAck: 0xffffff00,
    inFlightBytes: 255, availableWindowBytes: 130817, writeWaiters: 1, ackPending: 1,
    windowBlocked: 0, windowBlockedMs: 0, peerAckUnchangedMs: 10000,
    readRetainedBytes: 131072, receiveWindowBytes: 0,
  }))};
  assert.ok(Buffer.byteLength(JSON.stringify(metrics)) > 16 * 1024, 'fixture must exceed the previous upload limit');
  assert.equal((await app.api(route, 'wrong-token', metrics)).status, 401);
  const response = await app.api(route, session.token, metrics);
  assert.equal(response.status, 200, await response.clone().text());
  await until(() => app.logs().split('\n').slice(0, -1).some(line => line.includes('event=browser_transport')));
  const line = app.logs().split('\n').find(line => line.includes('event=browser_transport'));
  assert.ok(line.includes(`session=${session.id}`));
  const stored = JSON.parse(line.split(' metrics=')[1]);
  assert.equal(stored.streams.length, 64);
  assert.equal(stored.streams[63].sendSeq, 0xffffffff);
  assert.equal(stored.streams[63].peerAckUnchangedMs, 10000);
  assert.equal(stored.streams[63].readRetainedBytes, 131072);
  assert.equal(stored.streams[63].receiveWindowBytes, 0);
  assert.equal(stored.previewCooldownMs, 29999);
  assert.equal(stored.uplinkWaitMaxMs, 2001);
  assert.equal((await app.api(route, session.token, {...metrics, payload: 'PRIVATE_DIAGNOSTIC_PAYLOAD'})).status, 400);
  assert.ok(!app.logs().includes('PRIVATE_DIAGNOSTIC_PAYLOAD'));
});

async function modelReplyTask(t, respond, env = {}) {
  const requests = [];
  const provider = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body));
    const reply = await respond(requests.length, requests.at(-1));
    if (!reply) return;
    res.writeHead(reply.status || 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(reply.body));
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  t.after(() => { provider.closeAllConnections(); provider.close(); });
  const app = await harness(t, {
    LLM_BASE_URL: `http://127.0.0.1:${provider.address().port}/v1`,
    LLM_MODEL: 'fixture-replies', LLM_API_KEY: 'fixture-reply-key', ...env,
  });
  const session = await app.session();
  const usb = await peer(t, session);
  await ready(app, session);
  const route = `/api/sessions/${session.id}`;
  const response = await app.api(route + '/tasks', session.token, { instruction: 'Inspect the fixture safely' });
  assert.equal(response.status, 201);
  const task = await response.json();
  const snapshot = async () => (await app.api(route, session.token)).json();
  return { app, session, route, task, requests, snapshot, usb };
}

function modelCompletion(content, finish_reason = 'stop') {
  return { body: { choices: [{ finish_reason, message: { content } }] } };
}

contract('WDA recovery waits for readiness and a fresh observation without replaying an uncertain tap', async t => {
  for (const interrupted of [false, true]) {
    await t.test(interrupted ? 'interrupted native response' : 'native WDA timeout', async t => {
      const fixture = await modelReplyTask(t, call => modelCompletion(JSON.stringify(call === 1
        ? { type: 'action', tool: 'iphone_tap', args: { x: 5, y: 7 }, reason: 'Inspect fixture screen' }
        : { type: 'done', message: 'Fresh screen verified' })), {
        FIXTURE_TAP_WDA_FAILURES: '1', FIXTURE_WDA_RECOVERY_MS: '600',
        FIXTURE_RECOVERY_OBSERVATION_FAILURES: '1', ...(interrupted ? { FIXTURE_TAP_INTERRUPTED: '1' } : {}),
      });
      let state;
      await until(async () => { state = await fixture.snapshot(); return ['recovering', 'failed'].includes(state.task?.state); });
      assert.equal(state.task.state, 'recovering', JSON.stringify(state.task));
      assert.equal(state.task.steps[0].state, 'uncertain');
      assert.equal(state.task.recovery.maxWaitSeconds, 120);
      await until(async () => { state = await fixture.snapshot(); return ['completed', 'failed'].includes(state.task?.state); }, 600);
      assert.equal(state.task.state, 'completed', JSON.stringify(state.task));
      assert.equal(state.task.steps.length, 1);
      assert.equal(state.task.steps[0].state, 'uncertain');
      assert.equal(fixture.requests.length, 2);
      const context = JSON.parse(fixture.requests[1].messages[1].content[0].text);
      assert.equal(context.recentHistory[0].state, 'uncertain');
      assert.equal(context.observation.caption, 'fixture fresh screen after action');
      const counters = await nativeCounts(fixture);
      assert.equal(counters.taps, 1);
      assert.ok(counters.counts.screenshot >= 3);
    });
  }
});

contract('WDA recovery is cancelled promptly by stop or device disconnection', async t => {
  for (const disconnect of [false, true]) {
    await t.test(disconnect ? 'device disconnect' : 'user stop', async t => {
      const fixture = await modelReplyTask(t, () => modelCompletion(JSON.stringify({
        type: 'action', tool: 'iphone_tap', args: { x: 5, y: 7 }, reason: 'Inspect fixture screen',
      })), { FIXTURE_TAP_WDA_FAILURES: '1', FIXTURE_WDA_RECOVERY_MS: '300000' });
      let state;
      await until(async () => { state = await fixture.snapshot(); return ['recovering', 'failed'].includes(state.task?.state); });
      assert.equal(state.task.state, 'recovering', JSON.stringify(state.task));
      if (disconnect) {
        assert.equal((await fixture.app.api(fixture.route, fixture.session.token, undefined, {}, 'DELETE')).status, 200);
      } else {
        const stopped = await fixture.app.api(`${fixture.route}/tasks/${fixture.task.id}/stop`, fixture.session.token, {});
        assert.equal((await stopped.json()).state, 'stopped');
        await pause(2200);
        assert.equal((await fixture.snapshot()).task.state, 'stopped');
      }
      assert.equal(fixture.requests.length, 1);
    });
  }
});

contract('WDA recovery preserves unrelated failures and uncertain confirmed actions', async t => {
  for (const confirmed of [false, true]) {
    await t.test(confirmed ? 'confirmed action needs manual outcome check' : 'unrelated error remains fatal', async t => {
      const fixture = await modelReplyTask(t, () => modelCompletion(JSON.stringify({
        type: 'action', tool: 'iphone_tap', args: { x: 5, y: 7 }, reason: 'Inspect fixture screen', requiresConfirmation: confirmed,
      })), { FIXTURE_TAP_WDA_FAILURES: '1', ...(confirmed ? {} : { FIXTURE_TAP_ERROR: 'Fixture validation failure' }) });
      if (confirmed) {
        let waiting;
        await until(async () => { waiting = await fixture.snapshot(); return waiting.task?.state === 'awaiting_confirmation'; });
        await fixture.app.api(`${fixture.route}/tasks/${fixture.task.id}/confirm`, fixture.session.token, {
          actionId: waiting.task.confirmation.actionId, approved: true,
        });
      }
      let state;
      await until(async () => { state = await fixture.snapshot(); return state.task?.state === 'failed'; });
      assert.equal(state.task.steps[0].state, confirmed ? 'uncertain' : 'failed');
      assert.equal(fixture.requests.length, 1);
      assert.match(state.task.error, confirmed ? /结果不确定|uncertain/i : /Fixture validation failure/);
    });
  }
});

contract('WDA recovery has a two-episode task limit while retaining uncertain steps', async t => {
  const fixture = await modelReplyTask(t, call => modelCompletion(JSON.stringify({
    type: 'action', tool: 'iphone_tap', args: { x: call, y: 7 }, reason: 'Inspect a different fixture target',
  })), { FIXTURE_TAP_WDA_FAILURES: '3' });
  let state;
  await until(async () => { state = await fixture.snapshot(); return state.task?.state === 'failed'; });
  assert.equal(state.task.steps.length, 3);
  assert.ok(state.task.steps.every(step => step.state === 'uncertain'));
  assert.match(state.task.error, /恢复次数|recovery limit/i);
  assert.equal(fixture.requests.length, 3);
});

contract('WDA recovery rejects a fresh observation from a different device', async t => {
  const fixture = await modelReplyTask(t, () => modelCompletion(JSON.stringify({
    type: 'action', tool: 'iphone_tap', args: { x: 5, y: 7 }, reason: 'Inspect fixture screen',
  })), { FIXTURE_TAP_WDA_FAILURES: '1', FIXTURE_RECOVERY_FOREIGN_OBSERVATION: '1' });
  let state;
  await until(async () => { state = await fixture.snapshot(); return state.task?.state === 'failed'; });
  assert.match(state.task.error, /identity/);
  assert.equal(state.task.steps[0].state, 'uncertain');
  assert.equal(fixture.requests.length, 1);
});

contract('WDA recovery handles an unavailable initial observation before calling the model', async t => {
  const fixture = await modelReplyTask(t, () => modelCompletion(JSON.stringify({ type: 'done', message: 'Fresh fixture observed' })), {
    FIXTURE_INITIAL_OBSERVATION_WDA_FAILURES: '1',
  });
  let state;
  await until(async () => { state = await fixture.snapshot(); return ['completed', 'failed'].includes(state.task?.state); });
  assert.equal(state.task.state, 'completed', JSON.stringify(state.task));
  assert.equal(state.task.steps.length, 0);
  assert.equal(state.task.recovery.attempt, 1);
  assert.equal(fixture.requests.length, 1);
});

contract('WDA recovery retries an unavailable observation after a successful navigation', async t => {
  const fixture = await modelReplyTask(t, call => modelCompletion(JSON.stringify(call === 1
    ? { type: 'action', tool: 'iphone_tap', args: { x: 5, y: 7 }, reason: 'Return to fixture album list' }
    : { type: 'done', message: 'Fresh album screen verified' })), {
    FIXTURE_TAP_WDA_FAILURES: '0', FIXTURE_RECOVERY_OBSERVATION_FAILURES: '1',
    FIXTURE_TAP_ERROR: 'Fixture screenshot unavailable after navigation',
  });
  let state;
  await until(async () => { state = await fixture.snapshot(); return ['completed', 'failed'].includes(state.task?.state); });
  assert.equal(state.task.state, 'completed', JSON.stringify(state.task));
  assert.equal(state.task.steps.length, 1);
  assert.equal(state.task.steps[0].state, 'succeeded');
  assert.equal(state.task.recovery.attempt, 1);
  const context = JSON.parse(fixture.requests[1].messages[1].content[0].text);
  assert.equal((await nativeCounts(fixture)).taps, 1);
});

contract('WDA recovery requires checking uncertain text input before continuing', async t => {
  const fixture = await modelReplyTask(t, () => modelCompletion(JSON.stringify({
    type: 'action', tool: 'iphone_type_text', args: { text: 'fixture text' }, reason: 'Fill fixture input',
  })), { FIXTURE_TAP_WDA_FAILURES: '1', FIXTURE_TYPE_TEXT_ERROR: 'WDA 请求超时（请求已发出，手机可能仍在执行，先截图确认）：WDA request timed out' });
  let state;
  await until(async () => { state = await fixture.snapshot(); return state.task?.state === 'failed'; });
  assert.equal(state.task.steps[0].state, 'uncertain');
  assert.match(state.task.error, /结果不确定/);
  assert.equal(fixture.requests.length, 1);
});

contract('WDA recovery ends after the actual 120-second deadline', async t => {
  const fixture = await modelReplyTask(t, () => modelCompletion(JSON.stringify({
    type: 'action', tool: 'iphone_tap', args: { x: 5, y: 7 }, reason: 'Inspect fixture screen',
  })), { FIXTURE_TAP_WDA_FAILURES: '1', FIXTURE_WDA_RECOVERY_MS: '300000' });
  let state;
  await until(async () => { state = await fixture.snapshot(); return ['recovering', 'failed'].includes(state.task?.state); });
  assert.equal(state.task.state, 'recovering');
  await pause(119000);
  await until(async () => { state = await fixture.snapshot(); return state.task?.state === 'failed'; });
  assert.match(state.task.error, /120/);
  assert.equal(state.task.steps[0].state, 'uncertain');
  assert.ok(state.task.recovery.elapsedMs >= 120000);
  assert.ok(state.task.recovery.elapsedMs < 125000);
  assert.equal(fixture.requests.length, 1);
});

contract('model reply accepts complete JSON fences and text content parts', async t => {
  const done = JSON.stringify({ type: 'done', message: 'Fixture verified' });
  for (const [name, content] of [
    ['JSON fence', '```json\n' + done + '\n```'],
    ['text parts', [{ type: 'text', text: done.slice(0, 15) }, { type: 'text', text: done.slice(15) }]],
  ]) {
    await t.test(name, async t => {
      const fixture = await modelReplyTask(t, () => modelCompletion(content));
      let state;
      await until(async () => {
        state = await fixture.snapshot();
        return ['completed', 'failed'].includes(state.task?.state);
      });
      assert.equal(state.task.state, 'completed', JSON.stringify(state.task));
      assert.equal(fixture.requests.length, 1);
    });
  }
});

contract('model reply honors optional null parameters accepted by the native command validator', async t => {
  const fixture = await modelReplyTask(t, call => modelCompletion(JSON.stringify(call === 1
    ? { type: 'action', tool: 'iphone_swipe', args: { from_x: 1, from_y: 2, to_x: 3, to_y: 4, seconds: null }, reason: 'Fixture swipe' }
    : { type: 'done', message: 'Fixture verified' })));
  let state;
  await until(async () => {
    state = await fixture.snapshot();
    return ['completed', 'failed'].includes(state.task?.state);
  });
  assert.equal(state.task.state, 'completed', JSON.stringify(state.task));
  assert.equal(state.task.steps.length, 1);
  assert.equal(state.task.steps[0].state, 'succeeded');
});

contract('model reply requests a schema requiring a non-null action tool from the provider', async t => {
  const fixture = await modelReplyTask(t, (_call, request) => modelCompletion(JSON.stringify(
    request.response_format?.type === 'json_schema'
      ? { type: 'done', message: 'Structured fixture verified' }
      : { type: 'action', tool: null, args: {}, reason: 'Malformed fixture action' }
  )));
  let state;
  await until(async () => { state = await fixture.snapshot(); return ['completed', 'failed'].includes(state.task?.state); });
  assert.equal(state.task.state, 'completed', JSON.stringify(state.task));
  const format = fixture.requests[0].response_format;
  const action = format.json_schema.schema.anyOf.find(branch => branch.properties.type.enum.includes('action'));
  assert.equal(format.json_schema.name, 'phone_reply');
  assert.equal(format.json_schema.strict, false);
  assert.ok(action.required.includes('tool'));
  assert.equal(action.properties.tool.type, 'string');
  assert.equal(action.additionalProperties, false);
  assert.equal(fixture.requests.length, 1);
  assert.equal(state.task.steps.length, 0);
});

contract('model reply corrects missing and non-text tools with the same schema before dispatch', async t => {
  for (const [name, fields] of [['missing', {}], ['null', { tool: null }], ['object', { tool: { name: 'iphone_tap' } }]]) {
    await t.test(name, async t => {
      const fixture = await modelReplyTask(t, (call, request) => modelCompletion(JSON.stringify(
        call === 1 || !request.response_format
          ? { type: 'action', ...fields, args: {}, reason: 'Malformed fixture action' }
          : { type: 'done', message: 'No action needed' }
      )));
      let state;
      await until(async () => { state = await fixture.snapshot(); return ['completed', 'failed'].includes(state.task?.state); });
      assert.equal(state.task.state, 'completed', JSON.stringify(state.task));
      assert.equal(fixture.requests.length, 2);
      assert.deepEqual(fixture.requests[1].response_format, fixture.requests[0].response_format);
      // The correction must not suggest a concrete tool that the model might copy.
      const correction = fixture.requests[1].messages.at(-1).content;
      assert.match(correction, /string tool name from the catalog/);
      assert.doesNotMatch(correction, /iphone_/);
      assert.equal(state.task.steps.length, 0);
    });
  }
});

contract('model reply schema never bypasses native validation and correction cannot replay earlier actions', async t => {
  const fixture = await modelReplyTask(t, call => modelCompletion(JSON.stringify(call === 1
    ? { type: 'action', tool: 'iphone_tap', args: { x: 5, y: 7 }, reason: 'Fixture action' }
    : call === 2
      ? { type: 'action', tool: null, args: {}, reason: 'Malformed fixture action' }
      : { type: 'done', message: 'Fixture verified' })));
  let state;
  await until(async () => { state = await fixture.snapshot(); return ['completed', 'failed'].includes(state.task?.state); });
  assert.equal(state.task.state, 'completed', JSON.stringify(state.task));
  assert.equal(state.task.steps.length, 1);
  assert.equal(fixture.requests.length, 3);
  assert.equal((await nativeCounts(fixture)).taps, 1);
});

contract('model reply schema refusal falls back to schema instructions and remembers the model capability', async t => {
  const fixture = await modelReplyTask(t, call => call === 1
    ? { status: 400, body: { error: { message: 'Unsupported response_format json_schema' } } }
    : modelCompletion(JSON.stringify({ type: 'done', message: 'Fixture verified' })));
  let state;
  await until(async () => { state = await fixture.snapshot(); return ['completed', 'failed'].includes(state.task?.state); });
  assert.equal(state.task.state, 'completed', JSON.stringify(state.task));
  assert.equal(fixture.requests.length, 2);
  assert.equal(fixture.requests[1].response_format, undefined);
  assert.match(fixture.requests[1].messages[0].content, /"required":\["type","tool","args","reason"\]/);
  await fixture.app.api(fixture.route + '/tasks', fixture.session.token, { instruction: 'Inspect the fixture again' });
  await until(async () => { state = await fixture.snapshot(); return state.task?.state === 'completed' && fixture.requests.length === 3; });
  assert.equal(fixture.requests[2].response_format, undefined);
  assert.equal(state.task.steps.length, 0);
});

contract('model reply schema fallback is bounded and unrelated provider errors remain fatal', async t => {
  for (const [name, first, calls, status] of [
    ['unrelated 400', { status: 400, body: { error: 'private invalid argument' } }, 1, 400],
    ['unrelated 422', { status: 422, body: { error: 'private invalid request' } }, 1, 422],
    ['refused format then HTTP failure', { status: 422, body: { error: 'json_schema unsupported' } }, 2, 403],
  ]) {
    await t.test(name, async t => {
      const fixture = await modelReplyTask(t, call => call === 1 ? first : { status: 403, body: { error: 'private HTTP error' } });
      let state;
      await until(async () => { state = await fixture.snapshot(); return state.task?.state === 'failed'; });
      assert.match(state.task.error, new RegExp(`HTTP ${status}`));
      assert.equal(fixture.requests.length, calls);
      assert.equal(state.task.steps.length, 0);
      assert.ok(!JSON.stringify(state.task).includes('private'));
    });
  }
});

contract('model reply correction preserves confirmation and executes the corrected action once', async t => {
  const fixture = await modelReplyTask(t, call => modelCompletion(call === 1
    ? 'I will inspect the fixture next.'
    : JSON.stringify(call === 2
      ? { type: 'action', tool: 'iphone_tap', args: { x: 5, y: 7 }, reason: 'Fixture action', requiresConfirmation: true }
      : { type: 'done', message: 'Fixture verified' })));
  let state;
  await until(async () => {
    state = await fixture.snapshot();
    return state.task?.state === 'awaiting_confirmation' || state.task?.state === 'failed';
  });
  assert.equal(state.task.state, 'awaiting_confirmation', JSON.stringify(state.task));
  assert.equal(fixture.requests.length, 2);
  assert.deepEqual(fixture.requests[1].messages.slice(0, 2), fixture.requests[0].messages);
  assert.match(fixture.requests[1].messages.at(-1).content, /JSON/);
  const command = { requestId: 'before-confirmation', deviceId: fixture.session.deviceId, tool: 'iphone_status' };
  const before = await (await fixture.app.api(fixture.route + '/command', fixture.session.token, command)).json();
  assert.equal(JSON.parse(before.text).taps, 0);
  await fixture.app.api(`${fixture.route}/tasks/${fixture.task.id}/confirm`, fixture.session.token, {
    actionId: state.task.confirmation.actionId, approved: true,
  });
  await until(async () => { state = await fixture.snapshot(); return state.task?.state === 'completed'; });
  const after = await (await fixture.app.api(fixture.route + '/command', fixture.session.token, {
    ...command, requestId: 'after-confirmation',
  })).json();
  assert.equal(JSON.parse(after.text).taps, 1);
  assert.equal(state.task.steps.length, 1);
  assert.equal(fixture.requests.length, 3);
});

contract('model reply correction is bounded and reports the invalid argument without raw reply text', async t => {
  const fixture = await modelReplyTask(t, () => modelCompletion(JSON.stringify({
    type: 'action', tool: 'iphone_tap', args: { x: 'private-invalid-value', y: 7 }, reason: 'Fixture action',
  })));
  let state;
  await until(async () => { state = await fixture.snapshot(); return state.task?.state === 'failed'; });
  assert.equal(fixture.requests.length, 2);
  assert.equal(state.task.steps.length, 0);
  assert.match(state.task.error, /args.*x|Invalid x/);
  assert.ok(!JSON.stringify(state.task).includes('private-invalid-value'));
});

contract('model reply marked length is corrected before any device action even when its JSON parses', async t => {
  const fixture = await modelReplyTask(t, call => call === 1
    ? modelCompletion(JSON.stringify({ type: 'action', tool: 'iphone_tap', args: { x: 5, y: 7 }, reason: 'Truncated response' }), 'length')
    : modelCompletion(JSON.stringify({ type: 'done', message: 'No action was required' })));
  let state;
  await until(async () => { state = await fixture.snapshot(); return ['completed', 'failed'].includes(state.task?.state); });
  assert.equal(state.task.state, 'completed', JSON.stringify(state.task));
  assert.equal(state.task.steps.length, 0);
  assert.equal(fixture.requests.length, 2);
  assert.ok(fixture.requests[1].max_tokens > fixture.requests[0].max_tokens);
});

contract('model reply recovery stops on provider failures and explicit refusals', async t => {
  for (const [name, response, error] of [
    ['HTTP failure', { status: 403, body: { error: 'private-provider-error' } }, /HTTP 403/],
    ['refusal', { body: { choices: [{ message: { content: null, refusal: 'private refusal text' } }] } }, /refus|拒绝/i],
  ]) {
    await t.test(name, async t => {
      const fixture = await modelReplyTask(t, () => response);
      let state;
      await until(async () => { state = await fixture.snapshot(); return state.task?.state === 'failed'; });
      assert.match(state.task.error, error);
      assert.equal(fixture.requests.length, 1);
      assert.equal(state.task.steps.length, 0);
      assert.ok(!JSON.stringify(state.task).includes('private'));
    });
  }
});

contract('model reply correction is cancelled when the user stops the task', async t => {
  const fixture = await modelReplyTask(t, call => call === 1 ? modelCompletion('not JSON') : undefined);
  await until(async () => fixture.requests.length === 2 || (await fixture.snapshot()).task?.state === 'failed');
  assert.equal(fixture.requests.length, 2);
  await fixture.app.api(`${fixture.route}/tasks/${fixture.task.id}/stop`, fixture.session.token, {});
  const state = await fixture.snapshot();
  assert.equal(state.task.state, 'stopped');
  assert.equal(state.task.steps.length, 0);
});

contract('native action failure exposes its bounded cause and never retries typing', async t => {
  const reason = 'No keyboard on screen; tap a text field first. ' + 'detail '.repeat(500);
  const fixture = await modelReplyTask(t, () => modelCompletion(JSON.stringify({
    type: 'action', tool: 'iphone_type_text', args: { text: 'fixture draft', submit: false }, reason: 'Enter the draft',
  })), { FIXTURE_TYPE_TEXT_ERROR: reason });
  let state;
  await until(async () => { state = await fixture.snapshot(); return state.task?.state === 'failed'; });
  assert.match(state.task.error, /No keyboard on screen/);
  assert.ok(state.task.error.length < 2200);
  assert.equal(state.task.steps.length, 1);
  assert.equal(state.task.steps[0].state, 'failed');
  assert.equal(fixture.requests.length, 1);
});

const missingKeyboard = 'No keyboard on screen (no text field has focus), nothing typed; tap a text field first and check with a screenshot that the keyboard is up';
const typeDraft = { type: 'action', tool: 'iphone_type_text', args: { text: 'fixture draft', submit: false }, reason: 'Enter the draft' };
const focusField = { type: 'action', tool: 'iphone_tap', args: { x: 20, y: 50 }, reason: 'Focus the draft field' };
async function nativeCounts(fixture) {
  const response = await fixture.app.api(fixture.route + '/command', fixture.session.token, {
    requestId: 'typing-counts', deviceId: fixture.session.deviceId, tool: 'iphone_status',
  });
  return JSON.parse((await response.json()).text);
}
contract('typing focus recovers only after a fresh observation and a focus tap', async t => {
  for (const reason of [missingKeyboard, '屏幕上没有键盘(没有输入框获得焦点),什么都没输;先点一下输入框,截图确认键盘出来了再输入']) {
    await t.test(reason.startsWith('No') ? 'English' : 'Chinese', async t => {
      const actions = [typeDraft, focusField, typeDraft, { type: 'done', message: 'Draft entered' }];
      const fixture = await modelReplyTask(t, n => modelCompletion(JSON.stringify(actions[n - 1])), {
        FIXTURE_TYPE_TEXT_NEEDS_FOCUS: reason,
      });
      let state;
      await until(async () => { state = await fixture.snapshot(); return state.task?.state === 'completed'; });
      assert.deepEqual(state.task.steps.map(step => step.state), ['failed', 'succeeded', 'succeeded']);
      const input = JSON.parse(fixture.requests[1].messages[1].content[0].text);
      assert.equal(input.recentHistory[0].result.message, reason);
      assert.ok(JSON.parse(fixture.requests[1].messages[1].content[0].text).observation.ocr.lines.length > 0);
      assert.ok(fixture.requests[1].messages[1].content.every(part => part.type === 'text'));
      const counts = await nativeCounts(fixture);
      assert.equal(counts.typeRequests, 2);
      assert.equal(counts.taps, 1);
      assert.equal(counts.counts.screenshot, 4);
    });
  }
});
contract('typing focus returns blind typing to the model before dispatch, then halts at the re-plan limit', async t => {
  const fixture = await modelReplyTask(t, () => modelCompletion(JSON.stringify(typeDraft)), {
    FIXTURE_TYPE_TEXT_ERROR: missingKeyboard,
  });
  let state;
  await until(async () => { state = await fixture.snapshot(); return state.task?.state === 'failed'; });
  // One dispatched (failed) typing, two blind attempts returned for re-planning, the third halts.
  assert.equal(fixture.requests.length, 4);
  assert.equal(state.task.steps.length, 1);
  assert.equal((await nativeCounts(fixture)).typeRequests, 1);
  assert.match(state.task.error, /focus/i);
  const replan = JSON.parse(fixture.requests[2].messages[1].content[0].text).recentHistory.at(-1);
  assert.equal(replan.state, 'rejected');
  assert.match(replan.result.message, /Tap the intended text field first/);
});
contract('typing focus stops after one unsuccessful focus recovery', async t => {
  const fixture = await modelReplyTask(t, n => modelCompletion(JSON.stringify(n === 2 ? focusField : typeDraft)), {
    FIXTURE_TYPE_TEXT_ERROR: missingKeyboard,
  });
  let state;
  await until(async () => { state = await fixture.snapshot(); return state.task?.state === 'failed' && state.task.steps.length === 3; });
  assert.equal(fixture.requests.length, 3);
  assert.equal(state.task.error, missingKeyboard);
  assert.equal((await nativeCounts(fixture)).typeRequests, 2);
});
contract('typing focus cannot report completion while the failed input is unresolved', async t => {
  for (const tapped of [false, true]) {
    await t.test(tapped ? 'after focus tap' : 'before focus tap', async t => {
      const actions = [typeDraft, ...(tapped ? [focusField] : []), { type: 'done', message: 'Draft entered' }];
      const fixture = await modelReplyTask(t, n => modelCompletion(JSON.stringify(actions[n - 1])), {
        FIXTURE_TYPE_TEXT_ERROR: missingKeyboard,
      });
      let state;
      await until(async () => { state = await fixture.snapshot(); return state.task?.state === 'failed'; });
      assert.equal(fixture.requests.length, actions.length);
      assert.equal((await nativeCounts(fixture)).typeRequests, 1);
    });
  }
});

contract('provider model catalog is cached and each task keeps its own validated model selection', async t => {
  let catalogCalls = 0; const generated = [];
  const provider = http.createServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer fixture-catalog-key');
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/v1/models') {
      catalogCalls++;
      return res.end(JSON.stringify({ data: [
        { id: 'codex/default' }, { id: 'other/vision' }, { id: 'other/vision' },
        { id: 'other/text' }, { id: '' }, { id: 'bad\nmodel' }, { id: 'x'.repeat(257) },
      ] }));
    }
    assert.equal(req.url, '/v1/chat/completions');
    let body = ''; for await (const chunk of req) body += chunk;
    const input = JSON.parse(body); generated.push(input.model);
    await pause(50);
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ type: 'done', message: 'fixture completed' }) } }] }));
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  t.after(() => { provider.closeAllConnections(); provider.close(); });
  const app = await harness(t, { LLM_BASE_URL: `http://127.0.0.1:${provider.address().port}/v1`, LLM_MODEL: 'codex/default', LLM_API_KEY: 'fixture-catalog-key' });
  const configs = await Promise.all(Array.from({ length: 6 }, async () => (await app.api('/api/config')).json()));
  for (const config of configs) assert.deepEqual(config, { backend: 'openai', aiReady: true, model: 'codex/default', models: ['codex/default', 'other/text', 'other/vision'] });
  assert.equal(catalogCalls, 1); assert.ok(!JSON.stringify(configs).includes('fixture-catalog-key'));
  const first = await app.session(); await peer(t, first); await ready(app, first);
  const second = await app.session({ device: { ...device, serialNumber: '00008110-001234567890001F' } });
  await peer(t, second, { ...device, serialNumber: second.deviceId }); await ready(app, second);
  for (const model of ['not-listed', null, 42, '', 'bad\nmodel']) {
    const response = await app.api(`/api/sessions/${first.id}/tasks`, first.token, { instruction: 'observe fixture', model });
    assert.equal(response.status, 400);
  }
  const started = await app.api(`/api/sessions/${first.id}/tasks`, first.token, { instruction: 'observe fixture', model: 'other/vision' });
  assert.equal(started.status, 201); assert.equal((await started.json()).model, 'other/vision');
  assert.equal((await app.api(`/api/sessions/${second.id}/tasks`, second.token, { instruction: 'observe fixture' })).status, 201);
  await until(async () => (await (await app.api(`/api/sessions/${first.id}`, first.token)).json()).task?.state === 'completed');
  await until(async () => (await (await app.api(`/api/sessions/${second.id}`, second.token)).json()).task?.state === 'completed');
  assert.deepEqual(generated.sort(), ['codex/default', 'other/vision']);
  assert.equal((await (await app.api('/api/config')).json()).model, 'codex/default');
});

contract('failed or redirected model discovery preserves default use without leaking provider errors or credentials', async t => {
  let catalogs = 0, redirected = 0;
  const sink = http.createServer((_req, res) => { redirected++; res.end('{}'); });
  await new Promise(resolve => sink.listen(0, '127.0.0.1', resolve));
  const provider = http.createServer((req, res) => {
    if (req.url.endsWith('/models')) {
      catalogs++; res.writeHead(302, { Location: `http://127.0.0.1:${sink.address().port}/secret` });
      return res.end('private provider error and fixture-secret');
    }
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ type: 'done', message: 'fixture completed' }) } }] }));
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  t.after(() => { provider.closeAllConnections(); provider.close(); sink.closeAllConnections(); sink.close(); });
  const app = await harness(t, { LLM_BASE_URL: `http://127.0.0.1:${provider.address().port}/v1`, LLM_MODEL: 'default', LLM_API_KEY: 'fixture-secret' });
  for (let i = 0; i < 2; i++) {
    const config = await (await app.api('/api/config')).json();
    assert.deepEqual(config.models, ['default']); assert.ok(config.modelsError);
    assert.ok(!JSON.stringify(config).includes('fixture-secret')); assert.ok(!JSON.stringify(config).includes('private provider'));
  }
  assert.equal(catalogs, 1); assert.equal(redirected, 0);
  const s = await app.session(); await peer(t, s); await ready(app, s);
  const started = await app.api(`/api/sessions/${s.id}/tasks`, s.token, { instruction: 'observe fixture', model: 'default' });
  assert.equal(started.status, 201);
  await until(async () => (await (await app.api(`/api/sessions/${s.id}`, s.token)).json()).task?.state === 'completed');
});

contract('preview avoids accessibility snapshots and observation bounds slow element reads', async t => {
  const app = await harness(t, { FIXTURE_ELEMENTS_DELAY_MS: '4000' });
  const s = await app.session(); await peer(t, s); await ready(app, s);
  const route = `/api/sessions/${s.id}`;
  const preview = await app.api(route + '/preview', s.token);
  assert.equal(preview.status, 200);
  const frame = await preview.json(); assert.equal(frame.imageBase64, fixtureImageBase64);
  const stats = await (await app.api(route + '/command', s.token, { requestId: 'counts', deviceId: s.deviceId, tool: 'iphone_status' })).json();
  assert.deepEqual(JSON.parse(stats.text).counts, { screenshot: 1, list_elements: 0, launch_app: 0, terminate_app: 0, press_button: 0 });
  const observation = await (await app.api(route + '/screen', s.token)).json();
  assert.equal(observation.imageBase64, fixtureImageBase64); assert.ok(observation.elementsError);
  assert.ok(observation.timings.elementsMs >= 1000 && observation.timings.elementsMs < 3000, JSON.stringify(observation.timings));
  t.diagnostic(`slow 4000 ms element fixture returned after ${observation.timings.elementsMs} ms; preview used zero element reads`);
});

contract('AI previews reuse its observation and query text plus screenshot crops reach the next model call', async t => {
  let calls = 0, release;
  const bodies = [];
  const provider = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    bodies.push(JSON.parse(body)); calls++;
    const reply = calls === 1
      ? { type: 'action', tool: 'iphone_list_apps', args: {}, reason: 'Find fixture app' }
      : calls === 2 ? { type: 'action', tool: 'iphone_screenshot', args: { x: 0, y: 0, width: 100, height: 100 }, reason: 'Read crop' }
      : { type: 'done', message: 'Fixture completed' };
    const send = () => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(reply) } }] })); };
    if (calls === 1) release = send; else send();
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  t.after(() => { provider.closeAllConnections(); provider.close(); });
  const app = await harness(t, { LLM_BASE_URL: `http://127.0.0.1:${provider.address().port}/v1`, LLM_MODEL: 'fixture', LLM_API_KEY: 'fixture-only' });
  const s = await app.session(); await peer(t, s); await ready(app, s);
  const route = `/api/sessions/${s.id}`;
  await app.api(route + '/tasks', s.token, { instruction: 'Inspect fixture app' });
  await until(() => !!release);
  const count = async requestId => JSON.parse((await (await app.api(route + '/command', s.token, { requestId, deviceId: s.deviceId, tool: 'iphone_status' })).json()).text).counts;
  const before = await count('before-preview');
  const previews = await Promise.all(Array.from({ length: 12 }, () => app.api(route + '/preview', s.token).then(r => r.json())));
  assert.ok(previews.every(p => p.imageBase64 === fixtureImageBase64));
  assert.deepEqual(await count('after-preview'), before, 'active AI previews must not issue screenshot or element requests');
  release();
  let state;
  await until(async () => { state = await (await app.api(route, s.token)).json(); return ['completed', 'failed'].includes(state.task?.state); });
  assert.equal(state.task.state, 'completed', JSON.stringify(state.task)); assert.equal(calls, 3);
  const firstObservation = JSON.parse(bodies[0].messages[1].content[0].text).observation;
  assert.equal(firstObservation.ocr.coordinateSpace, 'phonePoints');
  assert.equal(firstObservation.ocr.lines[0].text, 'Fixture screen');
  assert.equal(firstObservation.elementsText, undefined);
  const second = JSON.parse(bodies[1].messages[1].content[0].text);
  assert.match(second.recentHistory[0].result.text, /com.example.fixture/);
  assert.equal(bodies[1].messages[1].content.filter(p => p.type === 'image_url').length, 0, 'read-only text lookup needs no new image');
  assert.equal(bodies[2].messages[1].content.filter(p => p.type === 'image_url').length, 0);
  assert.equal(JSON.parse(bodies[2].messages[1].content[0].text).observation.ocr.lines[0].text, 'Fixture screen');
  assert.deepEqual(await count('final-counts'), { screenshot: 2, list_elements: 0, launch_app: 0, terminate_app: 0, press_button: 0 });
  assert.ok(!JSON.stringify(state.task).includes('com.example.fixture'), 'tool contents stay out of polled UI snapshots');
  assert.ok(state.task.timings.modelMs >= 0);
  assert.ok(state.task.steps[0].timings.actionMs >= 0);
  t.diagnostic('12 preview requests during model thinking added 0 device screenshot/element reads');
});

contract('exact home command skips initial model planning but still observes and verifies its result', async t => {
  const bodies = [];
  const provider = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk; bodies.push(JSON.parse(body));
    res.setHeader('Content-Type','application/json'); res.end(JSON.stringify({ choices:[{ message:{ content:JSON.stringify({ type:'done',message:'Fixture verified home' }) } }] }));
  });
  await new Promise(resolve => provider.listen(0,'127.0.0.1',resolve));
  t.after(() => { provider.closeAllConnections(); provider.close(); });
  const app = await harness(t, { LLM_BASE_URL:`http://127.0.0.1:${provider.address().port}/v1`, LLM_MODEL:'fixture', LLM_API_KEY:'fixture' });
  const s = await app.session(); await peer(t,s); await ready(app,s); const route = `/api/sessions/${s.id}`;
  await app.api(route + '/tasks',s.token,{ instruction:'回到主屏幕' });
  let state; await until(async () => { state = await (await app.api(route,s.token)).json(); return ['completed','failed'].includes(state.task?.state); });
  assert.equal(state.task.state,'completed',JSON.stringify(state.task)); assert.equal(bodies.length,1);
  const input = JSON.parse(bodies[0].messages[1].content[0].text);
  assert.equal(input.recentHistory[0].tool,'iphone_press_button'); assert.equal(input.recentHistory[0].args.button,'home');
  assert.equal(state.task.steps[0].timings.direct,true);
  assert.equal(bodies[0].messages[1].content.filter(p => p.type === 'image_url').length,0);
});

contract('query-only evidence cannot dispatch coordinate taps until a fresh image is obtained', async t => {
  const bodies = [];
  const replies = [
    { type:'action',tool:'iphone_list_apps',args:{},reason:'Read apps' },
    { type:'action',tool:'iphone_tap',args:{ x:999,y:999 },reason:'Unverified coordinates' },
    { type:'action',tool:'iphone_tap',args:{ x:5,y:7 },reason:'Coordinates from fresh observation' },
    { type:'done',message:'Fixture completed' },
  ];
  const provider = http.createServer(async (req,res) => {
    let body = ''; for await (const chunk of req) body += chunk; bodies.push(JSON.parse(body));
    res.setHeader('Content-Type','application/json'); res.end(JSON.stringify({ choices:[{ message:{ content:JSON.stringify(replies[bodies.length-1] || { type:'done',message:'Unexpected extra call' }) } }] }));
  });
  await new Promise(resolve => provider.listen(0,'127.0.0.1',resolve)); t.after(() => { provider.closeAllConnections(); provider.close(); });
  const app = await harness(t,{ LLM_BASE_URL:`http://127.0.0.1:${provider.address().port}/v1`,LLM_MODEL:'fixture',LLM_API_KEY:'fixture' });
  const s = await app.session(); await peer(t,s); await ready(app,s); const route = `/api/sessions/${s.id}`;
  await app.api(route + '/tasks',s.token,{ instruction:'Inspect fixture and tap' });
  let state; await until(async () => { state = await (await app.api(route,s.token)).json(); return ['completed','failed'].includes(state.task?.state); });
  assert.equal(state.task.state,'completed',JSON.stringify(state.task)); assert.equal(bodies.length,4);
  assert.equal(bodies[1].messages[1].content.filter(p => p.type === 'image_url').length,0);
  assert.equal(bodies[2].messages[1].content.filter(p => p.type === 'image_url').length,0);
  assert.deepEqual(state.task.steps.filter(p => p.tool === 'iphone_tap').map(p => p.args),[{x:5,y:7}]);
});

contract('Rust entry point preserves auth, normalized identities, setup, screenshots and command deduplication', async t => {
  const app = await harness(t);
  assert.deepEqual(await (await app.api('/api/config')).json(), { backend: 'openai', aiReady: false, model: null });
  assert.equal((await app.api('/api/sessions', 'bad', { device })).status, 401);
  assert.equal((await app.api('/api/config', token, undefined, { Origin: 'https://evil.test' })).status, 403);
  const s = await app.session({ device: { ...device, serialNumber: device.serialNumber.replace('-', '').toLowerCase() + '\0\0' } });
  assert.equal(s.deviceId, device.serialNumber);
  await peer(t, s); await ready(app, s);
  const route = `/api/sessions/${s.id}`;
  const command = { requestId: 'once', deviceId: s.deviceId, tool: 'iphone_tap', args: { x: 5, y: 7 } };
  const responses = await Promise.all(Array.from({ length: 5 }, () => app.api(route + '/command', s.token, command).then(r => r.json())));
  assert.ok(responses.every(r => JSON.parse(r.text).taps === 1));
  const echo = JSON.parse(responses[0].text);
  assert.equal(echo.request.expect_udid, device.serialNumber); assert.equal(echo.request.cancel_on_close, true); assert.equal(echo.request.lang, 'en');
  assert.equal(echo.env.ICTL_MANAGE_USBMUXD, '0');
  assert.equal((await app.api(route + '/command', s.token, { ...command, args: { x: 6, y: 7 } })).status, 409);
  assert.equal((await app.api(route + '/command', s.token, { ...command, requestId: 'foreign', deviceId: 'a'.repeat(40) })).status, 409);
  assert.equal((await app.api(route + '/command', s.token, { ...command, requestId: 'invalid', args: { x: 1, y: 2, extra: true } })).status, 400);
  const image = await (await app.api(route + '/screen', s.token)).json(); assert.equal(image.imageBase64, fixtureImageBase64); assert.equal(image.deviceId, device.serialNumber);
  assert.equal((await app.api(route + '/setup', s.token, {})).status, 200);
  await until(async () => (await (await app.api(route, s.token)).json()).setup.transcript.includes('Apple account input'));
  assert.equal((await app.api(route + '/setup/input', s.token, { line: 'private-fixture-input' })).status, 200);
  await until(async () => (await (await app.api(route, s.token)).json()).setup.state === 'complete');
  assert.ok(!(await (await app.api(route, s.token)).text()).includes('private-fixture-input'));
  assert.equal((await app.api(route, s.token, undefined, {}, 'DELETE')).status, 200);
  assert.equal((await app.api(route, s.token)).status, 404);
});

contract('Rust virtual mux interoperates with plist and relay, preserves coalesced raw data and USB MTU', async t => {
  const app = await harness(t), s = await app.session(), usb = await peer(t, s);
  await ready(app, s);
  const r = await (await app.api(`/api/sessions/${s.id}/command`, s.token, { requestId: 'env', deviceId: s.deviceId, tool: 'iphone_status' })).json();
  const address = JSON.parse(r.text).env.USBMUXD_SOCKET_ADDRESS;
  const [host, port] = address.split(':');
  const socket = net.connect(Number(port), host); t.after(() => socket.destroy()); await once(socket, 'connect');
  const payload = Buffer.from(plist.build({ MessageType: 'Connect', DeviceID: 1, PortNumber: ((8100 & 255) << 8) | (8100 >>> 8) }));
  const head = Buffer.alloc(16); [16 + payload.length, 1, 8, 123].forEach((n, i) => head.writeUInt32LE(n, i * 4));
  const raw = Buffer.alloc(140_000, 47); let received = Buffer.alloc(0);
  socket.on('data', b => { received = Buffer.concat([received, b]); });
  socket.write(Buffer.concat([head, payload, raw]));
  await until(() => received.length >= 16 && received.length >= received.readUInt32LE(0) + raw.length);
  const size = received.readUInt32LE(0); assert.equal(plist.parse(received.subarray(16, size).toString()).Number, 0);
  assert.deepEqual(received.subarray(size), raw); assert.ok(usb.chunks.every(n => n <= 49116));
});

contract('Rust resumes signing namespace exclusively and disconnect revokes tokens', async t => {
  const app = await harness(t);
  const pairRecord = { udid: device.serialNumber, pairRecordBase64: Buffer.from(plist.build({ SystemBUID: 'contract-buid' })).toString('base64') };
  const s = await app.session({ pairRecord }), usb = await peer(t, s); await ready(app, s);
  assert.equal((await app.api('/api/sessions', token, { device, pairRecord })).status, 409);
  usb.ws.close(); await once(usb.ws, 'close');
  await until(async () => (await app.api(`/api/sessions/${s.id}`, s.token)).status === 404);
  const resumed = await app.session({ pairRecord }); await peer(t, resumed); await ready(app, resumed);
  assert.notEqual(resumed.id, s.id);
});

contract('Rust task calls OCR text provider, confirms once, completes and cancels pending generation', async t => {
  let calls = 0, lastBody, hanging = false;
  const provider = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    lastBody = JSON.parse(body); calls++;
    if (hanging) return;
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(calls === 1
      ? { type: 'action', tool: 'iphone_type_text', args: { text: 'hello', submit: true }, reason: 'Submit text' }
      : { type: 'done', message: 'Finished' }) } }] }));
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  t.after(() => { provider.closeAllConnections(); provider.close(); });
  const app = await harness(t, { LLM_BASE_URL: `http://127.0.0.1:${provider.address().port}/v1`, LLM_MODEL: 'fixture-vision', LLM_API_KEY: 'fixture-secret-key' });
  const s = await app.session(); await peer(t, s); await ready(app, s); const route = `/api/sessions/${s.id}`;
  const started = await app.api(route + '/tasks', s.token, { instruction: 'submit fixture' }); assert.equal(started.status, 201); const task = await started.json();
  let state; await until(async () => { state = await (await app.api(route, s.token)).json(); return state.task?.confirmation; });
  assert.ok(lastBody.messages[1].content.every(part => part.type === 'text'));
  assert.equal(JSON.parse(lastBody.messages[1].content[0].text).observation.ocr.lines[0].text, 'Fixture screen');
  assert.equal((await app.api(`${route}/tasks/${task.id}/confirm`, s.token, { actionId: 'stale', approved: true })).status, 409);
  const decision = { actionId: state.task.confirmation.actionId, approved: true };
  assert.equal((await app.api(`${route}/tasks/${task.id}/confirm`, s.token, decision)).status, 200);
  assert.equal((await app.api(`${route}/tasks/${task.id}/confirm`, s.token, decision)).status, 409);
  await until(async () => { state = await (await app.api(route, s.token)).json(); return state.task?.state === 'completed'; });
  assert.equal(state.task.steps[0].state, 'succeeded'); assert.ok(!JSON.stringify(state).includes('fixture-secret-key'));
  hanging = true;
  const next = await (await app.api(route + '/tasks', s.token, { instruction: 'wait' })).json();
  await until(() => calls === 3);
  const stopped = await app.api(`${route}/tasks/${next.id}/stop`, s.token, {}); assert.equal(stopped.status, 200); assert.equal((await stopped.json()).state, 'stopped');
});

contract('published WebUSB SDK and BrowserClient resume through the Rust service and handle USB unplug', async t => {
  const sdk = await import('@limrun/device-install');
  const { BrowserClient } = await import('../web/client.mjs');
  const { fakeUSB } = await import('./fixtures/fake-usb.mjs');
  const app = await harness(t);
  const usb = fakeUSB(false, true);
  class USBEvents extends EventTarget {
    async requestDevice() { return usb.device; }
    disconnect() { const event = new Event('disconnect'); Object.defineProperty(event, 'device', { value: usb.device }); this.dispatchEvent(event); }
  }
  const events = new USBEvents();
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator'), originalWS = globalThis.WebSocket;
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { usb: events } });
  globalThis.WebSocket = class extends WebSocket { constructor(url) { super(url, { origin }); } };
  t.after(() => { if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator); else delete globalThis.navigator; globalThis.WebSocket = originalWS; });
  const uid = '00008140-001234567890ABCD';
  const record = { udid: uid, pairRecordBase64: Buffer.from(plist.build({ SystemBUID: 'sdk-rust-buid', HostID: 'fixture' })).toString('base64') };
  const client = new BrowserClient({ sdk: { ...sdk, getPairRecord: async () => record, putPairRecord: async () => {} }, usbEvents: events });
  t.after(() => client.disconnect());
  await client.connect({ apiBase: app.base, accessToken: token });
  const s = client.snapshot().session;
  assert.equal(client.snapshot().phase, 'connected'); assert.equal(s.deviceId, uid);
  await until(async () => (await client.refresh()).ready);
  assert.deepEqual(usb.claims[0], [6, 1]); assert.deepEqual(usb.claims.at(-1), [3, 1]);
  events.disconnect();
  assert.equal(client.snapshot().phase, 'offline');
  await until(async () => (await app.api(`/api/sessions/${s.id}`, s.token)).status === 404);
});

contract('Rust serves built frontend and excludes secrets, traversal and unsupported files', async t => {
  const app = await harness(t);
  const page = await fetch(app.base + '/'); assert.equal(page.status, 200); assert.match(page.headers.get('content-type'), /text\/html/);
  const html = await page.text(); assert.match(html, /assets\//);
  const asset = html.match(/src="([^"]+\.js)"/)[1]; assert.equal((await fetch(app.base + asset)).status, 200);
  const head = await fetch(app.base + '/', { method: 'HEAD' }); assert.equal(head.status, 200); assert.equal(await head.text(), '');
  for (const url of ['/.env', '/%2eenv', '/assets/missing.js', '/api/missing', '/%2e%2e%2fCargo.toml']) assert.equal((await fetch(app.base + url)).status, 404, url);
});

contract('Rust .env native overrides reach daemon and command results remain retired after cache eviction', async t => {
  const app = await harness(t, {}, { ICTL_ANISETTE_URL: 'https://selfhosted.fixture.invalid/' });
  const s = await app.session(); await peer(t, s); await ready(app, s);
  const route = `/api/sessions/${s.id}/command`;
  const command = { deviceId: s.deviceId, tool: 'iphone_status' };
  const first = await (await app.api(route, s.token, { ...command, requestId: 'original' })).json();
  assert.equal(JSON.parse(first.text).env.ICTL_ANISETTE_URL, 'https://selfhosted.fixture.invalid/');
  for (let i = 0; i < 256; i++) assert.equal((await app.api(route, s.token, { ...command, requestId: `evict-${i}` })).status, 200);
  const expired = await app.api(route, s.token, { ...command, requestId: 'original' });
  assert.equal(expired.status, 409); assert.match((await expired.json()).error, /cannot be replayed/);
});

contract('Rust closes stalled headers and returns a bounded body timeout', async t => {
  const app = await harness(t);
  const address = new URL(app.base);
  async function stalled(request) {
    const socket = net.connect(Number(address.port), address.hostname); t.after(() => socket.destroy());
    let bytes = ''; socket.on('data', chunk => { bytes += chunk; });
    await once(socket, 'connect'); socket.write(request);
    socket.setTimeout(22000, () => socket.destroy(new Error('read deadline was not enforced')));
    await once(socket, 'close'); return bytes;
  }
  const [header, body] = await Promise.all([
    stalled('GET /api/config HTTP/1.1\r\nHost: localhost\r\n'),
    stalled(`POST /api/sessions HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer ${token}\r\nContent-Length: 500\r\nConnection: close\r\n\r\n{`),
  ]);
  assert.ok(!header || header.includes('408'));
  assert.match(body, /408/); assert.match(body, /Request body timeout/);
});

contract('Android uses browser ADB RPC with session isolation, compressed observations, deduplication and disconnect cleanup', async t => {
  const { AndroidRelay } = await import('../web/android/relay.mjs');
  const { AndroidCommands } = await import('../web/android/core.mjs');
  const app = await harness(t);
  const android = { platform:'android', serialNumber:'R5C_ABC-123',vendorId:1256,productId:1234,productName:'Android fixture' };
  const s = await app.session({ device: android });
  assert.equal(s.deviceId,'android:R5C_ABC-123'); assert.match(s.relayUrl,/\/device\/ws\?/);
  const duplicate = await app.api('/api/sessions',token,{device:android}); assert.equal(duplicate.status,409);
  const calls=[];
  const commands = new AndroidCommands({deviceId:s.deviceId,delay:async()=>{},
    shell:async command=>{calls.push(command);if(command.startsWith('uiautomator'))return '<hierarchy><node text="设置" enabled="true" bounds="[0,0][100,100]"/></hierarchy>';return '';},
    capture:async()=>({imageBase64:'anBlZw==',caption:'Android full screen 576x1280',view:{width:576,height:1280,nativeWidth:1080,nativeHeight:2400},sourceBytes:1000000,uploadedBytes:90000}),
    controller:{setClipboard:async value=>calls.push(value.content)},
  });
  const ws = new WebSocket(s.relayUrl,{origin});
  const relay = new AndroidRelay(ws,s.deviceId,(request,signal)=>commands.execute(request,signal));
  t.after(()=>relay.close());
  await once(ws,'open');
  ws.send(encodeFrame({type:1,payload:jsonPayload({...android,serialNumber:s.deviceId})}));await relay.ready;
  const state = await ready(app,s);assert.equal(state.platform,'android');assert.equal(state.daemon.state.state,'ready');assert.equal(state.setup.state,'complete');
  const route=`/api/sessions/${s.id}`;
  const screen=await (await app.api(route+'/screen',s.token)).json();
  assert.equal(screen.imageBase64,'anBlZw==');assert.match(screen.elementsText,/设置/);assert.equal(screen.deviceId,s.deviceId);
  const body={requestId:'unicode',deviceId:s.deviceId,tool:'iphone_type_text',args:{text:'你好安卓',submit:false}};
  const response=await app.api(route+'/command',s.token,body);assert.equal(response.status,200);assert.equal((await response.json()).kind,'text');
  assert.equal((await app.api(route+'/command',s.token,body)).status,200);assert.equal(calls.filter(c=>c==='你好安卓').length,1,'duplicate HTTP request must not type twice');
  assert.equal((await app.api(route+'/command',s.token,{...body,requestId:'wrong-device',deviceId:'android:OTHER'})).status,409);
  assert.equal((await app.api(route+'/command',token,body)).status,401,'controller token cannot control a session');
  const disconnected=once(ws,'close');relay.close();await disconnected;
  await until(async()=>[404,410].includes((await app.api(route,s.token)).status));
  const replacement=await app.session({device:android});assert.notEqual(replacement.id,s.id);
});

contract('Android AI tasks observe the Android device and require confirmation before Unicode submit', async t => {
  const { AndroidRelay } = await import('../web/android/relay.mjs');
  const { AndroidCommands } = await import('../web/android/core.mjs');
  const bodies=[];
  const provider=http.createServer(async (request,response)=>{
    let body='';for await(const chunk of request) body+=chunk;
    bodies.push(JSON.parse(body));
    const action=bodies.length===1 ? {type:'action',tool:'iphone_type_text',args:{text:'你好，安卓 👋',submit:true},reason:'输入用户指定的中文并提交'} : {type:'done',message:'已观察提交后的 Android 页面'};
    response.setHeader('Content-Type','application/json');response.end(JSON.stringify({choices:[{message:{content:JSON.stringify(action)}}]}));
  });
  await new Promise(resolve=>provider.listen(0,'127.0.0.1',resolve));
  t.after(()=>{provider.closeAllConnections();provider.close();});
  const app=await harness(t,{LLM_BASE_URL:`http://127.0.0.1:${provider.address().port}/v1`,LLM_MODEL:'fixture',LLM_API_KEY:'fixture-only'});
  const selected={platform:'android',serialNumber:'AI_TEST',vendorId:1256,productId:1234};
  const s=await app.session({device:selected});
  const typed=[],keys=[];let captures=0;
  const commands=new AndroidCommands({deviceId:s.deviceId,delay:async()=>{},
    controller:{setClipboard:async message=>typed.push(message.content)},
    shell:async command=>{if(command.startsWith('input keyevent')) keys.push(command);return '<hierarchy><node text="结果" bounds="[0,0][100,100]"/></hierarchy>';},
    capture:async()=>{captures++;return {imageBase64:fixtureImageBase64,caption:'Android full screen 576x1280',view:{width:576,height:1280,nativeWidth:1080,nativeHeight:2400},sourceBytes:1000000,uploadedBytes:90000};},
  });
  const ws=new WebSocket(s.relayUrl,{origin});
  const relay=new AndroidRelay(ws,s.deviceId,(request,signal)=>commands.execute(request,signal));
  t.after(()=>relay.close());await once(ws,'open');
  ws.send(encodeFrame({type:1,payload:jsonPayload(selected)}));await relay.ready;await ready(app,s);
  const route=`/api/sessions/${s.id}`;
  assert.equal((await app.api(route+'/tasks',s.token,{instruction:'输入你好，安卓并提交'})).status,201);
  let state;
  await until(async()=>{state=await(await app.api(route,s.token)).json();return state.task?.state==='awaiting_confirmation';});
  assert.deepEqual(typed,[]);assert.deepEqual(keys,[]);
  const task=state.task;
  assert.equal((await app.api(route+`/tasks/${task.id}/confirm`,s.token,{actionId:task.confirmation.actionId,approved:true})).status,200);
  await until(async()=>{state=await(await app.api(route,s.token)).json();return ['completed','failed'].includes(state.task?.state);});
  assert.equal(state.task.state,'completed',JSON.stringify(state.task));
  assert.deepEqual(typed,['你好，安卓 👋']);assert.deepEqual(keys,['input keyevent 66']);assert.equal(captures,2);
  assert.equal(bodies.length,2);assert.match(JSON.parse(bodies[0].messages[1].content[0].text).observation.caption,/Android/);
  assert.equal(state.deviceId,'android:AI_TEST');assert.equal(state.setup.state,'complete');
});

contract('Rust serves WASM GET and HEAD with streaming MIME and rejects missing modules', async t => {
  const app = await harness(t);
  const files = await readdir(fileURLToPath(new URL('../dist/assets', import.meta.url)));
  const wasm = files.find(name => name.endsWith('.wasm'));
  assert.ok(wasm, 'production build must contain a real WASM module');
  const route = '/assets/' + wasm;
  const response = await fetch(app.base + route);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/wasm');
  const bytes = new Uint8Array(await response.arrayBuffer());
  assert.deepEqual([...bytes.slice(0, 4)], [0, 97, 115, 109]);
  const head = await fetch(app.base + route, { method: 'HEAD' });
  assert.equal(head.headers.get('content-type'), 'application/wasm');
  assert.equal(Number(head.headers.get('content-length')), bytes.length);
  assert.equal(await head.text(), '');
  assert.equal((await fetch(app.base + '/assets/missing.wasm')).status, 404);
});

contract('MJPEG descriptor requires session credentials and preview ticket cannot authorize commands', async t => {
  const app = await harness(t);
  const session = await app.session();
  await peer(t, session); await ready(app, session);
  const route = `/api/sessions/${session.id}`;
  assert.equal((await app.api(route + '/preview/stream', 'wrong')).status, 401);
  const descriptor = await app.api(route + '/preview/stream', session.token);
  assert.equal(descriptor.status, 200);
  const { url } = await descriptor.json();
  assert.ok(url.startsWith(route + '/preview/mjpeg/'));
  assert.ok(!url.includes(session.token));
  const ticket = url.split('/').at(-1);
  assert.equal((await app.api(route, ticket)).status, 401);
  assert.equal((await app.api(route + '/preview/mjpeg/invalid', session.token)).status, 401);
  assert.equal((await app.api(url, '', undefined, { Origin: 'https://evil.test' })).status, 403);
  await app.api(route, session.token, undefined, {}, 'DELETE');
  assert.ok([401, 404].includes((await app.api(url, '')).status));
});

contract('tasks have no step limit and run past one hundred actions until completion', async t => {
  const fixture = await modelReplyTask(t, call => modelCompletion(JSON.stringify(call > 120
    ? { type: 'done', message: '120 verified' }
    : { type: 'action', tool: 'iphone_status', args: {}, reason: 'Read fixture status' })));
  let state;
  await until(async () => { state = await fixture.snapshot(); return ['completed', 'failed'].includes(state.task?.state); }, 1500);
  assert.equal(state.task.state, 'completed', JSON.stringify(state.task.error));
  assert.equal(state.task.steps.length, 120);
  assert.equal(state.task.message, '120 verified');
  assert.equal(state.task.maxSteps, undefined);
});

contract('task attachments validate image bytes, enforce ownership and reach model as separate references', async t => {
  const fixture = await modelReplyTask(t, () => modelCompletion(JSON.stringify({ type: 'done', message: 'Reference verified' })));
  await until(async () => (await fixture.snapshot()).task?.state === 'completed');
  const app = fixture.app, s = fixture.session, route = fixture.route;
  const photo = { name: 'posting.png', mimeType: 'image/png', dataBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC' };
  assert.equal((await app.api(route + '/attachments', 'wrong', photo)).status, 401);
  assert.equal((await app.api(route + '/attachments', s.token, { ...photo, dataBase64: 'dGV4dA==' })).status, 400);
  const response = await app.api(route + '/attachments', s.token, photo);
  assert.equal(response.status, 201, await response.clone().text());
  const attachment = await response.json();
  assert.equal(attachment.name, 'posting.png'); assert.equal(attachment.mimeType, 'image/png');
  const other = await app.session();
  assert.equal((await app.api(`/api/sessions/${other.id}/tasks`, other.token, { instruction: 'Inspect', attachments: [attachment.id] })).status, 404);
  const start = await app.api(route + '/tasks', s.token, { instruction: 'Inspect reference picture', attachments: [attachment.id] });
  assert.equal(start.status, 201);
  await until(async () => (await fixture.snapshot()).task?.state === 'completed');
  const payload = fixture.requests.at(-1);
  const content = payload.messages[1].content;
  assert.equal(content.filter(c => c.type === 'image_url').length, 0);
  const input = JSON.parse(content[0].text);
  assert.equal(input.referenceImages[0].ocr.lines[0].text, 'Fixture screen');
  assert.equal(input.referenceImages[0].ocr.coordinateSpace, 'referenceImagePixels');
  assert.ok(!JSON.stringify(payload).includes(photo.dataBase64));
  assert.ok(!JSON.stringify(payload).includes(fixtureImageBase64));
  assert.ok(!JSON.stringify(payload).includes('phoneImageUrl'));
  assert.match(JSON.stringify(content), /posting.png/);
  const state = await fixture.snapshot();
  assert.ok(!JSON.stringify(state).includes(photo.dataBase64));
  assert.equal((await app.api(route + '/attachments/' + attachment.id, s.token, undefined, {}, 'DELETE')).status, 200);
  assert.equal((await app.api(route + '/tasks', s.token, { instruction: 'Inspect', attachments: [attachment.id] })).status, 404);
});

contract('MJPEG preview receives independent USB frames while model is thinking and closes on disconnect', async t => {
  const fixture = await modelReplyTask(t, () => null);
  const { app, session: first } = fixture;
  await app.api(fixture.route, first.token, undefined, {}, 'DELETE');
  const s = await app.session();
  const ws = new WebSocket(s.relayUrl, { origin });
  const ports = new Map(); const intervals = [];
  const closedStreams = new Set();
  ws.on('message', bytes => {
    const f = decodeFrame(bytes);
    if (f.type === F.StreamClose) closedStreams.add(f.streamId);
    if (f.type === F.OpenStream) {
      ports.set(f.streamId, JSON.parse(f.payload).port);
      ws.send(encodeFrame({ type: F.OpenResult, requestId: f.requestId, streamId: f.streamId, payload: jsonPayload({ ok: true }) }));
    }
    if (f.type === F.StreamData && ports.get(f.streamId) === 9100) {
      assert.match(f.payload.toString(), /GET \/ HTTP/);
      const send = bytes => { if (ws.readyState === WebSocket.OPEN) ws.send(encodeFrame({ type: F.StreamData, streamId: f.streamId, payload: bytes })); };
      send(Buffer.from('HTTP/1.0 200 OK\r\nContent-Type: multipart/x-mixed-replace; boundary=frame\r\n\r\n'));
      const image = Buffer.from([255,216,255,217]);
      const frame = Buffer.concat([Buffer.from('--frame\r\nContent-Type: image/jpeg\r\nContent-Length: 4\r\n\r\n'), image, Buffer.from('\r\n')]);
      send(frame); intervals.push(setInterval(() => send(frame), 60));
    }
  });
  t.after(() => { for (const timer of intervals) clearInterval(timer); ws.terminate(); });
  await once(ws, 'open'); ws.send(encodeFrame({ type: F.DeviceHello, payload: jsonPayload(device) }));
  await ready(app, s);
  const route = `/api/sessions/${s.id}`;
  await app.api(route + '/tasks', s.token, { instruction: 'Inspect reference safely' });
  await until(async () => (await (await app.api(route, s.token)).json()).task?.state === 'thinking');
  const descriptor = await (await app.api(route + '/preview/stream', s.token)).json();
  const response = await fetch(app.base + descriptor.url);
  assert.equal(response.status, 200); assert.match(response.headers.get('content-type'), /multipart\/x-mixed-replace/);
  assert.equal(response.headers.get('x-accel-buffering'), 'no');
  const reader = response.body.getReader(); const received = await reader.read();
  assert.ok(Buffer.from(received.value).includes(Buffer.from([255,216,255,217])));
  const state = await (await app.api(route, s.token)).json();
  assert.equal(state.task.state, 'thinking'); assert.equal(state.preview.state, 'streaming'); assert.ok(state.preview.frames >= 1);
  assert.equal((await app.api(route + '/preview/stream', 'wrong-token', undefined, {}, 'DELETE')).status, 401);
  const stopped = await app.api(route + '/preview/stream', s.token, undefined, {}, 'DELETE');
  assert.equal(stopped.status, 200);
  await until(() => [...closedStreams].some(id => ports.get(id) === 9100));
  let ended = false;
  for (let i = 0; i < 10; i++) { if ((await reader.read()).done) { ended = true; break; } }
  assert.ok(ended, 'explicit stop must close the HTTP body even if the browser/proxy keeps it open');
  assert.equal(ws.readyState, WebSocket.OPEN);
  assert.equal((await (await app.api(route, s.token)).json()).preview.state, 'waiting');
  const resumed = await fetch(app.base + descriptor.url);
  assert.equal(resumed.status, 200);
  const resumedReader = resumed.body.getReader();
  assert.ok(Buffer.from((await resumedReader.read()).value).includes(Buffer.from([255,216,255,217])));
  ws.close(); await once(ws, 'close');
  for (let i = 0; i < 10; i++) { if ((await resumedReader.read()).done) return; }
  assert.fail('preview did not close with its owning session');
});

contract('control boundaries force bounded capture despite low latency opt-out', async t => {
  const app = await harness(t, { ICTL_LOW_LATENCY: '0', ICTL_CAPTURE_POLICY: 'local' });
  const session = await app.session(); await peer(t, session); await ready(app, session);
  const response = await app.api(`/api/sessions/${session.id}/command`, session.token, { deviceId: session.deviceId, requestId: 'capture-policy', tool: 'iphone_status' });
  const echo = JSON.parse((await response.json()).text);
  assert.equal(echo.env.ICTL_LOW_LATENCY, '0');
  assert.equal(echo.env.ICTL_CAPTURE_POLICY, 'bounded-remote');
});

contract('control boundaries hold task ownership through model and confirmation waits', async t => {
  for (const confirmation of [false, true]) await t.test(confirmation ? 'confirmation wait' : 'model wait', async t => {
    let release;
    const modelGate = new Promise(resolve => { release = resolve; });
    const action = { type: 'action', tool: 'iphone_tap', args: { x: 5, y: 7 }, reason: 'Inspect fixture screen', requiresConfirmation: confirmation };
    const fixture = await modelReplyTask(t, async call => {
      if (call === 1 && !confirmation) await modelGate;
      return modelCompletion(JSON.stringify(call === 1 ? action : { type: 'done', message: 'Verified fixture' }));
    });
    let state;
    await until(async () => { state = await fixture.snapshot(); return confirmation ? state.task?.state === 'awaiting_confirmation' : fixture.requests.length === 1; });
    const command = (requestId, tool, args = {}) => fixture.app.api(fixture.route + '/command', fixture.session.token, { requestId, deviceId: fixture.session.deviceId, tool, args, taskId: fixture.task.id, action_deadline_monotonic_ns: Number.MAX_SAFE_INTEGER });
    const before = JSON.parse((await (await command('before', 'iphone_status')).json()).text);
    for (const [tool, args] of [ ['iphone_tap', { x: 5, y: 7 }], ['iphone_launch_app', { app: 'com.example.fixture' }], ['iphone_screenshot', {}], ['iphone_list_elements', {}], ['iphone_wait_for', { text: 'fixture' }] ]) {
      const denied = await command('denied-' + tool, tool, args);
      assert.equal(denied.status, 409, await denied.clone().text());
    }
    const setup = await fixture.app.api(fixture.route + '/setup', fixture.session.token, {});
    assert.equal(setup.status, 409, await setup.clone().text());
    assert.match((await setup.json()).error, /owns session control/i);
    const setupInput = await fixture.app.api(fixture.route + '/setup/input', fixture.session.token, { line: 'fixture input' });
    assert.equal(setupInput.status, 409);
    assert.match((await setupInput.json()).error, /owns session control/i);
    assert.equal((await fixture.app.api(fixture.route + '/screen', fixture.session.token)).status, 409);
    assert.equal((await fixture.app.api(fixture.route + '/preview', fixture.session.token)).status, 200);
    const after = JSON.parse((await (await command('after', 'iphone_status')).json()).text);
    assert.equal(after.taps, before.taps);
    assert.deepEqual(after.counts, before.counts);
    if (confirmation) {
      assert.equal((await fixture.app.api(`${fixture.route}/tasks/${fixture.task.id}/confirm`, fixture.session.token, { actionId: state.task.confirmation.actionId, approved: true })).status, 200);
    } else release();
    await until(async () => { state = await fixture.snapshot(); return ['completed', 'failed'].includes(state.task?.state); });
    assert.equal(state.task.state, 'completed', JSON.stringify(state.task));
    const fresh = await command('manual-after-release', 'iphone_tap', { x: 3, y: 4 });
    assert.equal(fresh.status, 200, await fresh.clone().text());
    const result = await fresh.json();
    assert.equal(JSON.parse(result.text).taps, 2);
    const duplicate = await command('manual-after-release', 'iphone_tap', { x: 3, y: 4 });
    assert.deepEqual(await duplicate.json(), result);
  });
});

contract('control boundaries prevent task claim from overtaking admitted manual observation', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const fixture = await modelReplyTask(t, async () => { await gate; return modelCompletion(JSON.stringify({ type: 'done', message: 'Cancelled initial fixture' })); }, { FIXTURE_ELEMENTS_DELAY_MS: '700' });
  await until(() => fixture.requests.length === 1);
  await fixture.app.api(`${fixture.route}/tasks/${fixture.task.id}/stop`, fixture.session.token, {});
  release();
  await pause(30);
  const screen = fixture.app.api(fixture.route + '/screen', fixture.session.token);
  await pause(80);
  const blocked = await fixture.app.api(fixture.route + '/tasks', fixture.session.token, { instruction: 'Inspect queued control fairly' });
  assert.equal(blocked.status, 409, await blocked.clone().text());
  assert.equal((await screen).status, 200);
  const fresh = await fixture.app.api(fixture.route + '/tasks', fixture.session.token, { instruction: 'Inspect after manual completion' });
  assert.equal(fresh.status, 201, await fresh.clone().text());
});

contract('control boundaries anchor action age before reading the HTTP body', async t => {
  const app = await harness(t); const session = await app.session();
  await peer(t, session); await ready(app, session);
  const payload = JSON.stringify({ deviceId: session.deviceId, requestId: 'slow-http-body', tool: 'iphone_tap', args: { x: 5, y: 7 } });
  const response = await new Promise((resolve, reject) => {
    const request = http.request(app.base + `/api/sessions/${session.id}/command`, { method: 'POST', headers: { Authorization: `Bearer ${session.token}`, 'Content-Type': 'application/json' } }, res => {
      let body = ''; res.on('data', bytes => { body += bytes; }); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
    });
    request.on('error', reject); request.write(payload.slice(0, 12));
    setTimeout(() => request.end(payload.slice(12)), 150);
  });
  assert.equal(response.status, 200);
  assert.ok(response.body.timings.queueMs >= 100, `HTTP body wait missing from action age: ${JSON.stringify(response.body.timings)}`);
});

contract('control boundaries keep setup child admission until input and completion', async t => {
  const fixture = await modelReplyTask(t, () => modelCompletion(JSON.stringify({ type: 'done', message: 'Initial task complete' })));
  await until(async () => (await fixture.snapshot()).task?.state === 'completed');
  await pause(30);
  assert.equal((await fixture.app.api(fixture.route + '/setup', fixture.session.token, {})).status, 200);
  const blocked = await fixture.app.api(fixture.route + '/tasks', fixture.session.token, { instruction: 'Inspect while setup waits' });
  assert.equal(blocked.status, 409, await blocked.clone().text());
  assert.equal((await fixture.app.api(fixture.route + '/setup/input', fixture.session.token, { line: 'fixture input' })).status, 200);
  await until(async () => (await fixture.snapshot()).setup?.state === 'complete');
  const fresh = await fixture.app.api(fixture.route + '/tasks', fixture.session.token, { instruction: 'Inspect after setup completion' });
  assert.equal(fresh.status, 201, await fresh.clone().text());
});

contract('control boundaries retain task ownership during WDA recovery and release on stop', async t => {
  const fixture = await modelReplyTask(t, () => modelCompletion(JSON.stringify({ type: 'action', tool: 'iphone_tap', args: { x: 5, y: 7 }, reason: 'Inspect fixture screen' })), { FIXTURE_TAP_WDA_FAILURES: '1', FIXTURE_WDA_RECOVERY_MS: '300000' });
  await until(async () => (await fixture.snapshot()).task?.state === 'recovering');
  const command = (requestId, tool, args = {}) => fixture.app.api(fixture.route + '/command', fixture.session.token, { requestId, deviceId: fixture.session.deviceId, tool, args });
  const blocked = await command('during-recovery', 'iphone_tap', { x: 3, y: 4 });
  assert.equal(blocked.status, 409);
  assert.equal(JSON.parse((await (await command('recovery-status', 'iphone_status')).json()).text).taps, 1);
  await fixture.app.api(`${fixture.route}/tasks/${fixture.task.id}/stop`, fixture.session.token, {});
  await pause(30);
  const fresh = await command('after-recovery-stop', 'iphone_tap', { x: 3, y: 4 });
  assert.equal(fresh.status, 200, await fresh.clone().text());
  assert.equal(JSON.parse((await fresh.json()).text).taps, 2);
  assert.equal(fixture.requests.length, 1);
});

contract('control boundaries block websocket pairing setup while a task owns control', async t => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const fixture = await modelReplyTask(t, async () => { await gate; return modelCompletion(JSON.stringify({ type: 'done', message: 'Fixture done' })); });
  await until(() => fixture.requests.length === 1);
  const errors = [];
  fixture.usb.ws.on('message', bytes => { const frame = decodeFrame(bytes); if (frame.type === F.Error && frame.requestId === 55) errors.push(JSON.parse(frame.payload.toString())); });
  fixture.usb.ws.send(encodeFrame({ type: F.StartPairing, requestId: 55 }));
  await pause(150);
  assert.equal((await fixture.snapshot()).setup.state, 'idle', 'pairing must not start native setup while task owns session');
  assert.equal(errors.length, 1);
  assert.match(errors[0].error, /control/i);
  assert.equal(fixture.usb.ws.readyState, WebSocket.OPEN);
  release();
  await until(async () => (await fixture.snapshot()).task?.state === 'completed');
});

contract('OCR-only planning skips automatic WDA elements and retains text geometry', async t => {
  const fixture = await modelReplyTask(t, () => modelCompletion(JSON.stringify({ type: 'done', message: 'OCR verified' })));
  let state;
  await until(async () => { state = await fixture.snapshot(); return ['completed', 'failed'].includes(state.task?.state); });
  assert.equal(state.task.state, 'completed', JSON.stringify(state.task));
  assert.equal((await nativeCounts(fixture)).counts.list_elements, 0);
  const payload = fixture.requests[0];
  const input = JSON.parse(payload.messages[1].content[0].text);
  assert.equal(input.observation.ocr.width, 390);
  assert.equal(input.observation.ocr.height, 844);
  assert.deepEqual(input.observation.ocr.lines[0].phonePolygon, [[0, 0], [390, 0], [390, 844], [0, 844]]);
  assert.equal(input.observation.elementsText, undefined);
  assert.ok(!JSON.stringify(payload).includes(fixtureImageBase64));
  assert.ok(!JSON.stringify(payload).includes('image_url'));
});

contract('OCR failure stops the task before the model receives any request', async t => {
  const fixture = await modelReplyTask(t, () => modelCompletion(JSON.stringify({ type: 'done', message: 'Unexpected' })), {
    FIXTURE_OCR_ERROR: '1',
  });
  let state;
  await until(async () => { state = await fixture.snapshot(); return ['completed', 'failed'].includes(state.task?.state); });
  assert.equal(state.task.state, 'failed', JSON.stringify(state.task));
  assert.match(state.task.error, /OCR/i);
  assert.equal(fixture.requests.length, 0);
});

contract('default image planning sends a screenshot without starting OCR', async t => {
  const fixture = await modelReplyTask(t, () => modelCompletion(JSON.stringify({ type: 'done', message: 'Image verified' })), {
    AI_OBSERVATION: '', FIXTURE_OCR_ERROR: '1',
  });
  let state;
  await until(async () => { state = await fixture.snapshot(); return ['completed', 'failed'].includes(state.task?.state); });
  assert.equal(state.task.state, 'completed', JSON.stringify(state.task));
  assert.equal(fixture.requests.length, 1);
  const content = fixture.requests[0].messages[1].content;
  assert.equal(content.filter(part => part.type === 'image_url').length, 1);
  assert.equal(JSON.parse(content[0].text).observation.ocr, undefined);
});

contract('a model plan runs predictable actions from one observation and one model call', async t => {
  const plan = { type: 'plan', actions: [
    { tool: 'iphone_tap', args: { x: 20, y: 50 }, reason: 'Focus the fixture field' },
    { tool: 'iphone_type_text', args: { text: 'fixture', submit: false }, reason: 'Enter the fixture text' },
    { tool: 'iphone_press_button', args: { button: 'home' }, reason: 'Return home' },
  ] };
  const fixture = await modelReplyTask(t, call => modelCompletion(JSON.stringify(call === 1 ? plan : { type: 'done', message: 'Plan verified' })));
  let state;
  await until(async () => { state = await fixture.snapshot(); return ['completed', 'failed'].includes(state.task?.state); });
  assert.equal(state.task.state, 'completed', JSON.stringify(state.task));
  assert.deepEqual(state.task.steps.map(step => [step.tool, step.state, step.planned]), [
    ['iphone_tap', 'succeeded', false], ['iphone_type_text', 'succeeded', true], ['iphone_press_button', 'succeeded', true],
  ]);
  assert.equal(fixture.requests.length, 2);
  assert.deepEqual(state.task.plan, []);
  const history = JSON.parse(fixture.requests[1].messages[1].content[0].text).recentHistory;
  assert.deepEqual(history.map(entry => entry.tool), ['iphone_tap', 'iphone_type_text', 'iphone_press_button']);
});

contract('a model plan stops before a later coordinate action and re-observes', async t => {
  const plan = { type: 'plan', actions: [
    { tool: 'iphone_tap', args: { x: 5, y: 7 }, reason: 'Open the fixture item' },
    { tool: 'iphone_tap', args: { x: 6, y: 8 }, reason: 'Stale coordinate fixture tap' },
  ] };
  const fixture = await modelReplyTask(t, call => modelCompletion(JSON.stringify(call === 1 ? plan : { type: 'done', message: 'Re-observed' })));
  let state;
  await until(async () => { state = await fixture.snapshot(); return ['completed', 'failed'].includes(state.task?.state); });
  assert.equal(state.task.state, 'completed', JSON.stringify(state.task));
  assert.deepEqual(state.task.steps.map(step => step.args), [{ x: 5, y: 7 }]);
  assert.equal(fixture.requests.length, 2);
  assert.equal((await nativeCounts(fixture)).taps, 1);
});

contract('a goal update during planning re-plans from the same screen for the new goal', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  const fixture = await modelReplyTask(t, async call => {
    if (call === 1) {
      await gate;
      return modelCompletion(JSON.stringify({ type: 'action', tool: 'iphone_tap', args: { x: 5, y: 7 }, reason: 'Old goal tap' }));
    }
    return modelCompletion(JSON.stringify({ type: 'done', message: 'New goal verified' }));
  });
  await until(() => fixture.requests.length === 1);
  const url = `${fixture.route}/tasks/${fixture.task.id}/instruction`;
  for (const invalid of [{}, { instruction: '' }, { instruction: 'x'.repeat(4001) }, { instruction: 'ok', extra: true }]) {
    assert.equal((await fixture.app.api(url, fixture.session.token, invalid)).status, 400, JSON.stringify(invalid).slice(0, 40));
  }
  assert.equal((await fixture.app.api(`${fixture.route}/tasks/missing/instruction`, fixture.session.token, { instruction: 'x' })).status, 404);
  const updated = await fixture.app.api(url, fixture.session.token, { instruction: 'New fixture goal' });
  assert.equal(updated.status, 200, await updated.clone().text());
  assert.equal((await updated.json()).instruction, 'New fixture goal');
  let state;
  await until(async () => { state = await fixture.snapshot(); return ['completed', 'failed'].includes(state.task?.state); });
  assert.equal(state.task.state, 'completed', JSON.stringify(state.task));
  assert.equal(state.task.message, 'New goal verified');
  assert.equal(state.task.steps.length, 0);
  assert.equal(state.task.instructionUpdates.length, 1);
  assert.equal(state.task.instructionUpdates[0].previous, 'Inspect the fixture safely');
  // The first done after a goal update is returned once so the model plans for the new goal.
  assert.equal(fixture.requests.length, 3);
  assert.equal(JSON.parse(fixture.requests[2].messages[1].content[0].text).recentHistory.at(-1).state, 'rejected');
  const instruction = JSON.parse(fixture.requests[1].messages[1].content[0].text).instruction;
  assert.match(instruction, /CURRENT GOAL[^\n]*New fixture goal/);
  assert.match(instruction, /Inspect the fixture safely/);
  const counts = await nativeCounts(fixture);
  assert.equal(counts.taps, 0);
  assert.equal(counts.counts.screenshot, 1, 'the second plan reuses the first observation');
  assert.equal((await fixture.app.api(url, fixture.session.token, { instruction: 'Too late' })).status, 409);
});

contract('a goal update voids an action awaiting confirmation without sending it', async t => {
  const fixture = await modelReplyTask(t, call => modelCompletion(JSON.stringify(call === 1
    ? { type: 'action', tool: 'iphone_tap', args: { x: 5, y: 7 }, reason: 'Fixture tap needing confirmation', requiresConfirmation: true }
    : { type: 'done', message: 'Confirmation voided' })));
  let state;
  await until(async () => { state = await fixture.snapshot(); return state.task?.state === 'awaiting_confirmation'; });
  const actionId = state.task.confirmation.actionId;
  const updated = await fixture.app.api(`${fixture.route}/tasks/${fixture.task.id}/instruction`, fixture.session.token, { instruction: 'Do not tap' });
  assert.equal(updated.status, 200, await updated.clone().text());
  await until(async () => { state = await fixture.snapshot(); return ['completed', 'failed'].includes(state.task?.state); });
  assert.equal(state.task.state, 'completed', JSON.stringify(state.task));
  assert.deepEqual(state.task.steps.map(step => step.state), ['cancelled']);
  assert.equal(state.task.confirmation, null);
  const stale = await fixture.app.api(`${fixture.route}/tasks/${fixture.task.id}/confirm`, fixture.session.token, { actionId, approved: true });
  assert.equal(stale.status, 409);
  assert.equal((await nativeCounts(fixture)).taps, 0);
  const history = JSON.parse(fixture.requests[1].messages[1].content[0].text).recentHistory;
  assert.equal(history[0].state, 'cancelled');
});

contract('a done reply asking for confirmation is re-planned once instead of ending the task', async t => {
  const replies = [
    { type: 'done', message: '切换账号会更改账户设置。请确认是否继续退出当前账号？' },
    { type: 'done', message: 'Fixture verified after re-plan' },
  ];
  const fixture = await modelReplyTask(t, call => modelCompletion(JSON.stringify(replies[Math.min(call, replies.length) - 1])));
  let state;
  await until(async () => { state = await fixture.snapshot(); return ['completed', 'failed'].includes(state.task?.state); });
  assert.equal(state.task.state, 'completed', JSON.stringify(state.task));
  assert.equal(state.task.message, 'Fixture verified after re-plan');
  assert.equal(fixture.requests.length, 2);
  assert.equal(state.task.steps.length, 0);
  const history = JSON.parse(fixture.requests[1].messages[1].content[0].text).recentHistory;
  assert.equal(history.at(-1).state, 'rejected');
  assert.match(history.at(-1).result.message, /requiresConfirmation:true/);
  assert.equal((await nativeCounts(fixture)).counts.screenshot, 1, 'the re-plan reuses the same observation');
});

contract('repeated actions that leave the screen unchanged are warned about and then stopped', async t => {
  // The fixture returns the same screenshot every time, so no tap changes the screen.
  const fixture = await modelReplyTask(t, call => modelCompletion(JSON.stringify(
    { type: 'action', tool: 'iphone_tap', args: { x: 5, y: 7 }, reason: `Fixture tap ${call}` })));
  let state;
  await until(async () => { state = await fixture.snapshot(); return ['completed', 'failed'].includes(state.task?.state); });
  assert.equal(state.task.state, 'failed', JSON.stringify(state.task));
  assert.match(state.task.error, /屏幕都没有变化/);
  assert.equal(state.task.steps.length, 6);
  const warned = fixture.requests.map(r => JSON.parse(r.messages[1].content[0].text).recentHistory)
    .find(history => history.some(entry => entry.state === 'warning'));
  assert.ok(warned, 'the model was warned before the task stopped');
  assert.ok(warned.filter(entry => entry.tool === 'iphone_tap').every(entry => entry.screenChanged === false));
});

contract('a new task in the same session sees the previous task as context', async t => {
  const fixture = await modelReplyTask(t, call => modelCompletion(JSON.stringify(
    { type: 'done', message: call === 1 ? 'First fixture result' : 'Second fixture result' })));
  let state;
  await until(async () => { state = await fixture.snapshot(); return state.task?.state === 'completed'; });
  const second = await fixture.app.api(fixture.route + '/tasks', fixture.session.token, { instruction: 'Continue the previous fixture task' });
  assert.equal(second.status, 201, await second.clone().text());
  await until(async () => { state = await fixture.snapshot(); return state.task?.state === 'completed' && fixture.requests.length === 2; });
  const history = JSON.parse(fixture.requests[1].messages[1].content[0].text).recentHistory;
  assert.equal(history[0].previousTasks.length, 1);
  assert.equal(history[0].previousTasks[0].instruction, 'Inspect the fixture safely');
  assert.equal(history[0].previousTasks[0].result, 'First fixture result');
  assert.equal(JSON.parse(fixture.requests[0].messages[1].content[0].text).recentHistory.length, 0);
});
