# cf-llm-proxy

A personal LLM proxy: it pools one operator's provider accounts and API keys and serves them through OpenAI-, Claude-
and Gemini-compatible APIs, behind Cloudflare Access. It began as a port of the Go server CLIProxyAPI, which it now
consults as a reference rather than follows.

## Language

### The proxy and its users

**Proxy**:
This deployment as a whole: one personal service that answers clients' model requests using the operator's
credentials.
_Avoid_: gateway, server

**Operator**:
The one person who owns and administers the proxy, and the only user of the control panel.
_Avoid_: user, customer

**Client**:
An application that sends model requests to the proxy, such as pi, Claude Code, Codex or an SDK.
_Avoid_: caller, consumer, user

**Principal**:
The Cloudflare Access identity behind a request: a person's email or a service token. Usage and session state are
attributed to it.
_Avoid_: user, API key, caller

**Service token**:
An Access identity for a machine, which a client presents instead of an interactive login. Each client gets its own.
_Avoid_: API key, client key

**Admin**:
A principal allowed into the control panel and the management API. An admin is named either by the deployment or by the
config document.
_Avoid_: management key holder, administrator

**Caller scope**:
The namespace that keeps one principal's sessions and cached conversation state apart from every other principal's.
_Avoid_: tenant, user scope

**Client key**:
A shared secret that the Go server accepted from clients. The proxy accepts it on import but never enforces it.
_Avoid_: API key, proxy key

### Providers and credentials

**Provider**:
An upstream LLM service the proxy can call: Claude, Codex, Gemini, Vertex, xAI, Antigravity, Kimi, Meta, Devin, OpenCode
Zen, OpenCode Go, or any single OpenAI-compatible endpoint.
_Avoid_: upstream (as a noun), family, executor type, section

**Channel**:
A provider in its role as the scope of model rules that apply to all of its accounts.
_Avoid_: channel as a general word for a provider

**Credential**:
Anything the proxy can authenticate to a provider with: an account or an API key.
_Avoid_: auth

**Account**:
A credential that is a provider login: an OAuth sign-in, a device-code login, an imported service account or an
uploaded auth file. API keys whose provider reports allowances, such as OpenCode Go keys, are listed beside the accounts
but are still API keys.
_Avoid_: auth, auth file, login

**API key**:
A credential that is a provider secret stored in the config document, as part of a key group.
_Avoid_: config key, config credential, provider key

**Key group**:
One endpoint of a provider in the config document, together with its API keys and the rules they share.
_Avoid_: section, compat group

**OpenAI-compatible endpoint**:
A key group for a third-party service that speaks OpenAI Chat Completions. Each one is a provider of its own.
_Avoid_: compat, compatibility entry

**Auth file**:
The stored document of one account: its provider tokens and the account's own settings, in the Go server's file format.
_Avoid_: credential file, token record

**Auth index**:
The opaque public handle that names a credential in the control panel, the management API and usage exports.
_Avoid_: credential id, auth id

**Disabled**:
Said of an account or API key that the operator has taken out of selection without deleting it.
_Avoid_: paused, excluded

**Connect**:
To add an account to the proxy, whether by signing in to the provider, importing a service account or uploading an auth
file.
_Avoid_: login, auth

**Re-authorize**:
To connect again as an existing account. Its tokens are replaced and its settings are kept.
_Avoid_: re-login, re-auth

**Login session**:
A pending connect attempt, which expires if it is not completed.
_Avoid_: OAuth session, auth session

**Token refresh**:
Renewing an account's provider tokens before they expire, or after the provider rejects them.
_Avoid_: refresh (on its own)

### Models

**Model id**:
A model name a client can request, as listed by the proxy's model lists.
_Avoid_: model name

**Upstream model**:
The model name the provider receives for an attempt.
_Avoid_: provider's name, route model

**Model rule**:
An operator-defined alias, exclusion or prefix that shapes which model ids a credential serves.
_Avoid_: mapping, routing rule

**Model alias**:
A model id that the operator defines to stand for an upstream model.
_Avoid_: mapping, rename

