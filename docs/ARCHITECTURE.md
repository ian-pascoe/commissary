# Cloudflare Workers port — architecture

This document records the binding decisions for the TypeScript/Effect rewrite of CLIProxyAPI that runs on plain
Cloudflare Workers behind Cloudflare Zero Trust Access. Behavioural references for the Go implementation live in
`docs/research/*.md`. The Go code is a reference, not the authority (ADR 0019): the proxy copies its behaviour where that
is the better design and differs where it is not. It is the read-only reference checkout in `.repos/CLIProxyAPI` (upstream [router-for-me/CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI), cloned by
`pnpm install`); Go paths cited here (`internal/...`, `sdk/...`) are relative to it.

## Goals and non-goals

Goals:

- Serve the OpenAI (chat/completions, completions, Responses), Claude (messages, count_tokens), Gemini (`/v1beta`) and
  Interactions APIs from a Worker, backed by the same provider credentials (OAuth and API key) as the Go server.
- Faithful port of model resolution, credential selection/cooldowns/refresh, translators, the thinking pipeline and
  user payload rules.
- Cloudflare Access is the only client authentication mechanism (legacy proxy API keys are imported but never enforced).

Non-goals (not ported): plugins (`internal/pluginhost`), CLIProxyAPIHome mode, TUI, mDNS discovery, pprof, git/Postgres/
object stores, request-log files, per-credential outbound proxies (`proxy-url`), uTLS TLS fingerprinting, Codex live /
realtime (WebRTC/SIP), the AI Studio `wsrelay` gateway, and deprecated `/v0/management` routes.

## Layout

```
.                             pnpm package, deployed with Alchemy (no Wrangler config)
  alchemy.run.ts              infrastructure: Worker, DOs, KV, D1 (+ migrations), assets, cron, Access
  infra/                      deploy settings (.env) and Cloudflare Access provisioning
  src/
    index.ts                  Worker entry: fetch, scheduled, DO class exports
    platform/                 Cloudflare bindings as Effect services (Env, ExecutionContext, KV, D1, DO stubs)
    http/                     router, CORS, error formatting per protocol, SSE framing, streaming helpers
    access/                   Cloudflare Access JWT verification, principals
    config/                   config schema (Effect Schema), storage, payload rules
    json/                     gjson/sjson-compatible path engine and JSON helpers
    registry/                 model catalogs, model info, /models listings
    credentials/              credential model, selection, cooldowns, refresh, ControlPlane Durable Object
    thinking/                 canonical thinking pipeline (port of internal/thinking)
    translator/               registry + one directory per (client -> provider) pair
    executor/                 executor interface + one directory per provider
    handlers/                 inbound protocol handlers (openai, responses, claude, gemini, interactions, ...)
    management/               /v8/management API (+ contract/: shared Effect HttpApi schemas), panel serving, OAuth flows
    usage/                    usage records, D1 persistence
    quota/                    server-side quota check: provider usage endpoints, stored per-credential reports
  web/                        control panel served at / (React, Effect Atom, TanStack Router; built into public/)
  test/                       vitest suites (+ fixtures generated from the Go code)
  tools/fixturegen/           Go programs (own module, root go.work) that emit golden fixtures from the Go code
  tools/sync-reference-repos.sh  clones/updates the reference repositories in .repos/ (pnpm install, pnpm repos:sync)
  .repos/CLIProxyAPI/         read-only Go reference checkout (git-ignored)
```

## Runtime topology

- **Worker** (stateless): routing, Access verification, request handling, translation, upstream `fetch`, streaming.
- **Orgs** (ADR 0021, `src/platform/org.ts`): one deployment serves many orgs, and every request and scheduled job
  belongs to exactly one. The per-request `CurrentOrg` service carries its id (`OrgId`: lowercase letters, digits and
  inner hyphens); `requestContext` provides it next to `WorkerEnv`, and for now it is always `global`, the org of the
  deployment that existed before orgs (later slices resolve it from the proxy key or the management URL). `CurrentOrg`
  is a required service, not a default: code that reaches org state without an org does not compile, and where a type
  cannot require it (the SessionState backends and the Antigravity executor also run outside a request in unit tests)
  a request without an org is a defect (`optionalRequestOrg`), never a silent read of `global`'s state.
- **`ControlPlane` Durable Object** (one per org, named by the org id: `controlPlaneOf(env, org)` is the only
  `getByName` of the namespace; `currentControlPlane` resolves the request's; SQLite storage): config document,
  credentials, selection cursors, cooldown/quota state, session affinity, OAuth login sessions, refresh scheduling via
  alarms. It is the single writer for its org's credential state, which replaces the Go `singleflight`/mutex/goroutine
  machinery, and knows its org from its own name (`ctx.id.name`; an object not named by an org id throws instead of
  serving `global`). The Worker talks to it through JS RPC methods (e.g.
  `pick`, `report`, `getConfig`). The org `global` keeps the object it always had (`getByName("global")`), so upgrading
  moves no data.
- **Org-scoped names**: everything the Worker derives for an org outside its ControlPlane is named per org with
  `orgScopedName(org, name)`: unchanged for `global` (so existing KV entries, SessionState instances and live sessions
  survive the upgrade), `org.<org>.<name>` for any other org. That covers the SessionState addresses (the store name),
  the KV entries of org data (Antigravity cooldowns, credits and model entitlements, the signature cache, xAI video
  bindings), the Antigravity credits-probe slot and OAuth callback states. Caller scopes hash the org in for any org but
  `global` (`callerScope(principal, org)`), and `auth_index` values use a key derived per org from `AUTH_INDEX_KEY`
  (`orgAuthIndexer`; `global` keeps the deployment key, so existing handles and panel links do not change). Worker-side
  caches of org data (the `ConfigReader` snapshots, the registry snapshots, the per-isolate signature cache and
  Antigravity state) are keyed by org.
- **`Platform` Durable Object** (the Platform registry, `src/platform/{platform,registry,registry-store}.ts`; one object
  per deployment, `platformOf(env)` = `getByName("platform")`, SQLite storage, tables `CREATE IF NOT EXISTS` on
  construction so a deployment gains it without a migration): what spans orgs. The list of orgs (`orgs`: permanent `id`,
  unique `slug`, `name`, `created_at`; `global` is seeded as slug `default`, name `Default` and left alone afterwards, so
  a rename sticks), the indexes of which orgs a person (`org_members`) and an Access service token
  (`org_service_tokens`) belong to (kept empty until orgs have members; the orgs' ControlPlanes stay authoritative, so
  the indexes are repairable), and the catalog refresh lease (below). Platform admins are not stored in it: the
  deployment's variables name them (see Authentication), so they can always repair the registry. See "Orgs in
  addresses" below.
- **Deployment-wide state**: the model catalog (KV copy, refresh status and refresh lease) and the client versions
  (Antigravity, xAI) are shared by every org. The catalog's source, `models.catalog`, is a deployment setting: only the
  `global` org's config may set it (another org's `ConfigStore` refuses a document that does, `422` through the
  management API), every org's `ConfigReader` snapshot carries `global`'s value (the read fails while `global`'s
  config was never read and cannot be, rather than fall back to the org's default), and every refresh (cron or any org's
  panel) uses `global`'s setting and the refresh lease in the Platform registry, so no org can repoint the shared
  catalog.
- **`SessionState` Durable Object** (one instance per store + caller scope + session key, `getByName`, SQLite storage):
  the replay and continuity caches (Codex/xAI/Claude/Kimi/Gemini/Antigravity reasoning replay, Claude continuity, Devin turn
  counter, Antigravity Interactions continuation) with TTL and compare-and-swap semantics, see "SessionState Durable Object".
  The Responses WebSocket does **not** use it: that state lives in the Worker invocation that accepted the socket (see
  "Responses WebSocket transports").
- **KV `CACHE`**: the model catalog (one trimmed models.dev document, refreshed by cron or on demand) and the status of its
  last refresh, best-effort caches (signature cache) with `expirationTtl`; org data under org-scoped keys.
- **D1 `USAGE`**: usage records written with `ctx.waitUntil`, each with its `org_id`; every query filters on it.
- **Static assets** (`public/`, Worker runs first): the control panel (`web/` build).
- **Cron trigger** (every 3 h, production only; `src/scheduled.ts`): the model catalog refresh (the one
  models.dev document: every provider's models, OpenCode's included), Antigravity version and model entitlements, xAI client version, usage retention, the Devin user status, a
  safety sweep that re-arms credential refresh alarms, and the quota check of connected accounts. A job is
  deployment-wide (catalog, client versions, usage retention: once per run) or org-scoped (entitlements, Devin status,
  refresh sweep, quota check: once per org the Platform registry lists, `global` first, with `CurrentOrg` set, a failure in one org not
  stopping the next). When the registry cannot be read the org jobs run for `global` alone, so a registry outage does not
  stop the deployment's own jobs.

Request flow:

```
client -> Cloudflare Access -> Worker
  verify Cf-Access-Jwt-Assertion -> principal (email | service token common_name); CurrentOrg (global for now)
  handler parses body (entry protocol) -> resolve model/providers (registry + config, suffixes, aliases)
  loop (retry rounds): ControlPlane.pick(...) of the request's org -> credential snapshot + lease
      executor: translate request -> thinking -> provider shaping -> payload rules (final) -> fetch upstream
      translate response (stream: one SSE line at a time with per-request state)
      ControlPlane.report(lease, result) -> cooldown/quota bookkeeping
  frame response for the entry protocol (SSE / JSON / WebSocket); usage record via waitUntil
```

## Engineering conventions

- TypeScript strict mode, ESM, `effect@4` (HTTP via `effect/http` `HttpRouter.toWebHandler`; per-request Cloudflare
  `env`/`ctx` are provided as services through the handler's per-request `Context`).
- Use Effect at boundaries and for orchestration: services (`Context.Service`) + `Layer`s, `Schema` for config,
  credentials and external payloads, tagged errors, `Stream` for upstream/downstream streaming, `HttpClient`
  (`FetchHttpClient`) for upstream calls so tests can swap the transport.
- Translators, thinking appliers, and payload rules are pure synchronous functions over parsed JSON values
  (`JSON.parse` output). Preserve key order; do not reorder fields when not required. Keep the Go structure
  (one module per Go file group) so future upstream changes can be ported mechanically; cite the Go source path at the
  top of each ported module.
- Payload rules remain the final semantic mutation before the upstream request in every executor path (see AGENTS.md).
- No wall-clock sleeps in tests; use Effect `TestClock`.
- Tests: `vitest` + `@effect/vitest`; Worker/Durable Object integration tests with `@cloudflare/vitest-plugin` (successor of `@cloudflare/vitest-pool-workers`).
  Translators and the thinking pipeline are verified against golden fixtures produced by `tools/fixturegen`
  from the Go implementation (`go run ./tools/fixturegen`), checked in under `test/fixtures/`.
- Never log tokens, API keys or JWTs.

## JSON values, config and payload rules

- **Path engine (`src/json/`)**: gjson/sjson semantics over parsed `JSON.parse` values instead of raw bytes, verified
  against the real tidwall libraries through golden fixtures (`go run ./tools/fixturegen/jsonpath`). `get`
  returns `undefined` for "does not exist" (`null` exists); `set`, `setRaw` and `del` mutate containers in place and
  return the root; values are inserted by reference (clone shared values). Known differences from Go: integer-like
  object keys are enumerated first by the JS engine, numbers are doubles (raw text such as `1.0` is not preserved),
  and sets/deletes on complex paths (`#`, `|`, `@`, `*`, `?`) throw `JsonPathError` (sjson silently rewrites matches;
  nothing in the Go code relies on it, payload rules expand `#(...)` queries into index paths first). Reads support
  `#`, `#.key`, `#(q)`, `#(q)#`, wildcards, pipes and the modifiers `@this @reverse @keys @values @flatten`.
- **Config (`src/config/`)**: the canonical document is the v8 layout restricted to keys that apply on Workers
  (`schema.ts`, kebab-case keys as in YAML). `codec.ts` imports YAML/JSON (v8, legacy flat layout and historical v8
  spellings, see `document.ts`), validates, normalises (`normalize.ts`, port of the Go `Sanitize*` functions) and
  encodes it back to the v8 layout (`encodeConfig`, which config entries are made of). Added keys without a Go counterpart: `access.admin-emails` and
  `access.admin-service-tokens` (the management allow-list of `global`, merged with the `PLATFORM_ADMIN_*` variables, see Authentication).
  Keys that are accepted but have no effect on Workers are listed in `config/not-applied.ts` with a one-line reason (and
  MIGRATION.md); the import names them in its answer (`not_applied`) and stores none of them (ADR 0025), so the Settings
  view carries no such list. `requests.proxy-url` is accepted but ignored. Unknown/inapplicable keys are dropped on import.
- **Storage** (ADR 0025): the `ControlPlane` DO (`src/credentials/control-plane.ts`) keeps the org's configuration as
  config entries in SQLite (`ConfigStore`, `src/config/store.ts`; the pure mapping between a `Config` and its rows is
  `src/config/entries.ts`). Every setting (by dotted path, e.g. `routing.strategy`), every API key group, every API key
  (its id is its credential id), every channel's model aliases, every channel's model exclusions and every payload rule
  is a row of its own with a `revision`, `updated_at` and `updated_by`. One change counter per org (`config_changes`)
  moves on every write and is the config `version`; each entry a write changes takes the counter's new value as its
  revision. A missing entry has revision 0, and so has a setting at its default, which is not stored. Since the counter
  never goes back, an entry deleted and created again never repeats a revision. A write names the revision of every entry
  it changes and is refused (`conflict`) when one is stale, so writes to different entries never conflict; its rows are
  applied and the assembled config decoded in one storage transaction, and a write that would leave an invalid config is
  rolled back (`invalid`). RPC: `getConfig(sinceVersion?)` (the assembled config, `unchanged: true` when the caller is
  current), `configEntries()` (that config with the revision of every entry, which the management routes edit),
  `writeSettings`, `writeChannelRule`, `writeKeyGroup` and `importConfig(text, by)` (all return a structured result with
  `invalid` / `conflict` instead of throwing). The ControlPlane assembles the config from the entries (`current()` /
  `snapshot()`) and only re-assembles it when the counter moved. The Worker reads through `ConfigReader`
  (`src/config/reader.ts`): per-isolate snapshot per org, 5 s TTL then a version check, stale-if-error, so readers still
  rebuild their cached views when the version moves. Each org's ControlPlane stores its own entries; deployment settings
  (`DEPLOYMENT_SETTINGS` in `config/store.ts`, today `models.catalog`) are accepted in the `global` org's config only, and
  `ConfigReader` puts `global`'s value into every other org's snapshot.
- **Config migration** (`ConfigStore`, a Durable Object SQLite schema migration; there is no D1 migration): a
  ControlPlane that stored the config as one document (the former single `config` row, config-version 8) and has no
  entries yet imports it on first start, in one transaction. The Config is the same, credential ids are the same (the Go
  content hash of each key, so auth indexes do not change), the counter continues after the document's version (every
  cached view rebuilds), the old row is kept, and the entries it writes have `updated_by = "migration"`. Not-applied keys
  are dropped, as on import.
- **Payload rules (`src/config/payload/`)**: `applyPayloadRules(config, request, payload)` is the single final barrier;
  it mutates `payload` in place (callers pass a freshly built body and a distinct `original`). The Codex tool-schema
  integer normalisation that Go performs inside the same function lives in `executor/helps/payload.ts` (`finalizePayload`: normalise
  for Codex clients targeting non-Codex executors, then `applyPayloadRules`); executors call `finalizePayload`.
