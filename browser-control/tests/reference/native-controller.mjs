import { spawn } from 'node:child_process';
import net from 'node:net';
import { mkdir, chmod } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { canonicalUID } from '../../src/device-identity.mjs';

const MAX_RESPONSE = 12 * 1024 * 1024;
const MAX_TRANSCRIPT = 32 * 1024;

export class NativeController {
  constructor(options) {
    this.options = { ...options, device: { ...options.device, serialNumber: canonicalUID(options.device.serialNumber) } };
    this.closed = false;
    this.children = new Set();
    this.groups = new Map();
    this.sockets = new Set();
    this.state = { ready: false, daemon: 'idle', setup: { state: 'idle', transcript: '', exitCode: null } };
  }

  spawn(mode) {
    const { command = process.env.ICTL_BIN || 'iphone-control', commandArgs = [], env = {}, device, dataDir, socketPath, muxAddress } = this.options;
    const child = spawn(command, [...commandArgs, mode], {
      detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...env, IPHONE_UDID: device.serialNumber, ICTL_DATA_DIR: dataDir,
        ICTL_SOCKET: socketPath, ICTL_MANAGE_USBMUXD: '0', USBMUXD_SOCKET_ADDRESS: muxAddress },
    });
    this.children.add(child);
    if (child.pid) this.groups.set(child, { cleanup: null });
    child.stdin.on('error', () => {});
    child.once('exit', () => { this.children.delete(child); void this.stopGroup(child).catch(() => {}); });
    child.once('error', () => { this.children.delete(child); if (!child.pid) this.groups.delete(child); });
    return child;
  }

  async start() {
    if (this.closed) throw new Error('Controller closed');
    if (this.starting) return this.starting;
    this.starting = this.startDaemon();
    return this.starting;
  }

  async startDaemon() {
    await mkdir(this.options.dataDir, { recursive: true, mode: 0o700 });
    await chmod(this.options.dataDir, 0o700);
    if (this.closed) throw new Error('Controller closed');
    const child = this.spawn('daemon');
    this.state.daemon = 'starting';
    let failure;
    // Daemon output is drained but never persisted: it can contain phone/account material.
    child.stdout.resume(); child.stderr.resume(); child.stdin.end();
    child.once('error', error => { failure = error; this.state.daemon = 'failed'; });
    child.once('exit', () => { failure ??= new Error('Native daemon exited'); this.state.ready = false; this.state.daemon = this.closed ? 'closed' : 'failed'; });
    const deadline = Date.now() + (this.options.startTimeoutMs ?? 30_000);
    while (!this.closed && !failure && Date.now() < deadline) {
      try {
        // Read-only readiness probes may repeat; sent phone actions never do.
        await this.request({ op: 'daemon' }, { timeoutMs: 1000 });
        this.state.ready = true; this.state.daemon = 'running'; return;
      } catch { await sleep(50); }
    }
    throw failure ?? new Error(this.closed ? 'Controller closed' : 'Native startup timeout');
  }

  request(request, { timeoutMs = this.options.requestTimeoutMs ?? 45_000, signal } = {}) {
    if (this.closed) return Promise.reject(new Error('Controller closed'));
    if (signal?.aborted) return Promise.reject(new Error('Request cancelled'));
    return new Promise((resolve, reject) => {
      const socket = net.connect(this.options.socketPath);
      this.sockets.add(socket);
      let buffer = Buffer.alloc(0);
      let settled = false;
      const finish = (error, result) => {
        if (settled) return;
        settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
        this.sockets.delete(socket); socket.destroy();
        if (error) reject(error); else resolve(result);
      };
      const abort = () => finish(new Error('Request cancelled; sent action is not retried'));
      const timer = setTimeout(() => finish(new Error('Native request timeout; sent action is not retried')), timeoutMs);
      signal?.addEventListener('abort', abort, { once: true });
      socket.once('connect', () => socket.write(JSON.stringify({ ...request, expect_udid: this.options.device.serialNumber, cancel_on_close: true, lang: 'en' }) + '\n'));
      socket.on('data', chunk => {
        if (buffer.length + chunk.length > MAX_RESPONSE) { finish(new Error('Native response too large')); return; }
        buffer = Buffer.concat([buffer, chunk]);
        const end = buffer.indexOf(10);
        if (end < 0) return;
        try {
          const result = JSON.parse(buffer.subarray(0, end).toString('utf8'));
          if (!['text', 'image', 'error'].includes(result.kind)) throw new Error('Invalid native response');
          finish(null, result);
        } catch (error) { finish(error); }
      });
      socket.once('error', error => finish(error));
      socket.once('close', () => finish(new Error('Native response interrupted; sent action is not retried')));
    });
  }

  async startSetup() {
    if (this.closed) throw new Error('Controller closed');
    if (this.state.setup.state === 'running') return this.state.setup;
    const setup = { state: 'running', transcript: '', exitCode: null };
    this.state.setup = setup;
    const child = this.spawn('setup');
    this.setupChild = child;
    const append = chunk => { setup.transcript = (setup.transcript + chunk.toString('utf8')).slice(-MAX_TRANSCRIPT); };
    child.stdout.on('data', append); child.stderr.on('data', append);
    const timer = setTimeout(() => {
      setup.state = 'stopping'; setup.error = 'Setup timeout';
      void this.stopGroup(child).then(() => { setup.state = 'failed'; }, () => { setup.state = 'failed'; setup.error = 'Setup cleanup failed'; });
    }, this.options.setupTimeoutMs ?? 15 * 60_000);
    child.once('error', () => { clearTimeout(timer); setup.state = 'failed'; setup.error = 'Could not start native setup'; });
    child.once('exit', code => {
      clearTimeout(timer); setup.exitCode = code;
      if (setup.state === 'running') setup.state = this.closed ? 'stopped' : code === 0 ? 'complete' : 'failed';
      if (this.setupChild === child) this.setupChild = undefined;
    });
    return setup;
  }

  setupInput(line) {
    if (this.closed || this.state.setup.state !== 'running' || !this.setupChild?.stdin.writable) throw new Error('Setup is not running');
    if (typeof line !== 'string' || line.length > 4096 || /[\r\n\0]/.test(line)) throw new Error('Invalid setup input');
    // One write only. Never append the line to state, logs or files.
    this.setupChild.stdin.write(line + '\n');
  }

  kill(child, signal) {
    if (!this.groups.has(child) || !child.pid) return;
    try { if (process.platform === 'win32') child.kill(signal); else process.kill(-child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }

  groupAlive(child) {
    if (!this.groups.has(child) || !child.pid) return false;
    if (process.platform === 'win32') return child.exitCode === null && child.signalCode === null;
    try { process.kill(-child.pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; }
  }

  stopGroup(child) {
    const group = this.groups.get(child);
    if (!group) return Promise.resolve();
    group.cleanup ??= (async () => {
      this.kill(child, 'SIGTERM');
      const deadline = Date.now() + 1500;
      let escalated = false;
      while (this.groupAlive(child)) {
        if (!escalated && Date.now() >= deadline) { this.kill(child, 'SIGKILL'); escalated = true; }
        await sleep(25);
      }
      this.groups.delete(child);
    })();
    return group.cleanup;
  }

  async close() {
    if (this.closing) return this.closing;
    this.closed = true; this.state.ready = false; this.state.daemon = 'closed';
    if (this.state.setup.state === 'running') this.state.setup.state = 'stopped';
    for (const socket of this.sockets) socket.destroy();
    this.closing = Promise.all([...this.groups.keys()].map(child => this.stopGroup(child)));
    await this.closing;
  }
}