**Alias pool**:
Several upstream models behind one model alias, tried in turn.
_Avoid_: model pool

**Forked alias**:
A model alias that leaves the upstream model's own id listed as well.
_Avoid_: fork (on its own)

**Force mapping**:
The rule that answers name the alias the client asked for rather than the upstream model.
_Avoid_: model rewrite

**Model exclusion**:
A pattern that removes models from what a credential, or every account of a channel, serves.
_Avoid_: blacklist, disabled model

**Model prefix**:
A per-credential name segment (`team/gpt-5`) through which clients reach that credential alone.
_Avoid_: namespace, prefix (on its own)

**Model catalog**:
The known models of each provider and their capabilities, built from models.dev and the catalog additions.
_Avoid_: catalogue, static models

**Catalog addition**:
A model, or a fact about a model, that the proxy records itself because models.dev lacks it. It fills gaps and never
overrides a value models.dev has.
_Avoid_: overlay, patch, overrides

**Model route**:
One credential's way of serving one model id, together with whether it can serve it right now.
_Avoid_: route (on its own)

**Thinking**:
How much a model reasons before it answers, expressed provider-neutrally as a budget or a level.
_Avoid_: reasoning effort, effort, variant

**Thinking suffix**:
A thinking value in parentheses after a model id (`gpt-5(high)`), which overrides whatever the request body asks for.
_Avoid_: suffix (on its own)

### Requests

**Client format**:
The API a client speaks to the proxy: OpenAI Chat Completions, OpenAI Responses, Claude Messages, Gemini or
Interactions.
_Avoid_: entry protocol, source format, handler type

**Provider format**:
The API the proxy speaks to a provider for an attempt.
_Avoid_: target format, protocol

**Translation**:
Converting a request and its answer between a client format and a provider format.
_Avoid_: conversion

**Upstream**:
Toward the provider: the upstream request, the upstream model, the upstream answer.
_Avoid_: upstream as a noun for a provider or for the Go server

**Request**:
One call a client makes to the proxy. It may take several attempts.
_Avoid_: attempt, call

**Attempt**:
One try of a request against one credential and one upstream model.
_Avoid_: request, retry

**Failover**:
Moving a request to another credential after a failed attempt.
_Avoid_: retry

**Retry round**:
A pass over the available credentials that ends when one succeeds. Rounds are separated by waiting for a cooldown to end.
_Avoid_: retry (on its own)

**Bootstrap**:
The start of a streamed answer, up to its first content. Until then a failure can still fail over to another
credential.
_Avoid_: peek, first byte

**Selection**:
Choosing the credential for an attempt. The proxy keeps the available credentials, takes the highest priority tier,
applies the routing strategy and then honours session affinity.
_Avoid_: scheduling, rotation

**Priority tier**:
Credentials of equal priority. Only the highest tier that has an available credential takes requests.

**Routing strategy**:
How selection spreads requests within a priority tier: round-robin, weighted round-robin or fill-first.
_Avoid_: rotation, routing (on its own)

**Weight**:
A credential's share of requests under weighted round-robin.

**Session**:
A client conversation, identified by a marker the client sends or derived from the conversation's content.
_Avoid_: thread, session state

**Session affinity**:
Sending a session's later requests to the credential that served it before.
_Avoid_: sticky routing, binding

**Payload rule**:
An operator-defined change to the body sent upstream. Payload rules are applied after every other change the proxy makes.
_Avoid_: payload (on its own), payload config

**Reasoning signature**:
An opaque, provider-signed token on reasoning content. Only the provider that produced it accepts it back.
_Avoid_: thought signature, signature (on its own)

**Reasoning replay**:
Putting a previous turn's reasoning back into a request, because the client did not send it back.
_Avoid_: continuity, ledger

**Compaction capsule**:
A sealed summary of earlier conversation history, which stands in for that history on providers without native
compaction.
_Avoid_: encrypted summary

**Responses WebSocket**:
A client's long-lived connection that carries a series of OpenAI Responses turns.
_Avoid_: socket session

### Health and limits

