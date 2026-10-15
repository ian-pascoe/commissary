#!/usr/bin/env bash
# Post-deploy check of a hosted proxy (PROXY_MODE=hosted, ADR 0026): no Access in front, the Worker signs people in.
# Retries while a new workers.dev hostname propagates.
# - /healthz answers 200 with no credentials;
# - /api/sign-in-options answers 200 and offers at least one provider (the sign-in settings reached the Worker);
# - the management API without a session answers 401 from the Worker (not an Access sign-in page);
# - the control panel without a session redirects to /sign-in;
# - a proxy route without credentials answers 401 `Missing API key` from the Worker;
# - with an API host (ADR 0028): the proxy routes answer 404 on the app host and the management API 404 on the API
#   host, both from the Worker.
# Usage: tools/check-hosted-deploy.sh <base-url> [<api-url>]
# `<api-url>` is where the proxy routes are served (default: `<base-url>`).
set -euo pipefail

base="${1:?usage: check-hosted-deploy.sh <base-url> [<api-url>]}"
base="${base%/}"
api="${2:-$base}"
api="${api%/}"

body="$(mktemp)"
headers="$(mktemp)"
trap 'rm -f "$body" "$headers"' EXIT

# Prints the status of `$1$2`, sent the way the panel sends it (same-origin). Redirects are not followed. The body
# lands in `$body` and the response headers in `$headers`.
status() {
  curl -sS -o "$body" -D "$headers" -w '%{http_code}' --max-time 20 \
    -H "Origin: $1" -H "Sec-Fetch-Site: same-origin" "$1$2" || echo 000
}

# Waits until `check <code>` succeeds for `<host><path>`; `describe` names the expectation in messages.
expect() {
  local host="$1" path="$2" describe="$3" check="$4" code
  for attempt in $(seq 1 30); do
    code="$(status "$host" "$path")"
    if "$check" "$code"; then
      echo "$host$path: $code ($describe)"
      return 0
    fi
    echo "$host$path: $code, expected $describe (attempt $attempt/30)"
    sleep 10
  done
  echo "::error::$host$path did not answer $describe" >&2
  exit 1
}

ok() { [ "$1" = 200 ]; }
has_provider() { [ "$1" = 200 ] && grep -Eq '"providers":\["' "$body"; }
not_signed_in() { [ "$1" = 401 ] && grep -q '"Not signed in"' "$body"; }
to_sign_in() { [ "$1" = 302 ] && grep -Eiq '^location: */sign-in' "$headers"; }
worker_401() { [ "$1" = 401 ] && grep -q '"Missing API key"' "$body"; }
worker_404() { [ "$1" = 404 ] && grep -q '"Not found: ' "$body"; }

expect "$base" /healthz "200 without credentials" ok
expect "$base" /api/sign-in-options "200 with a sign-in provider" has_provider
expect "$base" /v9/management/me "401 Not signed in from the Worker" not_signed_in
expect "$base" / "a redirect to /sign-in" to_sign_in
expect "$api" /v1/models "401 Missing API key from the Worker" worker_401
expect "$api" /v1beta/models "401 Missing API key from the Worker" worker_401

if [ "$api" != "$base" ]; then
  expect "$api" /healthz "200 without credentials" ok
  expect "$base" /v1/models "404 from the Worker: the proxy routes are on the API host" worker_404
  expect "$api" /v9/management/me "404 from the Worker: the management API is on the app host" worker_404
  expect "$api" /sign-in "404 from the Worker: sign-in is on the app host" worker_404
fi
