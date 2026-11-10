#!/bin/sh
set -eu
cd "$(dirname "$0")/../.."
# Cargo's source configuration is owned by the developer/CI environment.
cargo "+${RUSTUP_TOOLCHAIN:-1.90.0}" build --locked -p ictl-web --target wasm32-unknown-unknown
bindgen=${WASM_BINDGEN_BIN:-wasm-bindgen}
"$bindgen" target/wasm32-unknown-unknown/debug/ictl_web.wasm --target web --out-dir browser-control/pkg
"$bindgen" target/wasm32-unknown-unknown/debug/ictl_web.wasm --target nodejs --out-dir browser-control/pkg-node
mv browser-control/pkg-node/ictl_web.js browser-control/pkg-node/ictl_web.cjs
printf '{"type":"commonjs"}\n' > browser-control/pkg-node/package.json
