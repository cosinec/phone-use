import http from 'node:http';
import { randomUUID, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { mkdir, chmod, mkdtemp, readFile, writeFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Duplex } from 'node:stream';
import { WebSocketServer, WebSocket } from 'ws';
import { encodeFrame, decodeFrame, FrameType as F, jsonPayload, parsePayload, MAX_FRAME_PAYLOAD } from './relay-protocol.mjs';
import { createVirtualMux, readPairRecord } from './virtual-usbmuxd.mjs';
import { NativeController } from './native-controller.mjs';
import { commandRequest } from './commands.mjs';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const failure = (status, message) => Object.assign(new Error(message), { status });
const equal = (left, right) => typeof left === 'string' && typeof right === 'string' && Buffer.byteLength(left) === Buffer.byteLength(right) && timingSafeEqual(Buffer.from(left), Buffer.from(right));

function validateDevice(device) {
  if (!device || device.vendorId !== 1452 || !Number.isInteger(device.productId) || device.productId < 1 || device.productId > 65535
      || typeof device.serialNumber !== 'string' || !/^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{8}-[a-fA-F0-9]{16})$/.test(device.serialNumber)
      || (device.productName !== undefined && (typeof device.productName !== 'string' || device.productName.length > 256))) {
    throw failure(400, 'Invalid Apple device identity');
  }
  return { serialNumber: device.serialNumber, productId: device.productId, vendorId: device.vendorId, ...(device.productName ? { productName: device.productName } : {}) };
}
async function body(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_FRAME_PAYLOAD) throw failure(413, 'Request body too large');
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Object required');
    return value;
  }
  catch { throw failure(400, 'Invalid JSON body'); }
}
function json(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(value));
}

