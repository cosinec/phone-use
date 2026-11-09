import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { TaskRunner } from '../src/task-runner.mjs';

const action = (tool = 'iphone_press_button', args = { button: 'home' }, reason = 'Go home') => ({ type: 'action', tool, args, reason });
function setup(model, limits) {
  const calls = [];
  const session = { device: { serialNumber: '00008130-0000000000000001' }, abort: new AbortController(),
    screen: async () => ({ deviceId: '00008130-0000000000000001', elementsText: 'Home', imageBase64: 'aW1hZ2U=' }),
    runCommand: async input => { calls.push(input); return { kind: 'text', text: 'Native secret pairRecord token must not enter snapshot', outcome: {} }; } };
  return { runner: new TaskRunner({ model, session, limits }), session, calls };
}
async function until(predicate) {
  for (let n = 0; n < 200; n++) { if (predicate()) return; await sleep(5); }
  assert.fail('task did not settle');
}

test('stop invalidates a held model generation so a late reply executes zero commands', async () => {
  let release;
  const { runner, calls } = setup(() => new Promise(resolve => { release = resolve; }));
  const task = runner.start('open settings');
  await until(() => release); runner.stop(task.id); release(action()); await sleep(20);
  assert.equal(calls.length, 0); assert.equal(runner.snapshot().state, 'stopped');
});

test('observe, execute once and complete with bounded structured history and safe snapshots', async () => {
  const inputs = [];
  const { runner, calls } = setup(async input => { inputs.push(input); return inputs.length === 1 ? action() : { type: 'done', message: 'Finished' }; });
  runner.start('open settings'); await until(() => runner.snapshot().state === 'completed');
  assert.equal(calls.length, 1); assert.equal(calls[0].deviceId, '00008130-0000000000000001');
  assert.ok(calls[0].signal instanceof AbortSignal);
  assert.equal(inputs[1].history.length, 1); assert.equal(inputs[1].observation.elementsText, 'Home');
  assert.equal(runner.snapshot().steps[0].state, 'succeeded');
  assert.ok(!JSON.stringify(runner.snapshot()).includes('Native secret'));
  const copy = runner.snapshot(); copy.steps[0].args.button = 'lock';
  assert.equal(runner.snapshot().steps[0].args.button, 'home');
});

test('sensitive actions require explicit confirmation even when the model omits its flag', async () => {
  for (const request of [action('iphone_type_text', { text: 'hello', submit: true }), action('iphone_terminate_app', { app: 'Mail' }),
    action('iphone_open_url', { url: 'sms:123' }), action('iphone_tap_element', { text: '发送' }), action('iphone_tap', { x: 1, y: 2 }, 'Send the message')]) {
    let iterations = 0;
    const { runner, calls } = setup(async () => ++iterations === 1 ? request : { type: 'done', message: 'done' });
    const task = runner.start('do it'); await until(() => runner.snapshot().state === 'awaiting_confirmation');
    assert.equal(calls.length, 0);
    const { actionId } = runner.snapshot().confirmation;
    assert.throws(() => runner.confirm(task.id, 'stale', true), /confirmation/i);
    runner.confirm(task.id, actionId, true);
    assert.throws(() => runner.confirm(task.id, actionId, true), /confirmation/i);
    await until(() => runner.snapshot().state === 'completed'); assert.equal(calls.length, 1);
  }
});

test('confirmation denial, stop and session abort cannot release held actions', async () => {
  for (const choice of ['deny', 'stop', 'disconnect']) {
    const { runner, session, calls } = setup(async () => ({ ...action(), requiresConfirmation: true }));
    const task = runner.start('go'); await until(() => runner.snapshot().confirmation);
    const { actionId } = runner.snapshot().confirmation;
    if (choice === 'deny') runner.confirm(task.id, actionId, false);
    else if (choice === 'stop') runner.stop(task.id);
    else session.abort.abort();
    await until(() => runner.snapshot().state === 'stopped');
    assert.equal(runner.snapshot().steps[0].state, 'cancelled');
    assert.throws(() => runner.confirm(task.id, actionId, true), /confirmation/i); assert.equal(calls.length, 0);
  }
});

