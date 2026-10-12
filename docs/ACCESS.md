# Cloudflare Access setup

Access is the only client authentication of the Workers port. The Worker never sees passwords or API keys from clients: Access
authenticates the caller (identity provider login or a service token), then forwards the request with a signed
`Cf-Access-Jwt-Assertion` header that the Worker verifies.

## 1. What the deploy creates

`pnpm run deploy` (`alchemy.run.ts`, `infra/access.ts`) provisions Access together with the Worker, from the
settings in `.env` (template: `.env.example`):

| Setting                                              | Creates / sets                                                                                                  |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `CF_LLM_PROXY_DOMAIN`                                | A **self-hosted application** on that hostname (empty path: the whole hostname), and the Worker's custom domain |
| `ACCESS_ALLOW_EMAILS`, `ACCESS_ALLOW_EMAIL_DOMAINS`  | A reusable **Allow** policy (interactive login with your identity providers)                                    |
| `ACCESS_SERVICE_TOKENS` (names)                      | One **service token** per name and a **Service Auth** policy that admits exactly those tokens                   |
| `ACCESS_ALLOW_SERVICE_TOKEN_IDS`                     | Adds service tokens managed elsewhere (by token ID, e.g. CI's) to the **Service Auth** policy                   |
| `ACCESS_SESSION_DURATION`                            | Session duration of the application (default `24h`)                                                             |
| `ACCESS_SERVICE_TOKEN_HEADER`                        | Optional single-header service tokens (section 5)                                                               |
| `ACCESS_TEAM_DOMAIN`                                 | Worker variable (issuer and JWKS host); your Zero Trust team name                                               |
| `ACCESS_ADMIN_EMAILS`, `ACCESS_ADMIN_SERVICE_TOKENS` | Worker variables: management admins (token names from `ACCESS_SERVICE_TOKENS` are replaced by their Client IDs) |

The application's **AUD tag** is passed to the Worker as `ACCESS_AUD` automatically. The deploy also sets the application's
cookie to **SameSite=Lax** and **HTTP Only**, so the `CF_Authorization` session cookie is not sent with cross-site
subrequests (the first line of defence against cross-site request forgery on the panel; see "Browser sessions" below). The
Alchemy application resource does not manage these fields and its updates are PUT-style, so a follow-up step re-applies them
after every change of the application: do not edit them in the dashboard.

The production Worker has no `workers.dev` or preview URLs, so the custom domain is the only way in. Pull-request preview
stages (`pr-<number>`, see [DEPLOY.md](DEPLOY.md)) instead serve their `workers.dev` URL behind their own application,
which the Worker enrolls into. Service token credentials:

- The Client IDs are printed in the deploy outputs (`serviceTokens`).
- The Client Secrets are returned by Cloudflare only on creation; the deploy writes them to
  `.alchemy/access-service-tokens.json` (mode 0600, git-ignored) as ready-to-use header pairs on the deploying
  machine. They are also kept in the Alchemy state (encrypted at rest in the Cloudflare state store; plain JSON under
  `.alchemy/state` with `ALCHEMY_STATE=local`). Copy them into your clients, then delete the file if you like.
- Tokens are valid for one year. Rotate one by deleting its name from `ACCESS_SERVICE_TOKENS`, deploying, and adding it back
  (or add a new name first for a seamless switch). Use one token per client/machine so usage records (`principal`) and
  revocation are per client.

**Bring your own application.** Set `ACCESS_AUD` to the AUD tag(s) of an Access application you manage yourself (dashboard
or other tooling) and the deploy creates no Access resources; `ACCESS_ALLOW_*`/`ACCESS_SERVICE_TOKENS` must then be empty.
The application must cover the Worker's whole hostname, with an Allow policy for people and a Service Auth policy for tokens
(an Allow policy does not match service tokens). Set SameSite=Lax on its cookie yourself.

## 2. Policies

| Who                                  | Policy action    | Selector                   | Notes                                                  |
| ------------------------------------ | ---------------- | -------------------------- | ------------------------------------------------------ |
| People using the panel / browsers    | **Allow**        | Emails, email domain       | Interactive login                                      |
| Tools (Claude Code, Codex, SDKs, CI) | **Service Auth** | The stack's service tokens | Non-interactive; an Allow policy does not match tokens |

Need IdP groups, device posture or other rules? Extend the policies in `infra/access.ts` (Alchemy's
`Cloudflare.Access.Policy` accepts every Cloudflare rule shape).

## 3. Worker variables

Set by the deploy from the settings above (Alchemy binds them as plain-text variables):

| Variable                      | Meaning                                                                                               |
| ----------------------------- | ----------------------------------------------------------------------------------------------------- |
| `ACCESS_TEAM_DOMAIN`          | `myteam`, `myteam.cloudflareaccess.com` or `https://myteam.cloudflareaccess.com` (issuer + JWKS host) |
| `ACCESS_AUD`                  | AUD tag(s) of the application(s), comma separated                                                     |
| `ACCESS_ADMIN_EMAILS`         | Admins for `/v8/management*` and the panels (comma/space separated, case-insensitive)                 |
| `ACCESS_ADMIN_SERVICE_TOKENS` | Service token **Client IDs** allowed to administer (the full `….access` id)                           |
| `ACCESS_DEV_BYPASS`           | Set only by `alchemy dev` (local development); empty on deployed Workers                              |
| `AUTH_INDEX_KEY`              | Secret (`secret_text`) HMAC key of `auth_index`: minted by the deploy, not a setting (below)          |

Empty `ACCESS_TEAM_DOMAIN` or `ACCESS_AUD` fails closed: protected routes answer 500. An authenticated principal that is not on an
admin list gets 403 on management routes but can still use the proxy endpoints.

The config document can add admins too: `access.admin-emails` and `access.admin-service-tokens` (same formats) are merged with
the two variables. The variables always apply and never need the config, so an env admin can repair a broken config or remove
config admins; config admins are only looked up for principals that are not env admins, and an unreadable config denies them.
Anyone who can edit the config can add admins this way, which is already admin-only, with one exception: only a **service-token**
administrator or an env admin (`ACCESS_ADMIN_EMAILS`, `ACCESS_ADMIN_SERVICE_TOKENS`, the local dev bypass) may change
`access.admin-service-tokens`, through `PATCH /settings`, `PUT /settings/config` (and its `check`) or `/config*`. An email admin who is
one only through `access.admin-emails` gets `403 {"error":"service_tokens_require_service_admin","message":…}` and nothing is
stored (writing the same list again is fine). Without it such an admin could grant a service token the credential download below.

`ACCESS_DEV_BYPASS` only applies to requests whose host is `localhost`, `127.0.0.1` or `[::1]`, and is refused (with a logged
warning) whenever `ACCESS_TEAM_DOMAIN` or `ACCESS_AUD` is set: a Worker wired to Access never skips it.

`AUTH_INDEX_KEY` is the one secret binding: 32 random bytes each stage mints on its first deploy and keeps in the Alchemy
state, so there is nothing to set (management security below, [DEPLOY.md](DEPLOY.md) "Operations"). Like the dev bypass,
a Worker with `ACCESS_TEAM_DOMAIN` or `ACCESS_AUD` set refuses the fixed `alchemy dev` key and any key shorter than 64
characters; a missing key is refused everywhere.

## 4. How the Worker validates requests

1. The path is classified (`src/access/routes.ts`): `/v1*` (incl. `/v1beta`, `/v1internal`), `/openai/v1*`, `/backend-api/codex*` and the unprefixed
   aliases `/chat/completions`, `/completions`, `/responses` need a
   principal; `/v8/management*`, the control panel (`/`, `/accounts`, `/keys`, `/models`, `/usage`, `/settings` with their
   sub-paths, `/assets/*`) and `/management.html` (the upstream panel's old address, a redirect to `/`) need an admin;
   everything else (`/healthz`, the OAuth browser callbacks `/anthropic/callback`, `/codex/callback`,
   `/antigravity/callback`, `/callback`, `/devin/callback`) is public to the Worker.
   Matching is case-, slash- and percent-encoding-insensitive, so odd spellings cannot dodge the gate.
2. `Cf-Access-Jwt-Assertion` is verified with `jose`: RS256 signature against the JWKS at
   `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs` (cached per isolate, refetched on an unknown `kid` at most every
   30 s), `iss` = the team domain, `aud` contains one of `ACCESS_AUD`, `exp` required and `exp`/`nbf` valid (30 s clock skew).
3. The principal is the `email` claim (users) or `common_name` (service token Client ID). It is recorded in usage records and
   scopes session state per caller.
4. A missing header answers 401 `Missing API key`; an invalid token 401 `Invalid API key` (Go wording, so existing clients
   show familiar errors).

Because the Worker trusts only the signed JWT, requests that skip Access (e.g. a `workers.dev` URL enabled by hand) are rejected.

### Browser sessions (CSRF and WebSocket hijacking)

Browsers attach the Access session cookie automatically, so without further checks a page on another site could drive an
admin's session. Before authentication the gate (`src/access/csrf.ts`) refuses, with 403 `Cross-site request rejected`:

- state-changing requests (anything but `GET`/`HEAD`/`OPTIONS`) to `/v1*`, `/openai/v1*`, `/backend-api/codex*`, the
  unprefixed `/chat/completions`, `/completions`, `/responses` and the
  management zone when `Sec-Fetch-Site` is `cross-site`/`same-site` or `Origin` names another host;
- any management request (`/v8/management*`, the panel paths) with a foreign `Origin` or a cross-site `Sec-Fetch-Site`,
  except a top-level document navigation (`GET`/`HEAD` with `Sec-Fetch-Mode: navigate` and `Sec-Fetch-Dest: document`)
  to a panel page (`/`, `/accounts`, `/keys`, `/models`, `/usage`, `/settings` and their sub-paths) or
  `/management.html`: a link to a panel page still opens it, while frames (clickjacking), `/assets/*` and every
  `/v8/management*` request are refused (OAuth providers redirect to the public callback paths, never there);
- WebSocket upgrades (`GET /v1/responses`, `/backend-api/codex/responses`) whose `Origin` is not the Worker's own host
  (403 `Cross-origin WebSocket rejected`).

Management writes must also carry `Content-Type: application/json` (`multipart/form-data` for `POST /credentials`,
`application/yaml`/`text/yaml` for `PUT /config.yaml`) or have no body; other types answer 415. The management zone never sends
CORS headers, so other origins cannot pass a preflight or read a management response. Proxy routes keep
`Access-Control-Allow-Origin: *` for reads.

Non-browser clients (curl, SDKs, Claude Code, Codex) send neither `Origin` nor `Sec-Fetch-*` and are not affected; the panel
is served by the Worker itself and is same-origin. Browser applications on other origins cannot call the proxy's POST routes;
put a server-side client in between.

### Management API security

- Go's `POST /requests/api-call` (substitutes `$TOKEN$` into a request to any host the caller names, the upstream
  panel's quota probe) is not ported. Quota checks (`POST /credentials/quota`) call the auth file's own provider usage
  endpoint. Key tests (`POST /api-keys/probe`) send a config key to the `base-url` stored with it, and an admin can
  change that `base-url` while keeping the key (`PUT /api-keys/groups`, or the raw editor, whose review lists such a
  move under `moved_secrets`): an admin can still direct a stored key to a host of their choice. The replies carry no
  token.
- The configuration is read back masked: `GET /config`, `/config/<path>`, `/config.yaml` and `/settings/config` show
  the secret positions as `[redacted#n]…abcd`: API keys and client keys, header values other than an allow-list of
  protocol headers and pure client copies, URL user info and query or fragment values whose names look secret,
  payload parameters whose names (or, for `*-raw` JSON text, keys inside) look secret. Detection is by position and
  name: a secret typed into another field (a model alias, a `prefix`) is shown. Writes to `/config*` refuse
  placeholders (`422 masked_value`, or `masked_value_outside_secret_field`); edit secrets in the panel's raw editor
  (`/settings/config`), which restores them. Config error messages never quote a written value (YAML errors are a
  fixed sentence per error code with line and column; schema errors an expectation and a path) and are not
  scrubbed: they name at most keys the caller wrote, so a refused write reads the same whether a typed value, key
  or alias name equals a stored secret or not.
- Credential downloads (`GET /v8/management/credentials/download?name=<file>`) are the one way to read a stored token:
  the auth file verbatim, refresh token included, for moving an account to another deployment. Only a **service
  token** administrator (`ACCESS_ADMIN_SERVICE_TOKENS`, or `access.admin-service-tokens` in the config, §3) may call
  it; an email admin gets `403 {"error":"download_requires_service_token","message":…}` before the file is looked up,
  and a principal that is no admin the gate's `403 Forbidden`. A person's browser session is the credential most
  exposed to theft, so the tokens are handed only to a client that was set up for automation (curl with
  `CF-Access-Client-Id`/`-Secret`, [MIGRATION.md](MIGRATION.md) §2). The panel never calls it. This narrows who can read a
  token; it does not make tokens unreachable to an email admin, who can still point a stored key at a host of their
  choice (above). Treat admin access as access to every stored token: keep the admin lists short and prefer service tokens scoped to automation.
- No response publishes a hash of a stored key. The handle of a credential (`auth_index`, also in panel URLs
  `/accounts/<auth_index>` and usage exports) is an HMAC under the per-deployment secret `AUTH_INDEX_KEY`, so it reveals
  nothing about the key (Go's unsalted index of a config key's id, itself an unsalted hash of the key, let anyone holding
  it test guesses offline). Config credential ids (`claude:apikey:<hash>`) are never sent: not in `GET /api-keys`, usage
  summaries and series (`group_by=auth` keys are `auth_index` values), `routing/models` or proxy responses, whose
  `X-CPA-TRACE-ID` is a random request id for every client. Lookups by `name` match auth files only, so a guessed id is
  not confirmed either; address a config key by its `auth_index`.
- Writes never confirm a guessed secret: the reply does not confirm a guess, the next read does. A typed API key
  equal to a key stored in another group of its family (gemini, interactions, vertex: the families whose keys are unique
  across groups) is answered like any other new key: `PUT /api-keys/groups` and the path writes of `/config/*path` drop the
  typed copy silently and the raw editor's save drops it before storing and advances the version whenever a secret was
  typed. The same goes for header values, a `proxy-url` or a `base-url` written for a key kept by `auth_index`: they are typed
  too, so trying them never produces a different reply. (A whole-document `PUT /config` or `PUT /config.yaml` replaces everything and
  keeps Go's first-wins.) The stored key always
  wins, so a typed copy never deletes a stored key (or its group); a group left with no key is dropped like any
  empty group. Configuration error messages never quote a value.

### Logs and personal data

Every proxied request produces one structured log line (Workers Logs) whose `principal` field is the Access identity:
`user:<email>` for people, `service:<client id>` for service tokens. Usage records in D1 store the same id. Emails are
personal data: restrict who can read Workers Logs and the D1 database, and set the retention you need
(`USAGE_RETENTION_DAYS`, Workers Logs retention). Tokens, API keys, JWTs, request bodies, headers and query strings are never
logged; scheduled-job failures are logged as a one-line summary with URL queries removed.

## 5. Optional: single-header service token

Some tools can only send one custom header. Access can read the service token from a header of your choice, as a JSON value.
Set `ACCESS_SERVICE_TOKEN_HEADER` (e.g. `x-api-key`) and deploy; the deploy sets the application's
`read_service_tokens_from_header`. Clients then send:

```
x-api-key: {"cf-access-client-id": "<CLIENT_ID>", "cf-access-client-secret": "<CLIENT_SECRET>"}
```

This is handled entirely by Access; the Worker still only sees the resulting JWT. The header name is your choice
(`Authorization` is the Cloudflare docs' example, but then the client's own bearer token cannot carry anything else); `x-api-key`
suits the Anthropic SDK, where the API key is that header. The two-header form keeps working alongside it. If your organisation
enables _strict service token authentication_, only Service Auth policies authorise token requests. With a bring-your-own
application (`ACCESS_AUD`), configure the setting on that application with the Cloudflare API.

## 6. WARP note

The Worker needs the Access JWT regardless of how the client reaches the hostname. A WARP-enrolled device still passes through
Access; satisfy it with an Allow policy that matches the user's identity (or device posture) or, for CLI tools, simply use a
service token, which does not depend on the device. Check the Cloudflare WARP/Access docs for the current options.

## Troubleshooting

| Symptom                                    | Cause                                                                                                                 |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| 302 to `cloudflareaccess.com` in a CLI     | Service token headers missing/wrong, or no Service Auth policy for the token                                          |
| 403 from Access (before the Worker)        | Token not in the Service Auth policy (name missing from `ACCESS_SERVICE_TOKENS`)                                      |
| 500 `Authentication service error`         | `ACCESS_TEAM_DOMAIN` wrong (check the team name) or `ACCESS_AUD` empty                                                |
| 401 `Missing API key`                      | Request reached the Worker without Access (wrong hostname) or no JWT header                                           |
| 401 `Invalid API key`                      | AUD/issuer mismatch, expired JWT                                                                                      |
| 403 `Forbidden` on the panel               | Principal not in `ACCESS_ADMIN_EMAILS` / `ACCESS_ADMIN_SERVICE_TOKENS`                                                |
| 403 `download_requires_service_token`      | Credential download called as an email admin: use a service token administrator                                       |
| 403 `service_tokens_require_service_admin` | `access.admin-service-tokens` changed by a config-only email admin: use a service token administrator or an env admin |
| 403 `Cross-site request rejected`          | Browser request from another origin (or a proxy POST from a web app)                                                  |
| 415 `Unsupported Content-Type`             | Management write without `content-type: application/json` (or YAML/multipart)                                         |
