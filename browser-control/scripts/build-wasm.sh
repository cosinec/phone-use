#!/bin/sh
set -eu
cd "$(dirname "$0")/../.."
profile=${WASM_BUILD_PROFILE:-debug}
case "$profile" in
    debug) profile_flag= ;;
    release) profile_flag=--release ;;
    *) echo "WASM_BUILD_PROFILE must be debug or release" >&2; exit 2 ;;
esac
# Cargo registry configuration belongs to the developer/CI environment.
cargo "+${RUSTUP_TOOLCHAIN:-1.90.0}" build --locked -p ictl-web --target wasm32-unknown-unknown $profile_flag
bindgen=${WASM_BINDGEN_BIN:-wasm-bindgen}
wasm="target/wasm32-unknown-unknown/$profile/ictl_web.wasm"
"$bindgen" "$wasm" --target web --out-dir browser-control/pkg
"$bindgen" "$wasm" --target nodejs --out-dir browser-control/pkg-node
mv browser-control/pkg-node/ictl_web.js browser-control/pkg-node/ictl_web.cjs
printf '{"type":"commonjs"}\n' > browser-control/pkg-node/package.json
