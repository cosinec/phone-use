import test from 'node:test';
import assert from 'node:assert/strict';
const wasm = await import('../pkg-node/ictl_web.cjs').catch(() => ({}));
test('Rust WASM exports perform identity and gesture operations through the runtime entry', () => {
  assert.equal(typeof wasm.canonicalUID, 'function', 'Rust canonicalUID export must exist');
  assert.equal(wasm.canonicalUID('00008140001234567890abcd'), '00008140-001234567890ABCD');
  assert.equal(wasm.toPhonePoint(25, 110, {left:20,top:10,width:200,height:200},100,200), null);
});

test('Rust stop dispatch starts in the current session before a synchronous disconnect', async () => {
  const { BrowserClient } = await import('../web/client.mjs');
  const requests = [];
  const client = new BrowserClient({
    sdk: {
      requestUSBAccess: () => Promise.resolve({device:{},hello:{serialNumber:'00008140001234567890abcd',vendorId:1452,productId:1}}),
      getPairRecord: async () => undefined,
      pairDevice: async () => ({relay:{close(){}}}),
      closeDeviceRelayTarget: async () => {},
    },
    usbEvents: null,
    fetchImpl: async (url, options) => {
      requests.push(url);
      return {ok:true,json:async()=>({id:'owned-session',deviceId:'00008140-001234567890ABCD',token:'session-token'})};
    },
  });
  await client.connect({apiBase:'http://cloud',accessToken:'controller'});
  const stopping = client.stopTask('task');
  stopping.catch(() => {});
  assert.ok(requests.includes('http://cloud/api/sessions/owned-session/tasks/task/stop'));
  await client.disconnect();
  await stopping;
  assert.equal(client.snapshot().phase, 'offline');
});

test('Rust shell quoting preserves the previous String conversion behavior', () => {
  assert.equal(wasm.quote(42), "'42'");
  assert.equal(wasm.quote(null), "'null'");
  assert.equal(wasm.quote(undefined), "'undefined'");
});
