import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import net from 'node:net';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import * as plist from 'plist';
import WebSocket from 'ws';
import { createGateway } from '../src/gateway.mjs';
import { NativeController } from '../src/native-controller.mjs';
import { encodeFrame, decodeFrame, FrameType as F, jsonPayload, parsePayload } from '../src/relay-protocol.mjs';

const origin = 'http://localhost:5173';
const device = { serialNumber: '00008110-001234567890001E', vendorId: 1452, productId: 4776 };
const pairRecord = { udid: device.serialNumber, pairRecordBase64: Buffer.from(plist.build({ SystemBUID: 'browser-buid', HostID: 'fixture' })).toString('base64') };

async function start(t, options = {}) {
  const runtimeDir = await mkdtemp(path.join(os.tmpdir(), 'gateway-test-'));
  const controllers = [];
  const gateway = createGateway({ accessToken: 'controller-secret', allowedOrigins: [origin], runtimeDir,
    controllerFactory(session) {
      const controller = new NativeController({ ...session, command: process.execPath, commandArgs: [new URL('./fixtures/native-cli.mjs', import.meta.url).pathname], startTimeoutMs: 3000, requestTimeoutMs: 200 });
      controllers.push(controller); return controller;
    }, ...options });
  await gateway.listen('127.0.0.1', 0);
  const url = `http://127.0.0.1:${gateway.server.address().port}`;
  t.after(async () => { await gateway.close(); await rm(runtimeDir, { recursive: true, force: true }); });
  async function api(route, token = 'controller-secret', body, method = body === undefined ? 'GET' : 'POST', headers = {}) {
    return fetch(url + route, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  }
  const session = async (dev = device, record) => {
    const response = await api('/api/sessions', undefined, { device: dev, ...(record ? { pairRecord: record } : {}) });
    assert.equal(response.status, 201); return response.json();
  };
  return { gateway, runtimeDir, controllers, url, api, session };
}
async function waitFor(predicate) {
  for (let n = 0; n < 200; n++) { if (await predicate()) return; await sleep(10); }
  assert.fail('condition did not settle');
}
async function peer(session, dev = device) {
  const ws = new WebSocket(session.relayUrl, { origin });
  const queued = []; const waiters = [];
  ws.on('message', bytes => { const frame = decodeFrame(bytes); if (waiters.length) waiters.shift()(frame); else queued.push(frame); });
  await once(ws, 'open');
  ws.send(encodeFrame({ type: F.DeviceHello, payload: jsonPayload(dev) }));
  return { ws, send(type, payload = {}, requestId = 0, streamId = 0) { ws.send(encodeFrame({ type, requestId, streamId, payload: Buffer.isBuffer(payload) ? payload : jsonPayload(payload) })); }, next() { return queued.length ? Promise.resolve(queued.shift()) : new Promise(resolve => waiters.push(resolve)); } };
}
async function rejectUpgrade(url, websocketOrigin = origin) {
  return new Promise(resolve => {
    const ws = new WebSocket(url, { origin: websocketOrigin });
    ws.on('error', () => {});
    ws.on('unexpected-response', (_, response) => { response.resume(); ws.terminate(); resolve(response.statusCode); });
  });
}
function muxPacket(value) {
  const body = Buffer.from(plist.build(value)); const header = Buffer.alloc(16);
  [body.length + 16, 1, 8, 7].forEach((n, i) => header.writeUInt32LE(n, i * 4));
  return Buffer.concat([header, body]);
}
async function muxSocket(controller) {
  const [host, port] = controller.options.muxAddress.split(':');
  const socket = net.connect(Number(port), host); await once(socket, 'connect'); return socket;
}

test('HTTP and WebSocket authenticate exact origins and validate identities before native startup', async t => {
  const app = await start(t);
  assert.equal((await app.api('/api/sessions', 'bad', { device })).status, 401);
  assert.equal((await app.api('/api/sessions', undefined, { device: { ...device, vendorId: 1 } })).status, 400);
  assert.equal((await app.api('/api/sessions', undefined, { device }, 'POST', { Origin: 'http://evil' })).status, 403);
  assert.equal((await app.api('/api/sessions', undefined, { device: { ...device, serialNumber: '../../escape' } })).status, 400);
  const session = await app.session();
  assert.equal(await rejectUpgrade(session.relayUrl.replace(session.token, 'bad')), 401);
  assert.equal(await rejectUpgrade(session.relayUrl, 'http://evil'), 403);
  assert.equal(app.controllers.length, 0);
  const wrong = await peer(session, { ...device, serialNumber: '00008110-001234567890002E' });
  await once(wrong.ws, 'close');
  assert.equal(app.controllers.length, 0);
});

test('two sessions are isolated, duplicate sockets reject, commands validate/dedupe and screens return native images', async t => {
  const app = await start(t);
  const first = await app.session();
  const otherDevice = { ...device, serialNumber: '00008110-001234567890002E' };
  const second = await app.session(otherDevice);
  const a = await peer(first); const b = await peer(second, otherDevice);
  t.after(() => { a.ws.terminate(); b.ws.terminate(); });
  await waitFor(() => app.controllers.length === 2 && app.controllers.every(c => c.state.ready));
  assert.notEqual(app.controllers[0].options.socketPath, app.controllers[1].options.socketPath);
  assert.notEqual(app.controllers[0].options.muxAddress, app.controllers[1].options.muxAddress);
  assert.notEqual(app.controllers[0].options.dataDir, app.controllers[1].options.dataDir);
  assert.ok(app.controllers.every(c => Buffer.byteLength(c.options.socketPath) < 104));
  assert.equal(await rejectUpgrade(first.relayUrl), 409);
  assert.equal((await app.api(`/api/sessions/${first.id}`, second.token)).status, 401);
  const route = `/api/sessions/${first.id}/command`;
  assert.equal((await app.api(route, first.token, { requestId: 'bad', deviceId: second.id, tool: 'iphone_tap', args: { x: 1, y: 2 } })).status, 409);
  assert.equal((await app.api(route, first.token, { requestId: 'bad', deviceId: device.serialNumber, tool: 'iphone_press_button', args: { button: 'power' } })).status, 400);
  const command = { requestId: 'tap-1', deviceId: device.serialNumber, tool: 'iphone_tap', args: { x: 1, y: 2 } };
  const responses = await Promise.all([app.api(route, first.token, command), app.api(route, first.token, command)]);
  assert.equal(responses[0].status, 200);
  const values = await Promise.all(responses.map(r => r.json()));
  assert.deepEqual(values[0], values[1]);
  assert.equal(JSON.parse(values[0].text).taps, 1);
  assert.equal((await app.api(route, first.token, { ...command, args: { x: 2, y: 2 } })).status, 409);
  const screen = await (await app.api(`/api/sessions/${first.id}/screen`, first.token)).json();
  assert.equal(screen.imageBase64, 'aW1hZ2U=');
  assert.equal(screen.caption, 'fixture points 390×844');
  assert.equal(screen.deviceId, device.serialNumber);
  assert.equal(JSON.parse(screen.elementsText).request.op, 'list_elements');
  assert.equal(JSON.parse(screen.elementsText).request.limit, 80);
  a.ws.close(); await once(a.ws, 'close');
  await waitFor(() => app.controllers[0].closed);
  assert.equal(app.controllers[1].closed, false);
  await waitFor(() => !app.gateway.sessions.has(first.id));
  assert.equal((await app.api(`/api/sessions/${first.id}`, first.token)).status, 404);
});

test('SDK pairing publishes SavePairRecord, bridges real streams, handles Ping and fails unsupported install promptly', async t => {
  const app = await start(t);
  const session = await app.session();
  const usb = await peer(session);
  t.after(() => usb.ws.terminate());
  await waitFor(() => app.controllers[0]?.state.ready);
  usb.send(F.StartPairing);
  await waitFor(() => app.controllers[0].state.setup.state === 'running');
  const mux = await muxSocket(app.controllers[0]);
  t.after(() => mux.destroy());
  mux.write(muxPacket({ MessageType: 'SavePairRecord', PairRecordID: device.serialNumber, PairRecordData: Buffer.from(pairRecord.pairRecordBase64, 'base64') }));
  const ready = await usb.next();
  assert.equal(ready.type, F.PairRecordReady);
  assert.deepEqual(parsePayload(ready.payload), pairRecord);
  const setup = await app.api(`/api/sessions/${session.id}/setup/input`, session.token, { line: 'test-secret' });
  assert.equal(setup.status, 200);
  await waitFor(() => app.controllers[0].state.setup.state === 'complete');
  mux.destroy();
  const stream = await muxSocket(app.controllers[0]);
  t.after(() => stream.destroy());
  stream.write(muxPacket({ MessageType: 'Connect', DeviceID: 1, PortNumber: 32498 }));
  const open = await usb.next();
  assert.equal(open.type, F.OpenStream); assert.equal(parsePayload(open.payload).port, 62078);
  usb.send(F.OpenResult, { ok: true }, open.requestId, open.streamId);
  assert.equal(plist.parse((await once(stream, 'data'))[0].subarray(16).toString()).Number, 0);
  stream.write(Buffer.from([0, 255, 1]));
  const data = await usb.next();
  assert.equal(data.type, F.StreamData); assert.deepEqual(data.payload, Buffer.from([0, 255, 1]));
  const nativeData = once(stream, 'data');
  usb.send(F.StreamData, Buffer.from([255, 0, 2]), 0, open.streamId);
  assert.deepEqual((await nativeData)[0], Buffer.from([255, 0, 2]));
  const closed = once(stream, 'close');
  usb.send(F.StreamClose, {}, 0, open.streamId); await closed;
  usb.send(F.Ping, Buffer.alloc(0), 88);
  assert.equal((await usb.next()).type, F.Pong);
  usb.send(F.StartInstall, pairRecord);
  const error = await usb.next(); assert.equal(error.type, F.Error); assert.match(parsePayload(error.payload).error, /native setup/i);
});

test('stored records resume persistent native namespace without signing again and reject concurrent owners', async t => {
  const app = await start(t);
  const first = await app.session(device, pairRecord);
  const usb = await peer(first);
  await waitFor(() => app.controllers[0]?.state.ready);
  const dataDir = app.controllers[0].options.dataDir;
  usb.send(F.StartPairing);
  assert.deepEqual(parsePayload((await usb.next()).payload), pairRecord);
  assert.equal(app.controllers[0].state.setup.state, 'idle');
  assert.equal((await app.api('/api/sessions', undefined, { device, pairRecord })).status, 409);
  usb.ws.close(); await once(usb.ws, 'close');
  await waitFor(() => app.controllers[0].closed);
  await waitFor(() => !app.gateway.sessions.has(first.id));
  const resumed = await app.session(device, pairRecord);
  const usb2 = await peer(resumed);
  t.after(() => usb2.ws.terminate());
  await waitFor(() => app.controllers[1]?.state.ready);
  assert.equal(app.controllers[1].options.dataDir, dataDir);
  const mapFiles = await readdir(path.join(app.runtimeDir, 'record-map'));
  const map = await readFile(path.join(app.runtimeDir, 'record-map', mapFiles[0]), 'utf8');
  assert.ok(!map.includes(pairRecord.pairRecordBase64)); assert.ok(!map.includes('controller-secret'));
});

test('relay hello timeout and malformed frames close session and owned processes', async t => {
  const app = await start(t, { helloTimeoutMs: 100 });
  const session = await app.session();
  const idle = new WebSocket(session.relayUrl, { origin });
  idle.on('error', () => {});
  await once(idle, 'open'); await once(idle, 'close');
  assert.equal(app.controllers.length, 0);
  const second = await app.session();
  const usb = await peer(second);
  await waitFor(() => app.controllers[0]?.state.ready);
  usb.ws.send(Buffer.alloc(3));
  await once(usb.ws, 'close'); await waitFor(() => app.controllers[0].closed);
});

test('concurrent first use of the same pair record reserves one native namespace', async t => {
  const app = await start(t);
  const responses = await Promise.all([app.api('/api/sessions', undefined, { device, pairRecord }), app.api('/api/sessions', undefined, { device, pairRecord })]);
  assert.deepEqual(responses.map(r => r.status).sort(), [201, 409]);
});

test('SavePairRecord cannot replace a mapping owned by another active native session', async t => {
  const app = await start(t);
  const original = await app.session(device, pairRecord); const owner = await peer(original);
  const other = await app.session(); const usb = await peer(other);
  t.after(() => { owner.ws.terminate(); usb.ws.terminate(); });
  await waitFor(() => app.controllers.length === 2 && app.controllers.every(c => c.state.ready));
  const mux = await muxSocket(app.controllers[1]);
  t.after(() => mux.destroy());
  mux.write(muxPacket({ MessageType: 'SavePairRecord', PairRecordID: device.serialNumber, PairRecordData: Buffer.from(pairRecord.pairRecordBase64, 'base64') }));
  assert.equal((await usb.next()).type, F.Error);
  await waitFor(() => app.controllers[1].closed);
  assert.equal(app.controllers[0].closed, false);
});

test('malformed API objects and setup input are rejected with client errors', async t => {
  const app = await start(t);
  assert.equal((await app.api('/api/sessions', undefined, null)).status, 400);
  const session = await app.session(); const usb = await peer(session);
  t.after(() => usb.ws.terminate());
  await waitFor(() => app.controllers[0]?.state.ready);
  assert.equal((await app.api(`/api/sessions/${session.id}/setup/input`, session.token, { line: 'no prompt' })).status, 409);
  await app.api(`/api/sessions/${session.id}/setup`, session.token, {});
  assert.equal((await app.api(`/api/sessions/${session.id}/setup/input`, session.token, { line: 'first\nsecond' })).status, 400);
});

test('relay URL uses configured HTTPS public URL behind a reverse proxy', async t => {
  const app = await start(t, { publicUrl: 'https://control.example.test' });
  const session = await app.session();
  assert.equal(new URL(session.relayUrl).origin, 'wss://control.example.test');
});

test('failed OpenResult and stream open timeout unblock native Connect; unknown closed-stream data invalidates relay', async t => {
  const app = await start(t, { streamOpenTimeoutMs: 100 });
  const session = await app.session(); const usb = await peer(session);
  t.after(() => usb.ws.terminate());
  await waitFor(() => app.controllers[0]?.state.ready);
  const first = await muxSocket(app.controllers[0]);
  t.after(() => first.destroy());
  first.write(muxPacket({ MessageType: 'Connect', DeviceID: 1, PortNumber: 32498 }));
  const request = await usb.next();
  const refused = once(first, 'data');
  usb.send(F.OpenResult, { ok: false, error: 'refused' }, request.requestId, request.streamId);
  assert.equal(plist.parse((await refused)[0].subarray(16).toString()).Number, 3);
  const second = await muxSocket(app.controllers[0]);
  t.after(() => second.destroy());
  second.write(muxPacket({ MessageType: 'Connect', DeviceID: 1, PortNumber: 32498 }));
  const unanswered = await usb.next();
  assert.equal(unanswered.type, F.OpenStream);
  assert.equal(plist.parse((await once(second, 'data'))[0].subarray(16).toString()).Number, 3);
  assert.equal((await usb.next()).type, F.StreamClose);
  usb.send(F.StreamData, Buffer.from('late'), 0, request.streamId);
  await once(usb.ws, 'close');
  await waitFor(() => app.controllers[0].closed);
});

test('server entry rejects missing controller secret and serves non-secret config when configured', async t => {
  const missing = spawn(process.execPath, ['src/server.mjs'], { cwd: new URL('..', import.meta.url), env: { ...process.env, CONTROL_ACCESS_TOKEN: '' } });
  let stderr = ''; missing.stderr.on('data', bytes => { stderr += bytes; });
  const [code] = await once(missing, 'exit');
  assert.equal(code, 1); assert.match(stderr, /CONTROL_ACCESS_TOKEN required/);
  const runtimeDir = await mkdtemp(path.join(os.tmpdir(), 'gateway-entry-'));
  const child = spawn(process.execPath, ['src/server.mjs'], { cwd: new URL('..', import.meta.url), env: { ...process.env, CONTROL_ACCESS_TOKEN: 'entry-secret', PORT: '0', RUNTIME_DIR: runtimeDir } });
  t.after(async () => { child.kill('SIGTERM'); await once(child, 'exit'); await rm(runtimeDir, { recursive: true, force: true }); });
  let output = ''; child.stdout.on('data', bytes => { output += bytes; });
  await waitFor(() => output.includes('Gateway listening'));
  const url = output.match(/http:\/\/[^\s]+/)[0];
  const config = await (await fetch(url + '/api/config')).json();
  assert.deepEqual(config, { aiReady: false, model: null });
  assert.ok(!output.includes('entry-secret'));
});
