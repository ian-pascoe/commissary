#!/usr/bin/env bash
# Post-deploy check of a hosted proxy (PROXY_MODE=hosted, ADR 0026): no Access in front, the Worker signs people in.
# Retries while a new workers.dev hostname propagates.
# - /healthz answers 200 with no credentials;
# - /api/sign-in-options answers 200 and offers at least one provider (the sign-in settings reached the Worker);
# - the management API without a session answers 401 from the Worker (not an Access sign-in page);
# - the control panel without a session redirects to /sign-in;
# - a proxy route without credentials answers 401 `Missing API key` from the Worker.
# Usage: tools/check-hosted-deploy.sh <base-url>
set -euo pipefail

base="${1:?usage: check-hosted-deploy.sh <base-url>}"
base="${base%/}"

body="$(mktemp)"
headers="$(mktemp)"
trap 'rm -f "$body" "$headers"' EXIT

# Prints the status of `$base$1`, sent the way the panel sends it (same-origin). Redirects are not followed. The body
# lands in `$body` and the response headers in `$headers`.
status() {
  curl -sS -o "$body" -D "$headers" -w '%{http_code}' --max-time 20 \
    -H "Origin: $base" -H "Sec-Fetch-Site: same-origin" "$base$1" || echo 000
}

# Waits until `check <code>` succeeds for `path`; `describe` names the expectation in messages.
expect() {
  local path="$1" describe="$2" check="$3" code
  for attempt in $(seq 1 30); do
    code="$(status "$path")"
    if "$check" "$code"; then
      echo "$path: $code ($describe)"
      return 0
    fi
    echo "$path: $code, expected $describe (attempt $attempt/30)"
    sleep 10
  done
  echo "::error::$base$path did not answer $describe" >&2
  exit 1
}

ok() { [ "$1" = 200 ]; }
has_provider() { [ "$1" = 200 ] && grep -Eq '"providers":\["' "$body"; }
not_signed_in() { [ "$1" = 401 ] && grep -q '"Not signed in"' "$body"; }
to_sign_in() { [ "$1" = 302 ] && grep -Eiq '^location: */sign-in' "$headers"; }
worker_401() { [ "$1" = 401 ] && grep -q '"Missing API key"' "$body"; }

expect /healthz "200 without credentials" ok
expect /api/sign-in-options "200 with a sign-in provider" has_provider
expect /v8/management/me "401 Not signed in from the Worker" not_signed_in
expect / "a redirect to /sign-in" to_sign_in
expect /v1/models "401 Missing API key from the Worker" worker_401
expect /v1beta/models "401 Missing API key from the Worker" worker_401
