import { randomUUID } from 'node:crypto';
import { commandRequest } from './commands.mjs';
import { canonicalUID } from './device-identity.mjs';
import { validateModelReply } from './model-client.mjs';

const defaults = { maxSteps: 20, maxRuntimeMs: 6 * 60_000, maxInstructionChars: 4000, maxHistoryEntries: 8 };
const terminal = new Set(['completed', 'failed', 'stopped']);
const taskError = Symbol('taskError');
const failure = (status, message) => Object.assign(new Error(message), { status, [taskError]: true });
const safeModelErrors = new Set(['AI is not configured', 'Invalid task instruction', 'Invalid phone observation', 'Phone image exceeds model limit',
  'Model request cancelled', 'Model request timed out', 'Model provider request failed', 'Model response too large', 'Invalid model response', 'Invalid model JSON response', 'Invalid model reply']);
const sensitive = /\b(send|submit|pay|purchase|delete|erase|remove)\b|发送|提交|支付|购买|删除|清空|转账/i;

function confirmationRequired(action, request) {
  return action.requiresConfirmation || request.op === 'terminate_app' || (request.op === 'type_text' && request.submit)
    || (request.op === 'open_url' && !['http:', 'https:'].includes(new URL(request.url).protocol))
    || (['tap', 'tap_element', 'long_press'].includes(request.op) && sensitive.test(`${action.reason} ${action.args.text ?? ''}`));
}
function missed(result) {
  // ictl-protocol TAP_MISSED, plus English output used by gateway lang=en.
  return result.outcome ? result.outcome.tapped_nothing === true : /^(没找到|只匹配到|被挡住|Not found|Only matched|Covered)/.test(result.text ?? '');
}
function cancellable(promise, signal) {
  if (signal.aborted) return Promise.reject(failure(409, 'Task cancelled'));
  return new Promise((resolve, reject) => {
    const abort = () => reject(failure(409, 'Task cancelled'));
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

export class TaskRunner {
  constructor({ model, session, limits = {} }) {
    this.model = model; this.session = session; this.limits = { ...defaults, ...limits }; this.task = null;
    for (const [key, value] of Object.entries(this.limits)) {
      if (!(key in defaults) || !Number.isInteger(value) || value < 1 || value > defaults[key]) throw new Error('Invalid task limits');
    }
  }

  start(instruction) {
    if (this.task && !terminal.has(this.task.state)) throw failure(409, 'Session already has an active task');
    if (typeof this.model !== 'function' || this.model.ready === false) throw failure(503, 'AI is not configured');
    if (this.session.abort.signal.aborted) throw failure(410, 'Session closed');
    if (typeof instruction !== 'string' || !instruction.trim() || instruction.length > this.limits.maxInstructionChars || instruction.includes('\0')) throw failure(400, 'Invalid task instruction');
    const task = { id: randomUUID(), instruction: instruction.trim(), state: 'observing', steps: [], confirmation: null,
      startedAt: new Date().toISOString(), finishedAt: null, message: null, error: null, abort: new AbortController() };
    this.task = task;
    task.onClose = () => this.finish(task, 'stopped', 'Session disconnected. Already sent actions cannot be undone.');
    this.session.abort.signal.addEventListener('abort', task.onClose, { once: true });
    task.timer = setTimeout(() => this.finish(task, 'failed', null, 'Task time limit reached'), this.limits.maxRuntimeMs);
    void this.run(task);
    return this.snapshot();
  }

  active(task) { return this.task === task && !terminal.has(task.state) && !task.abort.signal.aborted && !this.session.abort.signal.aborted; }

  finish(task, state, message = null, error = null) {
    if (terminal.has(task.state)) return;
    const executing = task.steps.find(step => step.state === 'executing');
    if (executing) {
      executing.state = 'uncertain'; executing.finishedAt = new Date().toISOString();
      message ??= 'A device action may already have been sent and cannot be undone.';
    }
    for (const step of task.steps) {
      if (['pending', 'awaiting_confirmation'].includes(step.state)) { step.state = 'cancelled'; step.finishedAt = new Date().toISOString(); }
    }
    task.state = state; task.message = message; task.error = error; task.finishedAt = new Date().toISOString(); task.confirmation = null;
    clearTimeout(task.timer); this.session.abort.signal.removeEventListener('abort', task.onClose); task.abort.abort(); task.resolveConfirmation = null;
  }

  stop(taskId) {
    if (!this.task || this.task.id !== taskId) throw failure(404, 'Task not found');
    this.finish(this.task, 'stopped', 'Task stopped. Already sent actions cannot be undone.');
    return this.snapshot();
  }

  confirm(taskId, actionId, approved) {
    const task = this.task;
    if (!task || task.id !== taskId || !this.active(task) || task.state !== 'awaiting_confirmation'
        || task.confirmation?.actionId !== actionId || typeof approved !== 'boolean') throw failure(409, 'Invalid or stale confirmation');
    const resolve = task.resolveConfirmation;
    task.confirmation = null; task.resolveConfirmation = null;
    if (!approved) this.finish(task, 'stopped', 'Action confirmation declined.');
    else { task.state = 'executing'; resolve(); }
    return this.snapshot();
  }

  snapshot() {
    if (!this.task) return null;
    const { id, instruction, state, steps, confirmation, startedAt, finishedAt, message, error } = this.task;
    return structuredClone({ id, instruction, state, steps, confirmation, startedAt, finishedAt, message, error });
  }

  async run(task) {
    try {
      while (this.active(task)) {
        task.state = 'observing';
        const observation = await cancellable(this.session.screen(), task.abort.signal);
        if (!this.active(task)) return;
        if (observation.deviceId !== undefined && canonicalUID(observation.deviceId) !== canonicalUID(this.session.device.serialNumber)) throw failure(409, 'Observation device identity mismatch');
        task.state = 'thinking';
        const history = task.steps.slice(-this.limits.maxHistoryEntries).map(({ tool, args, reason, state, result }) => ({ tool, args, reason, state, result }));
        const reply = await cancellable(this.model({ instruction: task.instruction, observation, history, signal: task.abort.signal }), task.abort.signal);
        if (!this.active(task)) return;
        const action = validateModelReply(reply);
        if (action.type === 'done') { this.finish(task, 'completed', action.message); return; }
        if (task.steps.length >= this.limits.maxSteps) throw failure(409, 'Task step limit reached');
        const request = commandRequest(action.tool, action.args);
        const step = { id: randomUUID(), tool: action.tool, args: action.args, reason: action.reason, state: 'pending',
          startedAt: new Date().toISOString(), finishedAt: null, result: null };
        task.steps.push(step);
        if (confirmationRequired(action, request)) {
          step.state = 'awaiting_confirmation'; task.state = 'awaiting_confirmation';
          task.confirmation = { actionId: step.id, tool: step.tool, args: step.args, reason: step.reason };
          await cancellable(new Promise(resolve => { task.resolveConfirmation = resolve; }), task.abort.signal);
        }
        if (!this.active(task)) return;
        step.state = 'executing'; task.state = 'executing';
        const result = await cancellable(this.session.runCommand({ requestId: `task:${task.id}:${step.id}`, deviceId: this.session.device.serialNumber,
          tool: step.tool, args: step.args, signal: task.abort.signal }), task.abort.signal);
        if (!this.active(task)) return;
        if (!result || !['text', 'image', 'error'].includes(result.kind)) throw failure(503, 'Invalid native action response');
        step.result = { kind: result.kind }; step.finishedAt = new Date().toISOString();
        if (result.kind === 'error') { step.state = 'failed'; throw failure(503, 'Native action failed'); }
        if (step.tool === 'iphone_tap_element' && missed(result)) { step.state = 'missed'; throw failure(409, 'Element tap missed; task halted'); }
        step.state = 'succeeded';
      }
    } catch (error) {
      if (this.active(task)) this.finish(task, 'failed', null, error?.[taskError] || safeModelErrors.has(error?.message) ? error.message : 'Task operation failed; no action is retried');
    }
  }
}
