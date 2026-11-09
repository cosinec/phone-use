# syntax=docker/dockerfile:1
# Keep native binary, unsigned Appium WDA and native license notices unmodified.
FROM ghcr.io/derrors/iphone-control:0.1.4 AS native
FROM node:22-trixie-slim AS build
WORKDIR /app
COPY browser-control/package.json browser-control/package-lock.json ./
RUN npm ci
COPY browser-control/ ./
RUN npm run typecheck && npm run build && npm prune --omit=dev

# The published native binary uses Debian Trixie/glibc; use a compatible Node runtime.
FROM node:22-trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates libgcc-s1 libstdc++6 libssl3t64 zlib1g && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=native /usr/local/bin/iphone-control /usr/local/bin/iphone-control
COPY --from=native /usr/share/iphone-control/ /usr/share/iphone-control/
COPY --from=native /usr/share/licenses/ /usr/share/licenses/
COPY --from=native /usr/share/doc/iphone-control/ /usr/share/doc/iphone-control/
COPY --from=build /app/node_modules/ ./node_modules/
COPY --from=build /app/dist/ ./dist/
COPY --from=build /app/src/ ./src/
COPY --from=build /app/package.json ./package.json
COPY LICENSE ./LICENSE
COPY browser-control/THIRD_PARTY.md ./THIRD_PARTY.md
RUN mkdir -p /app/.runtime && chown -R node:node /app
USER node
ENV HOST=0.0.0.0 PORT=8787 RUNTIME_DIR=/app/.runtime ICTL_BIN=/usr/local/bin/iphone-control MALLOC_ARENA_MAX=2
EXPOSE 8787
# No system usbmuxd: each owned native session receives the virtual mux address.
CMD ["node", "--env-file-if-exists=.env", "src/server.mjs"]