test('invalid actions, mismatched observation identity, missed taps and native errors terminate without followup', async () => {
  for (const result of [{ kind: 'error', message: 'secret native data' }, { kind: 'text', text: 'Not found', outcome: { tapped_nothing: true } },
    ...['没找到', '只匹配到', '被挡住', 'Not found'].map(text => ({ kind: 'text', text }))]) {
    let models = 0;
    const { runner, session, calls } = setup(async () => { models++; return action('iphone_tap_element', { text: 'Settings' }); });
    session.runCommand = async request => { calls.push(request); return result; };
    runner.start('go'); await until(() => runner.snapshot().state === 'failed');
    assert.equal(models, 1); assert.equal(calls.length, 1); assert.ok(!JSON.stringify(runner.snapshot()).includes('secret native data'));
  }
  const invalid = setup(async () => action('iphone_tap', { x: -1, y: 2 })); invalid.runner.start('go');
  await until(() => invalid.runner.snapshot().state === 'failed'); assert.equal(invalid.calls.length, 0);
  const mismatch = setup(async () => action()); mismatch.session.screen = async () => ({ deviceId: '00008130-0000000000000002' });
  mismatch.runner.start('go'); await until(() => mismatch.runner.snapshot().state === 'failed'); assert.equal(mismatch.calls.length, 0);
});

test('one task per session, instruction bounds, step and wallclock limits are enforced', async () => {
  const { runner, calls } = setup(async () => action(), { maxSteps: 2, maxInstructionChars: 10 });
  assert.throws(() => runner.start('x'.repeat(11)), /instruction/i);
  assert.throws(() => runner.start(''), /instruction/i);
  runner.start('go'); assert.throws(() => runner.start('another'), /active task/i);
  await until(() => runner.snapshot().state === 'failed'); assert.equal(calls.length, 2); assert.match(runner.snapshot().error, /step limit/i);
  const timed = setup(() => new Promise(() => {}), { maxRuntimeMs: 20 }); timed.runner.start('go');
  await until(() => timed.runner.snapshot().state === 'failed'); assert.match(timed.runner.snapshot().error, /time limit/i);
  const missing = setup(Object.assign(async () => {}, { ready: false })); assert.throws(() => missing.runner.start('go'), /AI is not configured/);
});

test('stop while executing aborts the command and reports the sent action as uncertain without retry', async () => {
  const { runner, session, calls } = setup(async () => action());
  session.runCommand = async input => { calls.push(input); return new Promise((resolve, reject) => input.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })); };
  const task = runner.start('go'); await until(() => calls.length === 1); runner.stop(task.id);
  await sleep(20); assert.equal(calls[0].signal.aborted, true); assert.equal(calls.length, 1);
  assert.equal(runner.snapshot().steps[0].state, 'uncertain'); assert.match(runner.snapshot().message, /cannot be undone/i);
});

test('observation/provider errors do not leak secrets into snapshots and malformed responses remain uncertain', async () => {
  const observed = setup(async () => action());
  observed.session.screen = async () => { throw Object.assign(new Error('pairRecord secret-key'), { status: 503 }); };
  observed.runner.start('go'); await until(() => observed.runner.snapshot().state === 'failed');
  assert.ok(!JSON.stringify(observed.runner.snapshot()).includes('secret-key'));
  const provider = setup(async () => { throw Object.assign(new Error('provider secret-key'), { code: 'MODEL_ERROR' }); });
  provider.runner.start('go'); await until(() => provider.runner.snapshot().state === 'failed');
  assert.ok(!JSON.stringify(provider.runner.snapshot()).includes('secret-key'));
  const invalid = setup(async () => action()); invalid.session.runCommand = async () => ({ kind: 'unexpected' });
  invalid.runner.start('go'); await until(() => invalid.runner.snapshot().state === 'failed');
  assert.equal(invalid.runner.snapshot().steps[0].state, 'uncertain');
});

test('approval followed immediately by stop cancels the action before dispatch and does not leave a waiting step', async () => {
  const { runner, calls } = setup(async () => ({ ...action(), requiresConfirmation: true }));
  const task = runner.start('go'); await until(() => runner.snapshot().confirmation);
  runner.confirm(task.id, runner.snapshot().confirmation.actionId, true); runner.stop(task.id); await sleep(20);
  assert.equal(calls.length, 0); assert.equal(runner.snapshot().steps[0].state, 'cancelled');
});

test('non-Error model rejection produces a terminal task error', async t => {
  const { runner, calls } = setup(async () => { throw null; });
  const task = runner.start('go'); t.after(() => runner.stop(task.id));
  await until(() => runner.snapshot().state === 'failed'); assert.equal(calls.length, 0);
});