export function createGateway(options) {
  const { accessToken, allowedOrigins, runtimeDir = path.resolve('.runtime'), controllerFactory = session => new NativeController(session) } = options;
  if (typeof accessToken !== 'string' || !accessToken.trim()) throw new Error('Nonempty accessToken required');
  if (!Array.isArray(allowedOrigins) || !allowedOrigins.length || allowedOrigins.some(o => typeof o !== 'string' || !/^https?:\/\//.test(o))) throw new Error('Exact allowedOrigins required');
  const origins = new Set(allowedOrigins);
  const publicBase = options.publicUrl ? new URL(options.publicUrl) : null;
  if (publicBase && !['http:', 'https:'].includes(publicBase.protocol)) throw new Error('HTTP(S) publicUrl required');
  const sessions = new Map();
  const owners = new Map();
  const wsServer = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_PAYLOAD + 16 });
  let stopping = false;
  let allocation = Promise.resolve();
  let closing;
  let initialization;
  const initialize = () => initialization ??= (async () => {
    for (const dir of [runtimeDir, path.join(runtimeDir, 'record-map'), path.join(runtimeDir, 'data')]) {
      await mkdir(dir, { recursive: true, mode: 0o700 }); await chmod(dir, 0o700);
    }
  })();
  const recordKey = record => createHash('sha256').update(accessToken).update(record.pairRecordBase64).digest('hex');
  function allocate(operation) {
    const pending = allocation.then(operation); allocation = pending.catch(() => {}); return pending;
  }
  async function saveMapping(record, namespace) {
    const target = path.join(runtimeDir, 'record-map', recordKey(record) + '.json');
    try {
      const saved = JSON.parse(await readFile(target, 'utf8'));
      if (!UUID.test(saved.namespace)) throw new Error('Invalid namespace');
      if (saved.namespace !== namespace && owners.has(saved.namespace)) throw failure(409, 'Native signing state has an active owner');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const temporary = target + '.' + randomUUID();
    await writeFile(temporary, JSON.stringify({ namespace }), { mode: 0o600, flag: 'wx' });
    await rename(temporary, target);
  }
  async function newSession(device, pairRecord) {
    await initialize();
    if (stopping) throw failure(503, 'Gateway closing');
    if (sessions.size >= (options.maxSessions ?? 32)) throw failure(429, 'Session limit reached');
    let namespace = randomUUID();
    if (pairRecord) {
      try { readPairRecord(pairRecord, device.serialNumber); } catch { throw failure(400, 'Invalid pair record'); }
      try {
        const saved = JSON.parse(await readFile(path.join(runtimeDir, 'record-map', recordKey(pairRecord) + '.json'), 'utf8'));
        if (!UUID.test(saved.namespace)) throw new Error('Invalid namespace');
        namespace = saved.namespace;
      } catch (error) { if (error.code !== 'ENOENT') throw failure(500, 'Could not read native resume state'); }
    }
    // Reserve the native namespace synchronously before any filesystem/process await.
    if (owners.has(namespace)) throw failure(409, 'Native signing state has an active owner');
    const id = randomUUID();
    owners.set(namespace, id);
    try {
      if (pairRecord) await saveMapping(pairRecord, namespace);
      const socketDir = await mkdtemp(path.join(os.tmpdir(), 'ictl-'));
      await chmod(socketDir, 0o700);
      const session = { id, namespace, token: randomBytes(32).toString('hex'), device, pairRecord,
        dataDir: path.join(runtimeDir, 'data', namespace), socketPath: path.join(socketDir, 'ctl.sock'), socketDir,
        state: 'waiting_for_relay', controller: null, mux: null, ws: null, streams: new Map(), nextId: 1,
        commands: new Map(), actionChain: Promise.resolve(), abort: new AbortController() };
      session.expiry = setTimeout(() => void closeSession(session), options.sessionTimeoutMs ?? 5 * 60_000);
      session.runCommand = input => runCommand(session, input);
      session.screen = () => screen(session);
      sessions.set(id, session);
      return session;
    } catch (error) { owners.delete(namespace); throw error; }
  }
  async function closeSession(session) {
    if (session.closing) return session.closing;
    session.state = 'closed'; session.token = undefined; session.abort.abort(); clearTimeout(session.expiry); clearTimeout(session.helloTimer); clearInterval(session.heartbeat);
    session.closing = (async () => {
      session.ws?.terminate();
      for (const entry of session.streams.values()) { clearTimeout(entry.timer); entry.reject?.(new Error('Relay closed')); entry.duplex.destroy(); }
      session.streams.clear();
      await Promise.allSettled([session.controller?.close(), session.mux?.close()]);
      await rm(session.socketDir, { recursive: true, force: true });
      owners.delete(session.namespace); sessions.delete(session.id);
      session.commands.clear(); session.pairRecord = undefined; session.token = undefined;
    })();
    return session.closing;
  }
  function send(session, type, payload = Buffer.alloc(0), requestId = 0, streamId = 0, callback) {
    if (session.ws?.readyState !== WebSocket.OPEN || session.state === 'closed') throw new Error('Relay closed');
    if (session.ws.bufferedAmount > 4 * MAX_FRAME_PAYLOAD) { void closeSession(session); throw new Error('Relay send buffer exceeded'); }
    session.ws.send(encodeFrame({ type, requestId, streamId, payload }), callback);
  }
  function relayError(session, message, requestId = 0) {
    try { send(session, F.Error, jsonPayload({ error: message }), requestId); } catch { /* Already closing. */ }
  }
  function openStream(session, port) {
    if (session.streams.size >= 64) return Promise.reject(new Error('Stream limit reached'));
    const id = session.nextId++;
    if (id > 0xffffffff) return Promise.reject(new Error('Stream IDs exhausted'));
    return new Promise((resolve, reject) => {
      const duplex = new Duplex({
        read() {},
        write(chunk, encoding, done) {
          try { send(session, F.StreamData, chunk, 0, id, done); } catch (error) { done(error); }
        },
        destroy(error, done) {
          const entry = session.streams.get(id);
          if (entry) {
            clearTimeout(entry.timer); session.streams.delete(id);
            entry.reject?.(error ?? new Error('Stream closed'));
            if (!entry.remoteClose && session.state !== 'closed') { try { send(session, F.StreamClose, Buffer.alloc(0), 0, id); } catch {} }
          }
          done(error);
        },
      });
      duplex.on('error', () => {});
      const entry = { duplex, resolve, reject, requestId: id, opened: false };
      session.streams.set(id, entry);
      entry.timer = setTimeout(() => duplex.destroy(new Error('Stream open timeout')), options.streamOpenTimeoutMs ?? 20_000);
      try { send(session, F.OpenStream, jsonPayload({ port }), id, id); } catch (error) { duplex.destroy(error); }
    });
  }
  async function hello(session, frame) {
    const device = validateDevice(parsePayload(frame.payload));
    if (device.serialNumber !== session.device.serialNumber || device.productId !== session.device.productId || device.vendorId !== session.device.vendorId) throw new Error('DeviceHello identity mismatch');
    session.state = 'connecting'; clearTimeout(session.helloTimer); clearTimeout(session.expiry);
    const mux = await createVirtualMux({ device: session.device, pairRecord: session.pairRecord,
      openStream: port => openStream(session, port),
      onPairRecord(record) {
        session.pairRecord = record;
        void allocate(() => saveMapping(record, session.namespace)).then(() => {
          if (session.state !== 'closed') send(session, F.PairRecordReady, jsonPayload(record));
        }).catch(() => { relayError(session, 'Could not save native resume state'); void closeSession(session); });
      },
    });
    if (session.state === 'closed') { await mux.close(); return; }
    session.mux = mux; session.muxAddress = mux.address;
    session.controller = controllerFactory(session);
    session.starting = Promise.resolve().then(() => session.controller.start()).then(() => {
      if (session.state !== 'closed') session.state = 'connected';
    }).catch(() => { relayError(session, 'Native controller startup failed'); void closeSession(session); });
  }
  async function handleFrame(session, frame) {
    if (session.state === 'waiting_for_relay') {
      if (frame.type !== F.DeviceHello || frame.streamId !== 0) throw new Error('DeviceHello required first');
      await hello(session, frame); return;
    }
    switch (frame.type) {
      case F.DeviceHello: throw new Error('Duplicate DeviceHello');
      case F.OpenResult: {
        const entry = session.streams.get(frame.streamId);
        if (!entry || entry.opened || entry.requestId !== frame.requestId) throw new Error('Unexpected OpenResult');
        const result = parsePayload(frame.payload);
        clearTimeout(entry.timer);
        if (result.ok !== true) { entry.remoteClose = true; entry.duplex.destroy(new Error('Device refused stream')); }
        else { entry.opened = true; entry.reject = null; entry.resolve(entry.duplex); }
        break;
      }
      case F.StreamData: {
        const entry = session.streams.get(frame.streamId);
        if (!entry?.opened) throw new Error('Unknown or unopened stream');
        if (entry.duplex.readableLength + frame.payload.length > MAX_FRAME_PAYLOAD) throw new Error('Stream receive buffer exceeded');
        entry.duplex.push(frame.payload); break;
      }
      case F.StreamClose: {
        const entry = session.streams.get(frame.streamId);
        if (entry) { entry.remoteClose = true; entry.duplex.destroy(); }
        break;
      }
      case F.Ping: send(session, F.Pong, Buffer.alloc(0), frame.requestId); break;
      case F.Pong: break;
      case F.StartPairing:
        if (session.pairRecord) send(session, F.PairRecordReady, jsonPayload(session.pairRecord));
        else void session.starting.then(() => { if (session.state !== 'closed') return session.controller.startSetup(); }).catch(() => relayError(session, 'Native setup failed'));
        break;
      case F.StartInstall: relayError(session, 'Asset installation is unsupported; use native setup for WDA', frame.requestId); break;
      default: throw new Error('Unsupported relay frame');
    }
  }
  async function ready(session) {
    if (session.state === 'closed' || !session.controller) throw failure(409, 'Device relay is not connected');
    await session.starting;
    if (session.state === 'closed' || !session.controller.state.ready) throw failure(503, 'Native control transport is not ready');
  }
  function serial(session, operation) {
    const pending = session.actionChain.then(() => { if (session.state === 'closed') throw failure(410, 'Session closed'); return operation(); });
    session.actionChain = pending.catch(() => {}); return pending;
  }
  function runCommand(session, input) {
    const { requestId, deviceId, tool, args = {}, signal } = input;
    if (deviceId !== session.device.serialNumber) throw failure(409, 'Device identity mismatch');
    if (typeof requestId !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(requestId)) throw failure(400, 'Invalid requestId');
    let request;
    try { request = commandRequest(tool, args); } catch (error) { throw failure(400, error.message); }
    const fingerprint = JSON.stringify(request);
    const existing = session.commands.get(requestId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw failure(409, 'requestId already used for another command');
      return existing.promise;
    }
    if (session.commands.size >= 256) {
      const oldest = [...session.commands.entries()].find(([, value]) => value.settled);
      if (!oldest) throw failure(429, 'Command queue full');
      session.commands.delete(oldest[0]);
    }
    const entry = { fingerprint, settled: false };
    entry.promise = serial(session, async () => {
      await ready(session);
      const cancellation = signal ? AbortSignal.any([signal, session.abort.signal]) : session.abort.signal;
      return session.controller.request(request, { signal: cancellation });
    }).finally(() => { entry.settled = true; });
    session.commands.set(requestId, entry);
    return entry.promise;
  }
  function screen(session) {
    return serial(session, async () => {
      await ready(session);
      const image = await session.controller.request({ op: 'screenshot', region: null }, { signal: session.abort.signal });
      if (image.kind !== 'image') throw failure(503, image.message ?? 'Screenshot unavailable');
      const result = { imageBase64: image.jpeg_base64, caption: image.caption, elementsText: '', deviceId: session.device.serialNumber };
      try {
        const elements = await session.controller.request({ op: 'list_elements', filter: '', limit: 80, max_age_ms: 0 }, { signal: session.abort.signal });
        if (elements.kind === 'text') result.elementsText = elements.text;
        else result.elementsError = elements.message ?? 'UI elements unavailable';
      } catch { result.elementsError = 'UI elements unavailable'; }
      return result;
    });
  }
  const server = http.createServer(async (request, response) => {
    try {
      const requestOrigin = request.headers.origin;
      if (requestOrigin && !origins.has(requestOrigin)) throw failure(403, 'Origin denied');
      if (requestOrigin) { response.setHeader('Access-Control-Allow-Origin', requestOrigin); response.setHeader('Vary', 'Origin'); }
      if (request.method === 'OPTIONS') {
        response.writeHead(204, { 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS' }); response.end(); return;
      }
      const url = new URL(request.url, 'http://gateway');
      if (request.method === 'GET' && url.pathname === '/api/config') { json(response, 200, { aiReady: false, model: null }); return; }
      const token = request.headers.authorization?.startsWith('Bearer ') ? request.headers.authorization.slice(7) : undefined;
      if (request.method === 'POST' && url.pathname === '/api/sessions') {
        if (!equal(token, accessToken)) throw failure(401, 'Authentication required');
        const input = await body(request);
        const session = await allocate(() => newSession(validateDevice(input.device), input.pairRecord));
        const relay = new URL('/ios/device/ws', publicBase ?? `${request.socket.encrypted ? 'https' : 'http'}://${request.headers.host}`);
        relay.protocol = relay.protocol === 'https:' ? 'wss:' : 'ws:'; relay.searchParams.set('token', session.token);
        json(response, 201, { id: session.id, token: session.token, relayUrl: relay.toString(), state: session.state }); return;
      }
      const match = url.pathname.match(/^\/api\/sessions\/([a-f0-9-]+)(\/.*)?$/);
      if (!match) throw failure(404, 'Route not found');
      const session = sessions.get(match[1]);
      if (!session) throw failure(404, 'Session not found');
      if (!equal(token, session.token)) throw failure(401, 'Authentication required');
      const route = match[2] ?? '';
      if (request.method === 'DELETE' && !route) { await closeSession(session); json(response, 200, { state: 'closed' }); return; }
      if (request.method === 'GET' && !route) {
        let daemon = null;
        if (session.controller?.state.ready) {
          try { const snapshot = await session.controller.request({ op: 'daemon' }, { timeoutMs: 3000, signal: session.abort.signal }); if (snapshot.kind === 'text') daemon = JSON.parse(snapshot.text); } catch {}
        }
        json(response, 200, { id: session.id, deviceId: session.device.serialNumber, state: session.state, ready: session.controller?.state.ready ?? false,
          daemon, setup: session.controller?.state.setup ?? { state: 'idle', transcript: '', exitCode: null }, task: null }); return;
      }
      if (request.method === 'POST' && route === '/setup') { await body(request); await ready(session); await session.controller.startSetup(); json(response, 200, session.controller.state.setup); return; }
      if (request.method === 'POST' && route === '/setup/input') {
        const input = await body(request); await ready(session);
        if (typeof input.line !== 'string' || input.line.length > 4096 || /[\r\n\0]/.test(input.line)) throw failure(400, 'Invalid setup input');
        if (session.controller.state.setup.state !== 'running') throw failure(409, 'Setup is not running');
        session.controller.setupInput(input.line); json(response, 200, { accepted: true }); return;
      }
      if (request.method === 'POST' && route === '/command') { json(response, 200, await runCommand(session, await body(request))); return; }
      if (request.method === 'GET' && route === '/screen') { json(response, 200, await screen(session)); return; }
      throw failure(404, 'Route not found');
    } catch (error) { if (!response.headersSent) json(response, error.status ?? 503, { error: error.message }); else response.destroy(); }
  });
  server.headersTimeout = 10_000; server.requestTimeout = 15_000;
  server.on('upgrade', (request, socket, head) => {
    const reject = status => { socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); };
    let url;
    try { url = new URL(request.url, 'http://gateway'); } catch { reject(400); return; }
    if (url.pathname !== '/ios/device/ws') { reject(404); return; }
    if (!origins.has(request.headers.origin)) { reject(403); return; }
    const session = [...sessions.values()].find(s => equal(url.searchParams.get('token'), s.token));
    if (!session || session.state === 'closed' || stopping) { reject(401); return; }
    if (session.ws) { reject(409); return; }
    wsServer.handleUpgrade(request, socket, head, ws => {
      session.ws = ws;
      session.helloTimer = setTimeout(() => void closeSession(session), options.helloTimeoutMs ?? 10_000);
      let chain = Promise.resolve(); let queuedBytes = 0; let alive = true;
      session.heartbeat = setInterval(() => { if (!alive) { void closeSession(session); return; } alive = false; ws.ping(); }, options.heartbeatMs ?? 30_000);
      ws.on('pong', () => { alive = true; });
      ws.on('message', (bytes, binary) => {
        queuedBytes += bytes.length;
        if (!binary || queuedBytes > 4 * MAX_FRAME_PAYLOAD) { void closeSession(session); return; }
        chain = chain.then(() => { if (session.state !== 'closed') return handleFrame(session, decodeFrame(bytes)); }).catch(() => {
          relayError(session, 'Invalid relay message'); void closeSession(session);
        }).finally(() => { queuedBytes -= bytes.length; });
      });
      ws.on('error', () => void closeSession(session)); ws.on('close', () => void closeSession(session));
    });
  });
  return {
    server, sessions,
    async listen(host = '127.0.0.1', port = 8787) {
      await initialize();
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
      return server.address();
    },
    async close() {
      closing ??= (async () => {
        stopping = true; await allocation; await Promise.allSettled([...sessions.values()].map(closeSession));
        await new Promise(resolve => wsServer.close(resolve));
        await new Promise(resolve => server.close(resolve));
      })();
      return closing;
    },
  };
}
