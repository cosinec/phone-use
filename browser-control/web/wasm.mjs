// Node tests and the browser execute bindings generated from the same Rust crate.
const node = typeof process !== 'undefined' && process.versions?.node;
let runtime;
if (node) {
  const require = process.getBuiltinModule('module').createRequire(import.meta.url);
  runtime = require('../pkg-node/ictl_web.cjs');
} else {
  runtime = await import('../pkg/ictl_web.js');
  await runtime.default();
}
export default runtime;
