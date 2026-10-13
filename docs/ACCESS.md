# Cloudflare Access setup

Access is the only client authentication of the Workers port. The Worker never sees passwords or API keys from clients: Access
authenticates the caller (identity provider login or a service token), then forwards the request with a signed
`Cf-Access-Jwt-Assertion` header that the Worker verifies.

## 1. What the deploy creates

`pnpm run deploy` (`alchemy.run.ts`, `infra/access.ts`) provisions Access together with the Worker, from the
settings in `.env` (template: `.env.example`):

| Setting                                                  | Creates / sets                                                                                                  |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `CF_LLM_PROXY_DOMAIN`                                    | A **self-hosted application** on that hostname (empty path: the whole hostname), and the Worker's custom domain |
| `ACCESS_ALLOW_EMAILS`, `ACCESS_ALLOW_EMAIL_DOMAINS`      | A reusable **Allow** policy (interactive login with your identity providers)                                    |
| `ACCESS_SERVICE_TOKENS` (names)                          | One **service token** per name and a **Service Auth** policy that admits exactly those tokens                   |
| `ACCESS_ALLOW_SERVICE_TOKEN_IDS`                         | Adds service tokens managed elsewhere (by token ID, e.g. CI's) to the **Service Auth** policy                   |
| `ACCESS_SESSION_DURATION`                                | Session duration of the application (default `24h`)                                                             |
| `ACCESS_SERVICE_TOKEN_HEADER`                            | Optional single-header service tokens (section 5)                                                               |
| `ACCESS_TEAM_DOMAIN`                                     | Worker variable (issuer and JWKS host); your Zero Trust team name                                               |
| `PLATFORM_ADMIN_EMAILS`, `PLATFORM_ADMIN_SERVICE_TOKENS` | Worker variables: platform admins (token names from `ACCESS_SERVICE_TOKENS` are replaced by their Client IDs)   |

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

| Variable                                             | Meaning                                                                                               |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `ACCESS_TEAM_DOMAIN`                                 | `myteam`, `myteam.cloudflareaccess.com` or `https://myteam.cloudflareaccess.com` (issuer + JWKS host) |
| `ACCESS_AUD`                                         | AUD tag(s) of the application(s), comma separated                                                     |
| `PLATFORM_ADMIN_EMAILS`                              | Platform admins: manage every org and create orgs (comma/space separated, case-insensitive)           |
| `PLATFORM_ADMIN_SERVICE_TOKENS`                      | Service token **Client IDs** that are platform admins (the full `….access` id)                        |
| `ACCESS_ADMIN_EMAILS`, `ACCESS_ADMIN_SERVICE_TOKENS` | Deprecated names of the two above: still read and merged with them, and logged once as a warning      |
| `ACCESS_DEV_BYPASS`                                  | Set only by `alchemy dev` (local development); empty on deployed Workers                              |
| `AUTH_INDEX_KEY`                                     | Secret (`secret_text`) HMAC key of `auth_index`: minted by the deploy, not a setting (below)          |

Empty `ACCESS_TEAM_DOMAIN` or `ACCESS_AUD` fails closed: protected routes answer 500. Past Access, what a principal may do
depends on its role in the org it reaches ("Members, roles and teams" below): a principal with no role there gets 403.

### Platform admins and orgs

The deployment serves one or more **orgs** (ADR 0021). The Platform registry (a Durable Object) lists them; the first, `global`,
exists from the start with the slug `default` and holds everything the deployment stored before orgs existed. Each org has a
**slug** (1-63 lowercase letters, digits and inner hyphens) that addresses it:

| What              | Address                                                                   |
| ----------------- | ------------------------------------------------------------------------- |
| Panel of an org   | `/o/<slug>/` (`/o/<slug>/accounts`, `/keys`, `/models`, ...)              |
| Management API    | `/v8/management/orgs/<slug>/<route>` (every route below `/v8/management`) |
| Org list, create  | `GET`/`POST /v8/management/orgs`                                          |
| Rename an org     | `PATCH /v8/management/orgs/<slug>` (name and/or slug)                     |
| Who am I, my orgs | `GET /v8/management/me`                                                   |

A **platform admin** (`PLATFORM_ADMIN_*`) manages every org through these addresses and is the only one who may list, create and
rename orgs: anyone else gets `403 {"error":"platform_admin_required"}`. An org the registry does not list answers `404` to a
platform admin and `403` to anyone else. The unscoped addresses (`/v8/management/credentials`, `/accounts`, ...) keep working
and mean `global`, so existing scripts and bookmarks are unchanged. `/` opens the panel of the only org the caller belongs to
and asks which one to open when there are several (`/?choose` always asks, to create an org). A person's login and proxy keys
are unaffected: clients reach their org with their key, not with the address.

Renaming `ACCESS_ADMIN_*` to `PLATFORM_ADMIN_*` is the only settings change an upgrade asks for, and it can wait: the old names are
merged with the new ones. A rename of an org's slug breaks the old address, not the org's data (stored under its permanent id).

### Members, roles and teams

Everyone else reaches an org as one of its **members** (ADR 0022). A member holds one **role** in the org: **org owner**,
**org admin** or **plain member**; a person can be a member of several orgs with a role in each. A platform admin is an org
owner of every org without being stored as a member. Members, teams and service tokens live in the org's ControlPlane, which
the Worker asks on every request: a removed member, or a member whose role was lowered, is refused on their next request.

| Who may                                                                                      |   Plain member    | Org admin |          Org owner           | Platform admin |
| -------------------------------------------------------------------------------------------- | :---------------: | :-------: | :--------------------------: | :------------: |
| Use the proxy endpoints of the org                                                           |         ✓         |     ✓     |              ✓               |       ✓        |
| Open the org's panel; read usage (`GET /observability/usage/records`, `/summary`, `/series`) | own requests only |     ✓     |              ✓               |       ✓        |
| Connect, list, disable and remove their **own private** accounts and API keys (see below)    |  ✓ where allowed  |     ✓     |              ✓               |       ✓        |
| Every other management route of the org (credentials, keys, models, settings, prices, ...)   |                   |     ✓     |              ✓               |       ✓        |
| List members, teams and service tokens; manage teams                                         |                   |     ✓     |              ✓               |       ✓        |
| Add or remove plain members; register or remove member service tokens                        |                   |     ✓     |              ✓               |       ✓        |
| Add or remove org admins and owners; change any role                                         |                   |           |              ✓               |       ✓        |
| Turn auto-join on or off (`PATCH /membership`)                                               |                   |           |              ✓               |       ✓        |
| Allow or stop private credentials (`PATCH /membership`, `private_credentials`)               |                   |     ✓     |              ✓               |       ✓        |
| Give a service token a role above plain member; download a credential                        |                   |           | owner **service token** only |       ✓        |
| List, create and rename orgs                                                                 |                   |           |                              |       ✓        |

- **Adding a member** (`POST /members` with an email and a role) takes effect the next time the person signs in through Access;
  no email is sent, and Access must still admit them (§2). Removing a member takes them off every team, and they are refused
  from their next request on, even where auto-join is on: a person or service token an org admin removed does not join by
  themselves again until an org admin adds (or registers) them back.
- **Auto-join** (`GET`/`PATCH /membership`, `{"auto_join": true}`): with it on, a person Access admits who is not a member of
  the org joins it as a plain member on their first request. It is on for `global`, so a self-hosted deployment keeps admitting
  everyone its Access policies admit, and off for every new org, where only added members get in (`403` for anyone else, the
  proxy endpoints included).
- **Shared and private credentials** (ADR 0023): every account and API key belongs to the org (**shared**, managed by org admins,
  as before) or to one member (**private**). A private credential is used only for its owner's requests, never for an org
  admin's, another member's or a service token's. Its owner manages it through the same routes as an org admin manages a shared
  one (`/credentials*`, `/oauth/*`, `/api-keys*`; what a plain member creates is always private); an org admin sees that it
  exists (provider, owner, label, whether it is disabled) in `GET /credentials` and `GET /api-keys` (`others`), may disable
  or remove it, and reaches nothing else about it: no models, quota, usage or file, and `404` for any other operation. Its
  download is refused to everyone but its owner (`403 private_credential`, also for an owner service token). Private traffic
  is left out of org-wide usage summaries, series, listings and exports; only the owner reads it. `private_credentials` of
  `/membership` is the org setting: on for `global` and for a new org only when `POST /orgs` asks; turning it off disables
  every private credential of the org (kept, not deleted) and refuses new ones (`403`) until it is turned on again. Everything
  that existed before is shared.
- **Service tokens** (`/service-tokens`) are registered to one org by their Client ID with a role (`409 service_token_taken`
  when another org has the token, also when two orgs register it at once: the one the registry indexes first keeps it). With
  auto-join on, an unregistered token is admitted as a plain member without being stored,
  so existing clients of `global` keep working; register it to give it a role.
- **Teams** (`/teams`) are named groups of members within an org; an org admin filters usage by member (`member=<id>`) or team
  (`team=<id>`) and groups a summary by member (`group_by=member`).
- An org with members keeps at least one owner: lowering or removing the last owner answers `409 last_owner`.
- **ADR 0006 per org**: giving a service token a role above plain member, and downloading a credential (§4), need a service
  token that is an owner of the org, or a platform admin. A person's browser session is the credential most exposed to theft
  and cannot grant itself those powers: a person who is an org owner registers only plain-member tokens
  (`403 service_token_owner_required` otherwise).

**Upgrading from config admin lists.** Before members, `global` was also managed by the config document's
`access.admin-emails` and `access.admin-service-tokens`. The first time an org's ControlPlane is used after the upgrade, those
lists become members of `global`, once: the platform admins of the time become org owners, `access.admin-emails` org admins and
`access.admin-service-tokens` service tokens with the owner role (they could download credentials before). The lists then leave
the config, `GET /settings` no longer shows them, and a Go config document imported later has its `access.admin-*` keys ignored
(`not_applied`). In any other org the lists never granted anything and are only removed. The platform admins become stored
owners of `global` even when the lists were empty: taking an email out of `PLATFORM_ADMIN_EMAILS` later ends its platform admin
rights but not its `global` membership, which an org owner removes on the Members page (`DELETE /members/<id>`).

`ACCESS_DEV_BYPASS` only applies to requests whose host is `localhost`, `127.0.0.1` or `[::1]`, and is refused (with a logged
warning) whenever `ACCESS_TEAM_DOMAIN` or `ACCESS_AUD` is set: a Worker wired to Access never skips it.

`AUTH_INDEX_KEY` is the one secret binding: 32 random bytes each stage mints on its first deploy and keeps in the Alchemy
state, so there is nothing to set (management security below, [DEPLOY.md](DEPLOY.md) "Operations"). Like the dev bypass,
a Worker with `ACCESS_TEAM_DOMAIN` or `ACCESS_AUD` set refuses the fixed `alchemy dev` key and any key shorter than 64
characters; a missing key is refused everywhere.

## 4. How the Worker validates requests

1. The path is classified (`src/access/routes.ts`): `/v1*` (incl. `/v1beta`, `/v1internal`), `/openai/v1*`, `/backend-api/codex*` and the unprefixed
   aliases `/chat/completions`, `/completions`, `/responses` need a
   principal; `/v8/management*` (also `/v8/management/orgs/<slug>/...`), the control panel (`/`, `/accounts`, `/keys`, `/models`, `/usage`, `/members`, `/settings` with their
   sub-paths, the same pages under `/o/<slug>/`, `/assets/*`) and `/management.html` (the upstream panel's old address, a redirect to `/`) form the management zone;
   everything else (`/healthz`, the OAuth browser callbacks `/anthropic/callback`, `/codex/callback`,
   `/antigravity/callback`, `/callback`, `/devin/callback`) is public to the Worker.
   Matching is case-, slash- and percent-encoding-insensitive, so odd spellings cannot dodge the gate.
2. `Cf-Access-Jwt-Assertion` is verified with `jose`: RS256 signature against the JWKS at
   `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs` (cached per isolate, refetched on an unknown `kid` at most every
   30 s), `iss` = the team domain, `aud` contains one of `ACCESS_AUD`, `exp` required and `exp`/`nbf` valid (30 s clock skew).
3. The principal is the `email` claim (users) or `common_name` (service token Client ID). It is recorded in usage records and
   scopes session state per caller.
4. The org's ControlPlane admits the principal (`src/members/admission.ts`, auto-joining it where that is on) and the route's
   policy (`src/access/policy.ts`) names the role it needs: a member role for the proxy endpoints, the org's panel pages and the
   usage reads, org admin for every other management route. Who the caller is (`/v8/management/me`), the org list
   (`/v8/management/orgs*`, whose handlers ask for a platform admin), the panel pages without an org, `/assets/*` and
   `/management.html` need no role. A principal without the role gets 403 `Forbidden`.
5. A missing header answers 401 `Missing API key`; an invalid token 401 `Invalid API key` (Go wording, so existing clients
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
`application/yaml`/`text/yaml` for `POST /settings/import`) or have no body; other types answer 415. The management zone never sends
CORS headers, so other origins cannot pass a preflight or read a management response. Proxy routes keep
`Access-Control-Allow-Origin: *` for reads.

Non-browser clients (curl, SDKs, Claude Code, Codex) send neither `Origin` nor `Sec-Fetch-*` and are not affected; the panel
is served by the Worker itself and is same-origin. Browser applications on other origins cannot call the proxy's POST routes;
put a server-side client in between.

### Management API security

- Go's `POST /requests/api-call` (substitutes `$TOKEN$` into a request to any host the caller names, the upstream
  panel's quota probe) is not ported. Quota checks (`POST /credentials/quota`) call the auth file's own provider usage
  endpoint. Key tests (`POST /api-keys/probe`) send a config key to the `base-url` stored with it, and an admin can
  change that `base-url` while keeping the key (`PUT /api-keys/groups`, or a config import): an admin can still direct a stored key to a host of their choice, and a plain member the same for their own private key groups
  (only their own key can be sent there). The replies carry no
  token.
- No route reads a secret back. Provider API keys, client keys, header values and URL credentials are stored as config
  entries (ADR 0025) and never leave the Worker: `GET /api-keys` shows a `[redacted]…abcd` preview, `GET /settings` carries
  no secret, and the routes that returned the whole document (`/config*`, `/config.yaml`, `/settings/config`) and the raw
  editor are gone. So there are no masked placeholders to restore and nothing to refuse on write. A secret is replaced by
  typing a new one into its key group, or by importing a Go config document (`POST /settings/import`). Config error messages
  never quote a written value (YAML errors are a fixed sentence per error code with line and column; schema errors an
  expectation and a path) and are not scrubbed: they name at most keys the caller wrote, so a refused write reads the same
  whether a typed value, key or alias name equals a stored secret or not.
- Credential downloads (`GET /v8/management/credentials/download?name=<file>`) are the one way to read a stored token:
  the auth file verbatim, refresh token included, for moving an account to another deployment. Only a **service
  token** that is an owner of the org (§3 "Members, roles and teams") or a platform admin may call it; any other org admin or
  owner gets `403 {"error":"download_requires_service_token","message":…}` before the file is looked up, and a plain
  member the gate's `403 Forbidden`. A person's browser session is the credential most
  exposed to theft, so the tokens are handed only to a client that was set up for automation (curl with
  `CF-Access-Client-Id`/`-Secret`, [MIGRATION.md](MIGRATION.md) §2). The panel never calls it. A private credential is downloaded
  by its owner alone (their own session may, it is their own token); any other caller gets `403 private_credential`. This narrows who can read a
  token; it does not make tokens unreachable to an email admin, who can still point a stored key at a host of their
  choice (above). Treat org admin access as access to every stored token: keep the org's admins few and prefer service tokens scoped to automation.
- No response publishes a hash of a stored key. The handle of a credential (`auth_index`, also in panel URLs
  `/accounts/<auth_index>` and usage exports) is an HMAC under the per-deployment secret `AUTH_INDEX_KEY`, so it reveals
  nothing about the key (Go's unsalted index of a config key's id, itself an unsalted hash of the key, let anyone holding
  it test guesses offline). Config credential ids (`claude:apikey:<hash>`) are never sent: not in `GET /api-keys`, usage
  summaries and series (`group_by=auth` keys are `auth_index` values), `routing/models` or proxy responses, whose
  `X-CPA-TRACE-ID` is a random request id for every client. Lookups by `name` match auth files only, so a guessed id is
  not confirmed either; address a config key by its `auth_index`.
- Writes never confirm a guessed secret: the reply does not confirm a guess, the next read does. A typed API key
  equal to a key stored in another group of its family (gemini, interactions, vertex: the families whose keys are unique
  across groups) is answered like any other new key: `PUT /api-keys/groups` drops the typed copy silently and still
  advances the version. The same goes for header values, a `proxy-url` or a `base-url` written for a key kept by
  `auth_index`: they are typed too, so trying them never produces a different reply. The stored key always wins, so a typed
  copy never deletes a stored key (or its group); a group left with no key is stored but not shown. The config import
  replaces every entry, so its reply confirms nothing and Go's first-wins deduplication applies inside the imported
  document. A key whose secret a stored key of its family has keeps that key's credential id, so the next read shows the
  same `auth_index` (the next read confirms, as above); a wrong guess has replaced every stored key with the document's. Configuration error messages never quote a value.

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

| Symptom                                | Cause                                                                                                  |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 302 to `cloudflareaccess.com` in a CLI | Service token headers missing/wrong, or no Service Auth policy for the token                           |
| 403 from Access (before the Worker)    | Token not in the Service Auth policy (name missing from `ACCESS_SERVICE_TOKENS`)                       |
| 500 `Authentication service error`     | `ACCESS_TEAM_DOMAIN` wrong (check the team name) or `ACCESS_AUD` empty                                 |
| 401 `Missing API key`                  | Request reached the Worker without Access (wrong hostname) or no JWT header                            |
| 401 `Invalid API key`                  | AUD/issuer mismatch, expired JWT                                                                       |
| 403 `Forbidden`                        | No role in the org (add the member, or turn auto-join on), or a plain member on a route for org admins |
| 403 `owner_required`                   | Adding or removing an org admin or owner, or changing a role, needs an org owner                       |
| 403 `service_token_owner_required`     | A service token role above member needs an owner service token of the org, or a platform admin         |
| 409 `last_owner`                       | The change would leave an org with members but no owner: make someone else an owner first              |
| 403 `platform_admin_required`          | Listing, creating or renaming orgs needs a platform admin                                              |
| 404 on `/o/<slug>/...`                 | No org has that slug (a platform admin sees 404; others 403)                                           |
| 403 `private_credential`               | Download of a member's private credential by anyone but its owner                                      |
| 403 `private_credentials_unavailable`  | Adding a private API key group where the org does not let members hold private credentials             |
| 403 `download_requires_service_token`  | Credential download called by a person: use a service token that is an owner of the org                |
| 403 `Cross-site request rejected`      | Browser request from another origin (or a proxy POST from a web app)                                   |
| 415 `Unsupported Content-Type`         | Management write without `content-type: application/json` (or YAML/multipart)                          |
