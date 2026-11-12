#!/usr/bin/env bash
# Run a credential-free HTTP/authentication check against the final release image.
set -euo pipefail
image=${1:?Usage: smoke-image.sh IMAGE}
container=phone-use-ci-smoke
config_response=$(mktemp)
cleanup() {
  result=$?
  if (( result != 0 )); then docker logs --tail 80 "$container" || true; fi
  docker rm -f "$container" >/dev/null 2>&1 || true
  rm -f "$config_response"
  exit "$result"
}
trap cleanup EXIT
docker run --detach --name "$container" \
  -p 127.0.0.1:18787:8787 \
  -e HOST=0.0.0.0 -e PORT=8787 \
  -e CONTROL_ACCESS_TOKEN=ci-image-smoke-only \
  -e ALLOWED_ORIGINS=https://phone.invalid -e PUBLIC_BASE_URL=https://phone.invalid \
  "$image"
# Docker may accept the connection before the gateway starts listening, then reset it.
# Keep retry output in a file so a partial response cannot corrupt the JSON check.
curl --fail --silent --show-error --retry 30 --retry-delay 2 --retry-connrefused \
  --retry-all-errors --max-time 5 --retry-max-time 90 --output "$config_response" \
  http://127.0.0.1:18787/api/config
python3 -c 'import json,sys; assert isinstance(json.load(open(sys.argv[1])),dict)' "$config_response"
curl --fail --silent --show-error http://127.0.0.1:18787/ > /dev/null
status=$(curl --silent --show-error -o /dev/null -w '%{http_code}' \
  -X POST http://127.0.0.1:18787/api/sessions)
test "$status" = 401
