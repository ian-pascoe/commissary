#!/usr/bin/env bash
# Post-deploy check of where Cloudflare Access sits (ADR 0022). Retries while a new workers.dev hostname or Access
# application propagates.
# - /healthz answers 200 through Access with a service token;
# - the management API answers 200 through Access with a service token (which proves the Worker accepts the Access
#   JWT, i.e. ACCESS_AUD and the team domain are wired);
# - a proxy route without credentials reaches the Worker, which answers 401 `Missing API key` itself (the proxy routes
#   are out of Access: clients send proxy keys);
# - a client the way `cloudflared access` clients (pi) send it, an Access JWT in `cf-access-token` and a dummy key in
#   `Authorization`, is served on a proxy route (200): the first deploy with the bypass must not break them, since
#   `global` keeps Access sign-ins for clients on by default. The JWT is the `CF_Authorization` cookie Access sets for
#   the service token, which is issued for the main application, like a `cloudflared access login` token;
# - the control panel without credentials is stopped by Access (anything but 200).
# Usage: CF_ACCESS_CLIENT_ID=… CF_ACCESS_CLIENT_SECRET=… tools/check-deploy.sh <base-url>
set -euo pipefail

base="${1:?usage: check-deploy.sh <base-url>}"
base="${base%/}"
: "${CF_ACCESS_CLIENT_ID:?CF_ACCESS_CLIENT_ID is required}"
: "${CF_ACCESS_CLIENT_SECRET:?CF_ACCESS_CLIENT_SECRET is required}"

body="$(mktemp)"
headers="$(mktemp)"
trap 'rm -f "$body" "$headers"' EXIT

# The Access JWT a `cloudflared`-style client sends (set by `access_jwt`).
jwt=""

# Prints the status of `$base$1` with the credentials `$2`: `token` goes through Access with the service token,
# `cloudflared` sends `$jwt` in `cf-access-token` with a dummy API key, `none` sends nothing. Redirects are not followed,
# so an Access sign-in page shows as 302. The response headers land in `$headers`.
status() {
  local auth=()
  case "${2:-none}" in
    token)
      auth=(-H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET")
      ;;
    cloudflared) auth=(-H "cf-access-token: $jwt" -H "Authorization: Bearer sk-dummy") ;;
  esac
  curl -sS -o "$body" -D "$headers" -w '%{http_code}' --max-time 20 "${auth[@]}" "$base$1" || echo 000
}

# Waits until `check <path> <credentials>` succeeds; `describe` names the expectation in messages.
expect() {
  local path="$1" credentials="$2" describe="$3" check="$4" code
  for attempt in $(seq 1 30); do
    code="$(status "$path" "$credentials")"
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
worker_401() { [ "$1" = 401 ] && grep -q '"Missing API key"' "$body"; }
not_ok() { [ "$1" != 200 ] && [ "$1" != 000 ]; }

expect /healthz token "200 through Access" ok
expect /v8/management/me token "200 through Access" ok

# The `CF_Authorization` cookie of the last answer through Access with the service token.
jwt="$(sed -nE 's/^[Ss]et-[Cc]ookie: *CF_Authorization=([^;[:space:]]+).*/\1/p' "$headers" | tail -n 1)"
if [ -z "$jwt" ]; then
  echo "::error::Access set no CF_Authorization cookie for the service token" >&2
  exit 1
fi

expect /v1/models cloudflared "200 with cf-access-token and a dummy key" ok
expect /v1/models none "401 Missing API key from the Worker" worker_401
expect /v1beta/models none "401 Missing API key from the Worker" worker_401
expect / none "no 200 without Access" not_ok
