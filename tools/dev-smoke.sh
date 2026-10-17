#!/bin/sh
# Boots the stack under `alchemy dev` (local emulators, local state, no Cloudflare login) and checks that the bundled
# Workers start and answer: the CI replacement for a deploy dry run. It reads each Worker's ready line (ADR 0030): the
# app Worker (`Commissary`) serves the panel and the management API, the API Worker (`Api`) the client API and the cron
# jobs, and the state Worker (`State`), which defines the Durable Objects, serves no requests itself. Under `alchemy dev`
# the app binds its own copy of the Durable Objects (apps/app/src/dev.ts) and the API Worker reaches them over the app's
# dev-only bridge (apps/api/src/dev.ts, docs/DEVELOPMENT.md "Infrastructure"). It ends with the self-hosted journey
# across the Workers: an API key issued on the app Worker is taken by the API Worker, and refused there once revoked.
# Builds the control panel first so `/` is served.
# Usage: pnpm smoke
set -eu
cd "$(dirname "$0")/.."
pnpm -s exec turbo run build --filter=@commissary/web --output-logs=errors-only
log=$(mktemp)
ALCHEMY_STATE=local pnpm exec alchemy dev --stage smoke >"$log" 2>&1 &
pid=$!
cleanup() {
  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
  rm -rf .alchemy/state/commissary/smoke .alchemy/local
}
trap cleanup EXIT INT TERM

# The URL a Worker's ready line (`[<logical id>] ready at <url>`) names, once it is printed.
ready() {
  sed -n "s/.*\\[$1\\] ready at \\(http[^ ]*\\).*/\\1/p" "$log" | tail -n 1
}

url=""
api_url=""
state_url=""
up() {
  [ -n "$url" ] && [ -n "$api_url" ] && [ -n "$state_url" ] &&
    curl -fsS "$url/healthz" >/dev/null 2>&1 && curl -fsS "$api_url/healthz" >/dev/null 2>&1
}
i=0
while [ "$i" -lt 180 ]; do
  url=$(ready Commissary)
  api_url=$(ready Api)
  state_url=$(ready State)
  if up; then break; fi
  if ! kill -0 "$pid" 2>/dev/null; then cat "$log"; echo "alchemy dev exited" >&2; exit 1; fi
  i=$((i + 1))
  sleep 1
done
if ! up; then
  cat "$log"
  echo "the Workers did not become ready (app: ${url:-no ready line}, API: ${api_url:-no ready line}, state: ${state_url:-no ready line})" >&2
  exit 1
fi

# expect <status> <curl arguments>
expect() {
  want=$1
  shift
  status=$(curl -s -o /dev/null -w '%{http_code}' "$@")
  echo "$status $*"
  [ "$status" = "$want" ] || { cat "$log"; exit 1; }
}
check() { expect 200 "$@"; }
# The state Worker has no routes.
expect 404 "$state_url/"
check "$url/healthz"
# An address without an org redirects to the caller's only org.
check -L "$url/"
check -L "$url/accounts"
check "$url/o/default/"
check "$url/o/default/accounts"
check "$url/v9/management/settings"
check "$url/v9/management/observability/usage/summary"
check "$url/v9/management/me"
check "$url/v9/management/orgs"
check "$url/v9/management/orgs/default/settings"
# Each Worker serves its own paths only.
expect 404 "$url/v1/models"
expect 404 "$api_url/v9/management/me"
check "$api_url/healthz"
check "$api_url/v1/models"
check "$api_url/cdn-cgi/handler/scheduled?cron=0+*/3+*+*+*"

# The self-hosted journey across the Workers, as the dev admin (the dev bypass): join `default` (409 when already a
# member: API keys are issued to members), issue an API key on the app Worker, use it on the API Worker, revoke it on
# the app Worker, and wait until the API Worker refuses it (its verified-key cache keeps a key for up to 30 s,
# packages/auth's VERIFIED_KEY_TTL_MS). The key is never printed.
body=$(mktemp)
json() { curl -s -o "$body" -w '%{http_code}' -H 'content-type: application/json' "$@"; }
org="$url/v9/management/orgs/default"
# The dev admin: ACCESS_DEV_BYPASS from the environment or .env, as infra/settings.ts reads it.
dev_email="${ACCESS_DEV_BYPASS:-$(sed -n "s/^ACCESS_DEV_BYPASS=[\"']*\([^\"']*\).*/\1/p" .env 2>/dev/null | tail -n 1)}"
status=$(json -X POST -d "{\"email\":\"${dev_email:-dev@example.com}\",\"role\":\"member\"}" "$org/members")
echo "$status POST $org/members"
case "$status" in 201 | 409) ;; *) cat "$body" "$log"; exit 1 ;; esac
status=$(json -X POST -d '{"name":"smoke"}' "$org/api-keys")
echo "$status POST $org/api-keys"
[ "$status" = 201 ] || { cat "$body" "$log"; exit 1; }
key=$(sed -n 's/.*"key":"\([^"]*\)".*/\1/p' "$body")
id=$(sed -n 's/.*"id":"\([^"]*\)".*/\1/p' "$body")
[ -n "$key" ] && [ -n "$id" ] || { echo "no key or id in the answer" >&2; exit 1; }
with_key() { curl -s -o /dev/null -w '%{http_code}' -H "authorization: Bearer $key" "$api_url/v1/models"; }
status=$(with_key)
echo "$status $api_url/v1/models with the key"
[ "$status" = 200 ] || { cat "$log"; exit 1; }
expect 200 -X DELETE "$org/api-keys/$id"
i=0
until [ "$(with_key)" = 401 ]; do
  i=$((i + 1))
  [ "$i" -lt 65 ] || { cat "$log"; echo "the API Worker still takes the revoked key" >&2; exit 1; }
  sleep 1
done
echo "401 $api_url/v1/models with the revoked key, after ${i}s"
rm -f "$body"
echo "smoke ok: $url (API Worker at $api_url, state Worker at $state_url)"
