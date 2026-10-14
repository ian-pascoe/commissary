#!/usr/bin/env bash
# CI deploy of one stage (.github/workflows/ci.yml): runs `alchemy deploy` with the settings in the environment and
# writes the Worker's URL to the step output `url`. The control panel must be built first (`pnpm web:build`).
# Usage: tools/deploy-stage.sh <stage>
set -euo pipefail

stage="${1:?usage: deploy-stage.sh <stage>}"
log="${RUNNER_TEMP:-/tmp}/deploy-$stage.log"

pnpm run deploy --stage "$stage" --no-input --yes | tee "$log"

# The deploy ends by printing the stack outputs: `url: 'https://…'` on a line of its own, or inline when the outputs are
# short (`{ url: 'https://…', accessAud: '', … }`).
url="$(sed -nE "s/^.*[{ ]url: '(https:[^']+)'.*$/\1/p" "$log" | tail -n 1)"

if [ -z "$url" ]; then
  echo "::error::the deploy printed no url output" >&2
  exit 1
fi

echo "url=$url" >>"${GITHUB_OUTPUT:-/dev/stdout}"
