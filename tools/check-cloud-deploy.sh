#!/usr/bin/env bash
# Post-deploy check of Commissary Cloud (COMMISSARY_MODE=cloud, ADR 0026): no Access in front, the auth Worker signs
# people in on the auth host (ADR 0030). Retries while a new workers.dev hostname propagates.
# - /healthz answers 200 with no credentials, on the app host and on the auth host;
# - on the auth host, /api/sign-in-options answers 200 and offers at least one provider (the sign-in settings reached the
#   auth Worker), Better Auth's health check `/api/auth/ok` answers 200 (its secret and database are in place), and a
#   preflight from the app origin is allowed while one from another origin is refused (CORS);
# - the management API without a session answers 401 from the Worker (not an Access sign-in page);
# - the control panel without a session redirects to /sign-in;
# - a client API route without credentials answers 401 `Missing API key` from the API Worker (ADR 0030);
# - when the client API has a host of its own (an API host, ADR 0028, or a preview's API Worker workers.dev URL): the
#   client API answers 404 on the app host (from the app Worker) and the management API 404 there (from the API
#   Worker).
# Usage: tools/check-cloud-deploy.sh <base-url> <api-url> <auth-url>
# `<api-url>` is where the client API is served (empty: `<base-url>`), `<auth-url>` the auth host.
set -euo pipefail

usage="usage: check-cloud-deploy.sh <base-url> <api-url> <auth-url>"
base="${1:?$usage}"
base="${base%/}"
api="${2:-$base}"
api="${api%/}"
auth="${3:?$usage}"
auth="${auth%/}"

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

# Prints the status of a CORS preflight of a sign-in on the auth host, sent from the origin `$1`. The response headers
# land in `$headers`.
preflight() {
  curl -sS -o /dev/null -D "$headers" -w '%{http_code}' --max-time 20 -X OPTIONS \
    -H "Origin: $1" -H "Access-Control-Request-Method: POST" \
    -H "Access-Control-Request-Headers: content-type" "$auth/api/auth/sign-in/social" || echo 000
}

# Checks the auth host's answer to a preflight from the app origin and from another origin, retrying like `expect`.
expect_cors() {
  local allowed refused
  for attempt in $(seq 1 30); do
    allowed="$(preflight "$base")"
    if [ "$allowed" = 204 ] && grep -Fiq "access-control-allow-origin: $base" "$headers"; then
      refused="$(preflight "https://elsewhere.invalid")"
      if [ "$refused" = 403 ] && ! grep -iq '^access-control-allow-origin:' "$headers"; then
        echo "$auth: preflights allowed from $base ($allowed) and refused from elsewhere ($refused)"
        return 0
      fi
    fi
    echo "$auth: preflight ${allowed:-?}/${refused:-?}, expected 204 from $base and 403 from elsewhere (attempt $attempt/30)"
    sleep 10
  done
  echo "::error::$auth did not answer the CORS preflights as expected" >&2
  exit 1
}

ok() { [ "$1" = 200 ]; }
has_provider() { [ "$1" = 200 ] && grep -Eq '"providers":\["' "$body"; }
not_signed_in() { [ "$1" = 401 ] && grep -q '"Not signed in"' "$body"; }
to_sign_in() { [ "$1" = 302 ] && grep -Eiq '^location: */sign-in' "$headers"; }
worker_401() { [ "$1" = 401 ] && grep -q '"Missing API key"' "$body"; }
worker_404() { [ "$1" = 404 ] && grep -q '"Not found: ' "$body"; }

expect "$base" /healthz "200 without credentials" ok
expect "$auth" /healthz "200 without credentials" ok
expect "$auth" /api/sign-in-options "200 with a sign-in provider" has_provider
expect "$auth" /api/auth/ok "200 from Better Auth" ok
expect_cors
expect "$base" /v9/management/me "401 Not signed in from the Worker" not_signed_in
expect "$base" / "a redirect to /sign-in" to_sign_in
expect "$api" /v1/models "401 Missing API key from the Worker" worker_401
expect "$api" /v1beta/models "401 Missing API key from the Worker" worker_401

if [ "$api" != "$base" ]; then
  expect "$api" /healthz "200 without credentials" ok
  expect "$base" /v1/models "404 from the Worker: the client API is on the API host" worker_404
  expect "$api" /v9/management/me "404 from the Worker: the management API is on the app host" worker_404
  expect "$api" /sign-in "404 from the Worker: sign-in is on the app host" worker_404
fi
