# What must a remote MCP gateway support?

Research for ticket #108 (map #101). Researched 2026-10-15 against primary sources: the MCP specification, Cloudflare
developer docs and repos, client vendors' docs, and gateway vendors' docs/READMEs. Product decisions are not made
here; options and trade-offs are listed.

Glossary terms are used for the repo's own concepts (org, member, team, credential shared/private, grant, spend
limit, proxy key). "Gateway" means the Tools area: one remote MCP endpoint per member over many upstream services.

## Answer

1. **The spec has just changed shape.** The current MCP revision is **2026-07-28**, and it is *stateless*: no
   `initialize` handshake, no `Mcp-Session-Id`, no GET stream, no `Last-Event-ID` resume, no server-initiated JSON-RPC
   requests. Every request is one POST carrying protocol version and client capabilities in `_meta` and mirrored
   headers (`MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name`). Streamable HTTP is still the only remote transport.
   [changelog](https://modelcontextprotocol.io/specification/latest/changelog),
   [streamable-http](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)
2. **But clients are mixed.** Claude's connectors implement the 2025-03-26, 2025-06-18 and 2025-11-25 authorization
   specs (not 2026-07-28 as far as its docs say); Claude Code adopts 2026-07-28 only on its "v2 runtime" and only when the
   server answers a probe. So a gateway launched now must be **dual-era**: serve legacy (2025-11-25) clients *and* modern
   ones. Cloudflare's own MCP portals do exactly this.
   [Claude building docs](https://claude.com/docs/connectors/building),
   [Claude Code MCP](https://code.claude.com/docs/en/mcp),
   [portals](https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/mcp-portals/)
3. **Inbound auth the gateway must offer** (it is an OAuth 2.1 resource server *and* authorization server toward
   clients): RFC 9728 protected-resource metadata, a `401` with `WWW-Authenticate: Bearer resource_metadata=…`, RFC 8414
   (or OIDC) server metadata, PKCE, RFC 8707 `resource`, `iss` (RFC 9207), refresh tokens, **Client ID Metadata
   Documents (CIMD) as the preferred registration**, and **Dynamic Client Registration (DCR) as fallback** (DCR is now
   deprecated in the spec but Claude, Cursor, pi and Codex all still rely on or support it). Also a non-OAuth path for
   headless use: a static bearer (a proxy key-style token) is supported by Claude Code, Cursor, Codex and pi via
   headers.
4. **Cloudflare gives most of this off the shelf.** `@cloudflare/workers-oauth-provider` implements the authorization
   server side (pre-registered, CIMD, DCR clients, PKCE, RFC 9728 resource-server role, token exchange, KV storage).
   `createMcpHandler` (Agents SDK) is the recommended stateless Streamable HTTP server. **`McpAgent` is deprecated and
   feature-frozen**; new servers should not use it. Cloudflare MCP server portals (Zero Trust) already do the
   aggregate-many-servers job, but are an Access/Zero Trust product tied to a Cloudflare account and domain, so they are
   a reference design, not a component Commissary can embed for its own members.
5. **Workers/DO limits are not a blocker.** Per-request CPU defaults to 30 s (max 5 min on paid), no wall-clock limit
   on HTTP requests, 10,000 subrequests (paid), 6 simultaneous outbound connections, 128 MB per isolate; a Durable
   Object is soft-limited at ~1,000 req/s. A stateless gateway does not need Durable Objects for MCP sessions. Free-plan
   Workers (10 ms CPU, 50 subrequests) are the constraint for any self-hosting on the free plan.
6. **Aggregating upstreams = being an MCP client + OAuth client to each.** The gateway needs, per upstream: transport
   detection (Streamable HTTP; legacy SSE fallback as Cloudflare does), its own OAuth client identity (CIMD URL or
   DCR) with a stable redirect URI, per-member token storage with refresh, and re-auth signalling. Spec forbids
   **token passthrough**: the gateway must issue its own tokens to clients and hold the upstream tokens separately.
7. **Listing every tool does not scale; every serious design collapses it.** Composio (7 meta-tools: search → get
   schemas → multi-execute), Docker (`mcp-find`/`mcp-add`/`mcp-exec`/`code-mode`), Cloudflare portals
   (`minimize_tools`, `search_and_execute`, Code Mode) and the clients themselves (Claude Code tool search, pi
   `deferred`/`codemode` exposure) all use search → describe → call. The 2026-07-28 spec adds `ttlMs`/`cacheScope` on
   list results and requires deterministic tool order, which favours stable per-member lists and cacheable prefixes.
8. **Upstream servers reachable through a gateway** need: Streamable HTTP (SSE legacy only as fallback), a way to
   authenticate non-interactively on the gateway's behalf (OAuth with a registerable/redirectable client, or a static
   key/header), and ideally statelessness. Stateful (2025-era session) upstreams can be reached but cost the gateway a
   session store; servers that need server→client requests (elicitation, sampling) need protocol-specific bridging.

## 1. MCP specification (current: 2026-07-28)

Source for this whole section: the spec site, `latest` = 2026-07-28
([overview](https://modelcontextprotocol.io/specification/latest)). I could not find a release-date statement on the
pages read; the revision identifier is the date and the Cloudflare docs (updated 2026-07-27) and Claude Code docs already
reference it, so treat it as released. The prior revision is 2025-11-25.

### 1.1 Transports

- Two standard transports: stdio and **Streamable HTTP**. HTTP+SSE (2024-11-05) is classified *Deprecated* (a
  twelve-month deprecation window applies) ([changelog](https://modelcontextprotocol.io/specification/latest/changelog)).
- Streamable HTTP in 2026-07-28: a single MCP endpoint accepting **POST only**. Each JSON-RPC request/notification is
  its own POST; the client must send `Accept: application/json, text/event-stream`; the server replies with JSON or a
  request-scoped SSE stream. Required headers: `MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name`
  ([streamable-http](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)).
  Servers must validate `Origin` (403 if invalid).
- **Sessions removed.** `Mcp-Session-Id` is gone, `tools/list` etc. must not vary per connection
  ([SEP-2567 via changelog](https://modelcontextprotocol.io/specification/latest/changelog)). Cross-call state uses
  server-minted handles passed as ordinary tool arguments. The set of tools *may* vary by the authorization presented on
  the request ([tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)) — directly relevant to
  per-member tool lists/grants.
- Handshake removed; every request carries `_meta.io.modelcontextprotocol/protocolVersion` and `clientCapabilities`;
  `server/discover` is a mandatory server RPC; wrong version → `UnsupportedProtocolVersionError` (400)
  ([versioning](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning)).
- **Server→client interactions** (elicitation, sampling, roots) are no longer separate requests. The server returns an
  `InputRequiredResult`; the client retries the original request with `inputResponses` (MRTR, SEP-2322). Sampling,
  Roots and Logging are deprecated.
- **List-changed notifications** move from the GET stream to `subscriptions/listen`, a long-lived POST-response SSE
  stream the client opts into (`toolsListChanged`, etc.). SSE resumption is removed: a broken stream loses in-flight
  work.
- Legacy compatibility for a server that wants both eras: older clients send GET/DELETE/`Mcp-Session-Id`/`Last-Event-ID`
  that a modern-only server should answer 405 / ignore; clients detect era by trying a modern request first
  ([streamable-http: Backward Compatibility](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)).
- New optional **Tasks** extension (`io.modelcontextprotocol/tasks`) for long-running operations, MCP Apps, and
  `ttlMs`/`cacheScope` caching hints on list results.

### 1.2 Authorization (HTTP transports; optional in spec)

Source: [authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization),
[server discovery](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/authorization-server-discovery),
[client registration](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/client-registration).

- MCP server = OAuth 2.1 resource server; client = OAuth 2.1 client; the authorization server may be co-hosted or
  separate.
- Servers **must** implement RFC 9728 Protected Resource Metadata (`authorization_servers` required) and advertise it via
  `WWW-Authenticate: Bearer resource_metadata=…` on 401 and/or a well-known URI. Authorization servers must offer RFC
  8414 or OIDC discovery; clients must support both.
- Registration priority for clients: pre-registered → **CIMD** (if `client_id_metadata_document_supported`) → **DCR**
  (if `registration_endpoint`) → ask the user. CIMD: `client_id` is an HTTPS URL to a metadata JSON document
  (`client_id`, `client_name`, `redirect_uris` required); the authorization server fetches and validates it (redirect
  URIs must match). **DCR is deprecated in 2026-07-28** but retained for compatibility.
  Clients must key stored credentials by issuer and re-register if the authorization server changes.
- Clients **must** send RFC 8707 `resource` (canonical MCP server URI) on authorization and token requests; PKCE is
  required; `iss` (RFC 9207) is validated when present.
- Scope: servers should put `scope` in the `WWW-Authenticate` challenge; step-up authorization by re-challenging.
- **Token passthrough is an anti-pattern**: an MCP server must only accept tokens issued to itself (audience
  validation) and must not forward client tokens downstream
  ([security best practices](https://modelcontextprotocol.io/docs/tutorials/security/security_best_practices)).
  For a gateway this means: inbound token ≠ upstream token; hold separate upstream credentials.
- Elicitation: **form mode must not collect secrets (API keys, tokens, passwords)**; those must use **URL mode**, where
  the client shows the target host and asks consent before opening the URL
  ([elicitation](https://modelcontextprotocol.io/specification/2026-07-28/client/elicitation)). Relevant to a
  gateway's "connect this upstream account" flow: the natural in-protocol mechanism is URL-mode elicitation or a
  tool result containing a link (Composio does the latter, see §3).

### 1.3 Tool annotations

`ToolAnnotations`: `readOnlyHint`, `destructiveHint` (default true when not read-only), `idempotentHint`,
`openWorldHint`, plus `title`. The schema says all are **hints**, and that clients should never make tool-use
decisions on annotations from untrusted servers
([schema](https://modelcontextprotocol.io/specification/2026-07-28/schema)); the overview repeats that annotations must
be treated as untrusted unless the server is trusted
([overview](https://modelcontextprotocol.io/specification/latest)). Consequence: a gateway could use upstream
annotations to *propose* grant defaults (e.g. read-only tools auto-allowed), but enforcement must be the gateway's own
policy, not the hint. The hints are defaults-only; a gateway may also override/alias metadata (Cloudflare portals do:
rename tools/descriptions, MetaMCP does: "Tool Overrides & Annotations").

### 1.4 Elicitation and list-changed, in practice

- Elicitation (form/url) is a **client capability** declared per request. Under 2026-07-28 it is delivered via MRTR
  retries, so a stateless gateway can proxy it by passing `InputRequiredResult` back (with `requestState` echoed) —
  no held connection needed. On legacy sessions it needs the held SSE stream and a session. I did not find a source
  describing a gateway proxying this end to end; treat as an open design problem.
- `listChanged` on modern revision needs `subscriptions/listen` (long-lived SSE). Claude Code reopens it with back-off
  and caps (3 quick reopens; after 5 reopens/hour waits ~6 h) and notes serverless hosts commonly close streams after
  10+ s ([Claude Code MCP](https://code.claude.com/docs/en/mcp)). Implication: don't rely on push; make lists cacheable
  (`ttlMs`) and accept refresh-on-reconnect.

## 2. What clients support (as of 2026-10-15)

| Client | Remote transport | Inbound auth | Features/notes | Sources |
| --- | --- | --- | --- | --- |
| **Claude Code** | Streamable HTTP (`http`, alias `streamable-http`); SSE legacy; WebSocket experimental | OAuth with auto-discovery on 401/403, `claude mcp login`; static `headers`; `headersHelper` for dynamic tokens; pre-configured client ID/secret possible | `list_changed` refresh; elicitation form+URL; MCP tool search (defers tool defs); v2 runtime uses SDK 2.0 and probes for 2026-07-28; headless `-p` cannot run OAuth flow; fails sign-in if issuer unexpected; sends credentials only to HTTPS/localhost token endpoints | [mcp](https://code.claude.com/docs/en/mcp) |
| **Claude Desktop / claude.ai / mobile (custom connectors)** | Streamable HTTP; legacy SSE "being deprecated" | OAuth 2.0 (specs 2025-03-26, 2025-06-18, 2025-11-25); DCR default; CIMD only when server metadata advertises it, else DCR; static credential (beta, org Owner enters once); no `client_credentials`; callback `https://claude.ai/api/mcp/auth_callback`; uses only first `authorization_servers` entry; 10 s discovery/registration/token timeouts, 30 s refresh | No resource subscriptions, no sampling; ~150k char result cap, 240 s tool call timeout | [building](https://claude.com/docs/connectors/building), [authentication](https://claude.com/docs/connectors/building/authentication) |
| **Cursor** | stdio, SSE, Streamable HTTP | OAuth; **static OAuth client** (`auth.CLIENT_ID`/`CLIENT_SECRET`) for providers without DCR; headers; OAuth redirect changed from `cursor://` to `http://localhost:<port>` loopback (Cursor 3.10.x, forum report 2026-07) | Docs list tools, prompts, resources, roots, **elicitation**, MCP Apps as supported | [docs](https://cursor.com/docs/mcp), [forum](https://forum.cursor.com/t/oauth-redirect-uri-changed-from-cursor-to-http-localhost-for-streamable-http-mcp/165019) |
| **Codex (CLI/IDE/app)** | stdio and Streamable HTTP | `bearer_token_env_var`, static/env/helper headers, OAuth incl. **CIMD and DCR**, `codex mcp login`, configurable callback port/URL | Reads server `instructions` field (first 512 chars should be self-contained) | [OpenAI docs](https://learn.chatgpt.com/docs/extend/mcp), [config reference](https://developers.openai.com/codex/config-reference) |
| **pi** | stdio and Streamable HTTP (SSE rejected) | OAuth via DCR with auto-sign-in; optional registered `clientId`/`clientSecret`/`callbackPort`; bearer/`headers` | Tool exposure modes `codemode`(default)/`deferred`/`direct`/`hidden`, with `tool_search`; server `description`; core client lacks (per pi-mcp-adapter README) prompts, elicitation, sampling, Tasks, which the adapter adds | [pi MCP docs](https://pi.dev/docs/latest/mcp), [pi-mcp-adapter](https://pi.dev/packages/pi-mcp-adapter) |

Caveats: I could not confirm from first-party docs whether Cursor, Codex or pi speak 2026-07-28 yet (their docs
don't name a protocol revision); assume 2025-era until shown otherwise. Whether claude.ai/Desktop connect with
2026-07-28 is also unconfirmed — its docs name only up to 2025-11-25. Claude Code's v2 runtime is selected per session
(v2.1.232+ with feature flags, v2.1.274+ in some configurations), so a mix of runtimes is in use.

Practical bottom line for the gateway endpoint: serve **POST Streamable HTTP**, answer both eras, do OAuth with
CIMD+DCR on `/mcp`, accept a static bearer too, and keep discovery/registration/token endpoints under 10 s.

## 3. Cloudflare building blocks

### 3.1 Agents SDK: `createMcpHandler` and `McpAgent`

- Recommended for new servers: `createMcpHandler(createServer)` from `agents/mcp/server`, a stateless Streamable HTTP
  handler used with `McpServer` from `@modelcontextprotocol/server` (SDK v2)
  ([transport](https://developers.cloudflare.com/agents/model-context-protocol/transport/), updated 2026-07-27).
- **`McpAgent` (Durable Object–backed stateful server) is "deprecated and feature-frozen"**; Cloudflare tells new
  servers not to use it and gives a staged migration (`createLegacyMcpHandler` + `WorkerTransport` beside a stateless
  route) for existing sessions, pushed elicitation, sampling and replay
  ([McpAgent](https://developers.cloudflare.com/agents/model-context-protocol/mcp-agent-api/)). An SDK v2
  `McpServer` can't run inside `McpAgent`.
- Cloudflare's own guidance on tool design: avoid wrapping a full API; fewer, goal-oriented tools; several narrowly
  scoped servers
  ([MCP overview](https://developers.cloudflare.com/agents/model-context-protocol/)).
- RPC transport exists for Worker-to-Worker MCP (no auth) — a possible internal seam between a gateway and
  in-account tool servers.

### 3.2 `@cloudflare/workers-oauth-provider`

Source: [README](https://github.com/cloudflare/workers-oauth-provider) (main branch, fetched 2026-10-15).

- Two roles: an `OAuthAuthorizationServer` (issues tokens; `/authorize` is yours: sign in, consent, then
  `completeAuthorization`) and a resource server (your MCP endpoint) that publishes RFC 9728 metadata, answers 401 with a
  challenge, and accepts only tokens issued for its resource; the two can be separate Workers over a Service Binding or
  one Worker (`OAuthProvider` with `apiRoute`/`apiHandler`).
- Client registration: pre-registered, **CIMD** (`clientIdMetadataDocumentEnabled`; needs the
  `global_fetch_strictly_public` compat flag), and **DCR** (`clientRegistrationEndpoint`).
- Needs a KV namespace `OAUTH_KV`; tokens/codes/secrets stored only as hashes, `props` encrypted with a key only the
  token holder can unwrap. `tokenExchangeCallback`, token exchange and Enterprise-Managed Authorization
  (experimental) exist in "advanced configuration". Third-party sign-in (GitHub, Google…) as the identity step is
  documented; the MCP server issues **its own** token bound to the upstream identity — the same shape as the
  no-passthrough rule ([authorization](https://developers.cloudflare.com/agents/model-context-protocol/authorization/)).
- Fit for Commissary: its identity step could be the existing Cloudflare Access / management login; `props` can carry
  org/member identity so the handler resolves grants per request. Unverified by me: how well it maps to org/team
  scoping, multiple authorization servers per org, or revocation fan-out; a spike would answer that.

### 3.3 MCP server portals (Zero Trust Access)

Source: [portals docs](https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/mcp-portals/),
updated 2026-10-12.

- One HTTP endpoint (`https://<host>/mcp`) fronting many MCP servers; users log in via Access (IdP or one-time PIN);
  clients get a 401 with discovery pointing at Access "managed OAuth"; service tokens for M2M. Requires an active
  domain on Cloudflare and a configured IdP in Zero Trust.
- Protocol: accepts stateless 2026-07-28 and 2025 Streamable HTTP clients at `/mcp`, chooses per request; legacy
  sessions live until disconnect or 24 h idle; stateless requests keep per-grant state (auth, server toggles,
  upstream OAuth). Upstream: tries Streamable HTTP then SSE; fallback on 404/405/406, with URL-based strategies.
- Upstream OAuth: admin adds the server (DCR "Automatic" or manual client credentials, shared/Cloudflare-hosted
  callback URL option); users "are prompted to authenticate separately to each server that requires OAuth"; portals
  can also use the admin credential for requests; background sync of tools about every two hours with admin credentials
  for DCR servers.
- Policy: per-server Access policies decide visibility; **blocked users can still reach a server by its direct URL**
  unless Access is the server's OAuth provider (caution box in the docs). Per-portal tool allow-list, aliases/renames and
  description edits.
- Context optimisation: `?optimize_context=minimize_tools` (names only + `portal_query_tools`; "up to 5x" token savings)
  and `search_and_execute` (`query` + `execute`; constant token cost; code runs in a Dynamic Worker). **Code Mode**
  replaces tools with `portal_codemode_search`/`portal_codemode_execute` (JS in a sandbox, `Promise.all`).
  Built-in tools `portal_list_servers`, `portal_toggle_servers`, `portal_toggle_single_server`.
- Observability: Access logs tool calls; optional Gateway routing for DLP (AI-prompt DLP profiles do not apply).
- Not embeddable for a multi-tenant product (it is configured per Cloudflare account via dashboard/API with a DNS record
  for each portal host); useful as the closest design precedent and as an **upstream/alternative** for self-hosters
  who already run Zero Trust.

### 3.4 Platform limits that matter

Sources: [Workers limits](https://developers.cloudflare.com/workers/platform/limits/),
[Durable Objects limits](https://developers.cloudflare.com/durable-objects/platform/limits/).

| Limit | Value |
| --- | --- |
| CPU per HTTP request | Free 10 ms; Paid 30 s default, up to 5 min |
| Wall-clock duration, HTTP request | no limit (CPU, not time, is capped) |
| Subrequests per invocation | Free 50; Paid 10,000 (configurable up to 10M) |
| Simultaneous outbound connections | 6 per invocation |
| Memory per isolate | 128 MB |
| Worker size / startup | 64 MiB uncompressed / 1 s |
| Durable Object throughput | soft limit ~1,000 req/s per object (single-threaded) |
| DO storage | 10 GB per object; key+value ≤ 2 MB |
| DO CPU per request | 30 s default, up to 5 min |

Implications (my reading, not stated by a source): a per-request fan-out to many upstreams is bounded by 6 concurrent
connections; long tool calls and held SSE streams are OK on paid Workers but cost wall-clock in the client; a single
DO per org would cap ~1k req/s, but a stateless design needs no DO; self-hosters on Workers Free cannot do OAuth
crypto + fan-out within 10 ms CPU. Claude's own hosted clients cap a tool call at 240 s and results at ~150k chars.

## 4. How existing gateways aggregate servers and handle upstream auth

| Product | Model | Upstream auth | Tool-surface strategy | Sources |
| --- | --- | --- | --- | --- |
| **Composio** | Hosted. Shared MCP URL `https://connect.composio.dev/mcp`, or per-user *session* MCP endpoint keyed by `user_id` | Composio-managed OAuth apps and connected accounts per user; first use returns an OAuth link; multiple accounts per toolkit via aliases | **7 meta-tools**: `SEARCH_TOOLS`, `GET_TOOL_SCHEMAS`, `MULTI_EXECUTE_TOOL` (≤50 parallel), `MANAGE_CONNECTIONS`, `WAIT_FOR_CONNECTIONS`, remote workbench/bash. Sessions restrict toolkits/tools/tags | [connect](https://docs.composio.dev/docs/composio-connect), [sessions via MCP](https://docs.composio.dev/docs/sessions-via-mcp), [config](https://docs.composio.dev/docs/configuring-sessions) |
| **Smithery** | Hosted "Connect": REST API (and MCP transport via SDK) over *connections* grouped into *namespaces*, with metadata (e.g. userId) | Smithery maintains OAuth apps for popular integrations; automatic refresh; connection status `auth_required`/`input_required`; credentials write-only; auth layer is the open-source agent.pw; scoped short-lived service tokens | Client lists tools per connection (not aggregated into one MCP by default per the docs read) | [connect](https://smithery.ai/docs/use/connect), [namespaces](https://www.smithery.ai/docs/concepts/namespaces) |
| **Pipedream** | Hosted remote MCP (`remote.mcp.pipedream.net/v3`), per app, headers carry project id, environment, `x-pd-external-user-id` | Connect managed auth: app builder passes its own end-user ID; Pipedream stores tokens, refreshes; short-lived Connect tokens; OAuth clients are Pipedream's or custom | One MCP server per app; dynamic loading examples exist | [developers](https://pipedream.com/docs/connect/mcp/developers), [remote](https://pipedream.com/apps/remote) |
| **Docker MCP Gateway** | Local/self-hosted CLI plugin (Go); servers run as isolated containers; **profiles** group servers; catalog/OCI/registry/file refs | Secrets via Docker Desktop secrets store; built-in OAuth flows for services needing OAuth | **Dynamic MCP (experimental)**: `mcp-find`, `mcp-add`, `mcp-config-set`, `mcp-remove`, `mcp-exec`, `code-mode`; added servers are session-only | [README](https://github.com/docker/mcp-gateway), [dynamic MCP](https://docs.docker.com/ai/mcp-catalog-and-toolkit/dynamic-mcp/) |
| **MetaMCP** | Self-hosted (Docker; MIT): MCP servers → *namespaces* → public *endpoints* (SSE/Streamable HTTP/OpenAPI) with middleware, tool overrides & annotations, per-endpoint and per-user rate limits (in-memory counters) | Endpoint auth: API key bearer, or MCP OAuth (2025-06-18) on endpoints; Better Auth + OIDC SSO for the admin app; multi-tenant, private/public scopes. README states OAuth-enabled **upstream** MCP servers were tested for 03-26 | Namespace tool selection; "Elasticsearch for MCP tool selection" listed as coming soon | [README](https://github.com/metatool-ai/metamcp) |
| **Cloudflare portals** | Hosted in Zero Trust (see §3.3) | Per-user OAuth to each upstream, or admin credential; DCR or manual client | `minimize_tools`, `search_and_execute`, Code Mode | [portals](https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/mcp-portals/) |

Observed patterns across them:

1. **Two identity layers**: who the member is to the gateway (OAuth/API key) vs. who they are upstream (managed
   connections keyed by an external user ID). All hosted products key upstream tokens by an end-user ID and refresh
   server-side.
2. **Connect-on-demand** is common: an `auth_required` state plus a link (Composio's `MANAGE_CONNECTIONS`/
   `WAIT_FOR_CONNECTIONS`, Smithery's status, portal's per-server OAuth prompt) rather than failing hard.
3. **Shared vs private upstream credentials** exist already: Cloudflare portals' "admin credential" vs per-user OAuth;
   MetaMCP's private vs public scopes; Composio's connected-account aliases. This lines up with credential
   shared/private in the glossary; the products disagree on who may use a shared one (a policy, not a protocol, matter).
4. **Search → describe → call** is the converged answer to tool-count blow-up:
   - Composio: search (with execution plan) → schemas → multi-execute.
   - Cloudflare: names-only list + `query`, or `query` + `execute`, or code search/execute.
   - Docker: find/add/exec, or code-mode.
   - Clients: Claude Code tool search defers definitions (descriptions over 4,096 chars are truncated up front, 16,384 via
     search); pi `deferred`/`codemode`.
   Server `instructions` (Claude Code, Codex read them) are the lever to tell the client when to search.
5. Direct-listing is still needed for *small* sets and for clients without tool search; Cloudflare keeps the plain mode
   as default and optimises by URL parameter, a cheap precedent for per-endpoint modes.

## 5. What an upstream MCP server needs to be reachable through a gateway

Derived from the sources above; where it is my inference, it says so.

**Transport**
- Streamable HTTP (POST). SSE-only upstreams are legacy; Cloudflare's portal still falls back to SSE; Claude calls it
  "being deprecated"; the spec marks it Deprecated. pi rejects SSE entirely. A gateway on Workers can hold an SSE
  upstream for a request but not cheaply as a long-lived session.
- Reachable from Workers: public HTTPS endpoint, or private via a connector (portals use Cloudflare Tunnel plus
  Gateway routing, and require OAuth endpoints to be public). stdio-only servers (the bulk of the open-source
  ecosystem) cannot be reached from a Worker at all; Docker's gateway runs them in containers, which Workers can't do.
  Browser/Agents areas run elsewhere.

**Auth** (what the gateway must be able to do toward the upstream)
- *OAuth upstreams*: the gateway acts as the MCP client: discover via RFC 9728 → RFC 8414, register (CIMD URL under
  the gateway's own domain, or DCR, or manual client), run authorization code + PKCE with `resource`, store refresh
  tokens **per member** (or per org for a shared credential), refresh, and surface `auth_required`. Constraints
  seen in the wild: some providers require pre-registered redirect URIs (Figma, Linear per Cursor docs), so a stable,
  single callback URL matters (Cloudflare offers a shared callback URL for that reason); credentials must be keyed by
  issuer (spec); the gateway must verify `iss`.
- *Static-key upstreams*: header/bearer injected by the gateway (Claude connectors also support static credentials;
  Codex `bearer_token_env_var`; Smithery stores `headers` write-only). Org-level shared vs member-level private maps
  onto credential shared/private.
- *No-auth upstreams*: allowed (portals support them).
- Machine-to-machine (`client_credentials`) is not supported by Claude's connectors, and Composio/Smithery avoid exposing
  upstream tokens to clients: consistent with the passthrough rule.

**Statefulness**
- A 2026-07-28 upstream is stateless: a gateway Worker can call it request by request.
- A 2025-era upstream may issue `Mcp-Session-Id` after `initialize`; the gateway must keep a mapping (client request
  → upstream session) and re-`initialize` on 404/expiry. The 2025 session is also where elicitation/sampling/roots and
  notifications live. Cloudflare portals store legacy sessions (24 h idle expiry). Options: (a) a Durable Object or KV
  per (member, upstream) holding the session id, (b) re-initialise per call (slower, but stateless) — the portal docs do
  not say which portals does; I did not find a source.
- Elicitation/sampling from upstream through a gateway: under 2026-07-28 you can pass `InputRequiredResult` through;
  under 2025 you need a held stream. Gateways I read (Composio, Smithery, Pipedream, MetaMCP, Docker) don't document
  support; MetaMCP says it supports Tools, Resources and Prompts only.
- `list_changed` from upstreams: portals poll/sync tools (~2 h for DCR servers) rather than relay.

## 6. Options and trade-offs for later grilling (no decision made)

1. **Inbound surface.** (a) Stateless-only 2026-07-28: simplest and matches Cloudflare's direction, but excludes
   claude.ai/Desktop and anything on 2025-era SDKs. (b) Dual-era: realistic; costs a legacy path (sessions optional:
   most 2025 clients tolerate a server that never issues `Mcp-Session-Id`, which Streamable HTTP always permitted —
   verify per client). (c) Do not use `McpAgent`.
2. **Inbound auth.** workers-oauth-provider with CIMD+DCR vs. building on Access vs. API-key only. Proxy keys (existing
   concept) could double as the static-bearer path for headless/CI clients; OAuth is required for claude.ai and
   Claude Desktop style connectors. Open: whether one OAuth authorization server serves Models + Tools + Browser + Agents.
3. **Tool surface.** Direct listing (works everywhere, breaks at scale) vs. meta-tools search/describe/call vs.
   code mode (needs sandboxing; Cloudflare has Dynamic Workers) vs. per-endpoint selectable modes. All of them can sit
   behind one grant model if grants name `(service, tool)` rather than the exposed meta-tool. Clients with built-in tool
   search reduce the need but not for Claude connectors on the web (no such statement found).
4. **Grants enforcement.** Annotations are hints and untrusted; enforcement must be gateway-side. Note Cloudflare's
   caution: hiding a server in a portal does not block direct URL access — the gateway must be the only path to the
   upstream credential.
5. **Upstream credentials.** per-member OAuth vs shared org credential vs both; connect flows via URL-mode
   elicitation/links; refresh and revocation storage on Workers (KV/D1/DO) and per-issuer keying.
6. **Upstream reach.** Streamable HTTP + SSE fallback only vs. also hosting stdio servers (not possible on Workers;
   would need containers, i.e. a different runtime).
7. **Limits.** 6 concurrent outbound connections and 10 ms free-plan CPU shape both the fan-out design and what
   self-hosters on the free plan can do.

## 7. Gaps and things I could not confirm

- The release date of 2026-07-28 and its exact status (I inferred "released" from `latest` and third-party docs citing it).
- Which of Cursor, Codex, pi, claude.ai/Desktop actually negotiate 2026-07-28 today; Claude Code does, selectively.
- Whether Codex and Cursor support elicitation, `list_changed` and tool search (Cursor lists elicitation as supported;
  Codex docs read did not mention it; pi's core client lacks it per the adapter's README).
- Smithery's and Pipedream's behaviour for aggregating *many* upstreams behind one MCP URL (the docs I read describe
  per-connection/per-app endpoints); Composio is the only hosted one clearly doing the single-URL aggregate.
- Docker MCP Gateway's remote/HTTP serving and multi-user story (README presents it as a local developer tool).
- How Cloudflare portals store upstream tokens per user, and their per-account limits (not read).
- Any hosted-product terms/pricing; out of scope for this ticket.
