#!/bin/sh
# Boots the stack under `alchemy dev` (local emulators, local state, no Cloudflare login) and checks that the bundled
# Workers start and answer: the CI replacement for a deploy dry run. It reads each Worker's ready line: the app Worker
# (`Commissary`) serves the checks below, and the state Worker (`State`, ADR 0030), which defines the Durable Objects,
# serves no requests itself. Under `alchemy dev` the app binds its own copy of the Durable Objects (apps/app/src/dev.ts,
# docs/DEVELOPMENT.md "Infrastructure"). Builds the control panel first so `/` is served.
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
state_url=""
i=0
while [ "$i" -lt 180 ]; do
  url=$(ready Commissary)
  state_url=$(ready State)
  if [ -n "$url" ] && [ -n "$state_url" ] && curl -fsS "$url/healthz" >/dev/null 2>&1; then break; fi
  if ! kill -0 "$pid" 2>/dev/null; then cat "$log"; echo "alchemy dev exited" >&2; exit 1; fi
  i=$((i + 1))
  sleep 1
done
if [ -z "$url" ] || [ -z "$state_url" ] || ! curl -fsS "$url/healthz" >/dev/null 2>&1; then
  cat "$log"
  echo "the Workers did not become ready (app: ${url:-no ready line}, state: ${state_url:-no ready line})" >&2
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
check "$url/v1/models"
check "$url/v9/management/settings"
check "$url/v9/management/observability/usage/summary"
check "$url/v9/management/me"
check "$url/v9/management/orgs"
check "$url/v9/management/orgs/default/settings"
check "$url/cdn-cgi/handler/scheduled?cron=0+*/3+*+*+*"
echo "smoke ok: $url (state Worker at $state_url)"
