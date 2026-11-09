import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createModelClient } from './reference/model-client.mjs';

function client(options = {}) {
  return createModelClient({ baseUrl: 'https://provider.test/v1', model: 'vision-model', apiKey: 'server-only-key', ...options });
}
const observation = { deviceId: '00008130-0000000000000001', imageBase64: 'aW1hZ2U=', caption: 'points 390x844', elementsText: 'Send button' };
const response = value => new Response(JSON.stringify({ choices: [{ message: { content: typeof value === 'string' ? value : JSON.stringify(value) } }] }), { headers: { 'Content-Type': 'application/json' } });

test('compatible provider receives vision, untrusted element text and bounded history without function tools', async () => {
  let sent;
  const model = client({ fetchImpl: async (url, options) => { sent = { url, options }; return response({ type: 'action', tool: 'iphone_press_button', args: { button: 'home' }, reason: 'Go home' }); } });
  const result = await model({ instruction: 'open settings', observation, history: [{ tool: 'iphone_status', result: 'ready' }] });
  assert.equal(model.ready, true); assert.equal(model.model, 'vision-model');
  assert.equal(sent.url, 'https://provider.test/v1/chat/completions');
  assert.equal(sent.options.headers.Authorization, 'Bearer server-only-key');
  assert.equal(sent.options.redirect, 'error'); assert.ok(sent.options.signal instanceof AbortSignal);
  const payload = JSON.parse(sent.options.body);
  assert.equal(payload.model, 'vision-model'); assert.equal(payload.tools, undefined);
  assert.match(payload.messages[0].content, /untrusted/i);
  assert.match(payload.messages[0].content, /iphone_swipe/);
  assert.match(JSON.stringify(payload.messages), /data:image\/jpeg;base64,aW1hZ2U=/);
  assert.match(JSON.stringify(payload.messages), /Send button/);
  assert.equal(result.requiresConfirmation, false);
});

test('missing server model config is explicit and does not call a fake AI', async () => {
  let called = false;
  const model = client({ baseUrl: '', apiKey: '', model: '', fetchImpl: () => { called = true; } });
  assert.equal(model.ready, false); assert.equal(model.model, null);
  await assert.rejects(model({ instruction: 'hello', observation }), /AI is not configured/);
  assert.equal(called, false);
});

test('rejects malformed JSON, extra fields, invalid command args and shape before returning any action', async () => {
  for (const reply of ['```json\n{}\n```', '{broken', { type: 'batch' }, { type: 'done', message: 'ok', tool: 'iphone_tap' },
    { type: 'action', tool: 'iphone_tap', args: { x: -1, y: 2 }, reason: 'tap' },
    { type: 'action', tool: 'iphone_status', args: {}, reason: 'status', requiresConfirmation: 'false' },
    { type: 'action', tool: 'iphone_type_text', args: { text: null }, reason: 'type' },
    { type: 'action', tool: 'iphone_status', args: {}, reason: 'status', extra: 1 }]) {
    const model = client({ fetchImpl: async () => response(reply) });
    await assert.rejects(model({ instruction: 'go', observation }), /Invalid model/);
  }
});

test('provider failures, redirects and response size are bounded and never leak provider body or key', async () => {
  for (const fetchImpl of [async () => { throw new Error('redirect server-only-key'); }, async () => new Response('server-only-key', { status: 500 }),
    async () => response('x'.repeat(1000))]) {
    const model = client({ fetchImpl, limits: { maxResponseBytes: 500 } });
    await assert.rejects(model({ instruction: 'go', observation }), error => !error.message.includes('server-only-key') && /Model/.test(error.message));
  }
});

test('model timeout and caller abort cancel fetch, including a provider that ignores abort', async () => {
  let signal;
  const model = client({ limits: { timeoutMs: 20 }, fetchImpl: async (url, options) => { signal = options.signal; return new Promise(() => {}); } });
  await assert.rejects(model({ instruction: 'go', observation }), /Model request timed out/);
  assert.equal(signal.aborted, true);
  const abort = new AbortController();
  const second = client({ fetchImpl: async (url, options) => { signal = options.signal; return new Promise(() => {}); } });
  const pending = second({ instruction: 'go', observation, signal: abort.signal }); abort.abort();
  await assert.rejects(pending, /Model request cancelled/); assert.equal(signal.aborted, true);
});

test('instruction, image, history and streamed body bounds are enforced', async () => {
  let sent;
  const model = client({ limits: { maxInstructionChars: 10, maxImageBytes: 8, maxHistoryEntries: 2, maxHistoryChars: 100 }, fetchImpl: async (url, options) => { sent = JSON.parse(options.body); return response({ type: 'done', message: 'finished' }); } });
  await assert.rejects(model({ instruction: 'x'.repeat(11), observation }), /instruction/i);
  await assert.rejects(model({ instruction: 'go', observation: { ...observation, imageBase64: Buffer.alloc(9).toString('base64') } }), /image/i);
  await model({ instruction: 'go', observation, history: [{ reason: 'oldest' }, { reason: 'second' }, { reason: 'latest' }] });
  assert.ok(!JSON.stringify(sent).includes('oldest'));
  const streaming = client({ limits: { maxResponseBytes: 50 }, fetchImpl: async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('x'.repeat(51))); controller.close(); } })) });
  await assert.rejects(streaming({ instruction: 'go', observation }), /Model response too large/);
});

test('non-Error provider rejection is sanitized', async () => {
  const model = client({ fetchImpl: async () => { throw null; } });
  await assert.rejects(model({ instruction: 'go', observation }), /Model provider request failed/);
});

test('real fetch rejects provider redirects without forwarding its authorization key', async t => {
  let targetCalls = 0;
  const target = http.createServer((request, response) => { targetCalls++; response.end('unexpected redirect target'); });
  await new Promise(resolve => target.listen(0, '127.0.0.1', resolve));
  const provider = http.createServer((request, response) => {
    assert.equal(request.headers.authorization, 'Bearer server-only-key');
    request.resume(); response.writeHead(302, { Location: `http://127.0.0.1:${target.address().port}/stolen` }); response.end();
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await Promise.all([new Promise(resolve => provider.close(resolve)), new Promise(resolve => target.close(resolve))]); });
  const model = client({ baseUrl: `http://127.0.0.1:${provider.address().port}/v1` });
  await assert.rejects(model({ instruction: 'go', observation }), /Model provider request failed/);
  assert.equal(targetCalls, 0);
});
