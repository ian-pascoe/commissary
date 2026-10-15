# Connecting clients

All examples use `https://proxy.example.com` as the Worker's hostname and a **proxy key**: a key the proxy issues to a
member of an org (ADR 0022). Create one in the control panel under **Proxy keys** (any member can); it is shown once, so
copy it then. A key looks like `cfp_<org id>_<key id>_<secret>`: it names its org, so the proxy serves the request from
that org's accounts, and it acts as the member who created it (usage is recorded against the key and its member, and
one member's keys share session state). Export it once; never commit it:

```bash
export PROXY_KEY='cfp_…'
```

Send the key wherever the client sends a provider API key: `Authorization: Bearer <key>` (OpenAI, Codex, Claude Code's
auth token), `x-api-key` (Anthropic), `x-goog-api-key` or `?key=` (Gemini). The proxy routes (`/v1*`, `/openai/v1*`,
`/backend-api/codex*` and the unprefixed `/chat/completions`, `/completions`, `/responses`) are not behind Cloudflare
Access, so no Access headers are needed. A missing key answers `401 {"error":"Missing API key"}`; a wrong, revoked or
expired key `401 {"error":"Invalid API key"}`. Revoking a key in the panel takes effect within 30 seconds. List the
model ids you can use with `GET /v1/models`.

Clients set up before proxy keys that sign in through Access (a `cloudflared access` token in the `cf-access-token`
header) keep working in the first org (`global`) while its owner leaves **Access sign-ins for clients** on (the
`access_clients` setting, on by default); they never reach another org. See [MIGRATION.md](MIGRATION.md#5-move-clients-to-proxy-keys).
Access service token headers (`CF-Access-Client-Id`/`-Secret`) are not accepted on the proxy routes any more.

## curl

```bash
H=(-H "Authorization: Bearer $PROXY_KEY")
curl "${H[@]}" https://proxy.example.com/v1/models

# OpenAI chat completions
curl "${H[@]}" https://proxy.example.com/v1/chat/completions -H 'content-type: application/json' \
  -d '{"model":"gpt-5","messages":[{"role":"user","content":"hi"}]}'

# Anthropic messages
curl -H "x-api-key: $PROXY_KEY" https://proxy.example.com/v1/messages -H 'content-type: application/json' \
  -H 'anthropic-version: 2023-06-01' \
  -d '{"model":"claude-sonnet-4-5","max_tokens":256,"messages":[{"role":"user","content":"hi"}]}'

# Gemini
curl -H "x-goog-api-key: $PROXY_KEY" 'https://proxy.example.com/v1beta/models/gemini-2.5-pro:generateContent' \
  -H 'content-type: application/json' -d '{"contents":[{"role":"user","parts":[{"text":"hi"}]}]}'
```

Replace the model ids with ones from `/v1/models`.

## Claude Code

Claude Code reads these environment variables (see the
[environment variable reference](https://code.claude.com/docs/en/env-vars)):

```bash
export ANTHROPIC_BASE_URL=https://proxy.example.com
export ANTHROPIC_AUTH_TOKEN="$PROXY_KEY"   # sent as "Authorization: Bearer <key>"
claude
```

Set `ANTHROPIC_API_KEY="$PROXY_KEY"` instead of `ANTHROPIC_AUTH_TOKEN` if you prefer the `x-api-key` header; an API key
already logged in with `claude login` can interfere, so log out or use a clean `CLAUDE_CONFIG_DIR`. Pick a model served
by your credentials with `ANTHROPIC_MODEL` (and `ANTHROPIC_DEFAULT_SONNET_MODEL` etc.); the proxy also accepts
non-Claude models, translated to the Claude Code protocol.

Persistent alternative, `~/.claude/settings.json`:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "https://proxy.example.com",
    "ANTHROPIC_AUTH_TOKEN": "cfp_…"
  }
}
```

## Codex CLI

Define a custom provider in `~/.codex/config.toml` (see the
[config reference](https://developers.openai.com/codex/config-reference)):

```toml
model_provider = "cf-llm-proxy"
model = "gpt-5-codex" # any model id from /v1/models

[model_providers.cf-llm-proxy]
name = "cf-llm-proxy"
base_url = "https://proxy.example.com/v1"
wire_api = "responses" # the only supported value
env_key = "PROXY_KEY" # sent as "Authorization: Bearer <key>"
# supports_websockets = true     # optional: Responses over WebSocket (see the CPU-limit caveat in the README)
```

Run `codex` with `PROXY_KEY` exported. Codex sends `/v1/responses` (HTTP/SSE, or the WebSocket upgrade on the same path)
and `/v1/responses/compact`.

The Worker also serves the ChatGPT-backend paths `/backend-api/codex/responses`, `/responses/compact` and `/alpha/search`
for tools that hard-code them; they take the key the same way.

## OpenAI SDKs

```python
import os
from openai import OpenAI

client = OpenAI(base_url="https://proxy.example.com/v1", api_key=os.environ["PROXY_KEY"])
print(client.chat.completions.create(model="gpt-5", messages=[{"role": "user", "content": "hi"}]))
```

```ts
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "https://proxy.example.com/v1",
  apiKey: process.env.PROXY_KEY!,
});
```

## Anthropic SDKs

The SDK appends `/v1/messages` itself: the base URL has **no** `/v1`.

```python
import os
from anthropic import Anthropic

client = Anthropic(base_url="https://proxy.example.com", api_key=os.environ["PROXY_KEY"])
```

```ts
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({
  baseURL: "https://proxy.example.com",
  apiKey: process.env.PROXY_KEY!,
});
```

## Gemini SDKs (`google-genai`)

The base URL is the host; the SDK adds `/v1beta`.

```python
import os
from google import genai
from google.genai import types

client = genai.Client(
    api_key=os.environ["PROXY_KEY"],
    http_options=types.HttpOptions(base_url="https://proxy.example.com"),
)
```

```ts
import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({
  apiKey: process.env.PROXY_KEY!,
  httpOptions: { baseUrl: "https://proxy.example.com" },
});
```

## Browser users

Anyone allowed by an Access Allow policy who is a member of an org (added by an org admin, or joined through auto-join,
which is on for the first org) can open the control panel at `https://proxy.example.com/`: a plain member sees their own
usage and manages their own proxy keys, an org admin also manages credentials and every key of the org
([ACCESS.md](ACCESS.md#members-roles-and-teams)).

The proxy routes do not read the Access session cookie, so a web page on another origin cannot spend a signed-in user's
access: it would need a proxy key, which browsers never attach on their own. Call the proxy from a backend with a proxy
key.
