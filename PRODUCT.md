# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Control panel: React 19 + Vite with Effect Atom (`effect/reactivity`, `@effect/atom-react`) for state and data, a typed
client derived from an Effect `HttpApi` contract shared with the Worker, TanStack Router, accessible headless primitives. Served by the Worker's static assets at `/`, behind the Cloudflare Access gate. The rest
of the project is TypeScript + Effect v4 on Cloudflare Workers, deployed with Alchemy.

## Users

The members of each org the deployment serves, signed in through Cloudflare Access, on a desktop browser, in English.
Each holds a role in their org:

- **Org owners and org admins** run the org: they connect accounts, manage API keys, models and settings, and decide
  who belongs (the Members page: members, teams, service tokens, auto-join) and who may use which models of which shared
  accounts (the Grants page, by member, by team or by credential). Owners also change roles. On a self-hosted
  deployment this is often one person, the owner of the deployment, who is also a **platform admin** (owner of every
  org, the only one who creates orgs).
- **Plain members** use the proxy from their coding agents and open the panel to see their own usage and to create and
  revoke their own proxy keys (the Proxy keys page; org admins see every key of the org), and to see which models their
  grants let them use (My models), and the Spend limits that bind them with what is left of each (Limits; they may cap
  their own proxy keys, and org admins set every other limit and the org's calendar). Where the org lets members
  connect private credentials, they also get their own Accounts and API keys pages: they connect their own accounts and
  add their own keys, used only for their requests; org admins see that each exists (provider, owner, label) and can
  disable or remove it, never how it is used. Every other page is closed to them.

Day to day the proxy is consumed by coding agents (pi, Claude Code, Codex) on the members' machines; the panel is where
they go to check on it or change it.

## Product Purpose

A personal LLM gateway: a Cloudflare Workers fork of CLIProxyAPI that pools subscription accounts (Claude, Codex, xAI,
Antigravity, Kimi, Meta, Devin, Vertex) and provider API keys behind OpenAI-, Claude- and Gemini-compatible endpoints.
The panel answers "is my gateway healthy, what is it costing my accounts, and what needs my attention", and lets the
operator connect or re-authorize accounts, manage API keys, shape model routing and edit settings. Success: a weekly
glance shows the state in seconds; fixing a problem (expired account, exhausted quota, bad key) takes one obvious path.

## Positioning

The panel of this fork, not the upstream one: authenticated by Cloudflare Access (no management key, no login screen),
built on Workers-native data (D1 usage records with tokens and latency, the ControlPlane's credential state, cooldowns
and quota signals), and showing only what actually applies on Workers. It is a distinct fork; upstream panel
compatibility is not a goal.

## Operating Context

- Weekly: check health, account quota and usage.
- Occasionally: connect a new account or re-authorize one (device-code, pasted-callback, Vertex service-account import,
  credential JSON upload).
- Rarely: edit provider API keys, model aliases/exclusions, routing and other settings.
- Every pull request gets a preview deployment on workers.dev with empty storage; production is
  https://proxy.ianpascoe.dev.

## Capabilities and Constraints

- Management API under `/v8/management` (config document with versioned writes, credentials, OAuth sessions, usage
  summaries and records, upstream probe). It may change freely to serve the panel; breaking changes are acceptable.
- Tokens, API keys and credential secrets never reach the browser. The panel offers no credential download, and
  provider usage endpoints are asked by the server (the quota check), not from the browser.
- Not available on Workers and must not appear: plugins, file logs, management key, server host/port/TLS, outbound proxy
  URLs, the deprecated `/v0/management`.
- Every account and API key is **shared** (the org's, managed by org admins) or **private** (one member's, used only for
  their requests; ADR 0023). The panel shows whose each is; org admins see another member's private credential as an
  existence-only row, and private traffic never appears in org-wide usage.
- Zero data retention (ADR 0027): deleting an org, a member, a credential, a proxy key or an account deletes it at once, with
  no grace period and no restore. The panel therefore offers an export (secrets as previews) before an org is deleted and
  asks for the org's name (an account: the person's email) to confirm; it shows an org's usage retention period and
  suggests one while none is set.
- Terminology: an **account** is an OAuth/auth-file credential; an **API key** belongs to a provider key group or an
  OpenAI-compatible endpoint; a **principal** is the Access identity that made a request.

## Evidence on Hand

Real live data through the API: accounts (currently Claude and xAI), one OpenAI-compatible group, about 150 served
models, D1 usage records. No logo, illustrations or brand assets exist; the upstream panel's "CPAMC" branding is not
binding. No testimonials or marketing claims apply.

## Product Principles

1. Attention first: lead with what is broken, expiring or exhausted; healthy things stay quiet.
2. Truthful surface: show only settings and data that take effect on this deployment.
3. One home per concept: each account, key, model rule and setting is edited in exactly one place.
4. Secrets stay server-side: the server probes quotas and upstreams; the browser receives results.
5. Safe writes: every change is version-checked and its effect is visible immediately.

## Accessibility & Inclusion

No product-specific requirement was established; WCAG 2.2 AA and full keyboard operation are the baseline (assumed
default).
