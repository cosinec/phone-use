# syntax=docker/dockerfile:1
# Reuse the published WDA assets. Both Rust executables are built from this source.
FROM ghcr.io/derrors/iphone-control:0.1.4 AS assets
FROM rust:1.90-trixie AS rust-build
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY crates/ ./crates/
COPY apps/ ./apps/
COPY vendor/ ./vendor/
RUN --mount=type=cache,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,target=/usr/local/cargo/git,sharing=locked \
    --mount=type=cache,target=/src/target \
    cargo build --release --locked -p iphone-control -p ictl-gateway \
    && cp target/release/iphone-control target/release/iphone-control-gateway /usr/local/bin/

FROM rust-build AS gateway-notices
COPY docker/about.toml docker/about.hbs /notices/
RUN --mount=type=cache,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,target=/usr/local/cargo/git,sharing=locked \
    cargo install --locked --features cli cargo-about@0.9.3 \
    && cargo about generate --locked -m crates/ictl-gateway/Cargo.toml -c /notices/about.toml /notices/about.hbs -o /GATEWAY_LICENSES.html

FROM node:22-trixie-slim AS web-build
WORKDIR /web
COPY browser-control/package.json browser-control/package-lock.json ./
RUN npm ci
COPY browser-control/ ./
RUN npm run typecheck && npm run build

FROM debian:trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates libgcc-s1 libstdc++6 libssl3t64 zlib1g \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 1000 control
WORKDIR /app
COPY --from=rust-build /usr/local/bin/iphone-control /usr/local/bin/iphone-control-gateway /usr/local/bin/
COPY --from=assets /usr/share/iphone-control/ /usr/share/iphone-control/
COPY --from=assets /usr/share/licenses/ /usr/share/licenses/
COPY --from=assets /usr/share/doc/iphone-control/ /usr/share/doc/iphone-control/
COPY --from=gateway-notices /GATEWAY_LICENSES.html /usr/share/doc/iphone-control/GATEWAY_LICENSES.html
COPY --from=web-build /web/dist/ ./dist/
COPY LICENSE ./LICENSE
COPY browser-control/THIRD_PARTY.md ./THIRD_PARTY.md
RUN mkdir -p /app/.runtime && chown -R control:control /app
USER control
ENV HOST=0.0.0.0 PORT=8787 RUNTIME_DIR=/app/.runtime WEB_DIST_DIR=/app/dist ICTL_BIN=/usr/local/bin/iphone-control MALLOC_ARENA_MAX=2
EXPOSE 8787
CMD ["iphone-control-gateway"]
