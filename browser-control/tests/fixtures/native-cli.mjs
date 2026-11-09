// Transparent test substitute for iphone-control: same daemon/setup invocation and NDJSON socket.
import net from 'node:net';
import readline from 'node:readline';
import { chmodSync } from 'node:fs';

if (process.argv[2] === 'setup') {
  if (process.env.FIXTURE_IGNORE_TERM) process.on('SIGTERM', () => {});
  if (process.env.FIXTURE_SETUP_BURST) process.stdout.write('test output '.repeat(8000));
  process.stdout.write('Apple account input: ');
  const input = readline.createInterface({ input: process.stdin });
  input.once('line', () => { process.stdout.write('Input received; setup complete\n'); input.close(); process.exit(0); });
} else if (process.argv[2] === 'daemon') {
  let taps = 0;
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk;
      if (!buffer.includes('\n')) return;
      const request = JSON.parse(buffer.slice(0, buffer.indexOf('\n')));
      if (request.op === 'tap') taps++;
      if (request.op === 'tap' && request.x === 999) return;
      const response = request.op === 'screenshot'
        ? { kind: 'image', jpeg_base64: 'aW1hZ2U=', caption: 'fixture points 390×844' }
        : { kind: 'text', text: JSON.stringify({ request, taps, env: {
          IPHONE_UDID: process.env.IPHONE_UDID, ICTL_SOCKET: process.env.ICTL_SOCKET,
          ICTL_DATA_DIR: process.env.ICTL_DATA_DIR, ICTL_MANAGE_USBMUXD: process.env.ICTL_MANAGE_USBMUXD,
          USBMUXD_SOCKET_ADDRESS: process.env.USBMUXD_SOCKET_ADDRESS,
        } }) };
      const line = JSON.stringify(response) + '\n';
      socket.write(line.slice(0, 3));
      setTimeout(() => { if (!socket.destroyed) socket.write(line.slice(3)); }, 5);
    });
  });
  server.listen(process.env.ICTL_SOCKET, () => chmodSync(process.env.ICTL_SOCKET, 0o600));
  process.on('SIGTERM', () => { for (const socket of sockets) socket.destroy(); server.close(() => process.exit(0)); });
} else {
  process.stderr.write('fixture only supports daemon/setup\n'); process.exit(2);
}
