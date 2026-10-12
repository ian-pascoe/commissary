# Migrating from the Go server

The Workers port reads the Go `config.yaml` and the Go auth files (`*.json`), so migration is: deploy
([README](../README.md#deploy)), then import both through the management API.

## 0. Management access from a terminal

The management API needs an Access **admin**. For scripts, add a service token name to `ACCESS_SERVICE_TOKENS` and to
`ACCESS_ADMIN_SERVICE_TOKENS` in `.env` and deploy (see [ACCESS.md](ACCESS.md); its credentials land in
`.alchemy/access-service-tokens.json`), or add a Client ID to `access.admin-service-tokens` in the config once an env
admin has set it up, then:

```bash
M=https://proxy.example.com/v8/management
H=(-H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET")
```

Alternatively use the control panel (`/`) as an admin user: the raw configuration editor (_Settings → Raw
configuration_, `/settings/config`) takes a pasted `config.yaml`, and _Connect account_ uploads auth files.

## 1. Config

Remove what the Workers port ignores, then upload the file as-is:

```bash
curl "${H[@]}" -X PUT "$M/config.yaml" -H 'content-type: application/yaml' --data-binary @config.yaml
# {"status":"ok","config-version":8}
curl "${H[@]}" "$M/config.yaml"                                       # sparse export of what was stored, secrets masked
```

- Legacy top-level keys (`claude-api-key`, `codex-api-key`, `gemini-api-key`, `openai-compatibility`, `request-retry`, …) are
  migrated to the v8 layout on import; unknown or inapplicable keys are dropped. A malformed document answers 422
  `invalid_config` with a message; nothing is stored.
- **Secrets in `config.yaml`** (provider API keys) are stored in the `ControlPlane` Durable Object, not in your repo.
  They are never read back: every `GET /config*` shows them as `[redacted#n]…abcd` (numbered like the raw editor), and a
  write that contains such a placeholder answers 422 `masked_value` (`masked_value_outside_secret_field` outside a
  secret field) with its `path` (nothing stored). The path is that of the v8 layout: a placeholder in a legacy file
  (`claude-api-key: [{api-key: …}]`) is reported where the import moves it (`api-keys.claude[0].keys[0].api-key`). So
  import the original file, not an export; edit secrets afterwards in the raw editor (`PUT /settings/config`), which
  restores them.
- Management writes need a `content-type` (`application/json`; `application/yaml` for `config.yaml`; multipart for uploads):
  curl's default `application/x-www-form-urlencoded` answers 415 (cross-site request forgery protection, see ACCESS.md).
- Dropped on import (no effect on Workers): `host`/`port`/`tls`, `remote-management.*` (Access replaces it), `auth-dir`, `pprof`,
  logging to files, `wire-policy`/TLS fingerprint, plugins, Home, Postgres/git/object store settings.

### Not applied on Workers

These keys are accepted and kept in the stored document (so a round trip through the panel does not lose them) but have no
effect. Storing a config that sets any of them logs a warning naming the keys (`config keys not applied on Workers`):

| Key                                                          | Why                                                                                       |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `access.api-keys` (legacy top-level `api-keys`)              | Clients authenticate with Cloudflare Access, see [CLIENTS.md](CLIENTS.md)                 |
| `requests.proxy-url`, per-group/per-key `proxy-url`          | Workers `fetch` cannot use outbound proxies                                               |
| `api-keys.claude[].keys[].experimental-cch-signing`          | Kept for compatibility (also in Go); signing follows the credential type                  |
| `observability.logs.debug`, `observability.logs.request-log` | No debug/request-log files; Workers Logs carry one structured line per request            |
| `observability.usage.usage-statistics-enabled`               | Usage persistence is always on when the `USAGE` D1 binding exists                         |
| `observability.usage.redis-usage-queue-retention-seconds`    | The queue lives in D1 (`/observability/usage/queue`), retention is `USAGE_RETENTION_DAYS` |
| `routing.cooldown.save-cooldown-status`                      | Cooldowns always persist: the Durable Object is evicted when idle, which is not a restart |

`requests.streaming.keepalive-seconds` applies to SSE responses but not to the Responses WebSocket (no ping frames).

- The client `api-keys:` list is **not enforced**: every client must now present an Access identity ([CLIENTS.md](CLIENTS.md)).
  Give each client its own service token instead of a shared key.
- `PATCH $M/config` and `/config/<path>` allow incremental edits for scripts (plain new secrets are stored, placeholders
  refused as above). The panel's raw configuration editor is `/settings/config`.

### OpenCode Zen / OpenCode Go

Go reaches OpenCode only as an `openai-compatibility` entry (`base-url: https://opencode.ai/zen/v1` or `.../zen/go/v1`), which
sends every model to `/chat/completions`; models the gateway serves on another endpoint answer 400
`ModelProtocolUnsupported`. The Worker has dedicated providers: move the key to `api-keys.opencode-zen` (Zen) or
`api-keys.opencode-go` (Go) and drop the compat entry.

```yaml
api-keys:
  opencode-go:
    - keys:
        - api-key: sk-…
      # Optional: without `models`, every non-deprecated catalog model is registered (Zen: without its free models).
      models:
        - name: minimax-m3
        - name: deepseek-v4-flash
          alias: ds-flash
          protocol: chat # chat | responses | messages | gemini (Zen only); overrides the catalog
```

`base-url` is optional (defaults to the gateway). Each model is posted to its own endpoint (from the OpenCode catalog, refreshed
by the cron) with the gateway's session header; see ARCHITECTURE.md "OpenCode Zen and OpenCode Go". Model ids are the same as
in the compat entry, so clients keep their model names; compat `prefix`/`alias` settings carry over as group/model settings.
OpenCode Go keys also appear on the panel's Accounts page with their 5-hour, weekly and monthly usage, and a key over one
of those limits rests until the window resets while other keys take its requests.

## 2. Auth files (OAuth credentials)

Upload every `*.json` file from the Go `auth-dir` (default `~/.cli-proxy-api`). The file name becomes the credential id:

```bash
curl "${H[@]}" -X POST "$M/credentials" $(for f in ~/.cli-proxy-api/*.json; do printf -- '-F file=@%s ' "$f"; done)
# or a single raw file:
curl "${H[@]}" -X POST "$M/credentials?name=claude-ab12cd34-me@example.com.json" \
  -H 'content-type: application/json' --data-binary @claude-ab12cd34-me@example.com.json
curl "${H[@]}" "$M/credentials"          # list (tokens are redacted)
```

Results: `200 {"status":"ok","uploaded":N,…}`, or `207` with a `failed` list when some files were rejected (`file must be .json`,
`invalid name`). Uploaded credentials are selectable immediately; expired access tokens are refreshed using the stored refresh
token. Vertex service-account files can be uploaded the same way. Disabled flags and per-file settings (`prefix`, `priority`,
`proxy_url` is ignored) are kept.

Caveats:

- Provider refresh tokens are single-use for some providers (Claude, Codex). If the Go server and the Worker both keep refreshing
  the same file, one of them will see `invalid_grant`. **Stop the Go server after importing**, or re-login in the Worker (below).
- Files are bound to the provider's egress IP behaviour only by the provider's own policy; see "Known limitations" in the README.

## 3. OAuth re-login via the panel

Logging in fresh avoids sharing refresh tokens. In the panel → _Connect account_ (or `GET $M/oauth/auth-url?provider=<claude|codex|antigravity|devin|xai|meta|kimi|kimi-ai>`):

1. Open the returned authorization URL and sign in with the provider.
2. **Authorization-code providers (Claude, Codex, Antigravity, Devin)**: the provider redirects to `http://localhost:<port>/…callback?code=…&state=…`.
   That page will not load (nothing listens on your machine). Copy the **full redirected URL** from the address bar and paste it into the panel's
   callback field (API: `POST $M/oauth/callback` with `{"provider":"codex","redirect_url":"<url>"}`). The Worker exchanges the code
   itself; poll `GET $M/oauth/status?state=<state>` until `ok`. The window is 5 minutes.
3. **Device-code logins (Codex with `flow=device`, xAI, Meta, Kimi)**: show the code and URL, approve in the browser; the panel polls
   the status. No paste step.

The credential is stored under the same file-name scheme as Go (e.g. `claude-<hash>-<email>.json`); a re-login of the same account
replaces the tokens but keeps your per-file settings.

### Exporting an account (Worker to Worker, or back to files)

A stored auth file, tokens included, can be downloaded to move an account to another deployment. The download is limited to
**service-token administrators** (§0); an email admin, including in the panel, gets `403 download_requires_service_token`:

```bash
curl "${H[@]}" "$M/credentials/download?name=claude-ab12cd34-me@example.com.json" -o claude-ab12cd34-me@example.com.json
curl "${H[@]}" -X POST "$M/credentials?name=claude-ab12cd34-me@example.com.json" \
  -H 'content-type: application/json' --data-binary @claude-ab12cd34-me@example.com.json   # against the other deployment
```

The same caveat as §2 applies: two deployments refreshing one single-use refresh token break each other, so retire the source
account afterwards (or log in again on the target, §3, which needs no export). The file is written verbatim, so treat it as a secret.

## 4. Switch clients

Point each tool at the Worker with Access headers ([CLIENTS.md](CLIENTS.md)); verify `GET /v1/models` lists the models you expect,
then retire the Go server. Model aliases, prefixes, `excluded-models`, payload rules and routing settings from `config.yaml` carry over.
Usage statistics are not migrated; new usage is recorded in D1 and shown in the panel.
