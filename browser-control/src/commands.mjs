export function commandRequest(tool, args = {}) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Invalid command args');
  const used = new Set();
  const number = (key, fallback, max = 100_000) => {
    used.add(key);
    const value = args[key] ?? fallback;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > max) throw new Error(`Invalid ${key}`);
    return value;
  };
  const integer = (key, fallback, max = 10_000) => {
    const value = number(key, fallback, max);
    if (!Number.isInteger(value)) throw new Error(`Invalid ${key}`);
    return value;
  };
  const string = (key, fallback, max = 10_000) => {
    used.add(key);
    const value = args[key] ?? fallback;
    if (typeof value !== 'string' || value.length > max || value.includes('\0')) throw new Error(`Invalid ${key}`);
    return value;
  };
  const boolean = (key, fallback = false) => {
    used.add(key);
    const value = args[key] ?? fallback;
    if (typeof value !== 'boolean') throw new Error(`Invalid ${key}`);
    return value;
  };
  const app = () => {
    const value = string('app', undefined, 512);
    if (!value.trim()) throw new Error('Invalid app');
    return value;
  };
  let request;
  switch (tool) {
    case 'iphone_status': request = { op: 'status' }; break;
    case 'iphone_screenshot': {
      const keys = ['x', 'y', 'width', 'height'];
      const region = keys.some(key => args[key] !== undefined) ? keys.map(key => number(key)) : null;
      if (region && (region[2] === 0 || region[3] === 0)) throw new Error('Invalid screenshot dimensions');
      keys.forEach(key => used.add(key));
      request = { op: 'screenshot', region }; break;
    }
    case 'iphone_list_elements': request = { op: 'list_elements', filter: string('filter', ''), limit: integer('limit', 150, 1000), max_age_ms: 0 }; break;
    case 'iphone_tap': request = { op: 'tap', x: number('x'), y: number('y') }; break;
    case 'iphone_tap_element': request = { op: 'tap_element', text: string('text'), index: integer('index', 0), max_age_ms: 0 }; break;
    case 'iphone_long_press': request = { op: 'long_press', x: number('x'), y: number('y'), seconds: number('seconds', 1, 10) }; break;
    case 'iphone_swipe': request = { op: 'swipe', from: [number('from_x'), number('from_y')], to: [number('to_x'), number('to_y')], seconds: number('seconds', 0.3, 10) }; break;
    case 'iphone_type_text': request = { op: 'type_text', text: string('text'), submit: boolean('submit') }; break;
    case 'iphone_press_button': {
      const button = string('button');
      if (!['home', 'volume_up', 'volume_down', 'lock'].includes(button)) throw new Error('Invalid button');
      request = { op: 'press_button', button }; break;
    }
    case 'iphone_list_apps': request = { op: 'list_apps', include_system: boolean('include_system') }; break;
    case 'iphone_launch_app': request = { op: 'launch_app', app: app() }; break;
    case 'iphone_terminate_app': request = { op: 'terminate_app', app: app() }; break;
    case 'iphone_open_url': {
      const url = string('url', undefined, 4096);
      let parsed;
      try { parsed = new URL(url); } catch { throw new Error('Invalid URL'); }
      if (!['http:', 'https:', 'tel:', 'sms:', 'mailto:'].includes(parsed.protocol)) throw new Error('Unsupported URL scheme');
      request = { op: 'open_url', url }; break;
    }
    case 'iphone_wait_for': request = { op: 'wait_for', text: string('text'), timeout_ms: Math.floor(number('timeout', 5, 30) * 1000) }; break;
    case 'iphone_list_devices': request = { op: 'list_devices' }; break;
    default: throw new Error(`Unknown or unsupported tool ${tool}`);
  }
  for (const key of Object.keys(args)) if (!used.has(key)) throw new Error(`Unknown argument ${key}`);
  return request;
}
