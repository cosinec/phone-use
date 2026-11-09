import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
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
async function until(check) {
  for (let i = 0; i < 250; i++) { if (await check()) return; await pause(20); }
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
    WEB_DIST_DIR: fileURLToPath(new URL('../dist', import.meta.url)), LLM_BASE_URL: '', LLM_MODEL: '', LLM_API_KEY: '', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
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
  return { api, session, base, dir };
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

contract('Rust entry point preserves auth, normalized identities, setup, screenshots and command deduplication', async t => {
  const app = await harness(t);
  assert.deepEqual(await (await app.api('/api/config')).json(), { aiReady: false, model: null });
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
  const image = await (await app.api(route + '/screen', s.token)).json(); assert.equal(image.imageBase64, 'aW1hZ2U='); assert.equal(image.deviceId, device.serialNumber);
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

contract('Rust task calls visual provider, confirms once, completes and cancels pending generation', async t => {
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
  assert.equal(lastBody.messages[1].content[1].type, 'image_url');
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
