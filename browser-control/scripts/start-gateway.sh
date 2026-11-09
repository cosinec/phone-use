#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
if [ -n "${GATEWAY_BIN:-}" ]; then
    exec "$GATEWAY_BIN"
fi
# Node is used by Vite and tests. The running service is the Rust executable.
exec cargo run --locked --manifest-path ../Cargo.toml -p ictl-gateway --bin iphone-control-gateway