**Cooldown**:
A period during which a credential, or one of its models, is not selected after a failed attempt. The control panel
calls a credential in cooldown _resting_.
_Avoid_: cooling, back-off, blocked

**Failure scope**:
What a failed attempt is blamed on. The model is cooled down by default. The whole credential is cooled down when the
provider limits the account. Nothing is cooled down when the request itself was at fault.

**Cooldown reset**:
The operator clearing a credential's cooldowns.
_Avoid_: quota reset, reset (on its own)

**Allowance**:
A usage limit that the provider reports for an account over a period (five-hour, weekly, monthly), with the share used
and the time it renews.
_Avoid_: quota window, usage window, bucket, quota

**Pace**:
How an allowance's share used compares with the share of its period that has passed. An allowance _ahead of pace_ would
reach the limit before the allowance renews at its rate so far, one _behind pace_ would leave part of it unused, and one
_on pace_ is within a few points of an even rate.
_Avoid_: burn rate, velocity, utilization rate

**Quota check**:
Asking a provider for an account's current allowances.
_Avoid_: probe, quota (on its own)

**Quota signals**:
The rate-limit figures the proxy observes on live answers, as opposed to those from a quota check.
_Avoid_: quota (on its own)

**Standing**:
The control panel's verdict on an account, API key or model: taking requests, near its limit, resting, closed, failing
or disabled.
_Avoid_: status, health

**Reset grant**:
An Anthropic entitlement to empty an account's allowances a fixed number of times. Each use is one reset.
_Avoid_: credits, quota reset

**Reset claim**:
One attempt to use a reset. There is at most one at a time per Anthropic organisation. The control panel calls it
_using a reset_.

### Configuration and the control panel

**Config document**:
The single, versioned document that holds every operator setting, key group and model rule.
_Avoid_: config file, config.yaml, settings

**Config version**:
The counter that each write to the config document must name. A write based on an older version is refused.
_Avoid_: version (on its own), layout

**Layout**:
The shape of the config document: the current v8 layout, or the legacy flat layout, which is accepted on import.
_Avoid_: config version

**Settings**:
The typed part of the config document, edited on the Settings page.
_Avoid_: settings as a name for the whole document

**Raw configuration**:
The whole config document edited as text, with secrets shown as placeholders.
_Avoid_: config.yaml editor

**Secret placeholder**:
The stand-in shown for a stored secret. Saving it back keeps the secret unchanged.
_Avoid_: mask, redacted value

**Not-applied key**:
A config key that the proxy accepts, so documents from the Go server import unchanged, but that has no effect.
_Avoid_: unsupported, deprecated, ignored

**Control panel**:
The proxy's own web interface for the operator.
_Avoid_: management panel, dashboard, web UI

**Upstream panel**:
The Go server's management web interface. The proxy does not serve it.
_Avoid_: panel (on its own), Management Center

**Management API**:
The admin-only HTTP API that the control panel and operator scripts use.
_Avoid_: admin API

**Key test**:
A one-off check that a stored API key is accepted by its provider.
_Avoid_: probe, connection test

**Stage**:
One deployment of the proxy: production, or a pull request's preview with empty storage.
_Avoid_: environment

### Usage

**Usage**:
The proxy's own record of the traffic it served.
_Avoid_: usage as a word for allowances

**Usage record**:
The stored account of one attempt: its tokens, latency, principal, credential and outcome. A request that fails over
leaves one record per attempt.
_Avoid_: request, log entry

**Token breakdown**:
The split of a usage record's tokens into uncached input, cache reads, cache writes, reasoning and other output.
_Avoid_: usage (on its own)

**Usage export**:
The feed of usage records for external collectors, in the Go server's shape.
_Avoid_: usage queue

### The reference

**Go server**:
The original CLIProxyAPI, which the proxy was ported from and still consults for ideas and tested behaviour.
_Avoid_: upstream, reference repo

**Deviation**:
A deliberate behaviour difference from the Go server, from the time when the proxy followed it everywhere.
_Avoid_: difference, divergence

**Golden fixture**:
An expected result recorded by running the Go server's own code.
_Avoid_: snapshot