- **Config normalisation** follows the Go `Sanitize*` functions on the _flattened_ list: gemini/interactions keys are
  deduplicated across all groups of a family (key, base URL, proxy, prefix, order-independent headers; entry values override
  the group's), vertex keys by `api-key|base-url` (keys without api-key and models without name or alias are dropped), and
  credential-less entries (a gemini entry with only a base URL) are accepted.

## Thinking pipeline (`src/thinking/`)

Port of `internal/thinking`, keeping the "canonical `ThinkingConfig` → central validation → provider applier" shape.

- Entry point: `applyThinking(body, options)` collapses the five Go entry points (`ApplyThinking`,
  `…WithSummary`, `…WithSourceAndSummary`, `…WithModelInfo[AndSummary]`) via options: `sourceBody`, `summaryConfig`,
  `normalizedUpdatesChanged`, and `modelInfo` (resolved exact model; `null` = resolved but unknown) or
  `lookupModelInfo` (the registry lookup, `(modelId, providerKey) => info`). It returns `{ body, error? }`
  (`ThinkingError`, HTTP 400) and never throws.
- Bodies are parsed JSON mutated in place (`undefined` = Go's empty/invalid body). A `sourceBody` aliasing `body` is
  cloned first. Debug logging and plugin appliers are not ported. Applier errors (Kimi sjson failures) cannot occur
  on parsed JSON and are dropped.
- Model capabilities come from a minimal structural `ThinkingModelInfo`/`ModelThinkingSupport` (camelCase of
  `registry.ModelInfo`); the model registry slice supplies richer records and the lookup.
- Summary helpers (`extractSummaryConfig`, `applySummaryConfigForProvider`, `applyTranslatedSummaryToClaude`, …) are
  exported for the translator registry (Go calls them from `TranslateRequestEnvelope`).
- Fixtures: `go run ./tools/fixturegen/thinking` → `test/fixtures/thinking.json` (~2.7 MB; includes the Go
  static model catalog used by the lookup). Known Go quirk not mirrored: gjson reads _unparsable_ source JSON
  leniently in `extractCodexConfig`; the Workers port only handles parsed bodies.

## Credentials and selection (ControlPlane)

- **Per org**: each org's ControlPlane (`controlPlaneOf(env, org)`, see Runtime topology) holds that org's config,
  credentials, cooldowns, quota state, session affinity and OAuth logins; nothing below is shared between orgs. The
  Worker-side picker (`ControlPlanePickerLayer`) and refresher (`CredentialRefresher.controlPlane`) resolve the stub
  from `WorkerEnv` and `CurrentOrg` on every call, so the same credential name in two orgs is two credentials with
  separate cooldowns, and its `auth_index` differs between them (`orgAuthIndexer`).
- **Sources** (`src/credentials/`): auth JSON files imported through `importAuthFile`/`upsertCredential` (stored verbatim in
  the DO's SQLite `credentials` table, the file _is_ the metadata) and API keys synthesised from `api-keys` config with
  the Go content-hash ids (`synthesize.ts`, verified against the Go synthesizer via `tools/fixturegen/credentials`).
  `derive.ts` turns a stored file into the immutable `Credential` (priority, weight, prefix, headers, exclusions,
  aliases, plan/domain attributes); global exclusions and aliases are applied at selection time, so config edits take
  effect immediately. Config credentials are never stored; their runtime state is pruned when their id disappears.
- **Selection** (`selection/`, pure and deterministic, clock injected): candidate set -> availability (`availability.ts`,
  incl. "never an expired OAuth token") -> highest priority tier -> strategy (`strategies.ts`: round-robin, smooth
  weighted round-robin, fill-first) -> optional session affinity (`affinity.ts`, TTL cache keyed
  `callerScope::providers::session::model`). Model prefixes, `force-model-prefix`, exclusions, OAuth/API-key aliases,
  `force-mapping` and alias pools are resolved per credential in `routing.ts`. The caller still resolves the provider set
  (`PickRequest.providers`) from the model registry; the DO enforces the per-credential rules.
- **RPC**: `pick(request)` returns `{ ok: true, credential, route, lease }` (credential snapshot including token
  metadata, resolved base URL/headers, and the requested -> upstream model mapping) or `{ ok: false, failure }`
  (`model_cooldown` 429 + body, `auth_unavailable` 503, `auth_not_found`, `provider_not_found`). `report(lease, result)`
  runs the cooldown/quota state machine (below); `planRetry(query)` answers whether another retry round is worth starting
  and how long to wait.
  Management methods: `listCredentials` (redacted), `upsertCredential` (re-login merge, credentials.md §11),
  `importAuthFile`, `removeCredential`, `setCredentialDisabled`.
- **Results, cooldowns and quota** (`credentials/cooldown/`, port of `conductor_cooldown.go` `MarkResult`): `markResult`
  is a pure function over `CredentialState` with an injected clock. Per-(credential, model) cooldowns: 401/402/403 30 min,
  404 and model-support errors 12 h (or `Retry-After`), 429 `Retry-After` (>= 10 s) or the 1 s·2^n ladder (once per open
  window), 408/5xx 60 s (`transient-error-cooldown-seconds`), Cloudflare challenge ladder, invalid_grant 30 min;
  credential-scoped 429s (`ReportResult.credentialScoped`: Anthropic 5h/7d windows, Codex `usage_limit_reached`) block the
  whole credential (`credential_quota`); cooldowns only ever extend; request-scoped, connection-lifecycle and
  transient-transport failures never cool (`classify.ts`, shared with the Worker). `disable-cooling` precedence: credential
  metadata, then `routing.cooldown.disable-cooling`. Also kept per credential: counters, a 20x10 min recent-requests ring
  and the passive quota header snapshot (claude/codex/devin). Alias pools report each attempt under its upstream model
  (`ReportResult.model`, `route.pooled`) and `pick` drops cooling upstream models (a credential without any usable one is
  skipped). Persistence: counters, the last error and the cooldown fields (credential and per-model) are always saved,
  as plain `credential_state` rows instead of the Go `.cds` files; `routing.cooldown.save-cooldown-status` has no effect.
- **Retry planning** (`selection/retry.ts`, `retryAllowed` + `closestCooldownWait`): per-credential `request_retry`,
  `max-retry-interval`, the 10 s floor for an already-attempted 429 credential. `PickRequest.retryRound`/`requestRetry`
  make credentials with an exhausted budget age out of later rounds. Alias pools count as available when any upstream model
  is (Go only discovers a cooling pool when it filters the execution models). When the wait exceeds the limit the plan
  carries the recovery time so the Worker can answer with `Retry-After`.
- Deviations from Go: several providers are selected from one ID-sorted union (no per-provider slot cursor); alias groups
  of the session cache are independent keys (the LCP matcher is ported, see Sessions below). `PickRequest.session` carries the
  explicit id extracted by `handlers/session.ts`; `lcp` and `fallbackSession` carry the content-based identities.
  Cooldowns are always persisted (Go only with `save-cooldown-status`, for its restarts): workerd evicts an idle ControlPlane
  after seconds, which is not a restart, and a Worker cannot tell an eviction from a deploy. Without this a cooling model
  (for example an OpenCode "Model access is disabled" answer) was picked again after the first idle gap.

## Request pipeline

Core contracts every provider slice implements (Go references in each module header):

- **Translators (`src/translator/`)**: `TranslatorRegistry` keyed by `(client format, provider format)` with named
  `client`/`provider` arguments (Go's inverted `TranslateStream(from=provider, to=client)` order does not leak).
  Request transforms are pure functions over a private copy of the parsed body (refusals throw `TranslationError`,
  a request-scoped 400); response transforms take raw text (one upstream SSE line, or the whole body) and return
  complete client chunks as text (bare JSON for OpenAI/Gemini, `event:`/`data:` framed for Claude/Responses/
  Interactions). Per-attempt state is `TranslationState` (Go `param *any`), incl. `toolInputError` and
  `canFinalize`. Go fallbacks are kept (force `model`; passthrough stream/non-stream; raw usage for token counts).
  The thinking summary hooks are injected (`SummaryHooks`). Pairs are registered in `translator/builtin.ts`;
  golden fixtures come from `go run ./tools/fixturegen/translator` (corpus files under
  `tools/fixturegen/translator/corpus/`, one fixture file per corpus file, picked up automatically by
  `test/translator-fixtures.test.ts`; cases may declare `needs` to be skipped until a capability lands).
- **Executors (`src/executor/`)**: `ProviderExecutor { execute, executeStream, countTokens }` over
  `ExecutorRequest`/`ExecutorOptions` (Go `Request`/`Options`, typed `ExecutionMetadata`) and an `ExecutionContext`
  (credential snapshot, config snapshot, `UsageReporter`). Streams are `Stream<string, ExecutionError>` of client
  chunks. All failures are `ExecutionError` (status, upstream body as message, `retryAfterMs`, `credentialScoped`,
  `requestScoped`, `terminalAuth`, `direct`, `code`). Order inside executors: translate -> `Thinking.apply` -> provider shaping -> `applyPayloadRules` (last) -> `HttpClient` (tracing
  propagation disabled so no `traceparent` reaches providers). Shared helpers live in `executor/helps/`.
- **Credential selection**: `CredentialPicker { pick, report, planRetry }` (`executor/picker.ts`, contract documented
  there). The default implementation (`control-plane-picker.ts`) is a thin adapter over the ControlPlane RPC; it maps the
  DO snapshot to the executor view (`kind`, `header:<Name>` attributes, `base_url`) and turns pick failures into
  `ExecutionError`s (`model_cooldown` keeps its JSON body and `Retry-After`). `static-picker.ts` is a config-only stand-in
  for tests (`makePipeline` uses it; `test/support/pool.ts` runs the real `CredentialPool` in-process with an injected
  clock). The route returned by `pick` (`PickedRoute`: upstream model pool, `originalAlias`, `forceMapping`, `pooled`) is
  computed in the DO; `executor/models.ts` is only used by the static picker.
- **Handlers (`src/handlers/`)**: `execute.ts` runs resolve (`ModelProviders` service: the model registry;
  `ModelProviders.configLayer` serves tests without one) -> pick -> executor -> report -> usage (one record per attempt via `UsageSink`, published when the
  stream ends). `respond.ts` peeks the first stream chunk inside the request scope (the web handler keeps the scope
  open for streamed bodies) so pre-stream failures become real HTTP errors, then frames with a per-protocol
  `StreamFramer` (`framing.ts`), with optional keep-alives. Error bodies per protocol are in `http/errors.ts`. Non-stream answers of Claude, OpenAI chat/completions,
  Gemini/Interactions, images and OpenAI-shaped video retrieval go through `withNonStreamKeepAlive` (`requests.nonstream-keepalive-interval`):
  nothing is committed before the first interval, so a timely answer keeps its real status; afterwards a blank line is written per interval and
  the final body (errors included) follows under a committed `200 application/json`, like Go. Video content downloads and `/v1/responses` are
  not wrapped (Go does not either).
  Route layers close over the services (`handlers/layer.ts`, `makeProxyRoutes` for tests) and are Access-gated.
  Deviation: `POST /chat/completions`, `/completions`, `/responses`, `/responses/compact` and the `GET /responses`
  WebSocket are unprefixed aliases of the `/v1` routes (Go serves only `/v1`). A client whose Anthropic models append
  `/v1/messages` and whose OpenAI models append `/chat/completions` to the same base URL (pi's `opencode-go` catalog)
  then needs a single base URL. The aliases are in `PROTECTED_PREFIXES` (`access/routes.ts`). `GET /models` is not
  aliased, because it is a control panel page.
  Request bodies (`handlers/request.ts`, `http/body.ts`) decode `Content-Encoding: zstd` with a 32 MiB cap on the decoded
  size (`http/zstd.ts`: frame windows/content sizes are checked before fzstd allocates, the streaming decoder stops past the
  cap); a larger body answers 413 (deviation: Go reads it unbounded).
- **Conductor** (`handlers/conductor.ts`, port of `conductor_execution.go`/`conductor_stream.go`): `conduct(prepared, run)`
  runs retry rounds. A round picks credentials one after another (`excludedIds` grows, no sleeping) until one succeeds, a
  stop condition hits (request-scoped rule `stop*`, request faults 400/409/413/422 and the listed body codes,
  `responses/compact` faults) or nothing is selectable; the final error is the last one that reached an upstream. Between
  rounds the Worker asks `planRetry` (only for 403/408/429/500/502/503/504 and transient transport errors) and sleeps
  `wait + jitter` (Effect clock, so tests use `TestClock`). `max-retry-credentials` caps a round, per-credential
  `request-retry` ages credentials out of later rounds, request-scoped rules (`continue`, `continue-and-cooldown`, `stop`,
  `stop-and-cooldown`) come from credential metadata or `oauth.request-scoped-errors`. Every attempt is reported exactly
  once (`Attempt.finish`: picker report + one usage record), including client aborts (`connection_lifecycle`, no cooldown).
  Each attempt holds the invocation open with `ctx.waitUntil` from its start until `finish` completed (`holdInvocation`,
  `platform/env.ts`; released by the request scope if `finish` never started), because a cancelled streamed body is finalised
  after the response and workerd drops pending work of a disconnected client otherwise. Route layers capture their services
  with `routeServices()` (`http/route-services.ts`), which drops the layer's `Scope`: providing `Effect.context()` of a layer to
  a handler replaced the request scope with the isolate-lifetime layer scope, so streamed attempts were never finalised on a
  client disconnect.
  Workers limits (deviation): at most 16 upstream attempts per request and cooldown waits capped at 30 s; a longer recovery
  returns the last error (429/503) with `Retry-After`.
  Streams are only "successful" after the first payload chunk (bootstrap read inside the request scope); earlier errors, an
  immediate close (`empty_stream`) or an HTTP error fail over; later errors reach the client and are reported when the
  stream ends. `requests.streaming.bootstrap-retries` repeats the whole execution for bootstrap failures. Force-mapped
  aliases rewrite the `model` fields of responses and chunks (`handlers/model-rewrite.ts`).
  Credential preparation and the 401 loop wrap every attempt (`executor/helps/credential-refresh.ts`, port of
  `prepareRequestAuth` + `tryRefreshAfterUnauthorized`): `ensureFresh` first when the snapshot cannot be used as is (Vertex
  without a minted token, Meta without a key, OAuth token missing/expired, Antigravity within 5 min), and after a 401
  `refreshNow(id, rejectedToken)` plus one repeat with the new token (a rejected attempt keeps its own failed usage record;
  results are reported against the refreshed `credentialVersion`; a token that did not change is not repeated, a terminal
  refresh failure marks the 401 `terminalAuth`). Executors with their own transport paths (WebSocket) can call
  `withCredentialRefresh(context, use)` directly; `CredentialRefresher.none` disables it for API-key-only tests.
- **Models and thinking**: `ModelProviders.registryLayer` resolves providers from the `ModelRegistry` snapshot
  (`providersForModel`, `firstAvailableModel`); `ModelProviders.configLayer` remains for tests without a registry.
  `Thinking.live` (`executor/thinking.ts`) wires `applyThinking`, the translated summary-intent rules of `helps/thinking.go`
  and the registry summary hooks; `Thinking.noop` stays for tests. The conductor resolves the capabilities of each attempt
  through `ModelCapabilities.registryLayer` (the credential's own registration first - prefix/alias/config `models` aware -
  then `snapshot.lookupModelInfo`) and hands them to the executor as `ExecutorRequest.modelInfo` plus
  `modelLookup = snapshot.lookupModelInfo`, which executors pass to `Thinking.apply`.
- **Sessions**: `handlers/session.ts` ports `session.ExtractSessionInfo` (headers, Claude `metadata.user_id`, body fields)
  and feeds `PickRequest.session` together with the Access `callerScope`. Requests without an explicit marker are bound by
  content (`src/session-routing/`, `routing.ts` = `prepareSessionRouting`, only when `routing.session-affinity` is on):
  - **LCP conversation matcher** (`canonical.ts`, `matcher.ts`; Go `session/lcp.go`, `auth/selector.go pickLCP/OnResult`):
    the request is reduced to canonical turns (five protocols, thinking tags/CRLF/timestamps/UUIDs of system text masked,
    tool parts sorted, >16 KiB values sampled) and a SHA-256 fingerprint per turn. The `MerklePrefixMatcher` (bounded: 1024
    turns, 4096 groups, 262144 prefixes, TTL = `session-affinity-ttl`) lives next to the affinity cache in the ControlPlane
    pool: `pick` matches the longest known prefix (fork = divergence, compaction = shared tail after history reduction), binds
    new sequences to the picked credential and returns the LCP identity (`PickResult.session`, used for usage records);
    `report` touches the sequence on success or drops exactly that sequence on a credential-attributed failure (the lease
    carries the sequence and the access generation, so a late failure cannot evict a refreshed binding). Namespace
    `lcp:v1::<provider|mixed>::<model>::<callerScope>`; credential changes call `invalidateAuth`.
  - **Derived identity** (`identity.ts`; Go `session.DeriveID`/`hasExplicitSession`): `derived:ctx:v1:<sha256>` over the
    leading instructions and the first user input (only when no explicit marker exists); used when the LCP matcher does not
    apply (no non-system turn) and recorded in usage even with affinity off. Last fallback: the FNV message hash of the first
    system/user/assistant messages (`msg:<hex>`, short hash as parent).
  - The derived id also reaches executors as `ExecutionMetadata.derivedSessionId` (`ctx:v1:...`, absent with an explicit marker): OpenAI-compatible prompt-cache keys and Antigravity's `derivedAntigravitySessionId` hash it like Go's `DerivedSessionUUID`.
  - Deviations: the Go JSON `Raw` text is replaced by the compact re-serialisation of the parsed body (sampling of >16 KiB JSON
    parts and `original_size` are measured on it), a sparse sample cut inside a multi-byte character decodes to U+FFFD, and
    execution-session (WebSocket) metadata ids are not consulted. Go parity is tested with `tools/fixturegen/session`
    (`test/fixtures/session.json`: turns, fingerprints, derive ids, matcher scenarios).

## Codex provider and Responses API (`src/executor/codex/`, `src/translator/codex/`, `src/handlers/responses/`)

- **Translators** (`translator/codex/<pkg>/{request,response}.ts`, registered by `codex/register.ts`): faithful ports of
  `internal/translator/codex/*` for `openai`, `openai-response`, `claude`, `gemini` and `interactions` -> `codex`. Shared
  helpers are under `translator/common/` (SSE frame builders, `UserTurnDrops`, apply_patch bridge, Responses tool winners,
  Claude message helpers; the signature checks are `src/signature/`). `TranslationError` may carry the translated `body` (Go returns both
  for unsupported-part refusals). Golden fixtures: `corpus/codex-*.json`; **generate them with `TZ=UTC`** (Gemini timestamps
  use the process time zone in Go). The Interactions `interaction.completed` event embeds the current time, so it is
  covered by a fake-timer unit test instead of a fixture. Request `tool_use.input` text is re-serialised compactly (Go
  forwards the raw bytes), hence the corpus files are excluded from the formatter (`.oxfmtrc.jsonc`).
- **Executor** (`executor/codex/executor.ts`): per attempt `translate -> Thinking.apply -> model/stream fields ->
  instructions -> image_generation tool -> reasoning sanitising -> parallel_tool_calls -> tool schema normalisation ->
  reasoning replay -> prompt cache key + Session-Id -> input id sanitising -> finalizePayload (last) -> headers (routing
  hint reads the final body) -> fetch`. Streams are processed line by line (`stream.ts`); non-stream aggregates the SSE
  until the terminal event; compaction posts to `/responses/compact` as `openai-response`. Errors (`errors.ts`) follow
  `codex_executor_terminal.go`: usage-limit/capacity -> 429 (credential-scoped unless `model-level-cooling`), body
  rewrites (`context_too_large`, `thinking_signature_invalid`, `previous_response_not_found`, `auth_unavailable`),
  in-stream `error`/`response.failed` mapping, empty `response.incomplete` -> request-scoped 502, missing terminal ->
  request-scoped 408. 401 refresh/retry is done by the conductor (`withCredentialRefresh`), not by the executor.
- **Reasoning replay** (`replay.ts`): Claude-format callers get cached encrypted reasoning/tool calls re-inserted by
  anchor matching. The store is an interface; the default keeps one entry per model in the `SessionState` DO of the session
  (TTL 1 h, appends are compare-and-swap read-modify-writes, session keys are isolated per caller scope), with a per-isolate
  memory fallback when the binding is absent and `makeInMemoryReplayStore` for tests.
- **Handlers**: `POST /v1/responses`, `/v1/responses/compact` and `/backend-api/codex/{responses,responses/compact}` share
  `responses/routes.ts`; the Responses frame assembler (`responses/framer.ts`) buffers partial frames, filters private
  `responsesapi.*`/`codex.*` events (Codex clients keep `codex.response.metadata`), rebuilds an empty
  `response.output`, normalises error payloads (redacting secrets) and ends with a bare newline. `/v1/images/{generations,
  edits}` (`handlers/openai/images.ts`) serve the Codex `gpt-image-*` models (multipart edits become JSON in the handler;
  free-plan credentials are excluded through `ExecutionInput.disallowFreeAuth`). `/v1/alpha/search` and
  `/backend-api/codex/alpha/search` (`handlers/codex/alpha-search.ts`) forward the sanitised body to
  `.../alpha/search`, selecting only OAuth credentials or API keys with `alpha-search` (`executor/policy-picker.ts`).
- **Multi-agent v2, orphan delegation, `is-compat`** (slice #26, see "Codex client rewriting and compat variants"): the executor
  optimises collaboration tools/namespace (`optimizeCodexMultiAgentV2RequestForAuth`, restored in stream, non-stream and WebSocket
  events) and compat models use the `claude -> codex` compat transform.
- **Stream bootstrap buffering** (`upstream.codex.stream-bootstrap-buffering` / `-timeout`, `bootstrap.ts` + `stream.ts`/`websocket.ts`): frames that
  carry nothing observable (handshake preamble, keepalives, empty `*.added` frames; a closed allow-list like Go's
  `isCodexBootstrapBufferableEvent`) are held until the first real event, within 48 upstream lines (WebSocket: messages read), 1 MiB and the
  optional timeout (Go duration or whole seconds, `0`/`none`/... = unlimited; the clock is the Effect clock on the WebSocket path, the reader's
  injected `nowMs` on SSE). An overload/rate-limit/capacity rejection inside the HTTP 200 stream (or any upstream `error` frame on the WebSocket)
  fails the attempt with a 503 before anything reaches the client, so the conductor fails over to the next credential; other terminal
  failures flush the held handshake and are delivered in-stream; a clean EOF while holding fails the attempt without releasing. `grok-pager` /
  `grok-shell` clients get `keepalive` events as `: keepalive` SSE comments (`TransformKeepaliveSSELine`).

- **models.json header overrides** (`helps/model-headers.ts`): `config.override_header` of the executed model is read from the attempt's
  registry snapshot (`ExecutorRequest.modelLookup(model, "")`, `ThinkingModelInfo.config.overrideHeader`) and forced onto every
  upstream request (HTTP, images, WebSocket handshake) like `applyModelHeaderOverrides`; the `modelHeaderOverrides` executor option
  still wins in tests.
- **`is-compat` fallback** (`codex/compat.ts`, Go `resolveCodexModelIsCompat`): the resolved model info decides; without one the
  credential's `api-keys.codex` entry (index, then key + base URL) is authoritative for its `models` list, then the generic
  API-key lookup.
- **Image tool usage** (`publishCodexImageToolUsage`): `response.tool_usage.image_gen` tokens become an extra usage record under the
  `image_generation` tool model (`UsageReporter.publishAdditionalModel`; the conductor publishes the extra records after the main one).

- **WebSocket**: `executor/codex/websocket.ts` is the upstream transport (Go `CodexWebsocketsExecutor`), dispatched from
  `executeStream` like Go's `CodexAutoExecutor`; see "Responses WebSocket transports".
- **Response steering / full duplex** (`upstream.codex.response-steering`, `codex/duplex.ts`, Go `streamCodexDuplex`): with the flag on, a
  downstream socket on a Codex credential with `websockets` hands its single client-frame reader to the executor
  (`WebsocketExecution.duplex`, set by `handlers/responses/websocket/socket.ts`). The executor owns the upstream socket until the
  client goes away: a writer fiber queues explicit creates (max 16) while steering is unacknowledged, forwards `response.steer`
  (payload rules as `codex-websockets`, `type` re-forced) and answers malformed/unsupported frames with a local 400 `error` event;
  a reader fiber classifies per-response failures, keeps the per-response settings (replay scope, native output, collaboration-tool
  renaming, reasoning/instructions; 16 retained) that automatic successors and `response.append` inherit, and forwards
  `response.steer.*` events byte for byte. A failure before the first `response.created` fails the attempt (credential failover);
  later 401/403/429 events are delivered and then end the socket; ambiguous failures end it without cooling the credential
  (`duplexConnectionError` is request-scoped). The handler treats a duplex stream as the socket: error events after
  `response.created` are events, the stream ending closes the socket quietly, and the upstream-disconnect callback is left to the
  executor. Deviations: one usage record per attempt with the summed tokens of all responses (Go: a record per response);
  `authEnabled` defaults to true (a credential disabled mid-socket is not re-checked); other providers never run duplex.
- **Non-stream over WebSocket** (`makeCodexWebsocketExecute`, Go `CodexWebsocketsExecutor.Execute`): a non-stream execution carrying
  `metadata.websocket` on a `websockets` credential reads the upstream events until the first terminal one and answers with the
  translated completed response (same session/socket rules, replay-required for continuations without a live socket).
- **Not ported (follow-ups)**: the Responses-tool image path being reachable only for non-`gpt-image` models (ported but not routed).

## xAI provider and media endpoints (`src/executor/xai/`, `src/handlers/openai/{videos,speech,xai-*}.ts`)

Port of `xai_executor*.go` (HTTP/SSE; the Responses WebSocket executor is `executor/xai/websocket.ts`, see "Responses
WebSocket transports"). Reuses the Codex translators
(`* -> codex`, compaction `* -> openai-response`) and the Codex output helpers.

- **Base URLs and identity** (`credentials.ts`, `headers.ts`): `using_api` (attribute, metadata, `auth_kind`; OAuth defaults to
  `false`) selects the API (`https://api.x.ai/v1`) or the CLI chat proxy (`https://cli-chat-proxy.grok.com/v1`) for chat and
  media; `/responses/compact` and `/tts` always use the official API (the proxy 404s and a 404 would cool the pool).
  The CLI identity headers (`X-XAI-Token-Auth`, `x-grok-client-version`, `xai-grok-workspace/<ver>` UA, ...) are only sent for
  `POST /responses` against the proxy. The client version comes from KV `CACHE` key `xai/client-version` (fallback `1.0.46`),
  written by the cron task `xai-client-version-refresh` (npm `@xai-official/grok/latest`, strict `x.y.z` >= 1.0.13) and read through
  `Effect.serviceOption(WorkerEnv)` with a one-minute per-isolate cache, so executor signatures stay unchanged.
- **Responses shaping** (`executor.ts` `prepare`): translate -> `Thinking.apply` (target format `xai`) -> model/stream -> tool
  normalisation (`tools.ts`, `tool-choice.ts`: namespace flattening or folding into dispatcher functions above 200 tools,
  `custom` -> `function`, `$ref` inlining, schema simplification, `additional_tools` promotion, hosted-tool choices, orphaned
  `tool_choice`, `web_search` client alias, optional `x_search` injection) -> reasoning replay -> input normalisation
  (`input.ts`) -> `prompt_cache_key`/`x-grok-conv-id` -> `finalizePayload` (user payload rules, last). Response events
  (`response.ts`, `stream.ts`) get reasoning-text -> summary normalisation, namespace/alias restoration, hidden X Search trace
  filtering and a rebuilt `response.output`. Non-stream requests still stream upstream and aggregate; truncated streams answer 408.
- **Compaction**: `responses/compact` posts to the official API; a streaming request with a `compaction_trigger` input item is
  executed through compact and re-emitted as a synthetic Responses SSE stream (`compact.ts`).
- **Reasoning replay** (`replay.ts`): Claude/Responses callers get cached encrypted reasoning, assistant text and tool calls of the
  previous turn re-inserted (sliding TTL 1 h). Same pattern as Codex: a store interface over the `SessionState` DO (per-isolate
  memory fallback, `makeInMemoryXaiReplayStore` for tests); session keys are isolated per Access `callerScope` (no scope, no replay).
- **Errors** (`errors.ts`): 403 "bad credentials" -> 401 (conductor refresh + retry), 429 `free-usage-exhausted` -> 24 h cooldown
  hint (`retryAfterMs`), speech 404s that do not say the model is unavailable are request-scoped.
- **Media** (`media.ts` + handlers): executor entry protocols `openai-image`/`openai-video`/`openai-speech` (whole bodies returned
  verbatim; `ExecutorResponse.bytes` carries audio). `/v1/images/{generations,edits}` accept `grok-imagine-image*` (converted to
  the xAI shape and back; streams replay the result as `*.completed` frames like Go). `/v1/videos*` (xAI-native) and
  `/openai/v1/videos*` (OpenAI shape, `sora-2` maps to `grok-imagine-video`, content downloads proxied). Video results are only
  retrievable with the creating credential: the handler stores `{authId, routing model}` in KV (`xai/video-binding/<sha256(id)>`,
  TTL `multimedia.video-result-auth-cache-ttl`, default 3 h, KV minimum 60 s) and pins retrievals through `ExecutionInput.pinnedId`
  (`ExecutionOutput.credentialId` reports the serving credential). `/v1/audio/speech` and `/v1/tts` convert to `POST /tts`.
- **apply_patch bridge** (`helps/apply-patch-responses.ts`, `translator/common/apply-patch-responses.ts`; Go
  `NormalizeApplyPatchResponsesRequest` / `ApplyPatchResponsesBridge` / `ApplyPatchResponsesState`): the winning custom `apply_patch`
  declaration (also inside namespaces / `additional_tools`), its history items and tool choices become the strict `{"input": ...}`
  function before the xAI tool normalisation; every upstream event passes `rememberDispatcherEvent` (pre-restoration evidence), the
  namespace/alias/X Search pipeline and the state's `transform`, which restores `custom_tool_call` items and
  `response.custom_tool_call_input.*` events, expands folded dispatcher envelopes (`{"name": <child>, "arguments": ...}`, folded above 200
  tools) into the child call, validates identity (item id, call id, output index) and arguments, resequences `sequence_number` and
  fails the turn with one local `response.failed` frame plus a sanitised 502 (`Invalid apply_patch tool arguments received from
  upstream.`). EOF/`[DONE]` without a validated completion fails the same way. Non-stream, compact answers (bare response), SSE lines and the
  WebSocket path (failure frame, upstream socket invalidated, EOF drop with an open patch call) use the same state. Verified against the real
  Go state over 55 scripted scenarios (`go run ./tools/fixturegen/applypatch`, `test/apply-patch-responses.test.ts`). A non-string
  patch history input is a request-scoped 400 (Go returns a plain error).
- **Compaction over the xAI socket**: a `compaction_trigger` on a downstream WebSocket whose credential has `websockets` compacts the socket's
  recorded transcript over HTTP `/responses/compact` (`executeCompactionTriggerFromWebsocket`; without a transcript the request's own
  input, else `previous_response_id`; empty context = 400, a malformed compacted answer = 502), replaces the transcript by the compacted
  item, maps the new response id to "no upstream id" and re-emits the synthetic Responses stream. A frame that needs the upstream socket
  answers replay-required.
- **Multi-agent v2** input rewriting (`rewriteCodexMultiAgentV2Input`, after the stream/model fields are set) and orphan delegation
  (translation step) are shared with Codex.
- **Not ported (follow-ups)**: for xAI image requests, mask/`input_fidelity` style Codex-only options.

- **`ForAPIKey` scoping**: done for every provider by `withApiKeyScope` in the executor registry (xAI included, also on the WebSocket path:
  the socket runs through the conductor). Go's xAI settings live under the shared `upstream.xai`, which `ForAPIKey` keeps, so there is
  nothing xAI-specific to scope.

- **Multi-agent v2** input rewriting (`rewriteCodexMultiAgentV2Input`, after the stream/model fields are set) and orphan delegation
  (translation step) are shared with Codex. xAI image requests ignore `mask`/`input_fidelity` exactly like Go (the xAI edit body only
  carries prompt, images, `aspect_ratio`, `resolution`, `quality` and `n`). The Go Claude stream input-token estimate on the xAI
  WebSocket path cannot trigger here: downstream sockets only carry Responses-format requests (`NewClaudeInputTokenState` needs a
  Claude client), and the HTTP path gets it from `TranslatorRegistry.translateStream`.

## Responses WebSocket transports (`src/handlers/responses/websocket/`, `src/executor/websocket/`, `src/executor/{codex,xai}/websocket.ts`)

Port of `openai_responses_websocket*.go` (inbound `GET /v1/responses` and `GET /backend-api/codex/responses` with
`Upgrade: websocket`), `codex_websockets_*.go` and `xai_websockets_executor.go`. The Access gate authenticates the
upgrade request like any other (default-deny prefixes); the principal is captured for the socket's lifetime.

- **Where the socket lives (decision)**: in the Worker invocation that accepts it (`WebSocketPair` + `server.accept()`,
  `routes.ts`), **not** in a `SessionState` Durable Object. Per-socket state (previous request/response chaining, pending tool
  calls, pinned credential, upstream mode, tool-call repair caches) is plain memory of the socket's fiber and dies with the socket,
  like the goroutine-per-connection state in Go. A DO with the hibernation API would add nothing: the outbound upstream
  WebSocket and the running turn keep the object awake anyway and outbound sockets cannot hibernate; it would only add an RPC hop
  per frame. The cost is that an isolate restart (deploy) drops live sockets; clients reconnect and replay full input, which is
  also what happens when Go restarts. The `SessionState` object holds no socket state.
- **Loop** (`socket.ts`): one fiber per socket, started with `Effect.runForkWith(context)` from the upgrade handler (the services of the
  request are captured once; every turn runs in its own `Effect.scoped`). A second fiber is the only reader of the client socket so
  `response.interrupt` reaches the running upstream socket (or cancels a local HTTP turn) without waiting behind the response.
  Closing the client socket interrupts the fiber: the attempt is reported as a connection-lifecycle failure (no cooldown) and the
  upstream execution sessions are closed. Turns call `executeStream` (the normal conductor: pick, failover, usage, refresh) with
  `ExecutionInput.websocket = { sessionId, requireUpstream }`, `onSelected` (the credential of each attempt) and `pinnedId`;
  `preferWebsockets` makes `pick` prefer Codex credentials with `websockets`.
- **Per-frame planning** (`plan.ts`, `normalize.ts`; pure): `response.create` / `response.append` become executable bodies. Without
  an upstream socket the transcript is rebuilt locally (previous input + previous output + new input, compaction/replacement
  detection, call-id and item-id dedupe; `generate:false` warm-ups answered with synthetic `response.created`/`response.completed`
  `resp_prewarm_<uuid>`). After a turn that ran on a credential with `websockets` (Codex/xAI) the socket pins that credential and later
  frames pass through (`previous_response_id` kept, state upstream); a model change drops the pin. A continuation that needs the live
  upstream socket but cannot have it closes the client with 1012 "upstream requires HTTP replay" (the client replays full input).
  Terminal failures expose request-shape errors (and terminal auth) as a Responses `error` frame and close; credential/quota/transport
  failures close silently (1011) like Go; 1009 (message too big) and replay-required map to their own close codes.
- **Tool-call repair** (`tool-cache.ts`): orphaned `function_call(_output)` items of replayed input are re-attached from per-session
  caches (256 entries, per isolate, keyed by caller scope + the client's session key, released with the last socket).
- **Upstream transport** (`executor/websocket/`): `UpstreamWebSocketConnector` dials with `fetch` + `Upgrade: websocket` (30 s handshake
  timeout, `wss:` URLs are fetched as `https:`); tests substitute in-memory sockets through `makeProxyRoutes({ websocketConnector })`.
  `UpstreamSessionStore` keeps one retained socket per execution session (= downstream socket id), serialises requests with a
  semaphore, reuses the socket while the target `(credential id, URL)` is unchanged, redials once when a send fails, applies the 5 minute
  idle read deadline (`Effect.timeout`, testable with `TestClock`), maps binary frames, close codes and drops to errors, and
  invalidates a socket whose turn ended before its terminal event. An idle socket that the upstream drops closes the downstream socket
  (Go `UpstreamDisconnectChan`). Requests without a session use an ephemeral socket closed after the turn. The Worker holds at most
  one upstream socket per client socket; it counts towards the 6 simultaneous outbound connections of the invocation.
- **Codex** (`codex/websocket.ts`): the HTTP `prepare` in websocket mode (`previous_response_id`, `generate`, `stream_options` kept;
  payload rules last) then framing only (`type: "response.create"`). Handshake headers follow `applyCodexWebsocketHeaders`
  (`OpenAI-Beta: responses_websockets=2026-02-06`, `session_id`/`Conversation_id`, turn-state/metadata passthrough, routing hint).
  Events are forwarded as bare JSON (Go skips response translation for downstream sockets): `response.done` -> `response.completed`,
  rebuilt `response.output`, usage detail objects, replay cache update, `error` frames and terminal failures classified like the SSE path
  (`websocket_connection_limit_reached` retries immediately on another credential).
- **xAI** (`xai/websocket.ts`, `websocket-ids.ts`): official API base URL only (the CLI chat proxy answers 405 to upgrades), frame =
  prepared body with `type: response.create`, no `stream`/`stream_options`/`background`, `store: true`, no `instructions` on
  continuations, payload rules on that body and `type` re-forced afterwards. Downstream response ids are mapped to upstream ids
  (`-xai-<seq>` suffix for repeats; `previous_response_id` dropped and the recorded transcript prepended when the upstream target
  changed). `generate:false` warm-ups end after `response.created` with a synthesised `response.completed`.
- **Fallback to HTTP**: credentials without `websockets` (or other providers) run each turn over the ordinary HTTP executors, with the
  transcript rebuilt locally; a downstream WebSocket never needs an upstream one.

Deviations from Go / not ported: no WebSocket ping keep-alives (`streaming.keepalive-seconds` is ignored: the Workers WebSocket API
cannot send ping frames); terminal failures close with 1011/1012/1009 instead of dropping the TCP connection; credential pinning only
covers WebSocket-capable credentials and the decision to pass through is based on the previously pinned credential instead of the global
credential list; no request-log timelines. Response steering / full duplex and non-stream execution over WebSocket are ported
(see the Codex section). The multi-agent v2 tool preparation and orphan delegation rewrite run on
each planned frame (`handlers/responses/codex-prepare.ts`), the executors do the rest. Upgrades whose `Origin` is not the Worker's own host are refused by the Access gate (Go: `CheckOrigin` always true; the
Access cookie makes cross-site WebSocket hijacking possible, see Authentication). CPU limits for
long-lived sockets follow the Workers platform rules (`limits.cpu_ms`).

## Model registry and `/models` endpoints (`src/registry/`)

Port of `internal/registry` plus the model registration in `sdk/cliproxy/service_models.go`. The Go registry is a mutable
process-wide singleton that the service keeps in sync with credentials; on Workers it is a pure function of three inputs,
evaluated per isolate and cached for 5 s (`ModelRegistry.snapshot`, `RegistrySnapshot`; `ModelRegistry.fresh` builds uncached):

- **Credentials**: `ControlPlane.listModelSources()` returns a `ModelSource` per credential (provider, executor key, prefix,
  plan tier, exclusions, per-account aliases, the `models:` of config entries, credential/model runtime state; no secrets).
- **Config**: `ConfigReader` (global `oauth.model-alias`, `oauth.settings`, `routing.force-model-prefix`,
  `upstream.claude.disable-cloaking-model-list`).
- **Catalogs** (ADR 0019, ADR 0020): every provider's models come from **models.dev** plus the **catalog additions**, not
  from the Go server's embedded JSON.
  - _Document_ (`models-dev.ts`): the models.dev `api.json` (≈5.4 MB) trimmed to the nine providers the proxy reads
    (`anthropic`, `google`, `google-vertex`, `xai`, `meta`, `kimi-code-plan-global`, `openai`, `opencode`, `opencode-go`)
    and to the fields it uses: no prices (only a `free` flag where the OpenCode gateways list a model at 0/0), no
    knowledge cut-off or other metadata. A document missing a provider or with a provider without models is invalid
    (the one-document rule: it feeds every provider, so it is all or nothing); a single malformed model is skipped and
    counted (the refresh reports and logs the number). `reasoning_options: null` (models.dev's way to say a model reasons
    without settings) is kept as an empty list.
  - _Additions_ (`catalog-additions.ts`, `catalog/additions.json`): what the proxy owns on top, versioned data that is
    never fetched: full records for models models.dev does not list (Antigravity and Devin entirely, models models.dev
    dropped), per-model `facts` models.dev lacks (thinking `dynamicAllowed`, web search, ...), per-provider `defaults`,
    `include`/`exclude` patterns and the Codex `plans` (which model ids each plan offers). Seeded once from the Go
    catalog. An addition only **fills gaps**: where models.dev has a value it wins (a wrong value is fixed at models.dev).
    Context length, output limit, modalities and the reasoning levels of a model models.dev lists follow models.dev, so
    some limits differ from Go's (Codex context windows grow to models.dev's figure; thinking levels come from
    `reasoning_options`, falling back to the additions' ranges). Thinking rules: a `budget_tokens` option gives a range
    but allows a budget of 0 (`zeroAllowed`) only with `min: 0` or a `toggle` option; an `effort` value `none` allows it
    too; a model that reasons with an empty or null `reasoning_options` has no thinking settings of its own (the
    additions' facts may still fill some, but no levels are invented); a model models.dev marks `reasoning: false` has no
    thinking at all, whatever the additions say (so `vertex/gemini-2.5-flash-image` no longer reports a budget). Every
    Codex plan id has a full record in the additions: it fills gaps and stands in if models.dev stops listing the id, so
    a refresh cannot empty a plan, and the provider `defaults` are not applied to plan models. Intended behaviour
    change: models.dev's `none` effort now reaches the Codex plan models (`gpt-5.5`, `gpt-6-*`, `gpt-5.6-*`), so
    `reasoning.effort: "none"` is forwarded upstream instead of being lowered to `low`. The Codex client catalog
    (`catalog/codex_client_models.json`) keeps its own format and stays bundled.
  - _Build_ (`catalog-build.ts`, `catalog.ts`): `buildModelsCatalog(document, additions)` makes the 13 sections (`claude`,
    `gemini`, `vertex`, `aistudio`, `codex-free|team|plus|pro`, `kimi`, `antigravity`, `xai`, `devin`, `meta`). A provider
    offers every current (not `deprecated`) text-output model models.dev lists for it, minus its `exclude`s, then the
    additions' own records. `aistudio` and `gemini` share `google`, `vertex` takes `google-vertex`, Codex plans take
    `openai`. Differences from Go: Devin is one aggregated section (a `devin/<id>` lookup resolves the whole section, Go's raw-section
    quirk is not repeated for `devin/` ids in `lookupModelInfo`), and Go's hard-coded Codex/xAI/Devin built-ins
    (`builtins.json`) are now additions.
  - _Bundled and stored copies_: `catalog/models-dev.json` is the trimmed snapshot shipped with the Worker (regenerated
    with `pnpm catalog:sync [url|file]`, `tools/sync-models-dev-catalog.ts`, idempotent). The same document is stored in KV
    `CACHE` (`registry/models-dev.json`) by the refresh; `CatalogStore` (`catalog-store.ts`) serves the KV copy per isolate,
    re-read at most once a minute, and falls back to the bundled one when KV is empty, unreadable or invalid. `models.catalog: embed` ignores the KV copy (the registry
    and the OpenCode executor read the bundled one at once, whatever KV still holds). The request path never fetches.
  - _Refresh_ (`refresh.ts`, `refreshModelsDev`): one operation for the cron task `model-catalog-refresh` (every 3 h like
    `ModelsRefreshInterval`) and the panel's on-demand refresh. It downloads the document (default
    `https://models.dev/api.json`, 30 s timeout, 16 MiB limit checked on `content-length` and while streaming), validates
    and trims it, stores it only when it changed (then drops the isolate cache) and records the attempt in KV
    (`registry/refresh-status.json`: time, outcome, reason, and the time the stored copy was last confirmed current). A failed,
    oversized or invalid download keeps the stored catalog. `models.catalog` chooses the source: empty = official,
    `embed` = delete the stored copy and serve the bundled snapshot, `disabled` = never refresh, otherwise one http(s)
    URL. `models.codex-catalog` and `models.devin-catalog` are accepted and no longer have an effect (listed under
    _Not applied_).
  - _One refresh at a time_: a download takes the **catalog refresh lease** in the Platform registry
    (`takeCatalogRefreshLease` / `releaseCatalogRefreshLease`: the same `SweepLeaseStore` as the quota sweep, table
    `catalog_refresh_lease`, atomic on the object's clock, 2 min expiry, given back with its token; the refresh is bounded
    by its 30 s timeout so it is not renewed). The cron task and the panel therefore never download at once, in whichever
    isolates they run; the second gets `running` without a request being made. The invocation is held open with
    `waitUntil` until the lease is given back. A Platform registry that cannot be reached fails the refresh (exclusivity
    cannot be shown); `embed` and `disabled` need no lease. The lease used to live in `global`'s ControlPlane
    (an unreleased lease there simply expires; the stale table is left unread).
- **Catalog status and on-demand refresh** (`management/catalog-routes.ts`, `contract/catalog.ts`; no Go counterpart):
  `GET /v8/management/models/catalog` answers `{mode, source_host?, source_problem?, stored, refreshed_at?, last_attempt?,
  models}`: the `models.catalog` mode (`official`, `embed`, `disabled`, `custom` with the host of the address, never the
  URL; an address that is not http(s) reads `disabled` with `source_problem` saying why), whether a refreshed copy from KV
  (`stored`) or the copy shipped with the Worker is in use (`embed` always reports the shipped copy: the stored one is not
  read), when the stored copy was last confirmed current, the latest attempt (`{at, status: updated|unchanged|failed,
  message?}`, the cron's or the panel's) and the model count per models.dev provider. `POST
  /v8/management/models/catalog/refresh` runs the cron task's operation now with the stored `models.catalog` setting and
  answers `200 {status: updated|unchanged|failed, message?, added?, removed?, skipped?, catalog}` (`added`/`removed`: models
  clients can call that appeared/disappeared, computed on the built catalogs per provider and counted once across Codex
  plans, so a deprecated or gateway-only change does not count; the removed ids are logged at warning level; `skipped`:
  malformed entries of the document that were left out; a failed download, size or validation problem is a `200` with
  `status: "failed"` and a fixed `message`, the stored catalog stays); `409 catalog_refresh_running` while another refresh
  (the scheduled one included) holds the lease, nothing is downloaded; `409 catalog_not_fetched` when `models.catalog` is
  `embed`, `disabled` or not an http(s) address. Admin only, CSRF rules as every write.
- **Assembly** (`credential-models.ts`): `registerModelsForAuth` per credential: base list (provider catalog, Codex plan
  tier, config `models:`), exclusions, OAuth aliases (`fork`, display names, per-credential first), `oauth.settings`
  context length, prefixes (`force-model-prefix`). OpenAI-compatibility models keep duplicate aliases (model pools) and skip
  exclusions/aliases like Go.
- **Index** (`registry.ts`): provider counts, per-provider records ("last registered wins", credentials registered in id
  order), the 5 min quota window and suspension rules of `modelRegistrationAvailability`, `GetModelProviders`,
  `GetModelInfo`, `LookupModelInfo` (registry, then static catalogs), `GetFirstAvailableModel`, native web-search capability.
  Records are camelCase `ModelInfo`s that satisfy `ThinkingModelInfo`; `snapshot.lookupModelInfo` is the `ModelInfoLookup`
  for `applyThinking`, `snapshot.providersForModel` is `util.GetProviderName` (the pipeline's `ModelProviders`).
- **Listings** (`listings.ts`, `models-api.ts`, `routes.ts`): `GET /v1/models[/{id}]` dispatches Grok shell UA -> `client_version`
  query -> Anthropic (`Anthropic-Version` or `claude-cli` UA, with ID cloaking `claude-fable-5-dd-<reversed id>`) -> OpenAI;
  detail routes pick the entry whose `id` equals the path remainder (ids may contain `/`). `GET /v1beta/models[/{model}]` is
  the Gemini shape. Bodies are serialised like Go's `encoding/json` (sorted keys, `\u003c` escapes) so they are byte-identical
  to the Go server's; lists are sorted by model id (Go's order is map iteration order).
- **Routing view** (`routing-view.ts`, `GET /v8/management/routing/models`; no Go counterpart): the admin answer to "which
  credentials serve each model, and why not". `RegistrySnapshot` keeps the enriched `sources` and the `configVersion` it was
  built from; `ModelRegistry.fresh` drops the config reader's cache, builds now and stores the result in the 5 s cache (no
  stale fallback: failures answer 502), so an edit shows on the next read (other isolates follow within the config and
  snapshot TTLs). `routingView(snapshot, now)` assembles every credential twice (`assembleCredentialModels`: as registered,
  and enabled without exclusions); each model of the second list is a route (`auth_index`, `upstream` = `metadataModelId`,
  `via` catalog/config/alias, `prefix`). State: `disabled` (credential off), `excluded` (missing from the registered list;
  `reason` = first matching pattern, `rule_scope` channel/account/key), else read from the credential state like
  `projectModel` (`quota` / `cooling` with `until`, `unavailable`, `available`). `listed` and `providers` come from the
  index, so they equal `/v1/models`; a model whose only routes are cooling is unlisted but still shown. The body also carries
  `oauth.model-alias`, `oauth.excluded-models`, `force_model_prefix`, per-channel account counts, `config_version` and `revisions` (the revision of each
  channel's rules by channel, the `If-Match` value of rule edits, see _Config entries_ below). Contract: `contract/routing.ts`.
- Fixtures: `go run ./tools/fixturegen/registry` drives the real Go handlers (`OpenAIModels`, `ClaudeModels`,
  `GeminiModels`, `GeminiGetHandler`, `WriteModelListResponse` detail mode) against a real `registry.ModelRegistry` and records
  bodies and registry queries (`test/fixtures/registry.json`).

Deviations from Go: models are registered under the credential's **executor key** (`kimi.com` -> `kimi`), which is what
`PickRequest.providers` is matched against; the quota window starts at the model state's observation time; Go's
`GetFirstAvailableModel` sorts with an inconsistent comparator for models without `created`, the port is deterministic
(newest, then id); credential/catalog edits show up within the 5 s snapshot TTL (1 min for KV catalogs). Not ported: plugin
models and Home.

**Codex client catalog** (`GET /v1/models[/{id}]?client_version=...`, `registry/codex-client-models.ts`, port of
`internal/client/codex/models`): every available model becomes an entry cloned from its template in `codex_client_models.json`
(or the `gpt-5.5` template with compact instructions), with reasoning levels (`max`/`ultra` only for clients >= 0.144.0 or
unparseable versions), modalities, priorities, Devin display names, `client.codex.optimize-multi-agent-v2` (`multi_agent_version`),
`client.codex.enable-apply-patch` (`apply_patch_tool_type: freeform` only when every provider of the exact public model has an
executor, `supportsApplyPatchProviders`) and `cpa_capabilities.web_search` for `client_version=cpa`. The body is serialised like
Go's `MarshalCompact` (sorted keys, no HTML escaping). Fixtures: the real Go `OpenAIModels` handler over the registry scenarios
(`codexClient` section of `test/fixtures/registry.json`: per-entry and whole-body hashes).

## Token refresh (`src/credentials/refresh/`)

Port of `auto_refresh_loop.go` + `conductor_refresh.go` + the per-provider `Refresh` executors. The `RefreshManager`
(Cloudflare-free, unit tested with a fake host/alarm/clock) is owned by the `ControlPlane` DO, which is the only writer:

- **Scheduling** (`schedule.ts`): `nextRefreshCheckAt` is a pure function of (now, credential, state) with the Go leads
  (codex 24 h, claude 4 h, antigravity 30 min, xai/kimi/kimi-ai/kimi.ai 5 min; devin, meta, kimi.com, vertex never).
  One alarm is multiplexed over all credentials: `rearm()` takes the minimum over the stored credentials (no heap) and
  is called after every credential mutation, after each alarm run and by the cron `sweepRefresh()`. `alarm()` refreshes
  what is due (`oauth.auth-auto-refresh-workers`, default 16, concurrently) and always re-arms, never sooner than 30 s
  when a credential is still due (guards against spinning). A running refresh pushes that credential's next check 60 s.
- **Single writer / dedupe**: one in-flight refresh per credential; the alarm, concurrent 401 recoveries and management
  calls share its outcome. `refreshNow(id, rejectedAccessToken?)` first records the rejected token (only when the token
  has no expiry of its own, like Go), returns the current credential without an upstream call when the token was
  already replaced, and otherwise refreshes. `forceRefresh(id)` ignores the terminal-unauthorized gating.
- **Persistence** (`pool.commitRefresh`, synchronous SQLite): new metadata is merged three-way (`three-way.ts`, the
  `MergeRefreshedAuth` metadata rules; user edits made while the refresh ran win, token keys take the refreshed value)
  and written before any caller sees the token, then runtime state (`outcome.ts`: failure table of credentials.md §9.2,
  back-off 5 min / invalid_grant 1->30 min, terminal 401, 30 s ineffective-refresh guard, concurrent cooldowns kept).
  A refresh whose base tokens were replaced meanwhile (re-login) is discarded. `credentialVersion` bumps on rotation,
  so leases of the old tokens are ignored by `report`.
- **Protocols** (`claude|codex|antigravity|xai|kimi|meta.ts`): `(context) => Effect<updatedMetadata, RefreshError,
  HttpClient>` over the injectable Effect `HttpClient` (`FetchHttpClient.layer` in production, a recording client in
  tests). Each HTTP call is bounded to 30 s, a whole refresh to 120 s. Claude retries only HTTP >= 500 and blocks the
  credential for `Retry-After` on 429; Codex retries three times except `refresh_token_reused`.
- **Request-time preparation** (`ensureFresh(id)`): returns a snapshot with a usable `metadata.access_token`: Meta mints
  the API key from the DCA token (persisted first), OAuth providers refresh when the token is missing/expired/rejected
  (Antigravity: within 5 min), **Vertex** mints a service-account token. `patchCredentialMetadata(id, patch)` persists
  preparation results (Antigravity `project_id`, Claude profile fields) without touching token material.
- **Vertex** (`vertex.ts`): no auth-file refresh. RS256 JWT-bearer grant with WebCrypto (PEM repaired like
  `keyutil.go`, PKCS#1 wrapped into PKCS#8, scope cloud-platform, 1 h lifetime). The token is cached in DO memory per
  credential (fingerprint = `credentialVersion:updatedAt`) until `exp - 60 s`, never persisted. Executors get it two ways:
  `pick` returns a snapshot whose `metadata.access_token`/`expired` are injected from the cache when still valid
  (`CredentialPool` `decorate` hook), and `ensureFresh` mints on a miss (concurrent callers share one mint). An executor
  therefore does: `if (!snapshot.metadata.access_token) snapshot = (await controlPlane.ensureFresh(id)).credential`.

Deviations from Go: credentials without a refresh token are never scheduled (Go loops every 30 s on an unchanged auth);
Codex keeps `email`/`plan_type` when the new `id_token` lacks them; a cached xAI `token_endpoint` must be an https x.ai
URL; Kimi/Claude device/uTLS headers are constants/subsets; Devin's metadata refresh (protobuf quota probe, never
scheduled) is not ported; `META_MINT_URL` is the Worker var of the same name (`RefreshContext.metaMintUrl`, also used by the Meta
login); Claude device-profile preparation is the executor's `stabilize-device-profile` store (below); Antigravity project discovery and the credits probe run in the Antigravity executor.

## Claude provider (`src/executor/claude/`, `src/translator/claude/`)

Ported from `internal/runtime/executor/claude_executor*.go`, `internal/translator/claude/*` and the helpers they use.

- **Credentials**: OAuth access tokens (`metadata.access_token`) and API keys (`api-keys.claude[]`, synthesised by
  `claude/config-credentials.ts`); base URL defaults to `https://api.anthropic.com`. OAuth credentials get the Claude
  Code treatment (cloaking); API-key credentials to first-party hosts keep caller-owned mode (caller betas verbatim,
  body `betas` appended). Custom `base-url` gateways skip upstream `count_tokens` and estimate locally.
- **Request order** (matches the Go executor and the payload-rules barrier): translate -> thinking -> sanitise ->
  cloaking (system relocation, billing block, identity, date reminder, user_id, context management) ->
  MCP tool aliasing -> cache-control policy -> payload rules -> CCH signing (`cch=` is `xxh64` over the normalised
  final body; only the five hex digits change) -> HTTP. Signing is the last step so it covers payload-rule output.
- **Responses**: Claude upstream always streams for non-stream clients; tool aliases are restored in non-stream bodies
  and stream lines; `ExecutionError` classification (`ratelimit.ts`) separates credential-scoped (unified-limit 429/401),
  request-scoped (Fast mode entitlement) and model-level failures for the picker.
- **Translators**: OpenAI chat, OpenAI Responses, Gemini and Interactions clients -> Claude, each with request and
  response (stream/non-stream/token-count) functions, golden-tested against Go through the translator corpus.
  `claude -> claude` has no translator (registry fallback forces `model`). Model capabilities (adaptive levels,
  max tokens) come from `translator/model-info.ts`, which the model registry slice populates.

Deviations from Go (all deliberate, documented in code headers):

- No uTLS/HTTP-2 fingerprinting (Workers limitation); `wire-policy` is dropped on import.
- **Device-profile stabiliser** (`device-profile.ts`, `upstream.claude.header-defaults.stabilize-device-profile`; Go
  `helps/claude_device_profile.go` local mode): confirmed Claude Code clients contribute their user agent / Stainless
  versions (only when they equal the configured baseline tuple; the platform is always pinned to the baseline), stored per
  credential and CLI entrypoint scope in the `SessionState` DO (sliding 7 d TTL, newer CLI version upgrades, compare-and-swap);
  unconfirmed clients get the baseline. The Home KV mode is not ported. Go parity: `tools/fixturegen/claudeprofile`.
- **`rebuild-mid-system-message`** (`mid-system.ts`): `role: "system"` messages are folded into `system` right after the
  thinking step (messages, count_tokens and the local estimator), enabled per `api-keys.claude` entry or the
  `rebuild_mid_system_message` credential attribute.
- **Thread continuation** (`thread.ts`): `thread.type = "continue"` requests without `tools` restore the MCP tool aliases saved
  for `message:<previous_message_id>` / `message:<new id>` (SessionState DO per caller scope, 1024 entries, 7 d TTL; Go: executor
  memory); an unknown previous message is the request-scoped 404 `not_found_error`.
- **Post-payload reconcilers** (`reconcile.ts`: Fable 5.1 / Opus 5.5 fallbacks, `thinking.display`, `# Reporting outcomes`
  block, system-turn placement) are ported and tested against the Go cases but, exactly like in Go, not called by the
  executors: payload rules are the final mutation, nothing may rewrite the body after them. `experimental-cch-signing` is
  accepted and ignored (Go keeps it for compatibility; signing is automatic).
- Kimi attribution stripping is in the pipeline (`stripAttributionSystem`); the continuity and thinking-replay stores live in the `SessionState` DO (see below): `begin` = one read (which
  slides the 1 h TTL) plus one write only when the prompt id or pinned date changed, `commit` = one compare-and-swap write using
  the generation carried in `ContinuityState` (`planContinuity` computes the arguments, the store is awaited before the
  synchronous `applyCloaking`).
- Signature handling is the full `internal/signature` port (`src/signature/`, see "Signature validation"):
  `sanitizeClaudeMessagesForClaudeUpstream` runs before the Claude upstream request.
- OpenAI Responses -> Claude: the Codex `apply_patch` custom tool is a strict `{"input": ...}` function upstream and the
  response translator (`claude/openai/responses/response.ts`) decodes it into `custom_tool_call` events
  (`ApplyPatchCallState`, identity/snapshot validation, `response.failed` + 502 on malformed input). Go's log-only invariant
  diagnostics are omitted.
- **Responses compaction capsules** (`helps/compaction.ts`, `claude/compaction.ts`; Go `helps/antigravity_compaction.go`,
  `claude_executor_compaction.go`): `responses/compact` and streaming `compaction_trigger` run a non-stream summary turn (Responses payload
  -> summary prompt appended, `tools`/`stream`/... removed; Claude keeps the tool definitions for `tool_use` history and sets
  `tool_choice: none`, without definitions the tool blocks are flattened to text after the CCH step and before the payload rules) and seal
  the answer into `cpa-ag-compact-v1:` + base64url(`nonce(12) || AES-256-GCM(SHA-256("CLIProxyAPI"), {"summary","model","created_at"})`)
  with WebCrypto. The key is the fixed Go secret on purpose: capsules stay interchangeable with the Go server and between deployments (it
  is obfuscation, not a secret). Incoming `compaction` items are expanded into developer messages before translation; Claude drops
  foreign (non-CPA) items, an unreadable capsule is a request-scoped 400. Usage follows the Responses accounting (input = input + cache
  creation + cache read). Verified against the real Go executors (`go run ./tools/fixturegen/compaction`,
  `test/compaction-fixtures.test.ts`: upstream request bodies, outputs, unsealed summaries, byte-identical sealing with a fixed nonce).
  The Claude and Antigravity executors also add the `output_tokens_details`/`input_tokens_details` of Responses answers
  (`EnsureResponsesUsageDetails`) that were missing on their non-stream/stream paths.
- `responses/compact` stays 501 where Go answers 501: Gemini/Vertex (`gemini_executor.go`, `gemini_vertex_executor.go`), Meta and Kimi.
  The OpenAI-compatibility executor posts the Responses-format request to `{base-url}/responses/compact` (no chat shaping, `stream`
  removed, reasoning cleartext cleared).

## Gemini, Vertex and Interactions (`src/executor/gemini/`, `src/translator/gemini/`, `src/handlers/gemini/`)

- **Providers**: one engine (`executor/gemini/google.ts`) parameterised by a `GoogleVariant` (`targets.ts`): `gemini`
  (API key, `x-goog-api-key`), `gemini-interactions` (same key, native `POST /v1beta/interactions` with the
  `Api-Revision` header) and `vertex` (API key against the project-less host, or a service account against the regional
  `projects/<id>/locations/<loc>` endpoint; Imagen models go through `:predict` with the request/response converters).
  Request shaping (`shaping.ts`: model/suffix handling, `maxOutputTokens` cap, content-turn splitting) and usage parsing
  (`usage.ts`: `usageMetadata`/Interactions usage with the v2 token breakdown - re-exported from `usage/parsers.ts` - and intermediate-usage filtering) follow the Go executors. Payload rules
  stay the last mutation of the body in every path (stream, count, Imagen, native Interactions).
- **Routes**: `POST /v1beta/models/*` (`generateContent`, `streamGenerateContent`, `countTokens`, Gemini SSE or raw
  chunks for other `alt`s) and `POST /v1beta/interactions` (exactly one of `model`/`agent`; agent requests are forced to
  the `gemini-interactions` provider and select credentials as for `gemini-2.5-flash`, the Go `auth_selection_model`).
  `ExecutionInput.forcedProvider`/`authSelectionModel` and `PickRequest.selectionModel` carry that through the conductor.
- **Vertex tokens**: service-account access tokens are minted by the ControlPlane (`ensureFresh`) before the attempt by
  the conductor's credential preparation (`needsPreparation` for `vertex` without `metadata.access_token`); the executor
  only reads `metadata.access_token` (401 `credentialScoped` when missing). API-key vs service-account is decided by the
  `api_key` attribute (a minted `access_token` next to a `service_account` is a bearer token, not an API key).
- **Translators** (all golden-fixture tested against Go, `tools/fixturegen/translator/corpus/*-gemini.json`,
  `gemini-interactions.json`, `interactions-*.json`): gemini->gemini, claude->gemini, openai->gemini,
  openai-response->gemini, interactions<->gemini, interactions->interactions (passthrough). Shared Gemini pieces live
  in `translator/gemini/{common,util}`: contents merging, thought-signature replay policy (Gemini target only; other
  providers' signatures are never replayable for Gemini, so only the Gemini decision table is ported), JSON-schema
  cleaners and the MIME table.
- **Responses (`translator/gemini/openai/responses/`)**: request/response ported file by file (carrier, trailing
  signature, tools, media, web search, streaming and non-streaming). Gemini returns whole function calls, so the
  apply_patch bridge is reduced to strict `{"input": ...}` validation (`finishApplyPatchArguments`) plus the event
  helpers it needs; a retained failure sets `state.toolInputError` (stream: `response.failed`, non-stream: translation
  failure -> 502). Hidden text signatures (a signature that trails the visible text) go to a `ReplayCache`
  (`replay-cache.ts`): the translators see a synchronous cache; the Gemini executor installs a request-scoped one
  around each synchronous translator call (`withReplayCache`, `executor/gemini/replay.ts`): it prefetches the cache keys of the
  assistant messages in the request in one DO round trip before translating (`textSignatureKeys`) and flushes the entries the
  response translation stored in one write before the chunk is emitted. One DO instance per caller scope holds the entries (1 h
  TTL, 10240 per caller); a backend failure degrades to the bypass signature, never to an error.
- **Fixtures**: cases with generated ids/timestamps are tagged `needs: ["id-normalization"]` and run by
  `test/translator-fixtures-ids.test.ts` (ids and `created_at` masked on both sides; thinking-summary cases apply the
  real summary hooks); everything else must match the Go bytes exactly (`test/translator-fixtures.test.ts`).
- **Deviations from Go**: `TranslationError.body` returns the partially translated body for fixture parity only;
  `gjson.Raw` whitespace is not preserved (embedded raw JSON is compacted); model capability lookups
  (`ModelSupportsWebSearch`, `lookupModelInfo`) read the embedded static catalog, not the live registry; Go's
  `PrepareAntigravityInteractions` lives in `executor/gemini/antigravity-interactions.ts` (see _SessionState Durable Object_); a Vertex Imagen
  request without a prompt answers 400; logging of signature decisions is dropped. `claude -> interactions` is ported separately (see below).

## Claude clients on Interactions providers (`src/translator/interactions/`)

Port of `internal/translator/interactions/claude` (registered as `claude -> interactions` by
`interactions/register.ts`): Claude Messages requests served by `gemini-interactions` (native `POST /v1beta/interactions`) and Devin.

- **Request** (`claude/request.ts`): `system` -> `system_instruction` (blocks joined with `\n`, attribution blocks kept like Go),
  `max_tokens`/`temperature`/`top_p`/`stop_sequences`/`thinking`/`output_config.effort`/`tool_choice` -> `generation_config`,
  messages -> `input` steps (`user_input`, `model_output`, `thought`, `function_call`, `function_result`), message-level `system`
  entries -> `<system-reminder>` user steps (held back behind pending tool results), tool results re-aligned with their `tool_use`
  order (`alignClaudeToolResults`), `tools` -> function declarations. Only inline base64 media is forwarded; a user turn emptied
  by unsendable parts is refused with a request-scoped 400 (`UserTurnDrops`). `convertClaudeRequestToInteractionsWithCompat`
  keeps empty thinking blocks and is selected for `is-compat` models by `translateRequestForExecutor` (the `gemini-interactions`
  executor).
- **Response** (`claude/response.ts`): Interactions stream events/aggregates -> Claude `message_start`/`content_block_*`/
  `message_delta`/`message_stop`/`error` frames (each frame ends with three newlines like Go) and Claude `message` bodies;
  `status: incomplete`/length finish reasons -> `max_tokens`, function calls -> `tool_use`, usage re-based so that Claude's
  `input_tokens` excludes cache reads/writes.
- **Fixtures**: `corpus/claude-interactions.json` (101 cases: Go tests ported plus edge cases); the golden harness now also masks
  the wall-clock `msg_<unixnano>` ids. End-to-end: `test/claude-interactions-pipeline.test.ts` (gemini-interactions through the
  full pipeline, Devin through its executor with a Claude source).

## OpenAI-compatible upstream for every client protocol (`src/translator/openai/`, `src/executor/openai-compat/`)

Port of `internal/translator/openai/{claude,gemini,openai,interactions}` plus the image paths of
`openai_compat_executor.go` and `openai_images_handlers.go`. `translator/openai/register.ts` registers (client -> provider):
claude/gemini/openai-response -> openai, interactions <-> openai (Chat Completions) and interactions <-> openai-response;
`handlers/openai/routes.ts` already converts Responses-shaped bodies sent to `/v1/chat/completions`.

- **Layout**: one directory per Go package; the helpers of Go's `translator/common` live in `translator/common/` (apply_patch
  bridge, Responses tool descriptors, tool-name fixing, user-turn-drop policy, file data, ...); `openai/common/read.ts` only adds
  OpenAI-side readers. Modules cite their Go source. The
  apply_patch identity state machine of `interactions/responses` is ported statement by statement (including the
  `ApplyPatchInputDecoder`), and every translator is covered by golden fixtures (`corpus/*-openai*.json`, `*-interactions.json`).
- **Images**: the executor serves `openai-image` entry requests (`executor/openai-compat/images.ts`): the JSON body is
  forwarded to `{base-url}/images/generations|edits` with model/stream normalised and payload rules applied last. The handler
  routes `gpt-image-*` to Codex and every model the registry types `openai-image` (config `models[].image: true`; test
  doubles of `ModelProviders` may implement the optional `modelType`) to the OpenAI-compatible executor, converting the
  non-stream answer to `response_format` (`buildImagesApiResponse`). The handler turns multipart edits into the JSON edit
  form, so the executor rebuilds `multipart/form-data` for the upstream (file names are not kept).
- **Executor shaping** (`openai-compat/executor.ts`): models whose `input-modalities` list text without image get their Chat tool
  results flattened to text, relayed Claude tool-result images replaced by `[image omitted: unsupported by upstream]`
  (`helps/openai-compat-tool-results.ts`, verified against Go by `fixturegen/compatparity`). With `support-prompt-cache-key` the
  `prompt_cache_key` is the client's, else (Claude callers) the Claude Code agent scope, else a UUIDv5 over provider, model, source
  format and the provider session (`ProviderSessionUUID`: the WebSocket execution session, then the derived session identity).
  SEAM: the derived identity is read from `ExecutionMetadata.sessionId`, like Codex and Antigravity; the content-hash derivation of the
  session slice feeds the same field.
- **Deviations**: a patch-enabled Interactions stream that ends without its source
  terminator now fails through `state.finalizeToolInput` (executors call it, see Devin); malformed
  Interactions event JSON is only approximated (longest valid object prefix) because gjson reads lazily; raw JSON texts that
  Go copies byte for byte (`gjson.Raw`) are re-serialised compactly.
- **No equivalent needed**: the Go OpenAI-compatible executor has no refresh and no reasoning replay cache (§7 of the pipeline
  research lists none for it); 401s are ordinary upstream errors for the conductor's classification.

## Management API and control panel (`src/management/`)

Port of `internal/api/handlers/management` for the `/v8/management` routes that apply on Workers. The API serves the
control panel at `/` (`web/`, through `contract/`) and may change incompatibly: routes keep Go's response shapes where
that is cheap, but scripts written for the Go server are not guaranteed to keep working. The upstream panel (`Cli-Proxy-API-Management-Center`) is not served:
its address redirects to `/` (_Legacy panel address_ below), and the routes only it needed are gone (`requests/api-call`,
the operational and log routes listed under _Also not ported_) or replaced by the config entry routes (_Config entries_). Auth is the Access admin gate only (`access/routes.ts` classifies `/v8/management*`, the
panel paths and `/management.html` as `management`); there is no management key.

- **Config entries** (`settings-routes.ts`, `api-keys-routes.ts`, `model-rules-routes.ts`, contract `config.ts`): Go's
  management API reads and edits the whole configuration as one document (`GET|PUT|PATCH /config`, `GET|PUT /config.yaml`,
  `GET|PUT|PATCH|DELETE /config/*path`) and writes without a version. Dropping those routes is a deliberate difference
  (ADR 0025, ADR 0019): the Workers port stores every setting, key group, API key, channel rule list and payload rule as a
  config entry with a revision (_Storage_ above), and each route below edits its own kind of entry and names the revision
  it read. A stale revision, or a group that vanished, answers `409 conflict` and stores nothing; a write of another
  entry never conflicts. Answers carry the new change counter as `version` (`Saved`, `EntrySaved` in `contract/config.ts`).
  - **Removed**: `GET|PUT|PATCH /config`, `GET|PUT /config.yaml`, `GET|PUT|PATCH|DELETE /config/*path`,
    `GET /settings/config`, `POST /settings/config/check`, `PUT /settings/config` and
    `PUT|DELETE /config/oauth/model-alias|excluded-models/:channel` answer `404` now (still behind the admin gate). With
    them go the raw configuration editor and its masking and placeholder machinery (`config-secrets.ts`,
    `settings-raw.ts`, `config-document.ts`): no route reads the whole document back, and no route reads a secret back
    at all (the API keys page shows previews, the settings view carries no secret), so there is nothing to mask and
    nothing to restore. The one whole-configuration write is the import (_Settings_ below).
  - Config errors never quote a value (`config/codec.ts`: a YAML syntax error is a fixed sentence per `yaml` error code
    from `config/yaml-message.ts`, never the library's text, plus `line`/`column`; an unresolvable alias
    `invalid YAML: unresolvable aliases`; a schema error its expectation and `path`, formatted without `got <input>`;
    `disable-image-generation` without its value). They name at most keys of the written document (the `path`, an unknown
    `api-keys` family or group field) and are passed on unscrubbed: scrubbing stored secrets out of an echoed key would
    itself tell a right guess from a wrong one. So a refused write reads the same whether a typed value, key or alias
    name equals a stored secret or not.
  - Admin service tokens (Workers addition): every write that can change `access.admin-service-tokens` (`PATCH /settings`
    and `POST /settings/import`) refuses a change by an email admin who is one only through the config
    (`403 service_tokens_require_service_admin`, `checkServiceTokenAdmins` in `settings.ts`; service-token administrators
    and env admins may), compared as a set against the stored list so rewriting the same list is fine.
  - Model rules (`model-rules-routes.ts`, contract `routing.ts`; Workers addition, Go's panel writes `oauth-model-alias` and
    `oauth-excluded-models` through `/config` paths): `PUT|DELETE /model-rules/aliases/:channel` and
    `/model-rules/exclusions/:channel` replace or remove one channel's whole list, which is one entry. The request names the
    revision it was based on in `If-Match` (`12`, `"12"` or `W/"12"`; `0` for a channel without rules): a missing or
    malformed header is `400 invalid_if_match`, a channel changed since `409 conflict`, a `DELETE` of a channel without
    rules `404 not_found`, and a list of which the normaliser would keep nothing `422 invalid_config`. The channel is the
    config's key, trimmed and lower-cased. The answer is `{status, version, revision}` with the channel's new revision (`0`
    after a delete). `GET /routing/models` carries `revisions: {aliases: {channel: rev}, exclusions: {channel: rev}}` (read
    first, so a write landing in between makes the edit answer `409` instead of overwriting a change the view did not show).
- **Credentials** (`credentials-routes.ts`, `credential-entry.ts`, `credentials/field-patch.ts`): list (filters,
  pagination), upload (multipart or raw JSON + `?name=`), delete (`name`/`names`/`all`), download (the stored file,
  tokens included; deviation from Go: only a service-token admin may call it, an email admin gets
  `403 download_requires_service_token`: the response is the one place a stored refresh token leaves the Worker, and
  a service token is the credential meant for scripts, see `ACCESS.md`), `models`, `status`, `fields`, `refresh`, `routing/cooldown/reset`. Credential id = file name; the
  list holds the auth files plus the config API keys whose provider reports quota with the key itself (`source:
  "config"`, `quota/report.ts` `CONFIG_QUOTA_PROVIDERS`: OpenCode Go only; `status` toggles any config key through its
  `excluded-models`, see _API keys_ below). Deviation from Go, which lists no config API keys in `/auth-files` (its
  panel shows them on the providers page only): the panel's Accounts page needs them for the OpenCode Go usage windows
  (see _Quota check_). Such an entry is named by its `auth_index` (`id` and `name`; the content-addressed credential id
  is never sent), `account` is the masked key (`[redacted]…abcd`), `supports_quota` is true, `key_group` (`{family,
  index}`) is where the key is edited on the Keys page, `disabled` means `*` in its `excluded-models`, and the status
  message is scrubbed of the key; the file-only fields (size, file times, note, weight, routing fields, headers) are
  absent. The quota check, `models` and the cooldown reset take its `auth_index`; the file-only operations naming it
  (delete, download, `fields`, `refresh`, `status` by `name`) answer `409 config_credential`, a several-name delete
  reports that `error` for it in its `207`, and a batch answers that `error` per account.
  Other config keys stay off the list (OpenCode Zen and the rest have no usage endpoint that takes the key). `auth_index` = `hex(HMAC-SHA256(AUTH_INDEX_KEY, "auth-index:" + id))[:16]` (`auth-index.ts`).
  Deviation from Go (security): Go's index is the unsalted `sha256(seed)[:16 hex]`, and a config credential id is
  itself `kind:sha256(kind␀key␀base␀proxy␀prefix␀headers)[:12]` (`credentials/synthesize.ts`), so anyone holding
  either could confirm guessed API keys offline and brute-force low-entropy ones (self-hosted or compat endpoints),
  narrowed further by the `…abcd` preview. The index is keyed with a per-deployment secret (`AUTH_INDEX_KEY`, an
  Alchemy `Random` minted on a stage's first deploy and kept in the stack state, `alchemy.run.ts`; fixed keys in
  `alchemy dev` and the tests), and config credential ids never leave the Worker: no management response, usage
  export or proxy header carries them, `name` lookups (`PATCH /credentials/status`, `GET /credentials/models`) match
  auth files only, and a config key is addressed by its `auth_index`. The index is never stored (D1 keeps the
  credential id, the ControlPlane recomputes indexes for lookups), so setting or rotating the key changes every index
  once (panel links `/accounts/<auth_index>` included). The key fails closed: a missing, non-string or < 16-character
  key throws instead of hashing (node:crypto accepts a 0-byte HMAC key), and once `ACCESS_TEAM_DOMAIN` or `ACCESS_AUD`
  is set (the condition that refuses `ACCESS_DEV_BYPASS`) the `alchemy dev` key and keys under 64 characters are
  refused too (`deploymentAuthIndexer`, logged once per isolate; the ControlPlane resolves the key per call, so a
  refusal fails the management calls that need an index, not the Durable Object; proxying is unaffected, its log
  line then omits `authIndex`). `auth_index` inputs match case-insensitively. The key is a node:crypto `KeyObject` imported once per isolate
  and the indexes are memoised (`subtle.sign` is async-only; DO lookups and the views are synchronous). The ControlPlane builds the redacted panel
  entries (`listCredentialEntries`) and owns the mutations (`patchCredentialFields`, `refreshCredential`,
  `refreshAllCredentials`, `resetCredentialCooldown`, `removeCredentials`, `getCredentialFile`, `batchCredentials`).
  `POST /credentials/batch {action: enable|disable|refresh|delete, names}` (`credentials-batch.ts`, Workers addition
  for the Accounts page's selection) answers `200 {action, results, succeeded, failed, skipped}` with one `{name, ok,
  skipped?, error?, message?, status?}` per distinct name (names are exact file names, not trimmed), so a partial
  failure names who failed and why: `not_found` for unknown names and config credential ids (a delete of a name
  already gone counts as done, as the single delete would leave it; so does a config id, which must read like any
  unknown name or the reply would confirm a guessed API key), `config_credential` for a listed config account named by
  its `auth_index` (indexes are public, so this confirms nothing), `refresh_failed` with a fixed message and the upstream status
  (never the token endpoint's body, which can echo the refresh token), and `skipped` + `not_refreshable` for an account
  without a refresh token. At most `MAX_BATCH_NAMES` (100) names, `MAX_BATCH_REFRESH_NAMES` (20) for a refresh (each
  name is an upstream call), `400` beyond or when empty; the body is read up to 64 KiB (`413` beyond). One endpoint
  instead of the panel calling the single-account routes: the single-writer ControlPlane applies
  enable/disable/delete against one snapshot in one SQLite transaction with one alarm re-arm (per-account calls would
  interleave with other writes and re-arm each time; a batch delete shares `removeCredentials`' cleanup of state,
  quota reports and the pool), the Worker spends one RPC instead of one per account, and token refreshes run in the
  object four at a time. Entries
  also carry the
  account's own routing fields for the panel (Workers addition): `prefix` (the effective one selection uses, not the
  raw metadata), `disable_cooling`, `headers` (masked like the API keys page, `maskHeaders`: every non-empty value
  except the safe-header allow-list `SAFE_HEADER_NAMES` and pure client copies `$Name` / `$CPA-SESSION-ID`, since a
  secret can sit under any name), `excluded_models` and `model_aliases` (its own lists, without the channel rules).
  `PATCH /credentials/fields` type-checks the fields the panel edits (`prefix` with outer slashes dropped like Go's
  synthesizer, then without `/` or spaces; booleans; exclusion patterns stored lower-cased; aliases with both names,
  different, each alias once; header names and single-line values, merged with names matched case-insensitively, an
  empty value removing a header whatever its name) and answers a refused value with `422 {error, path}`, where `path`
  is the field or its entry (`headers.<name>`, `model_aliases.<index>`) (Go: `400`, and it stored most values as sent;
  a malformed request stays `400`, including a nested path into a typed field such as `headers.X-Foo`, which Go set). A
  header value equal to the mask of the same header's stored value keeps the stored value; any other value containing
  `[redacted` or `[new secret` is refused, so a masked value is never stored or copied to another header. This does
  not make stored secrets immovable: a PATCH of `base_url` (stored as sent, as in Go) still sends the account's token
  to the new address.
- **API keys** (`api-keys-routes.ts`, `api-keys-view.ts`, `api-keys-write.ts`, `api-keys-probe.ts`, contract `api-keys.ts`):
  the control panel's keys page. Workers addition, no Go counterpart (Go's panel edits whole family arrays with raw keys).
  - `GET /api-keys`: every `api-keys` group (all families, compat endpoints included) with the config `version`, the
    group's `id` and `revision` (its config entry, see _Config entries_), the effective base URL and, per key, `auth_index`, a `[redacted]…abcd` preview, `disabled` (effective `excluded-models`
    holds `*`) and the runtime of its credential (`auth_index`, counters, cooldowns, last error; not its id). Built in the ControlPlane
    (`apiKeysView`) from one snapshot of config and credential pool. **Secrets never leave**: keys are previews, every
    header value is masked (`[redacted]…`) except safe headers and pure client copies (`maskHeaders`), `proxy-url` and `experimental-cch-signing` (no effect
    on Workers) are left out and only reported as group `warnings`.
  - `PUT /api-keys/groups` (`{family, id?, revision, group}`: replace the group `id` at `revision`, or add one after the
    family's last, with no `id` and `revision` 0) and `DELETE /api-keys/groups` (`{family, id, revision}`): a group and its
    keys are config entries (ADR 0025). The Worker reads the entries, answers `409 conflict` when the group changed since
    `revision` or vanished (a write of another group never conflicts), applies the edit to the assembled document,
    dry-runs it through the config decoder and writes the group alone (`writeKeyGroup`) **without retry** (the panel
    re-reads and the user decides). The duplicate settlement below reads the other groups without naming their
    revisions, so the store also refuses (`409 conflict`) a write after which the normaliser would drop a key another
    group of the family stored since that read. The answer is `{status, version, id, revision}` (the group's new revision; `0` once
    deleted). A key in a written group is `auth_index` (keep the stored secret) and/or `api-key` (new secret): a key is
    an entry whose id is its credential id, so editing the secret of a key keeps its credential id and so its
    `auth_index` (the old document model made it a new credential); an unknown `auth_index` is `409 unknown_auth_index`,
    a missing group `404 group not found`. Hidden settings and masked header
    values are carried over from the stored entry, so a write is lossless. The config normaliser drops groups and keys
    silently (codex without `base-url`, empty keys, ...): the dry run compares the result with the request and answers
    `422` with the reason when the written group's own shape caused the loss. Duplicate keys are the exception and are
    dropped silently, as Go's `Sanitize*Keys` do (Go answers `200`; the Workers port used to answer `422 duplicate
    key`). Deviations from Go, deliberate: (1) a `422` for a typed key equal to a stored one would let an admin
    confirm a guessed secret, so the reply (`{status, version, id, revision}`, the version always advancing) is the same for a
    right and a wrong guess: the reply does not confirm a guess, the next read does. (2) Stored keys win (Go keeps the
    first of a family's duplicates, which would let a typed key in an earlier group delete the stored key, or the
    whole group, of a later one): for the families Go deduplicates across groups (gemini, interactions, vertex;
    `keyIdentities` in `config/normalize.ts` is the normaliser's own uniqueness id) `settleDuplicates`
    (`api-keys-write.ts`, `key-duplicates.ts`) drops from the written group every typed key (`api-key`) equal to a
    key of another group, to a key the group keeps by `auth_index`, or to an earlier typed key, before the
    normaliser runs. A key counts as typed when the request writes its secret, header values (other than
    masked placeholders), a `proxy-url` or, for its group, another `base-url`: these feed the uniqueness id, so a
    collision found by trying a value would confirm a guess (an admin could try header values on a key kept by
    `auth_index`) and is dropped silently instead. A key kept by `auth_index` that the edit makes equal to a key of
    another group by its `prefix` alone is `422` (the other key differs only by a value the caller can read). `checkSurvival` asserts that every other group keeps its key count. A group
    left without keys (a new group, or a replaced one, made only of copies) is stored but not shown, as the list leaves
    out a group without keys, and the reply is the same. The assembled document is canonical (the store decodes it on every
    write), so list positions are document positions.
  - `POST /api-keys/probe {auth_index}`: one connection test, made by the **Worker** with the credential's own base URL
    and headers (the ControlPlane only hands over the target, `apiKeyProbeTarget`, like `quotaProbeTarget`): a model
    listing (gemini/interactions `/v1beta/models` paged, claude `/v1/models` with `x-api-key` on api.anthropic.com
    else Bearer, codex/xai/meta `/models` or `/v1/models`, compat `/models`) or, for Vertex (no listing), a one-token
    `countTokens` on the first configured model. 30 s bound, not reported to the credential pool (no counters or
    cooldown), `200` always (`ok: false` with `status_code` and a fixed message; bodies and keys are never copied).
    Meta `/models` and Vertex `countTokens` are unverified against the live services.
  - `PATCH /credentials/status` (`auth_index`; `name` addresses auth files only) on a config API key adds or removes `*` in its
    `excluded-models` (Go `toggleConfigAPIKeyExcludedAll`; answers `via: "config:excluded-models"`, `excluded_pattern: "*"`);
    the id and `auth_index` do not change. A compat key answers `409`: disable the endpoint (its group's `disabled`). The
    toggle names no revision: it sets one flag to the state asked for, so the last toggle wins; it moves the group's
    revision, so a key group form opened before it answers `409` on save instead of undoing it.
  - `configKeyIds` (`credentials/key-ids.ts`) maps config positions to credential ids through the synthesised credentials;
    the ControlPlane and the keys page share it. `includeDisabledGroups` also addresses the keys of a disabled compat
    group (they have no credentials in the pool).
- **Settings** (`settings-routes.ts`, `settings.ts`, contract `settings.ts`): the control panel's Settings page and the
  config import. Workers addition, no Go counterpart (Go v8 edits `/config` paths without a version and normalises
  silently). Every setting is a config entry of its own, by dotted path (_Storage_ above).
  - `GET /settings`: every Settings-owned value (`SETTINGS_TREE`: routing, retries/cooldowns, requests/streaming,
    upstream provider flags and header defaults, Codex client flags, refresh concurrency, OAuth provider settings,
    multimedia, model catalogs, config admin lists) in config spelling with defaults filled (unset Go pointers are
    `null`), the `defaults`, the config `version` and `updated_at`, `revisions` (the revision of every stored setting by
    dotted path; a setting at its default is not stored and is not listed, revision 0), `env_admins` (`PLATFORM_ADMIN_*`),
    `payload` rule counts per kind, `prefixed_credentials` and the read-only `request_scoped_errors` map. There is no
    `not_applied` list: not-applied keys are never stored, only the import names them. **No secrets**: API keys, proxy
    URLs and client keys are never in the view.
  - `PATCH /settings {revisions, patch}`: `patch` is a deep partial of the values; `null` resets a setting to its default
    (its entry is deleted). `revisions` names the revision of each setting the patch changes (absent = 0): a setting
    changed since answers `409 conflict` and nothing is stored, and writes to other settings never conflict. Unknown paths
    and not-applied keys answer `400 not_a_setting`, like any path that is no setting; invalid values
    `422 invalid_setting` with `message` and `path` (naming the value, e.g. `“EST” is not an IANA time zone`; type, then rules: Go
    durations > 0, non-negative counts, strategy literal, `gpt-` model prefix, catalog `""`/`embed`/`disabled`/http(s),
    IANA time zone or `Local`, email-shaped admin entries); then the edited document is dry-run through the config
    decoder and every written leaf must come back unchanged (a value the normaliser trims, lower-cases or clamps is
    refused with its path instead of "succeeding"). Only a service-token administrator or an env admin may change
    `access.admin-service-tokens`: an email admin who is one only through the config gets
    `403 service_tokens_require_service_admin` (also on `POST /settings/import`; a Workers addition: the
    credential download is for service tokens only, so an email admin must not be able to grant that right, see
    `docs/ACCESS.md`). A caller who is an admin only through `access.admin-*` cannot
    remove themselves (`422 would_remove_your_admin_access`; platform admins and the dev bypass can). Ok:
    `{status: "ok", version, revisions}`: the new revision of each changed setting (`0` for one reset to its default).
  - `POST /settings/import` (body: YAML or JSON text, `application/yaml`, `text/yaml` or `application/json`, at most
    512 KiB, `413 body_too_large` beyond; counted while it is read): the **only** write of the whole configuration. It
    replaces **every** config entry of the org with a Go config document (v8 or legacy layout, as `config/codec.ts`
    reads it) in one transaction, so what the document does not set goes back to its default and every key group,
    key, rule list and payload rule it does not list is deleted. It answers `{status: "ok", version, not_applied}`:
    the keys that have no effect on Workers, which are not stored (`config/not-applied.ts`; ADR 0015's round trip
    through the stored document is replaced by this answer). The same admin guards as `PATCH /settings` apply
    (`403 service_tokens_require_service_admin`; no self lock-out, `422 would_remove_your_admin_access`); they read
    the stored config, and the import names the change counter of that read, so a write landing in between makes it
    `409 conflict` (send it again) instead of passing the guards on a stale config. A key whose secret a stored key
    of its family has keeps that key's id (a secret edited in the panel no longer matches its content hash), so
    re-importing a document keeps credential ids and auth indexes. Invalid YAML
    is `422 invalid_config` with `message`, `line` and `column` (a fixed sentence per error code, never the source; YAML
    parsed with the 1.2 core schema, custom tags, merge keys and a `%YAML 1.1` directive refused, anchors expanded); a
    config that does not decode is `422 invalid_config` with `path` when known, and so is a document that sets a
    deployment setting (`models.catalog`) in an org other than `global`. Because it replaces everything, every key in the
    document is typed and there is no stored key to protect: Go's first-wins deduplication of keys applies inside the
    imported document, and the reply cannot tell a typed key from a stored one (nothing stored is kept). The panel has no UI
    for it yet: it is for `curl` and scripts (MIGRATION.md).
  - `ManagementError` decodes the optional `message` and `path` of an error body, so the panel can show the reason
    and focus the field.
- **Also not ported** (only the upstream panel called these; all answer `404`): `server/latest-version`
  (GitHub release lookup), the file-log routes (`GET|DELETE /observability/logs`, `/observability/logs/errors/*`,
  `/observability/logs/requests/*`; Workers have no log files), `routing/model-definitions/:channel` (static catalogs;
  the panel reads `routing/models` and `credentials/models`), `GET /observability/usage/api-keys` (per-key counters;
  `GET /api-keys` carries them) and `GET /oauth/callback` (the local callback forwarder's target; `POST` is the panel's).
  The upstream panel's `X-CPA-Version` and `X-CPA-Support-Plugin` response headers are not sent either (deviation from Go).
- **Not here**: `/oauth/*` (`oauth-routes.ts`, see _Provider OAuth logins_), `/observability/usage/*` (`usage-routes.ts`, see
  "Usage accounting and observability"), plugins, Home, `/v0/management`, and (deviation from Go) `POST /requests/api-call`:
  Go substitutes a credential's token into a request to any host the caller names, for the upstream panel's browser-side
  quota and key probes; here those probes run server-side (`credentials/quota`, `api-keys/probe`), so the route is not
  ported and answers `404` (still behind the admin gate).
- **Control panel** (`web-panel.ts`, `web/`): `GET /`, the panel's page paths (`/accounts`, `/keys`, `/models`, `/usage`,
  `/settings` and their sub-paths; `access/routes.ts` `PANEL_SECTIONS`) and `/assets/*` (hashed bundle files) are in the
  management zone, so only Access admins get them. Every page path answers `public/index.html` (the browser router picks
  the page) with a strict CSP (own origin only; inline `style` attributes allowed for meter widths and chart sizes), `404` with a build
  hint when it is missing. The panel calls `/v8/management` on its own origin with no key; Access authenticates the calls.
  Its client is derived from `contract/` (Effect `HttpApi` groups for the endpoints it uses, imported by the worker tests
  and the browser as `#contract/*`; `test/management-contract.test.ts` decodes real responses through it). Deviation
  from Go: `/` was a public JSON banner there.
- **Panel theme** (`web/src/lib/theme.ts`, `web/src/theme-boot.ts`, `web/src/styles/tokens.css`): light and dark through
  semantic `light-dark()` tokens. The theme follows `prefers-color-scheme` until the operator picks Light or Dark in the
  shell's theme menu (kept in `localStorage` as `cf-llm-proxy.theme`). The CSP allows no inline script, so a Vite plugin
  builds `theme-boot.ts` into a hashed same-origin classic script (`/assets/theme-<hash>.js`) placed in `<head>`; it sets
  `data-theme`, `color-scheme` and the `theme-color` metas before the first paint, so a stored choice never flashes.
- **Panel pages** (`web/src/pages/`): Overview (`/`); Accounts (`/accounts`: every account ordered by urgency, filters
  All / Needs attention / Disabled, search, allowance meters, "Check all quotas" with the accounts whose check failed,
  and a Select mode: checkboxes, select-all of the shown rows, and a bar pinned to the window bottom that enables,
  disables, refreshes the tokens of or deletes (after a confirmation naming each account) the selected accounts the
  filter shows, through `POST /credentials/batch` in requests of 100 (20 for a refresh, which leaves out providers
  without one); failed and left-out accounts stay selected with their reason on the bar and on the row; the delete
  confirmation stays open until the deletion settles, then focus moves to the result; the Select toggle reads Done
  while selecting, and leaving returns focus to it; config accounts (OpenCode Go keys) carry a "Config key" mark,
  take part in "Check all quotas" and stay out of a selection); Account (`/accounts/$authIndex`: allowance with reset
  blades, cooldowns with clear, window history, the Routing section (`#routing`: priority, weight, retry rounds,
  cooling, Codex WebSocket preference, model prefix, exclusions, aliases, extra headers with secret values kept masked,
  note; only the fields that apply to the provider; one save of the changed fields with a change count, a leave guard
  and a `422` under the row it names; Models links an account's own rules here), details, served models, check quota, refresh
  tokens, enable/disable, delete; a config account keeps the allowance, quota check, cooldowns, history and models,
  and links its key group on the Keys page in place of routing, enable/disable and delete); Connect (`/accounts/connect`: OAuth sign-in by pasted callback address or device
  code, Vertex service-account import, auth-file upload); Usage (`/usage`: totals, tokens per hour or day, a breakdown
  by model, account, provider, user or endpoint whose rows narrow the page, and the request log with each request's
  details and failure body); API keys (`/keys`: every `api-keys` group by provider, each OpenAI-compatible endpoint
  its own section, keys by their last characters with state, recent requests, a connection test, clear cooldowns and
  enable/disable; `/keys/$family/$index` and `/keys/new?family=` edit or add one group: endpoint, keys typed in once,
  models with discovery through the probe, exclusions, delete; reads `GET /api-keys` and writes one group with
  `PUT /api-keys/groups` carrying the group's `id` and `revision`, existing keys by `auth_index`, everything the form
  does not show kept as stored; delete sends `id` and `revision` too; a `409` shows a Reload button and no automatic
  refetch, so the draft stays); Models (`/models`: every model clients can call, plus the hidden ones
  no account serves now, ordered by standing, filters All / Needs attention / Hidden, search over names, aliases and
  accounts, each model's routes with their account or key, upstream name, alias or exclusion and the rule's channel,
  cooldowns with clear; a catalog line under the title ("Catalog refreshed 2 h ago · from models.dev", "shipped copy" while
  nothing is stored, the host of a custom address) with a **Refresh catalog** button that calls `POST /models/catalog/refresh` and says the outcome inline
  (models added/removed, already up to date, the failure reason, "already running"); the button is off, with the reason, while
  the source is Embedded copy or Off; `/models/rules` edits the channel rules `oauth-model-alias` and `oauth-excluded-models`, one
  section per channel with a live count of the models a pattern matches; reads `GET /routing/models` and writes one
  channel's list with `PUT`/`DELETE /model-rules/aliases|exclusions/:channel` carrying the channel's revision from the
  view's `revisions` as `If-Match`; on `409` the edit is planned again once on a fresh read, and a second refusal or a
  changed entry offers a reload); Settings (`/settings`: the settings that apply on Workers in sections, Routing,
  Retries & cooldowns, Requests & streaming, Payload rules, Images & video, Providers, Model catalog (one source field), Admin access,
  Account refresh; one
  form per section whose draft is a delta of the touched fields (`web/src/lib/settings.ts`), saved with
  `PATCH /settings` carrying the `revisions` of the changed settings and only the changed leaves (`null` back to the default); inputs
  are checked and normalised as the server would (trimmed, admin emails lower-case) before sending; after a save the
  view refetches and the other sections' drafts rebase onto it, listing a changed field that moved on the server; on
  `409` the panel re-reads and re-applies the delta once, stopping with the list of fields that moved when it still does not
  apply, and a `422` lands under the field its `path` names (the message
  names the bad value; the hint says what is expected); other save outcomes show in the section's sticky save bar; the
  jump list counts each section's unsaved changes and leaving the page with any asks first (`useBlocker`); payload
  rules and account error rules are read-only there ("Set … by importing a Go config document (POST /settings/import)."; the import has no panel
  UI yet, see _Config entries_). There is no raw configuration editor (removed with its CodeMirror dependencies, ADR 0025).
  The Usage page keeps its range (24 hours, 7 days, 30 days), breakdown and filters in the
  address (`?range=&by=&model=&provider=&account=&user=&failed=`, decoded per parameter by `web/src/lib/usage.ts`
  `readUsageSearch`, a malformed one dropped), reads `GET /observability/usage/summary`, `/series` (provider series
  summed in the browser; no principal filter, so no chart while a user filter is set) and `/records` (pages of 50
  through the `next_before` cursor); every range starts at its first bar. The shell's Refresh bumps one epoch atom
  that every usage query reads, so they all refetch. Allowance figures (`web/src/lib/quota.ts`) come from the
  stored quota check when it is newer than the last response's rate-limit headers, otherwise from the headers. Window
  history (`web/src/lib/history.ts`) sums `GET /observability/usage/series` hourly points into the account's past quota
  windows, counted back from the current reset (approximate for windows the provider starts on first use), or into days
  for an account without windows. The Vertex import is multipart, so the panel posts a `FormData` itself and decodes the
  answer with `contract/oauth.ts` `VertexImported` / `VertexImportFailed`. Pure helpers in `web/src/lib/` are tested in
  workerd (`test/web-*.test.ts`, included by `tsconfig.worker.json`).
- **Legacy panel address** (`web-panel.ts` `LEGACY_PANEL_REDIRECT`, deviation from Go, which serves the upstream panel
  there): `GET|HEAD /management.html` (any case or percent-encoding) answers `302 Location: /` with
  `cache-control: no-store`. It stays in the management zone (`access/routes.ts` `LEGACY_PANEL_PATH`): `401`
  unauthenticated, `403` for non-admins, no CORS. The browser keeps the old `#/auth-files`-style fragment over the
  redirect, and the panel maps it on boot to the page that replaced it (`web/src/lib/legacy-hash.ts`: auth files and
  quota → `/accounts`, OAuth → `/accounts/connect`, providers → `/keys`, OAuth rule editors → `/models/rules`, config and
  system → `/settings`, the rest → `/`).
- Deviations from Go: `/` serves the control panel (admins only) instead of the public JSON banner; cooldown `reason`s are
  limited to the quota reason / last error code; `GET /credentials` always returns JSON timestamps as RFC 3339 strings;
  `POST /credentials/quota`, `POST /credentials/quota/all`, `POST /credentials/batch` and the entries' `quota_report`
  are Workers additions (see _Quota check_), as are `/credentials/reset-grants` and the entries' `reset_grants` (see
  _Claude reset grants_). The API keys,
  Settings (with the import) and model rule routes are Workers additions (secrets never in their responses and never read
  back; every write names the revision of the entry it changes and a stale one is `409`; values the normaliser would
  rewrite refused with `422` instead of silently changed). Go's whole-document `/config*` routes are not ported
  (_Config entries_ above). Config API keys can be toggled
  (Go answers the same through `excluded-models`); compat keys cannot, only their endpoint.

## Quota check (`src/quota/`, `src/management/quota-routes.ts`)

Workers addition with no Go counterpart: the upstream panel asks the provider usage endpoints itself, from the browser,
through Go's `POST /requests/api-call` (not ported). Here the server does it, so tokens never reach the browser and the
result is stored.

- **Flow** (`check.ts`): the ControlPlane resolves the account and its token (`quotaProbeTarget`: `ensureFresh`, then
  `target.ts`; the token Go's api-call substitutes for `$TOKEN$`, the Meta `dca_token`, the Devin session token; for a
  listed config API key, named by its `auth_index`, the key itself without a refresh). The
  **Worker** then calls the usage endpoint with its `HttpClient` (`probe.ts`, 15 s per call), so the single-writer
  object is never held by a slow provider. Finally the ControlPlane merges the outcome into the stored report
  (`recordQuotaReport`, `report.ts`).
- **Routes**:
  - `POST /v8/management/credentials/quota {name}` answers `200 {status: "ok", report}`, including when the upstream call
    failed; the report then carries `error`.
  - `name` is the listed name: an auth file name, or a listed config key's `auth_index` (a config credential id is
    never accepted, so a check confirms no guessed key).
  - `404` for an unknown account; `422 quota check is not supported for <provider>` for providers without a usage
    endpoint.
  - `POST /v8/management/credentials/quota/all` (the panel's "Check all quotas") runs the sweep below now and answers
    `200 {started_at, finished_at, results, checked, failed}` (`results`: `{name, ok, error?, message?, status?}` per
    account, `status` the provider's HTTP status so the panel can tell a refused sign-in); `409 quota_check_running`
    while another sweep holds the lease.
  - A single check whose account's tokens changed while the provider answered (`credentialVersion` changed: a
    re-login or a token refresh) answers `409 stale`: the outcome describes the old tokens and is dropped, like a refresh
    result for replaced tokens.
- **Sweep** (`sweepQuotas`): every enabled account of a supported provider (auth files, and the listed config keys
  without `*` in their `excluded-models`, named by `auth_index`), two accounts at a time. A Claude check
  opens up to three upstream connections at once (usage, profile, reset grants), so two checks stay within the six
  connections a Workers invocation may have waiting for response headers (more are queued, and could run into the
  15 s bound). An outcome for replaced tokens is dropped (`stale`), its reset grant status with it. One sweep at a time across isolates: it takes a lease in the
  ControlPlane first (`sweep-lease.ts`, one SQLite row, taken atomically under the input gate on the object's clock,
  given back with its token; a table from before `renewed_at` is recreated, it only holds a transient lease). Each
  recorded account renews it (`renewed_at`), and so does a background renewal every 30 s, since one account's check
  can outlast the lease (`ensureFresh` up to 120 s plus the 15 s probe); when a renewal finds the lease lost the sweep
  stops (`409 quota_check_lost` for the panel). A lease not renewed for 2 min counts as abandoned, so a long sweep
  keeps it while a Worker that died mid-sweep blocks the next one for at most 2 min. Taking the lease is the acquire
  step of `acquireUseRelease`, so it is given back however the sweep ends (failure, a cancelled request), and the
  invocation is held open with `waitUntil` until it has been. `waitUntil` only extends an invocation by about 30 s
  after the client disconnects; if the release has not run by then, the lease expiry covers the rest.
- **Cron**: the `refresh` sweep runs before `quota-check` (`runQuotaSweep`, the same sweep), so the check sees the
  fresh tokens; the quota check skips its run (`skipped: true`) while the panel's sweep holds the lease instead of
  asking every provider twice.
  - **Subrequests per run**: the lease and list RPCs, then per account two RPCs (`quotaProbeTarget`,
    `recordQuotaReport`) and its upstream calls: three for Claude (usage, profile, reset grants), two when the sweep
    skips the grant read (stored status under 6 h old, or under 24 h old when not eligible; cron and "Check all
    quotas" alike), one or two for the other providers. Token refreshes run in the ControlPlane, not in the
    invocation. On the Workers Free plan (50 external subrequests per invocation, 1,000 to Cloudflare services such
    as Durable Objects; Workers limits page, October 2026) a run covers about 16 Claude accounts when every grant read
    is due, 25 when none is; on Paid (10,000) the limit is out of reach. Redirects are never followed for Anthropic
    calls, so a redirect chain cannot add subrequests.
- **Report**:
  - `checked_at` is the last attempt and `refreshed_at` the last success.
  - `windows` and `plan` survive a failed check, and a success without a plan keeps the previous plan.
  - `error` is a fixed message plus the upstream status, never a response body.
- **Storage** (`store.ts`): a separate SQLite table `credential_quota_report` in the ControlPlane, one JSON row per
  credential. It is not part of the cooldown state (`credential_state`), so cooldown resets do not touch it. A row is deleted with its credential and when an upsert replaces an existing credential's token
  material (a re-login). A config key's credential id is content-addressed, so editing the key gives it a new id and a
  fresh report; the old row is dropped by the next sweep (`quotaCheckTargets` keeps only the rows of current
  credentials). `listCredentialEntries`/`refreshCredential` add it to the entry as `quota_report`.
- **Providers and window ids**:

| Executor key      | Endpoint                                                                                                            | Window ids                                                                                                                                                         |
| ----------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `claude`          | `GET api.anthropic.com/api/oauth/usage` (plus `/profile` for the plan and the reset grant read, failures tolerated) | the payload keys (`five_hour`, `seven_day`, `seven_day_opus`, …, unknown keys title-cased); dollar pools skipped; `limits[]` `weekly_scoped` → `seven_day_<model>` |
| `codex`           | `GET chatgpt.com/backend-api/wham/usage`                                                                            | `primary`, `secondary`, `code_review_*`, `<limit>_*`; labelled from `limit_window_seconds`; plan = `plan_type`                                                     |
| `antigravity`     | `POST …/v1internal:retrieveUserQuotaSummary` (three hosts in order)                                                 | `bucketId`, labelled "Group · bucket", `used = 1 - remainingFraction`                                                                                              |
| `kimi`, `kimi-ai` | `GET api.kimi.com` / `api.kimi.ai` `/coding/v1/usages` (only these two hosts)                                       | `limits[]` by length (`five_hour`, …, else `limit_<n>`), `weekly` (summary), `monthly`                                                                             |
| `xai`             | `GET cli-chat-proxy.grok.com/v1/billing` (`?format=credits` for weekly)                                             | `weekly`, `monthly`                                                                                                                                                |
| `meta`            | `POST api.meta.ai/muse-code/key` with the `dca_token`                                                               | `window`, `weekly`                                                                                                                                                 |
| `devin`           | `GetUserStatus` (the `devin-user-status` call)                                                                      | `daily`, `weekly` (`used = 100 - remaining`)                                                                                                                       |
| `opencode-go`     | `GET {base}/usage` (default `opencode.ai/zen/go/v1/usage`, `Authorization: Bearer <config key>`, no redirects)      | `rolling` → `five_hour` ("5-hour"), `weekly`, `monthly` (`percent` used; a status other than `ok` reads as used up)                                                |

- **Differences from the upstream panel**:
  - xAI never makes its paid-account fallback (`/v1/me` plus a real chat completion). Its billing calls send the
    executor's Grok CLI version (KV `xai/client-version`, fallback `1.0.46`) instead of a pinned one: the chat proxy
    answers 426 to versions below 1.0.13, billing included. The billing payload is protobuf JSON, which omits zero
    values: a weekly period without `creditUsagePercent` reads as 0% used, and a `monthlyLimit` of 0 (no included
    allowance) gives no monthly window.
  - The Codex subscription and reset-credit calls and the Antigravity tier call are skipped.
  - Windows without a percentage are dropped (`used_percent` is required).
  - Labels are English and fixed.

## Claude reset grants (`src/quota/reset-grant*.ts`, `src/management/reset-grant-routes.ts`)

Workers addition with no Go counterpart (Go has no reset grant code; the upstream panel makes these calls from the
browser through `POST /requests/api-call`, not ported). A reset grant is Anthropic's `cedar_ember` program: a bundle of
resets, each of which empties the usage windows it `clears` (`five_hour`, `seven_day`, …). Upstream panel sources:
`services/api/claudeResetGrants.ts`, `features/quota/providers/claude/{selectResetGrant,resetGrantOperations}.ts`.

- **Upstream calls** (fixed host `api.anthropic.com`, Claude CLI headers and the account's OAuth bearer, from the Worker
  like the quota check): status `GET /api/oauth/usage?cedar_ember=1&skip_spend=1` (its `cedar_ember` block; 12 s),
  organization `GET /api/oauth/profile` (`organization.uuid`; 12 s), claim
  `POST /api/organizations/{uuid}/reset_rate_limits {program: "cedar_ember", grant_id, request_id}` (25 s).
- **Status** (`reset-grants.ts`): parsed fail-closed like the panel (one malformed grant, a duplicate id or a bad
  timestamp rejects the block; missing `usable_now` reads false, missing `use_requires_limit` true; labels stripped of
  control characters). `claimable` is `next_grant_id` when usable, else the lowest usable id; otherwise `blocked_by`
  says why (`ineligible`, `cooldown`, `none_left`, `unusable`, `not_limited`). The quota check reads it as a third,
  tolerated Claude call (one more subrequest per Claude account per check; the cron sweep skips it while the stored
  status is under 6 h old, or under 24 h old when it says not eligible, so new grants are eventually noticed); `GET /v8/management/credentials/reset-grants?auth_index=` reads it now.
  A status is dated by when its read started. The last good status is stored (SQLite table `credential_reset_grants`,
  `reset-grant-store.ts`) and listed as the entry's `reset_grants`; an older read never overwrites a newer one.
- **Stale reads** (`reset-grant-store.ts`): each row keeps two counters that are never reset, a `generation` bumped
  when a re-login replaces the tokens or the credential is removed (so re-creating the same name starts a new one) and
  a `claim_seq` bumped at every claim start and answer. The ControlPlane hands out the credential's `generation` and
  the sum of every row's `claim_seq` with the token (`resetGrantTarget`, `quotaProbeTarget`), so a claim of another
  auth file of the same organization also outdates a read, even once its journal is gone; a status read under an older pair is not stored, a read whose credential
  was replaced answers `409`, and a fresh claim decided on it is refused with `409` ("check resets and try again"),
  since the read may predate a reset another claim spent. Counters instead of timestamps: only the ControlPlane's own
  values are compared, never the clocks of the Worker and the Durable Object.
- **Claim** (`POST /v8/management/credentials/reset-grants/claim {auth_index}`, `reset-grant-flow.ts`): refused with
  `409` on a disabled account (reads stay allowed); re-reads the status (`502` when it cannot; nothing is sent), answers `outcome: "none_available"` without a request when nothing is
  claimable, reads the organization (`502` when it cannot), then sends the claim. Anthropic's `result` is the
  `outcome`; `429` is `rate_limited`, `401`/`403` `auth_error`; any other status or body, a timeout or a transport
  error is `unknown` (a reset may have been spent; "HTTP 200 alone is not a reset"); so is a `3xx`, since Anthropic
  calls never follow redirects (`redirect: "manual"`; a redirected status read is a failed read). Only `reset` (or
  `already_used` on a resend) counts as spent: the proxy then clears the account's cooldowns (as
  `POST /routing/cooldown/reset`) and checks its quota again. When the answer cannot be recorded in the ControlPlane
  the `outcome` is still returned, with a `warning`.
- **Double spends**: the claim journal lives in the ControlPlane (single writer, so serialized across tabs and admins):
  a claim in flight answers `409` to a second one for 60 s; an `unknown` claim stays open for 10 minutes and the next
  claim resends it with the same grant and `request_id`, naming the request it saw (`409` when another claim replaced
  it). The resend reads the status first (a failing read does not block it): when the grant's `resets_left` dropped
  below the count the claim was decided on, or a `cooldown_until` runs from after the claim started, the claim is
  answered without sending, as spent (claim closed, cooldowns cleared) only when that read also shows
  `at_limit: false`, else with `outcome: "not_confirmed"` (nothing cleared; "check resets before trying again"; the
  claim stays open and the next resend sends the same `request_id`). One claim per Anthropic
  organization runs or stays open at a time across every auth file of it: a claim in flight or open in another file
  of the same organization (two files of one account, or a re-login into it) answers `409`, which names the case of
  a removed file's claim (it frees itself within 10 minutes). A resend for another organization
  (the account was replaced) is refused with `409`, and a refusal of a resend keeps the claim open, since it cannot
  prove the first request did not spend (panel rules). `pending_claim.in_flight` says a request of the open claim is
  running (the panel offers no resend then); a resend whose claim another tab answered meanwhile gets its own `409`.
  The journal and the stored status are dropped with the credential and when a re-login replaces its tokens, except a
  journal in flight: its answer is still recorded and it keeps holding its organization.
- **Assumptions** (no Anthropic documentation exists for these endpoints; taken from the upstream panel and the
  Claude Code client, not verified against Anthropic): the `request_id` is an idempotency key, so a resend with it
  does not spend a second reset; `already_used` answering a resend means the first request spent the reset; a reset
  is the only thing that lowers a grant's `resets_left` or starts a `cooldown_until`; `skip_spend=1` makes the status
  read free of side effects; the Claude CLI headers (`CLAUDE_HEADERS`) are required. Clearing the proxy's cooldowns
  after a reset follows the Go maintainers' advice in issue #6507, not upstream code.
- **Differences from the upstream panel**: the journal is server-side and shared instead of per tab, with the in-flight
  lease; an open claim past its 10 minutes is dropped and the next claim starts fresh (the panel blocks the tab until
  reload); cooldowns are cleared after a reset (the panel leaves them); `percent_used` is not kept; window ids beyond
  the panel's three are kept when they look like ids. The weekly `juniper_tide` program is not handled (nor by the
  panel).

## Usage accounting and observability (`src/usage/`, `src/observability/`, `src/management/usage-routes.ts`)

Port of `sdk/cliproxy/usage` (token accounting v2), `helps/usage_helpers.go` (parsers, `StreamUsageBuffer`, TTFT) and the
`internal/redisqueue` export shape. One `UsageRecord` per upstream attempt (`UsageReporter` per attempt, `finish` exactly
once; a 401 retry keeps the rejected attempt's failed record, a failed-over credential gets its own).

- **Accounting v2** (`accounting.ts`): `TokenBreakdown` (`input = uncached + cacheRead + cacheWrite`, `output =
  nonReasoning + reasoning`, `total = input + output + unclassified`, quality `complete|unclassified|inconsistent`).
  `ensureTokenBreakdown(detail, provider, executorType)` picks the semantics: **subset** (openai, codex, xai, grok, kimi,
  qwen, deepseek, openrouter, `openai-compatible-*`; cache inside input, reasoning inside output), **independent**
  (claude/anthropic; cache outside `input_tokens`, thinking inside `output_tokens`), **separate-reasoning** (gemini,
  aistudio, antigravity, vertex, interactions; `candidatesTokenCount` excludes thoughts), otherwise unclassified. Parsers
  attach the protocol's own breakdown (`record.ts` OpenAI/Responses/Codex, `parsers.ts` Claude, Gemini, Interactions,
  Antigravity + `mergeStreamUsageDetail`); `UsageReporter.finish` guarantees a valid breakdown on every record.
  Executors feed the reporter with `publish` (latest wins, tier-only updates keep the token detail, an earlier response
  tier survives) or `publishMerged` (Claude/Interactions events that complement each other). Go's int64 overflow checks
  become safe-integer checks. Executors must use these parsers: a hand-rolled `UsageDetail` without a breakdown is
  re-derived from the raw buckets, which is wrong for Claude (reasoning inside output).
- **TTFT** (`ttft.ts` + reporter): `markFirstByte` (non-stream: effective TTFT), `recordFirstPacket` /
  `observeTokenEvent(now, isToken)` (streams: first substantive token event, first packet as fallback). Codex streams use
  `isResponsesTokenEvent`; OpenAI-compatible and Claude executors still mark the first response byte (hook the matching
  `is*TokenEvent` into their stream loops to refine it).
- **Persistence** (`d1.ts`, `d1-sink.ts`, `migrations/0001_usage_records.sql`): table `usage_records` (primary key =
  attempt `request_id`, `trace_id` = inbound request id, raw token columns plus the `acct_*` breakdown columns,
  `exported_at` for the queue; `migrations/0002_usage_sessions.sql` adds `session_id`, `parent_session_id` and `base_url`: the
  explicit, derived (`derived:ctx:v1:...`) or LCP (`lcp:v1:...`) session identity of the attempt - the LCP one comes back
  from `pick` - and the credential's configured upstream base URL; the queue export projects the session ids to canonical
  UUIDs like Go's `NormalizeToCanonicalUUID`, the parent only when it differs). `migrations/0003_usage_org.sql` adds
  `org_id` (`NOT NULL DEFAULT 'global'`, so records from before orgs are `global`'s) with `(org_id, requested_at)`
  indexes: the writer stores the request's `CurrentOrg`, and every listing, summary, series, export and queue query
  filters on it. `D1UsageSink` (default in `makeProxyRoutes`) inserts through `ctx.waitUntil` (awaits when
  `waitUntil` throws), logs failures with request id and message only and never fails the request. The sink reads
  `WorkerEnv`/`WorkerExecutionContext` from the fiber context at publish time (not part of its type, so the conductor's
  attempt plumbing is unchanged). `migrations/` is applied by Alchemy on every deploy
  (`D1.Database` `migrations` in `alchemy.run.ts`). Failure bodies are truncated to 2 KiB.
- **Retention** (`retention.ts`, cron task `usage-retention`): deletes records older than `USAGE_RETENTION_DAYS` (default
  30, `0` = keep) in bounded batches, across every org (a deployment-wide cron task). `usage-statistics-enabled` and `redis-usage-queue-retention-seconds` are not used:
  persistence is always on when the `USAGE` binding exists.
- **Management** (`management/usage-routes.ts`): `GET /v8/management/observability/usage/queue?count=N` (atomically pops the oldest unexported records, Go queue JSON with
  `token_breakdown`; `api_key` = Access principal id, `auth_index` = the management (keyed) `auth_index`) and the Workers
  additions `.../records` (filters `since|until|provider|model|principal|auth_index|failed`, `limit`, keyset `before`) and
  `.../summary` (`group_by=model|provider|principal|auth|endpoint|day`, totals per v2 bucket, avg latency/TTFT) and
  `.../series` (not in Go; the panel's per-account quota-window bars: `since` required, `until` default now, `bucket=hour|day`
  UTC, `group_by=auth|model|provider`, filters `provider|model|auth_index`; per key the points `{start, requests, failed,
  total_tokens}` (`acct_total_tokens`) of buckets with requests, one aggregate query; hour ranges are capped at 31 days and
  day ranges at 400, else 400). Credentials appear as their keyed `auth_index` only: `group_by=auth` keys are mapped
  from the stored `auth_id` on read (series re-sorted by index), and the `auth_index` filter (case-insensitive) is
  resolved by the ControlPlane to the live credential's id (`credentialIdOfAuthIndex`, no D1 read); only an index of
  no live credential (deleted, or matching nothing) reads the distinct `auth_id`s of the filtered rows
  (`resolveAuthIds`, an index scan bounded by the retained records). The former `auth_id`
  filter answers 400 instead of being ignored.
- **Trace and logs** (`observability/`): the global `TraceLayer` middleware gives each request a `RequestTrace` (Context
  reference, `undefined` outside the router) and sets `X-CPA-TRACE-ID` = the request id (a random UUID, also the usage
  records' `trace_id`). Deviation from Go: Go sends `yyyyMMddHHmmss-<auth index>-<request id>` to every API client (none
  when no credential was selected); its unsalted index would let any client confirm key guesses, and even a keyed one
  tells a client which credential served it. Nothing here or in the Go panel parses the header; admins join a response
  to its credential through the usage record (`trace_id` → `auth_index`) or the log line. `/healthz` is exempt. One structured log line per request
  (`method`, pathname without query, `status`, `latencyMs`, `principal`, `provider`, `model`, `authIndex`, `attempts`,
  `requestId`; `authIndex` is the keyed index) through Effect logging; `WorkersLoggerLayer` (`Logger.consoleStructured`) makes Workers Logs index the
  annotations. Headers, bodies, query strings and credentials are never logged. `principal` is the Access id (`user:<email>`),
  i.e. personal data, documented in ACCESS.md "Logs and personal data" (not hashed so operators can attribute usage). Failure
  logs of cron jobs and management handlers use `observability/cause.ts` (`causeSummary`: tag + message, URL queries removed,
  no stack) instead of `Cause.pretty`.

## Kimi, Meta and Devin providers (`src/executor/{kimi,meta,devin}/`)

Ported from `kimi_executor.go`/`kimi_thinking_replay.go`, `meta_executor*.go`, `devin_executor.go` and the `helps/devin_*`
helpers; `oauth_scope_executor.go` is `executor/helps/oauth-scope.ts`.

- **Kimi** routes by the client protocol: Claude -> the embedded Claude executor (`makeClaudeExecutor({ profile })`, see
  `claude/profile.ts`: Kimi model naming incl. `[1m]`/K2.x aliases, the response model restored to the requested one, the
  Claude Code attribution system block stripped unless the CLI fingerprint profile is on, `count_tokens` always upstream, base
  URL = the Messages base `.../coding`); OpenAI Responses -> `{base}/v1/responses` (body kept, `NormalizeKimiResponsesInput`,
  tool schemas, temperature); everything else -> `{base}/v1/chat/completions` (`normalizeKimiToolMessageLinks`, tool schema
  inlining via `helps/inline-refs.ts`, temperature rule, `stream_options.include_usage`). Device headers: the login-time
  `metadata.device_id` (persisted in the ControlPlane with the credential) else a UUIDv5 of the credential id; device
  name/model are constants. Thinking replay for Claude callers (`kimi/replay.ts`) reuses the matcher/accumulator of
  `claude/thinking-replay.ts` over the `SessionState` DO (own store name, TTL 1 h, isolated per caller scope).
- **Meta** is the Codex Responses pipeline without replay/images: `meta/request.ts` (translate to `codex`, thinking, model/stream,
  field deletions, instructions, keep-foreign reasoning sanitising via `codex/request.ts`, `search_content_types` removal,
  payload rules with protocol `meta`), `meta/errors.ts` (`resets_at` retry, 5 min 404 cooldown, credential-scoped
  subscription quota), always-streaming upstream aggregated for non-stream callers. The shaping and the SSE response handling
  live in `helps/responses-request.ts` / `helps/responses-sse.ts`, shared with the OpenCode `responses` protocol. The lazy DCA -> API-key mint is the
  conductor's `ensureFresh` (see Token refresh); the executor only reads the minted key.
- **Devin** (`devin/`): `protobuf.ts` (varint/bytes/fixed codec), `wire.ts` (`GetChatMessageRequest`, frame decoding, trailer
  mapping, system prompt sanitising), `connect.ts` (streaming 5-byte frame parser, gzip via `DecompressionStream`),
  `interactions.ts` (client Interactions body -> prompts/tools, incl. original-request supplements), `models.ts` (UID
  resolution over the embedded/registry catalog), `payload.ts` (payload rules run on the JSON view of the protobuf business
  fields and only those fields are re-encoded), `stream.ts` (frames -> Interactions events / aggregate, tool-call ordering,
  deferred thought stops, 128 tool call cap, EOS trailer required) and `executor.ts`. Non-Interactions clients need the
  `client -> interactions` translators registered in the translator registry (`gemini` and `interactions` exist; `openai`/
  `openai-response` belong to the OpenAI-compatibility slice; `claude -> interactions` is what Claude Code needs to use Devin, see
  _Claude clients on Interactions providers_); without one the body is parsed as-is (`messages` fallback) and the response
  passes through untranslated.
- **Fixtures**: `go run ./tools/fixturegen/devin` runs the real Go `DevinExecutor` against an `httptest` Connect-RPC
  server (request bytes, Interactions events, aggregates, trailer/model-UID/frame/system-prompt helpers) into
  `test/fixtures/devin.json`; `test/devin-*.test.ts` compare the TypeScript output with it.
- **API-key scoping**: `withApiKeyScope` (registry) gives API-key credentials the config without `oauth.providers.*`
  (Codex, Claude, Meta, Kimi, xAI, OpenAI-compatible; not Devin). Settings imported from aliased `upstream.*` spellings lose their
  OAuth-only origin and stay global (the Go `OAuthOnlyFields` provenance is not kept).

Deviations from Go: Devin's per-session turn counter is an atomic `incr` in the `SessionState` DO (TTL 24 h, per caller scope, not an
LRU of 5000); `fetch` always sends a
User-Agent (native devin-cli sends none; the executor sets it empty); missing Devin credentials answer 401 instead of a plain
error. Kimi `/responses` and Meta bridge the Codex `apply_patch` tool through the strict function (see the xAI section for the shared
state). Executor-level apply_patch guards (`helps/apply-patch-stream.ts`, Go `EndApplyPatchStream` & co): a failing non-stream request
of a client that declares the custom `apply_patch` tool, and a non-stream call of that tool whose arguments never became valid JSON, answer
the sanitised 502; a patch-enabled Responses stream that ends without its terminator (EOF, read error, trailer error) emits the translator's one
`response.failed` frame (`state.finalizeToolInput` of the Interactions -> Responses translator) and fails with the same 502 instead of the
generic abort events. `GetUserStatus` quota/profile refresh is the cron task `devin-user-status` (`credentials/devin-status.ts`,
`ControlPlane.refreshDevinStatus`): per stored credential it writes email/user/team/plan/org into the auth file, `quota.signals`
(`daily|weekly_quota_remaining_percent`, `*_reset_at`, `plan`, `plan_start|end`) and `last_refresh`; failures leave the credential untouched.
Devin's models are catalog additions (`devin/<id>` records, no source to fetch); the executor now resolves effort variants and max tokens through
the registry snapshot (`modelLookup`, ids `devin/<id>`) before the embedded catalog. Not ported: the Kimi
`X-Msh-Device-Name/Model` of the real host, request/response debug logs, the developer-only `cmd/fetch_devin_models` live catalog probe.

## OpenCode Zen and OpenCode Go (`src/executor/opencode/`, `src/registry/opencode-*.ts`)

No Go counterpart: CLIProxyAPI reaches OpenCode only through an `openai-compatibility` entry (chat only). The Workers port has two
API-key providers, `opencode-zen` (`https://opencode.ai/zen/v1`) and `opencode-go` (`https://opencode.ai/zen/go/v1`), configured
under `api-keys.opencode-zen` / `api-keys.opencode-go` (same group/key shape as the other API-key families; `models[].protocol`
is `chat`, `responses`, `messages` or `gemini`). One executor (`executor.ts`) serves both keys. `models[].protocol` decodes as
any string: the normaliser drops it in every other provider section (a stray value never breaks a document), and
`decodeRawConfig` rejects an unknown value in the OpenCode sections, naming its path. The panel's OpenCode model rows offer it as a
select ("Auto (catalog)" when unset).

- **Protocol per model** (`protocol.ts`): the `protocol` of the credential's config model entry (key `models`, else group
  `models`; the key is found by `config_index` and checked against its secret), else the model's AI SDK package in the OpenCode
  catalog, mapped as OpenCode's own client does (`@ai-sdk/openai` -> `responses`, `@ai-sdk/anthropic` -> `messages`,
  `@ai-sdk/google` -> `gemini`, `@ai-sdk/openai-compatible`/`@ai-sdk/mistral` -> `chat`), else `chat` with a logged warning (unknown
  model or package). Gemini exists only on Zen; on Go a Gemini protocol falls back to chat.
- **Paths**: `chat` -> `{base}/chat/completions` (`chat.ts`: openai-compat shaping, max-token normalisation from the entry's
  `use-max-completion-tokens`, `stream_options.include_usage`, `OpenAICompatStreamReader`); `responses` -> `{base}/responses`, always
  streamed upstream and aggregated for non-stream callers (the Responses shaping and SSE handling shared with Meta:
  `helps/responses-request.ts`, `helps/responses-sse.ts`, incl. the apply_patch bridge); `messages` -> `{base}/messages`
  (`messages.ts`: translate to Claude, non-Claude non-stream clients read a streamed answer that is validated and translated in one
  piece, `ClaudeStreamReader`); `gemini` -> `{base}/models/{model}:generateContent|streamGenerateContent` (`gemini.ts`: the shared
  Google engine as an API-key Gemini variant). Thinking and payload rules run as everywhere (payload rules last; protocol
  `openai`, `openai-response`, `claude` or the Gemini engine's). Token counting is local for every protocol (Gemini bodies are counted
  as chat). Images/video/speech entry formats and `/responses/compact` answer 501.
- **Headers** (`headers.ts`): each protocol's native auth (`Authorization: Bearer` for chat/Responses, `x-api-key` +
  `anthropic-version: 2023-06-01` for Messages, `x-goog-api-key` for Gemini); `User-Agent: cf-llm-proxy`,
  `x-opencode-client: cf-llm-proxy`; `x-opencode-session` = the client's own `x-opencode-session` unchanged, else a UUIDv5
  (`providerSessionUuid("opencode", …)`) of the explicit session identity, the WebSocket execution session or the derived
  conversation identity (stable across turns, distinct across conversations), else a random UUID (OpenCode Go answers 400
  `MissingSessionID` without the header). Another client's raw session id is never forwarded. Custom headers apply last and win.
  Client `anthropic-beta` headers are not forwarded. On the Messages protocol a client's `metadata.user_id` (Claude Code's device,
  account and session ids) is replaced by a stable UUIDv5 of it before the payload rules, so no raw client identity reaches the
  gateway.
- **Errors** (`errors.ts`): `ModelProtocolUnsupported`, "Model is unavailable", "Model access is disabled" (Zen workspace
  setting) and `FreeTierError` (Zen free models outside OpenCode) concern one model: they become `code: model_not_found` with a
  cooldown hint (5 min for the protocol mismatch, 30 min otherwise), so the conductor cools only that model of the credential and
  tries the next credential. 401 (bad key) and 402 (no balance) are credential-scoped (the conductor skips the rest of an alias
  pool; the cooldown itself is the model-level hard cooldown of a 401/402); a Go 429 (subscription limit) is credential-scoped, a
  Zen 429 stays model-level; `Retry-After` (seconds or an HTTP date) is honoured on 429 and 5xx. Gemini engine errors are
  re-classified with the same rules, before the stream and mid-stream.
- **Usage limits** (`usage-limit.ts`, OpenCode Go): over a subscription window the gateway answers `429` with
  `Retry-After: <seconds to the reset>` and `{"error":{"type":"GoUsageLimitError","message":"5-hour usage limit reached.
  Resets in 2hr 13min. …"},"metadata":{"limitName":"5 hour"}}` (opencode console handler, last public before the
  inference gateway went closed source; "Weekly"/"Monthly" likewise). Only OpenCode Go answers are classified, and
  narrowly: the `GoUsageLimitError` type on any status, or a message that starts with "5-hour"/"Weekly"/"Monthly usage
  limit reached" on a `402`, `403` or `429` (a message merely containing the phrase, such as a `400` echoing the
  prompt, is not a limit). On a stream it applies to the error event too. It is checked before the rules above and
  becomes a credential-scoped `429` whose cooldown is the longer of `Retry-After` and the "Resets in …" duration ("2hr
  13min", "3 days", "45min", "2h 13m"; read up to the sentence's end or "To continue"), else 30 min, and at most 32
  days (a bogus header cannot park a key for longer than a monthly window): the whole key is cooled (`credential_quota`) until the window resets, so the next request goes to another key or the fallback
  without asking the gateway again. No usage fetch on the request path; the quota check reads the windows.
- **Quota** (`src/quota/opencode-go.ts`): OpenCode Go keys are listed on the Accounts page as config accounts with the
  5-hour, weekly and monthly windows of `GET {base}/usage` (see _Quota check_ and _Management API_ "Credentials").
  OpenCode Zen has no usage endpoint.
- **Key test** (`management/api-keys-probe.ts`): the gateways list models without authentication, so the panel's key test
  POSTs `{base}/chat/completions` with the key, the gateway headers and the model `cf-llm-proxy-key-check` (`max_tokens: 1`); any
  2xx or 400 ("Model is unavailable": the key was accepted, nothing is billed) passes, 401 and other statuses fail.
- **Catalog** (`opencode-catalog.ts`): the gateways read the same models.dev document as every other provider (`opencode` and
  `opencode-go`, ADR 0020), bundled in `catalog/models-dev.json` and refreshed into KV by the one `model-catalog-refresh` task
  (see _Model registry_, "Catalogs"); there is no separate OpenCode catalog task, file or script any more. The request path
  reads the KV copy (per isolate, re-read at most once a minute) and falls back to the bundled snapshot when KV is empty or
  invalid. Without config `models` a gateway registers every non-deprecated catalog model (Zen without its free models,
  flagged `free` in the trimmed document, which the gateway rejects outside OpenCode); listed models get the catalog's
  context/output limits, input modalities, reasoning levels and the protocol's registry type.

Deviations (the whole provider is one): the session header is derived per conversation instead of OpenCode's per-chat id; the
`openai-compatibility` executor is not reused (its settings come from the compat group of the credential and its User-Agent is
fixed); no `prompt_cache_key` is derived; model-scoped gateway errors use the model-not-found cooldown instead of a plain client
error; `X-Opencode-Session` from a client is also an explicit session identity for routing and usage (`handlers/session.ts`); the
OpenCode Go keys are listed as Accounts (config-sourced) for their usage windows. Not ported/added: the `jev`/systemone
endpoint.

## SessionState Durable Object (`src/session-state/`)

Replaces the per-process maps of `internal/cache` (and the Home KV): `SESSION_STATE.getByName(<store>:<sha256(scope, session)[:32]>)`
is one instance per store, caller scope and session key (session keys are caller-isolated by their store, either by hashing the
Access `callerScope` into the key (Codex, xAI, Kimi, Antigravity), by prefixing it (Claude) or through the `scope` address part
(Gemini cache, Devin counter)); the instance holds a handful of `key -> string` entries in SQLite. The store name is
org-scoped (`orgScopedName`: unchanged for `global`, so live sessions survive the upgrade), and so are caller scopes, so
two orgs never share an instance.

- **Protocol** (`protocol.ts`, DO method `run(ops, now)`): ops `get` (optional sliding `extendTtlMs`), `put` (TTL, `ifGeneration`,
  `maxEntries`), `delete` (`ifGeneration`) and `incr` (atomic counter), executed in order in one `transactionSync`; results are
  `ok {generation, value?}`, `conflict {generation, value?}` (the current state, so a retry needs no read) or `rejected`. Generation
  `0` is "absent"; generations are `max(last + 1, now)`, so they are never reused, not even after an empty instance deleted
  itself (no ABA on stale tokens). The clock is the _caller's_ Effect `Clock`, which is what makes TTL tests deterministic
  (`TestClock`; start it at the real time so the alarm of the Durable Object is not armed in the past).
- **Engine** (`engine.ts`) is synchronous over a `StateTable`: `SqliteStateTable` in the DO (values chunked into 256 Ki-unit rows
  because a SQLite row is limited to 2 MiB while the Go caches allow 16 MiB per entry) and `MemoryStateTable` for the in-process
  backend and unit tests. Expiry is lazy (an expired entry reads as absent) plus an alarm armed at the earliest expiry that
  deletes expired entries and, when nothing is left, the whole instance storage (`deleteAll`, tables re-created). Bounds: TTL
  clamp 1 s .. 7 d, value <= 20 Mi units, `maxEntries` per instance (oldest writes evicted, expired purged first).
- **Client** (`client.ts`): `SessionStateBackend.run(address, ops)`; `durableObjectBackend` (per-request stubs from `WorkerEnv`,
  never captured), `makeMemoryBackend(now?)` (bounded to 10240 instances) and `resolveBackend()` = the DO when `WorkerEnv`
  binds `SESSION_STATE`, else the per-isolate memory backend (unit tests, local runs without the binding).
  `updateEntry` is the compare-and-swap read-modify-write loop (`known`/`slideTtl` options save the initial read).
  Every store treats a backend failure as a cache miss (`bestEffort`, logged): a request never fails because of replay state.
- **Stores** keep their interfaces; `makeInMemory*`/`makeMemory*` constructors are the same code over a memory backend (so tests
  and production share one implementation): `codex/replay.ts` (store `codex-replay`; read = 1 RPC, append = get + CAS put),
  `xai/replay.ts`, `claude/thinking-replay.ts` (the generation is the snapshot of `replaceIfUnchanged`/`deleteIfUnchanged`; Kimi
  uses it with its own store name), `claude/continuity.ts`, `devin/credentials.ts` (`incr`, one RPC per turn),
  `gemini/replay.ts` (batched prefetch/flush), `antigravity/replay/ledger.ts` and `gemini/antigravity-interactions.ts`.
  The Claude thinking replay and continuity interfaces became Effect-returning (they were synchronous).
- **Antigravity reasoning replay** (`executor/antigravity/replay/`, Go `antigravity_reasoning_replay.go` +
  `cache/antigravity_reasoning_replay_cache.go`): `scope.ts` (session key: Claude Code scope + system lane, `Session-Id`,
  body `session_id`, `prompt_cache_key`, derived id, else the stable id of the first user turn), `request-index.ts` (request
  index, context fingerprints, ledger items of the history), `apply.ts` (eligibility, locating parts by call id / opaque Claude id /
  context / occurrence, restoring native calls and signatures, inserting missing model calls), `provenance.ts` (degrading unresolved
  reserved ids to `call_<hash>`, signing first calls, `ValidateGeminiFunctionCallPairing`), `accumulator.ts` (turns the response
  into items; committed only after a finish reason, before `response.completed` for Responses clients, otherwise before the EOF
  completion), `ledger.ts` (normalisation, 1 h sliding TTL, snapshot-guarded replace/delete with _tombstones_, so a writer that read
  an older state cannot publish over a delete), `prepare.ts` (`prepareAntigravityGeminiReasoningReplayPayload`: replay, role
  normalisation, degrade, repair, pairing check; a replay that breaks pairing is dropped and the entry invalidated; an upstream 400
  mentioning a signature clears the entry). Only Gemini-family models use it; the replay runs after the credits flag and before the
  boundary turns and the envelope.
- **Interactions continuation** (`gemini/antigravity-interactions.ts`, Go `PrepareAntigravityInteractions`): for models starting
  with `antigravity` on the native Interactions path, a completed `requires_action` interaction is stored under the conversation
  key (caller, credential, endpoint, model, session identity or hash of the input up to the last user turn) and the sorted
  pending call ids (hashed, NULs are not valid SQLite keys), TTL 30 min from the write, 1024 entries per conversation; the next
  request with only matching `function_result` steps gets `previous_interaction_id` (and `environment_id`) and just those steps.
- **Not moved (by design)**: the Responses WebSocket tool caches and xAI WebSocket id state stay in the invocation that owns the
  socket (a live socket pins its isolate; Go loses them on restart too), see "Responses WebSocket transports".
- **Deviations from Go**: the global entry caps (10240 / 4096 / 1024 entries) are per-instance bounds plus the TTL sweep (an
  unbounded number of sessions costs storage only until they expire); Codex replay session keys are caller-isolated (Go isolates
  Claude/Kimi/xAI only); Antigravity replay sessions are caller-isolated too and have no execution-session metadata key; only the
  sequential replay application of Go is ported (its batched splice path is an optimisation that "retains the exact legacy
  behavior"), and context fingerprints are self-consistent hashes (not byte-identical with Go's); the Gemini cache is per caller
  instead of global; a miss no longer reserves a tombstone (the generation of the absent entry fences concurrent writers).

## Local token counting (`src/tokenizer/`, `src/executor/helps/token-count.ts`)

Port of the `tiktoken-go/tokenizer` usage in `helps/token_helpers.go`, `codex_executor_tokens.go` (also Meta),
`xai_executor_tokens.go`, `helps/claude_input_tokens.go` and `claude_executor_tokens.go` (gateway estimate). It replaces the
501 answers of `countTokens` for Codex, xAI, Meta and OpenAI-compatibility providers and the heuristic Claude estimate.

- **Tokenizer** (`bpe.ts`, `encodings.ts`): no npm dependency. `BpeCodec.count` is the Go `codec.Codec.Count` algorithm: the
  encoding's pre-tokenisation regex (translated to JavaScript), a whole-piece vocabulary hit counts one token, otherwise the
  piece is merged from bytes by lowest rank (leftmost wins ties); pieces over 192 bytes use an equivalent O(n log n) heap merge
  (Go's loop is quadratic). Special tokens are plain text, like Go. Encodings: `o200k_base` and `cl100k_base`; model mapping
  `encodingForModel` (`TokenizerForModel`: empty/gpt-4/gpt-3 -> cl100k, everything else o200k) and `encodingForCodexModel`
  (gpt-5/4.1/4o -> o200k, otherwise cl100k).
- **Ranks** are `src/tokenizer/ranks/{o200k_base,cl100k_base}.bin` (`count:u32le`, then `len:u8,bytes` per token in rank order,
  1.6 MB + 0.7 MB), generated from the Go vocabularies by `go run ./tools/fixturegen/tokens`. They are Workers `Data`
  modules (Alchemy's bundler rule for `*.bin`; `modulesRules` in `vitest.config.ts`), i.e. raw bytes without JavaScript to parse. The `Map` is
  built lazily on the first `count` of an encoding (o200k ~190 ms, cl100k ~80 ms once per isolate, in workerd), so module
  load stays cheap: `wrangler check startup` reported ~105-120 ms active startup before and after the
  slice (the 1 s limit is not at risk). Bundle size grows from 946 KiB to 2419 KiB gzipped (free plan limit 3 MiB, paid 10 MiB):
  dropping `cl100k_base` would save ~0.4 MiB if the limit becomes tight.
- **Regex fidelity**: Go's `regexp2` generated matchers differ from the textbook patterns, and parity is defined by Go:
  U+007F (DEL) is never matched (dropped), `\s*[\r\n]+` ends at the first newline run (`" \n \n"` is two pieces), and `\s` is
  `unicode.IsSpace` (U+0085 yes, U+FEFF no). `encodings.ts` encodes these quirks; `strings.TrimSpace` is `goTrimSpace`.
- **Counters** (`helps/token-count.ts`): `countOpenAIChatTokens`, `countCodexInputTokens`, `countXaiInputTokens` collect segments
  of the _final_ upstream body (after payload rules) exactly like the Go collectors. Executors: Codex shapes the body like Go's
  `CountTokens` (translate with `stream=false`, thinking, model, field deletions, instructions, payload rules; no replay, cache
  key or tool-schema normalisation), OpenAI-compatibility skips max-token/cache-key shaping, xAI reuses `prepare` + payload
  rules, Meta reuses `prepareMetaRequest(..., stream=false)` after the token check. Responses are produced by the registry's
  `translateTokenCount`. Devin keeps Go's `len/4`; Claude/Kimi use upstream `count_tokens` where Go does.
- **Claude stream input tokens** (`tokenizer/claude-input.ts`): `TranslatorRegistry.translateStream` applies Go's
  `ClaudeInputTokenState` for every `claude` client served by a non-Claude provider format (all executors, including future
  ones, without per-call-site wiring): the first `message_start` whose `message.usage.input_tokens` is missing/0 gets the
  `o200k_base` estimate of the client's original request (`ResponseContext.originalRequest`); the once-per-attempt flag is
  `TranslationState.claudeInputTokensHandled`. Estimation failures leave the chunk untouched. The raw Go translator corpus
  tests set the flag so they keep exercising the bare translators.
- **Fixtures** (`test/fixtures/tokens.json`, `go run ./tools/fixturegen/tokens`): ~390 texts x 2 encodings (edge cases,
  scripts, emoji, whitespace/newline/DEL fuzz, long pieces), the model -> encoding table, Claude estimates, 390 `CountTokens`
  answers of the real Go Codex/OpenAI-compat/xAI/Meta/Claude executors, and 21 stream scenarios through
  `helps.TranslateStreamWithClaudeInputTokens` (real translators plus a passthrough format for framing edge cases).
  Tests: `tokenizer-parity`, `tokenizer-units`, `token-count-executors`, `claude-input-tokens`.

Deviations from Go: raw JSON segments are `JSON.stringify` output of the parsed body (Go counts raw bytes: pretty-printed tool
schemas or `1.0` numbers sent by a client count slightly differently); Unicode property tables (`\p{L}` ...) come from V8, not
Go's `unicode` package, so characters assigned after the older table can be classified differently; a stream estimate error is
silent (Go logs a warning).

## Antigravity provider (`src/executor/antigravity/`, `src/translator/antigravity/`, `src/signature/`)

Ported from `antigravity_executor*.go`, `internal/translator/antigravity/*`, `internal/signature`, `internal/cache/signature_cache.go`,
`internal/misc/antigravity_version.go` and `sdk/cliproxy/antigravity_models.go`.

- **Translators** (`translator/antigravity/{gemini,openai,claude,interactions}/`, registered by `antigravity/register.ts`): gemini, openai,
  openai-response (a request _envelope_ transform: native web search depends on the resolved model info), claude and interactions -> antigravity,
  each with request, stream, non-stream (and token count) transforms, all golden-tested against Go (`corpus/antigravity-*.json`,
  `test/translator-fixtures{,-ids}.test.ts`). `ResponseContext.alt` carries the Gemini `alt` option the Go handlers put in the context
  (the Gemini response translator emits nothing without it; streams always use `""`). Claude clients get Gemini signatures as
  _carrier_ thinking blocks (`cpa-gemini-carrier-v1:<direction>:<kind>:<b64>`, `claude/carrier.ts`), Claude models keep R/Q-form
  signatures, and `web_search_*` tools map to native Google Search (`claude/web-search.ts`, request building and grounding -> `web_search_tool_result`
  blocks; the capability comes from the registry record, `supportsWebSearch`).
- **Signatures** (`src/signature/`): `claude.ts` ports the E/R/Q/CAIS validation including the strict protobuf-tree mode
  (`signature-bypass-strict`, default off) and `compatibleAntigravityClaudeThinkingSignature`; `provider.ts` the provider detection and
  `decideSignatureCompatibility` decision table for every target (claude, gemini, gpt, kimi, swe, grok); the Gemini envelope checks and replay sanitiser live in `gemini.ts` (re-exported by `translator/gemini/common/signature.ts`). `go run ./tools/fixturegen/signature` drives the real Go package over a corpus of
  synthetic envelopes (`test/fixtures/signature.json`, `test/signature-fixtures.test.ts`).
- **Signature cache** (`cache.ts`, `store.ts`): translators are synchronous, so the cache they read is a bounded per-isolate map with the Go
  semantics (3 h sliding TTL, 50 char minimum, gpt/claude/gemini buckets, Gemini sentinel on a miss). It is installed around the synchronous
  translator calls with `withSignatureContext` (like `withModelInfoLookup`); persistence is the `CACHE` KV namespace behind the
  `SignatureStore` interface (`sig:<group>:<sha256(text)[:16]>`, `expirationTtl` 3 h): the executor _prefetches_ the signatures a Claude request
  needs (thinking blocks without a usable signature) before translating and _flushes_ the writes recorded by the response translator through
  `waitUntil`. Every store failure is swallowed. `antigravity.signature-cache-enabled` / `signature-bypass-strict` switch cache and bypass mode.
- **Executor** (`executor/executor.ts`): per attempt `validate Claude signatures -> prefetch -> translate -> thinking -> sensitive words ->
  Gemini signature sanitising (+ function-response role normalisation) -> credits flag -> boundary user turns -> envelope (project, requestType,
  requestId, sessionId) -> model shaping (maxOutputTokens cap/removal, schema cleaning at schema locations only, Claude `VALIDATED`) ->
  payload rules (root `request`, always last) -> fetch`. Daily endpoint unless `base_url` is set (no cross-tier fallback), header whitelist
  (`Content-Type`, `Authorization`, short `User-Agent`, `header:*` attributes). Claude, `gemini-3-pro` and `gemini-3.1-flash-image` models
  stream upstream and the SSE is merged for non-stream callers (`stream.ts`); streams filter usage (non-terminal usage becomes
  `cpaUsageMetadata`, the stop-chunk bookkeeping is per stream), join JSON split over several lines, map in-stream `error` objects to status
  errors and synthesise the terminal event only after a clean EOF. `countTokens` posts the bare request. The conductor refreshes the token
  (`needsPreparation`/401 loop); a credential without `project_id` is completed through `loadCodeAssist`/`onboardUser` (the OAuth flow code) and
  persisted with `patchCredentialMetadata`.
- **429 handling** (`errors.ts`, `state.ts`): the Go decision table (`decideAntigravity429`) and `ParseRetryDelay`; a rate limit with a delay
  under 5 min records a per-(credential, model) short cooldown (KV `ag:sc:*`, memory without a binding) and later calls answer
  `429 auth in short cooldown` without an upstream request; `retryAfterMs` of every 429 reaches the ControlPlane cooldown bookkeeping.
- **Credits** (`credits.ts`, `handlers/conductor.ts`): `quota-exceeded.antigravity-credits` enables one extra _credits round_ after the normal
  rotation failed with 429/503/`auth_not_found|auth_unavailable|model_cooldown` for Claude models: the conductor picks Antigravity credentials
  again with `PickRequest.ignoreCooldown` (cooling credentials stay selectable), skips credentials whose stored balance is known to be empty and
  asks the executor for `enabledCreditTypes: ["GOOGLE_ONE_AI"]` through `ExecutorOptions.metadata.antigravityCredits`
  (`attemptOptions`). `INSUFFICIENT_G1_CREDITS_BALANCE` marks the credential out of credits (KV `ag:credits:<id>`, 30 min); the balance probe
  (`loadCodeAssist`, prod endpoint, `waitUntil`; one probe per credential per 10 min, claimed atomically with a create-if-absent
  write in the `SessionState` DO, not KV) refreshes it. The round walks every Antigravity credential once in the Go order
  (`findAllAntigravityCreditsCandidateAuths`): known-available balances first, then unknown ones (optimistic), each group sorted by credential id;
  known-empty credentials are skipped without an attempt (the conductor collects them with repeated `pick`s and releases the skipped leases
  as connection-lifecycle failures).
- **Cron** (`scheduled.ts`): `antigravity-version` polls the Hub manifest into KV `antigravity:version` (`2.9.1` fallback, 6 h TTL; executors read it
  through a 60 s isolate cache) and `antigravity-models` probes `fetchAvailableModels` for every enabled credential (first endpoint only, global
  user agent, failures keep the last good list and back off 2-30 min with jitter) into KV `ag:models:<id>`. The registry snapshot attaches
  the stored entitlements to the credential's `ModelSource` (`antigravityHints`): registered models = static list intersected with the fetched
  ids, `webSearchModelIds` set `supportsWebSearch`; credentials without a record serve the static list (like Go before the probe finishes).
  The Go 1-minute scan is replaced by the 3 h cron (= the Go catalog TTL).

The **reasoning-replay ledger** (Gemini-family models) and the Interactions **continuation sessions** run on the `SessionState` DO, see
_SessionState Durable Object_.

- **Compaction**: `responses/compact` (non-stream) and `compaction_trigger` run the summary turn through the normal Gemini/Claude path and
  seal a capsule (see the Claude section); sealed items in any Responses request are expanded first. Streaming `/responses/compact` is a 400.
- **Grounding redirects** (`grounding.ts`): for Claude clients with typed `web_search_*` tools and Responses clients with a web search tool
  whose translated request holds `googleSearch`, `groundingChunks[].web.uri` values of
  `https://vertexaisearch.cloud.google.com/grounding-api-redirect/*` are resolved with `HEAD` (`redirect: "manual"`, the 3xx `Location` must be
  https) before translation, in non-stream, aggregated and streamed payloads; any failure keeps the redirect URL. Verified by
  `test/antigravity-grounding.test.ts` (Go `antigravity_grounding_urls_test.go` scenario plus executor wiring).

Deviations from Go / not ported: per-credential HTTP pools and proxies; a bare `[DONE]` line yields nothing in the
Interactions response translator (as in Go), so the Interactions stream ends with `interaction.completed` only; short-cooldown
state and signature persistence are KV (eventually consistent), not the Go home KV.

## Signature validation (`src/signature/`)

Full port of `internal/signature`: `claude.ts` (E/R/Q/CAIS validation incl. strict protobuf mode), `gemini.ts` (envelope
inspection, `sanitizeGeminiRequestThoughtSignatures`, `validateGeminiThoughtSignatures`, `validateGeminiFunctionCallPairing`),
`gpt.ts`, `grok.ts` (`isValidGrokEncryptedContent`, `isRecognizedReasoningSignature`), `entropy.ts`, `provider.ts` (provider
detection by structure, `decideSignatureCompatibility` with Go's `reason` strings for every target) and `claude-messages.ts`
(`sanitizeClaudeMessagesSignaturesForTarget`/`ForModel`/`ForClaudeUpstream`, in place on parsed bodies). The simplified checks of
the earlier slices (`translator/common/signature.ts`, `openai/common/signature.ts`, `common/gemini-signature.ts`, the decodable-prefix
test in `executor/claude/sanitize.ts`, Devin's approximation) are gone: the Codex/OpenAI/Claude/Kimi/xAI/Devin paths call this module.
`go run ./tools/fixturegen/signature` (`test/fixtures/signature.json`) records detection, decisions (incl. reasons),
Grok/GPT/recognised checks, Gemini replay, ~500 sanitiser runs over synthetic histories and Gemini validation/pairing cases;
`test/signature-fixtures.test.ts` compares them with the port (key order included).

## Codex client rewriting and compat variants (`src/executor/helps/{codex-multi-agent-v2,translate}.ts`)

- **Multi-agent v2** (`codex-multi-agent-v2.ts`, port of `internal/client/codex/optimize-multi-agent-v2`): for official Codex
  clients (User-Agent allow-list) and `client.codex.optimize-multi-agent-v2`: `prepareCodexMultiAgentV2Tools` lists the available
  models in the `spawn_agent` description and removes `message.encrypted` from the collaboration tools; the Codex executor
  additionally renames the `collaboration` namespace to `collaboration-optimize` (unless the request already uses it) and restores
  it in every response event (`restoreCodexMultiAgentV2Response`, re-marshalled like Go: sorted keys); `rewriteCodexMultiAgentV2Input`
  turns `agent_message` items into user messages for non-Codex targets (and strips `author`/`recipient` for compat models);
  `rewriteCodexOrphanDelegationInput` (`upstream.codex.orphan-delegation-compatibility` and `X-Openai-Subagent: collab_spawn`)
  downgrades orphan `codex_app` delegation outputs. The Responses handler and WebSocket frames prepare the tools once
  (`handlers/responses/codex-prepare.ts`, model list from `ModelProviders.spawnAgentSource`); executors repeat the idempotent parts
  without the model list. Fixtures: `go run ./tools/fixturegen/multiagent` (896 combinations of client identity, flags and
  compat over the real Go functions, `test/fixtures/multiagent.json`).
- **`is-compat` models** (`translate.ts`): `translateRequestForExecutor` replaces every direct `registry.translateRequest` of the
  executors that Go routes through `helps.Translate*WithAPIKeyModelCompatibility` (Claude, Codex, Gemini/Vertex Interactions, Meta,
  OpenAI-compatibility, xAI; Kimi and Antigravity use it for the multi-agent rewrite only). The registry holds the `*WithCompat`
  request transforms (`registerCompatRequest`: claude -> codex/gemini/interactions/openai, openai/openai-response -> claude), selected
  when the resolved model info has `isCompat` (`ThinkingModelInfo.isCompat`). The Codex reasoning sanitiser keeps reasoning content
  and foreign `encrypted_content` for compat models. Fixtures: corpus `executor-compat.json` runs the Go helper itself
  (`corpusCase.executor`).

## Orgs in addresses (`src/access/org-address.ts`, `src/management/org-routes.ts`)

An org is addressed by its slug (ADR 0021), in two places, and the address is the only thing that names an org to the
management API and the panel (the proxy endpoints still name it with the caller's key):

- **`/v8/management/orgs/<slug>/<route>`** and **`/o/<slug>/<page>`** (`parseOrgAddress`, `routes.ts`). `orgAddressing` is a
  router middleware around the whole application: it takes the org prefix out of the URL before routing, so every
  management handler and the panel page handler are written once, for an unscoped path, and run against the org the address
  names (the `CurrentOrg` they read). The unscoped path means `global`. Matching is case-, slash- and
  percent-encoding-insensitive like the rest of the classification (`/V8/Management//Orgs/Acme/settings`), and
  `/v8/management/orgs` and `/v8/management/orgs/<slug>` (no route after the slug) are not prefixes: they are the
  platform-level routes below. The CSRF guards and the admin gate see the original URL, so every rule that applies to
  `/v8/management*` and to the panel pages applies to the scoped spellings too.
- The slug is resolved by the Platform registry (`getOrgBySlug`) **after** authentication, so an unauthenticated caller
  learns nothing about which slugs exist. A platform admin gets the org; a slug the registry does not list is `404` for a
  platform admin and `403` for anyone else (also for an admin named only by the config document, who is limited to
  `global`'s slug as the registry currently lists it, so renaming `default` does not lock them out). A registry that cannot be reached fails a scoped address
  with `500` (the org cannot be told); the unscoped addresses need no lookup and keep working.

Platform-level routes (`org-routes.ts`, contract group `orgs`, `src/management/contract/orgs.ts`):

| Route                              | Who            | Does                                                                                         |
| ---------------------------------- | -------------- | -------------------------------------------------------------------------------------------- |
| `GET /v8/management/me`            | any admin      | `{platform_admin, orgs: [{slug, name}]}`: every org for a platform admin, `global` otherwise |
| `GET /v8/management/orgs`          | platform admin | every org, `global` first                                                                    |
| `POST /v8/management/orgs`         | platform admin | creates `{slug, name}`; `201`, `409 slug_taken`, `422 invalid_slug`/`invalid_name`           |
| `PATCH /v8/management/orgs/<slug>` | platform admin | changes `slug` and/or `name`; the id never changes, so stored data stays where it is         |

Anyone else gets `403 platform_admin_required` on the three org routes. The panel reads `/me` for its org switcher.

**Panel.** The panel of an org is the same single-page app served at `/o/<slug>/...` (the Worker answers every page path of
every org with `index.html`). The app reads its org from the address: TanStack Router's `basepath` is `/o/<slug>`, and the
typed client rewrites each request to `/v8/management/orgs/<slug>/...` except `/me` and `/orgs` (`web/src/lib/org.ts`,
`ManagementClient`'s `transformClient`; the one hand-written request, the Vertex import, does the same). The shell shows an
org switcher to anyone who manages several orgs or may create them; choosing an org reloads the app at its address. An
address without an org (`/`, `/accounts`, ...) goes through `orgRedirect` (`web-panel.ts`): a caller who manages exactly
one org is redirected (`302`, uncached, path and query kept) to the same page of it; otherwise the app loads without an
org and shows the **chooser** (the orgs of `/me`, and for a platform admin a form that creates one). `/?choose` skips the
redirect, so a platform admin of one org can reach the form. Bookmarks and clients of the unscoped management API are
unaffected.

## Authentication (Cloudflare Access)

- Access application on the Worker's custom domain, provisioned with the Worker by `alchemy.run.ts`/`infra/access.ts`
  (Allow policy for people, Service Auth policy for the stack's service tokens, SameSite=Lax cookie; its AUD tag feeds
  `ACCESS_AUD`); `workersDev: false` so there are no `workers.dev`/preview URLs and Access cannot be bypassed.
- The Worker verifies `Cf-Access-Jwt-Assertion` (RS256, JWKS from `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`,
  `iss` = team domain, `aud` contains the application AUD tag, `exp`/`nbf`). JWKS is cached per isolate.
- Principal: `email` for users, `common_name` (service token client id) for service tokens. The principal replaces the
  Go `userApiKey` for usage records and the `caller_scope` hash used to isolate session state.
- Management routes require the principal to match an admin allow-list (emails / service token ids), in addition to Access
  policy: the `PLATFORM_ADMIN_EMAILS`/`PLATFORM_ADMIN_SERVICE_TOKENS` variables (the **platform admins**: always checked
  first, no I/O, so one can always repair the config and the registry; the deprecated `ACCESS_ADMIN_EMAILS`/
  `ACCESS_ADMIN_SERVICE_TOKENS` are merged in as aliases and logged once as a warning) united with the config document's
  `access.admin-emails`/`access.admin-service-tokens` (read through a `ConfigReader` built into the gate; an unreadable
  config denies non-platform admins). A platform admin manages every org the registry lists; an admin named only by the
  config document manages the org `global` and nothing else, until orgs have members of their own (ADR 0022).
- Cross-site protections (`access/csrf.ts`, before authentication; new in the port because the Access session cookie is sent by
  browsers automatically): state-changing requests are refused on protected and management zones when `Sec-Fetch-Site` is
  `cross-site`/`same-site` or `Origin` is another host; management requests of any method with a foreign `Origin` (or a
  cross-site `Sec-Fetch-Site`, unless a `GET`/`HEAD` with `Sec-Fetch-Mode: navigate` and `Sec-Fetch-Dest: document` to a
  panel page or `/management.html`: `routes.ts` `isPanelPagePath`; frames, `/assets` and `/v8/management*` never) too; WebSocket upgrades with a foreign `Origin`; management writes need
  JSON (multipart for `POST /credentials`, YAML for `POST /settings/import`) or no body (415). The CORS middleware adds no headers in
  the management zone (deviation from Go's `*`).
- Implementation notes (`src/access/`): the gate is a _global_ router middleware that matches protected path
  prefixes (default-deny for `/v1*`, `/openai/v1*`, `/backend-api/codex*`, the unprefixed `/chat/completions`,
  `/completions`, `/responses`, `/v8/management*`, normalising case, duplicate
  slashes and percent-encoding) and provides `AccessPrincipal`; route layers that read it use `withAccess(...)` for typing.
  JWKS keys are cached per isolate and refreshed on unknown `kid` at most once per 30 s (no cross-request locks, which
  workerd forbids). `ACCESS_DEV_BYPASS` only applies when the request host is loopback (i.e. `alchemy dev`) and is refused (warning logged once
  per isolate) whenever `ACCESS_TEAM_DOMAIN` or `ACCESS_AUD` is set.
- Machine clients use Access service tokens (`CF-Access-Client-Id`/`CF-Access-Client-Secret` headers, or Access
  single-header mode via `x-api-key`, set on the Access application with `read_service_tokens_from_header`; the Worker only sees the
  resulting JWT, so no Worker code is involved). User docs: `README.md` and `ACCESS.md`, `CLIENTS.md`, `MIGRATION.md`,
  `DEVELOPMENT.md` in this directory.

## Provider OAuth logins (`src/oauth/`, `src/management/oauth-routes.ts`)

Port of the management OAuth handlers (`auth_files_provider_oauth.go`, `auth_files_devin_oauth.go`, `oauth_callback.go`,
`oauth_sessions.go`) and `internal/auth/*`. The panel's OAuth page works unchanged: `GET /v8/management/oauth/auth-url?provider=`
(`claude`, `codex`, `antigravity`, `devin`, `xai`, `meta`, `kimi`, `kimi-ai`; `is_webui` ignored) returns `{status,url,state}`
(+ `flow:"device"`, `user_code`, `expires_in` for device logins), `GET /oauth/status?state=` answers `ok|wait|error`,
`DELETE /oauth/session?state=` cancels and `POST /oauth/callback` takes `{provider, redirect_url | state+code}`.

- **Sessions** (`session-store.ts`): a SQLite table in the `ControlPlane` DO with the Go rules (TTL 30 min, completed kept 1 min,
  `SetError` refreshes the TTL, cancel only for pending sessions). Flow secrets (PKCE verifier, device code) stay in the row and are
  wiped when the session ends; replies never contain them. A busy lease (2 min, released in `ensuring`) lets one exchange/poll run
  per session, and the credential is saved only while the session is still pending (a cancel racing the exchange wins).
- **Authorization-code logins** (Claude, Codex, Antigravity, Devin): provider client IDs only allow `localhost`/`127.0.0.1`
  redirect URIs, so the user pastes the redirected URL (`POST /oauth/callback`). The request performs the token exchange itself
  (no waiter goroutine/file hand-off); like Go it answers `{"status":"ok"}` once the callback is accepted and failures show up in
  `/oauth/status` (messages are Go's: `State code error` cannot occur because the state _is_ the session key; `Bad request`,
  `Failed to exchange authorization code for tokens[: cause]`, `Timeout waiting for OAuth callback`, ...). The callback window is
  5 minutes. PKCE (S256, 96 bytes; Devin 64) and states use WebCrypto; authorization URLs use Go's `url.Values.Encode` ordering.
- **Device logins** (Codex `?provider=codex&flow=device`, xAI, Meta, Kimi/Kimi.ai): `auth-url` requests the device code, the panel
  polls `/oauth/status` and each poll performs the upstream poll when `nextPollAt` has passed (xAI immediately, others after one
  interval; `slow_down` +5 s except Kimi), so providers are never polled faster than their interval. Windows: xAI 30 min, Meta/
  Kimi/Codex 15 min (or the device code's `expires_in`). No DO alarms are needed.
- **Credentials** are the Go files (same keys, same names: `claude-<sha8(org|account)>-<email>.json`, `codex-<sha8(account)>-<email>-<plan>.json`,
  `antigravity-<email>.json`, `xai-<email|sub>.json`, `meta-<email>-<sha16>.json`, `kimi[-ai]-<ms>.json`, `devin-<user>.json`, plus
  `disabled`). `record.ts` replays `saveTokenRecord`: same-name user settings are kept (never tokens), a Claude login migrates the
  legacy email/account-named file, then the file is stored through the pool (`importAuthFile` semantics) and is selectable at once.
- **Public browser callbacks** (`/anthropic/callback`, `/codex/callback`, `/antigravity/callback`, `/callback`, `/devin/callback`;
  `public-routes.ts`) exist for users that rewrite the localhost host to the Worker. They are outside the Access admin gate, so
  they only act on the `state` of a pending _callback_ login of the route's provider and answer with a static page (no-store,
  never containing code/state/tokens/errors); everything else is a neutral 400. The state of a login names its org
  (`orgScopedName`: `org.<org>.<hex>`, a bare state is `global`'s), so the callback asks only that org's ControlPlane.

Deviations from Go: the Antigravity login uses the Go fallback client version `2.9.1` (the executor reads the polled Hub version, see
_Antigravity provider_) and project discovery runs inside the login (non-fatal; the executor repeats it when `project_id` is missing); a transport failure or 5xx of one xAI/Kimi poll keeps waiting instead of ending the login; Codex
exchange errors include the (scrubbed) upstream status/body like Go but cap it at 512 chars; device-flow states carry a random
suffix (`xai-<ms>-<hex>`); Kimi stores the normalised `domain`; Claude's uTLS/ordered-header fingerprint cannot be reproduced (see
Claude provider). `POST /v8/management/oauth/import?provider=vertex` (`management/oauth-import.ts`, Go `ImportVertexCredential`)
takes a multipart service-account `file` (+ `location`, default `us-central1`), re-encodes the key as an RSA PKCS#1 PEM
(`normalizePrivateKey`, parity with `NormalizeServiceAccountMap` in `test/fixtures/session.json`; error texts of invalid keys
differ) and stores `vertex-<project>.json` merged over an existing file. Not ported: plugin logins and the local callback forwarder (`is_webui`). Credential JSON files from the Go
server can still be imported through management.
