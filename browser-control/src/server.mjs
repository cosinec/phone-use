import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGateway } from './gateway.mjs';

export async function startServer(env = process.env) {
  if (!env.CONTROL_ACCESS_TOKEN?.trim()) throw new Error('CONTROL_ACCESS_TOKEN required');
  const host = env.HOST || '127.0.0.1';
  const port = Number(env.PORT ?? 8787);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid PORT');
  const allowedOrigins = env.ALLOWED_ORIGINS?.split(',').map(value => value.trim()).filter(Boolean)
    ?? [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
  const gateway = createGateway({ accessToken: env.CONTROL_ACCESS_TOKEN, allowedOrigins,
    runtimeDir: env.RUNTIME_DIR || path.resolve(fileURLToPath(new URL('../.runtime', import.meta.url))), publicUrl: env.PUBLIC_BASE_URL });
  await gateway.listen(host, port);
  return gateway;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const gateway = await startServer();
    const { address, port } = gateway.server.address();
    console.log(`Gateway listening http://${address.includes(':') ? `[${address}]` : address}:${port}`);
    const stop = () => void gateway.close().then(() => process.exit(0), () => process.exit(1));
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
