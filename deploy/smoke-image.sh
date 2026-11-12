#!/usr/bin/env bash
# Run a credential-free HTTP/authentication check against the final release image.
set -euo pipefail
image=${1:?Usage: smoke-image.sh IMAGE}
container=phone-use-ci-smoke
cleanup() {
  result=$?
  if (( result != 0 )); then docker logs --tail 80 "$container" || true; fi
  docker rm -f "$container" >/dev/null 2>&1 || true
  exit "$result"
}
trap cleanup EXIT
docker run --detach --name "$container" \
  -p 127.0.0.1:18787:8787 \
  -e HOST=0.0.0.0 -e PORT=8787 \
  -e CONTROL_ACCESS_TOKEN=ci-image-smoke-only \
  -e ALLOWED_ORIGINS=https://phone.invalid -e PUBLIC_BASE_URL=https://phone.invalid \
  "$image"
curl --fail --silent --show-error --retry 30 --retry-delay 2 --retry-connrefused \
  http://127.0.0.1:18787/api/config | python3 -c 'import json,sys; assert isinstance(json.load(sys.stdin),dict)'
curl --fail --silent --show-error http://127.0.0.1:18787/ > /dev/null
status=$(curl --silent --show-error -o /dev/null -w '%{http_code}' \
  -X POST http://127.0.0.1:18787/api/sessions)
test "$status" = 401
