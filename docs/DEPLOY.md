# Continuous deployment

`.github/workflows/ci.yml` checks every pull request and push to `main`, then deploys with Alchemy:

| Event                                    | Stage         | Where                                                        |
| ---------------------------------------- | ------------- | ------------------------------------------------------------ |
| Push to `main`                           | `prod`        | `COMMISSARY_DOMAIN`, GitHub environment `production`         |
| Push to `main`                           | `cloud`       | its own domain, GitHub environment `cloud` (once set up)     |
| Pull request from a branch of this repo  | `pr-<number>` | the Worker's `workers.dev` URL, GitHub environment `preview` |
| That pull request closed (merged or not) | `pr-<number>` | destroyed                                                    |

A preview is a Commissary Cloud deploy (`COMMISSARY_MODE=cloud`) while its pull request has the label `cloud-preview` (adding or removing the label
redeploys it in the other mode); production is one when the `production` environment sets `COMMISSARY_MODE=cloud`
([Commissary Cloud](#commissary-cloud)); the `cloud` stage always is ([The Commissary Cloud stage](#the-commissary-cloud-stage)). Everything
else in this file describes a self-hosted Commissary, the default.

Deploys run only after typecheck, lint, workflow lint (actionlint, zizmor), the test shards and the smoke test pass.
Fork and Dependabot pull requests get the checks but no preview (they receive no deploy secrets). A manual run
(`workflow_dispatch`) on `main` redeploys production.

After each deploy, `tools/check-deploy.sh` checks where Access sits (ADR 0022): `/healthz` and `/v9/management/me`
answer 200 through Access with the CI service token (the second proves that the Worker accepts the Access JWT: team
domain and AUD wired); `/v1/models` and `/v1beta/models` without credentials reach the Worker, which answers
`401 Missing API key` itself (the client API is outside Access, behind API keys); `/v1/models` with an Access JWT
in `cf-access-token` and a dummy `Authorization` key, the way `cloudflared access` clients call it, answers 200 (the
JWT is the `CF_Authorization` cookie Access set for the service token); and `/` without credentials is stopped by
Access. A Commissary Cloud deploy is checked by `tools/check-cloud-deploy.sh` instead: `/healthz` answers 200,
`/api/sign-in-options` offers a provider, `/v9/management/me` answers `401 Not signed in` from the Worker, `/` redirects
to `/sign-in`, and the client API answers `401 Missing API key`. With an API host ([API host](#api-host)) both
scripts send the client API to it and also check that each host refuses the other's paths with the Worker's `404`.
The deploy job then shows the URL on the run, and previews get a pull request comment (`tools/preview-comment.sh`) that is updated on every push.

## Preview stages

A stage named `pr-<number>` is a preview (`infra/settings.ts`):

- Its own Worker on `workers.dev`, protected by its own Access application. The Worker enrolls into it (Alchemy's
  Worker `access` prop), so Access covers the `workers.dev` URL; no custom hostname is needed. The client API paths of that
  URL get the same bypass application as production ([ACCESS.md](ACCESS.md#1-what-the-deploy-creates)).
- Same policies as production: `ACCESS_ALLOW_*` for people, `ACCESS_ALLOW_SERVICE_TOKEN_IDS` for the CI token. Same
  platform admins (`PLATFORM_ADMIN_EMAILS`).
- Empty KV, D1 and Durable Objects, and no cron trigger. A preview has no provider credentials, so it serves the panel,
  the management API and the routes but cannot serve real requests. Add credentials through its panel if you need to.
- `COMMISSARY_DOMAIN`, `COMMISSARY_API_DOMAIN`, `ACCESS_AUD` and `ACCESS_SERVICE_TOKENS` are ignored: one URL serves
  everything.

Any machine with the deploy settings can deploy a preview by hand: `pnpm run deploy --stage pr-123`, and remove it with
`pnpm run destroy --stage pr-123`.

## API host

`COMMISSARY_API_DOMAIN` (optional, ADR 0028) gives a deployment a second hostname, the **API host**, that serves the
client API (`/v1`, `/v1beta`, `/v1internal`, `/openai/v1`, `/backend-api/codex`, `/chat/completions`, `/completions`,
`/responses`) and `/healthz`, and nothing else. `COMMISSARY_DOMAIN` becomes the **app host**: the control panel, sign-in
and the management API, and no client API route. One Worker answers on both custom domains and decides by hostname
(`apps/app/src/http/hosts.ts`); a path on the wrong host answers `404` with the host that serves it. The panel's API keys page
tells clients the API host (`GET /me` `api_url`).

- **Self-hosted:** Access covers the app host only; the API host has no Access application and the bypass application
  of the client API paths is not created (an existing one is deleted). Clients that sign in through Access send the app
  application's token (`cloudflared access token -app=https://<app host>`) to the API host in `cf-access-token`.
- **Commissary Cloud:** register the OAuth callbacks and the Turnstile hostname for the app host, where sign-in happens.
- **Moving to an API host** changes the address of every client: point them at the API host when the deploy finishes
  (their old base URL answers `404`). On Commissary Cloud people sign in again: the session cookie belongs to the old
  hostname. Unsetting the variable moves everything back to one host.
- Both hostnames must be in zones of the account; `pnpm ci:setup` writes the variable into the environment and extends
  the deploy token to the API host's zone.

## Commissary Cloud

Commissary Cloud (ADR 0029; the mode of ADR 0026, `COMMISSARY_MODE=cloud`) has no Access application: the Worker signs people in with GitHub and/or
Google (Better Auth), anyone may sign up, and each new person gets a Personal org they own. Platform admins are the
people in `PLATFORM_ADMIN_EMAILS` signed in with that email verified by the provider; `PLATFORM_ADMIN_SERVICE_TOKENS`
and every `ACCESS_*` setting are ignored, and scripts use management keys ([ACCESS.md](ACCESS.md#commissary-cloud)).

| Setting                                                    | Kind        | Meaning                                                               |
| ---------------------------------------------------------- | ----------- | --------------------------------------------------------------------- |
| `COMMISSARY_MODE`                                          | variable    | `cloud`; unset or `self-hosted` for a self-hosted Commissary          |
| `SIGN_IN_GITHUB_CLIENT_ID`, `SIGN_IN_GITHUB_CLIENT_SECRET` | var, secret | a GitHub OAuth app (or GitHub App); offered when both are set         |
| `SIGN_IN_GOOGLE_CLIENT_ID`, `SIGN_IN_GOOGLE_CLIENT_SECRET` | var, secret | a Google OAuth client (web application); offered when both are set    |
| `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY`               | var, secret | a Cloudflare Turnstile widget for the deploy's hostname (required)    |
| `OWNED_ORG_LIMIT`                                          | variable    | orgs a person may own unless a platform admin raises it (default 3)   |
| `ORG_RATE_LIMIT`                                           | variable    | requests per minute each org may send on the client API (default 600) |
| `ORG_RATE_LIMIT_NAMESPACE_ID`                              | variable    | the Workers rate-limit namespace, a positive integer (default 7201)   |

At least one provider and the Turnstile keys are required: the deploy refuses a Commissary Cloud stage without them.
`BETTER_AUTH_SECRET` is minted like the `auth_index` key (an Alchemy `Random`, resource `BetterAuthSecret`); nothing to
set. Replacing it signs everyone out.

1. **OAuth apps.** Register the callback `https://<host>/api/auth/callback/github` (GitHub) and
   `https://<host>/api/auth/callback/google` (Google, "Authorized redirect URIs"), where `<host>` is
   `COMMISSARY_DOMAIN` (the app host when there is an API host). The Worker reads the verified email and stores no provider token. A
   GitHub OAuth app takes a single callback host, so use one app per hostname; a GitHub App takes up to ten callback
   URLs and Google any number.
2. **Turnstile.** Create a widget (Cloudflare dashboard, Turnstile) for the hostname, managed mode.
3. **Settings.** Put them in `.env` (`.env.example` lists them) for local deploys. For CI, `pnpm ci:setup` writes the
   ones `.env` sets into both GitHub environments (the ids and limits as variables, the client secrets and the
   Turnstile secret as secrets), and `COMMISSARY_MODE=cloud` into `production` when `.env` sets it. Set them by hand in
   the GitHub environments otherwise.
4. **Deploy.** The D1 migration `0008_hosted_auth.sql` adds Better Auth's tables (`auth_user`, `auth_session`,
   `auth_account`, `auth_verification`); every deploy applies it, also on a self-hosted Commissary, where they stay empty.
   The Platform registry and each ControlPlane add their new tables and columns on first use.

**Single sign-on.** Orgs set up their own identity providers on the panel ([ACCESS.md](ACCESS.md#single-sign-on-for-an-org));
the deploy needs nothing for it: no setting, binding or D1 migration (the providers and domains live in each org's
ControlPlane and the domain index in the Platform registry, created on first use). The Worker reaches the identity
providers and `cloudflare-dns.com` (domain proof) with `fetch`.

**Commissary Cloud previews.** A preview with the `cloud-preview` label uses the `preview` environment's sign-in settings and
serves its `workers.dev` URL, so a sign-in completes only after that URL's callback is registered with the provider
(and its hostname added to the Turnstile widget). Previews share the rate-limit namespace with each other, and with
production when the environments set the same `ORG_RATE_LIMIT_NAMESPACE_ID`: the org `global` exists on every stage
under the same id, so give `preview` its own namespace.

### The Commissary Cloud stage

Next to `prod`, which stays self-hosted behind Access, CI deploys Commissary Cloud from `main`: the stage `cloud` (the Commissary Cloud stage), with
its own hostname, Worker, storage and users. The two share nothing but the code: an org, account or API key of one
does not exist on the other. The stage is always Commissary Cloud; the deploy refuses it without `COMMISSARY_MODE=cloud`, so it can
never take the self-hosted Commissary's hostname from `.env`.

Its settings live in `.env.cloud` (copy `.env.cloud.example`), never in `.env`, which keeps the self-hosted Commissary's
and the Commissary Cloud previews'. Set them up once:

1. **Hostname.** Pick one in a zone of the account, other than `COMMISSARY_DOMAIN` of `.env`, and optionally an API
   host (`COMMISSARY_API_DOMAIN`, [API host](#api-host)). The other steps use the app host.
2. **OAuth apps.** A GitHub OAuth app for that hostname (a GitHub OAuth app takes one callback host, so not the
   previews' app) with the callback `https://<host>/api/auth/callback/github`; for Google, add
   `https://<host>/api/auth/callback/google` to the client's redirect URIs.
3. **Turnstile.** Add the hostname to a widget (or create one) and put its keys in `.env.cloud`.
4. **Rate-limit namespace.** An `ORG_RATE_LIMIT_NAMESPACE_ID` that the previews' environment does not use.
5. **CI.** `pnpm ci:setup` creates the GitHub environment `cloud` (deployments from `main` only) with the settings of
   `.env.cloud`, and extends the deploy token to the hostname's zone. Until then the `deploy cloud` job of a push to
   `main` only notes that it is not set up.

The next push to `main` (or a manual run) deploys it and checks it with `tools/check-cloud-deploy.sh`. Whoever signs in with an
email of `PLATFORM_ADMIN_EMAILS` (verified by the provider) is a platform admin. By hand, `pnpm deploy:cloud`
deploys the stage from `.env.cloud` alone (`alchemy deploy --stage cloud --env-file .env.cloud`).

**Switching a stage.** Turning a self-hosted stage into a Commissary Cloud one deletes its Access applications, policies and
service tokens on the next deploy, and scripts with Access service tokens stop working: issue management keys first.
Members keep their orgs and roles, and sign in with a provider account whose verified email is their membership email.
`global`'s auto-join stops admitting anyone (on Commissary Cloud nobody joins `global` by signing in), so add the people
who should stay in it as members first.

## Setup

There are two Alchemy stacks. `commissary` (`alchemy.run.ts`) is Commissary itself, with the stages `prod`, `cloud` and
`pr-<number>`; its Worker's logical ID is `Commissary`. CI's credentials are code: `commissary-github`
(`stacks/github.ts`, stage `ci`) is the second stack, which creates them and writes them into GitHub.
It manages:

- the GitHub environments `production` (deployments from `main` only, no reviewers: a green push deploys) and
  `preview`, and `cloud` (like `production`) when `.env.cloud` exists ([The Commissary Cloud stage](#the-commissary-cloud-stage));
- `commissary-ci-deploy`, an account-owned Cloudflare API token limited to what `alchemy.run.ts` deploys: Workers Scripts,
  Workers KV Storage, D1, Secrets Store (Alchemy's state store) and Access: Apps and Policies (Write), Account Settings
  (Read), and Zone Read, DNS Write and Workers Routes Write on the zones of `COMMISSARY_DOMAIN` and
  `COMMISSARY_API_DOMAIN` (and of the `cloud` stage's);
- `commissary-ci-check`, the Access service token of the post-deploy check;
- in both environments, the secrets `CLOUDFLARE_API_TOKEN`, `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET` and the
  variables `CLOUDFLARE_ACCOUNT_ID`, `ACCESS_*` (from `.env`) and `ACCESS_ALLOW_SERVICE_TOKEN_IDS` (the check token's
  ID); in `production` also `COMMISSARY_DOMAIN` and `COMMISSARY_API_DOMAIN`; and Commissary Cloud's settings where `.env` sets them
  ([Commissary Cloud](#commissary-cloud));
- in `cloud`, the secret `CLOUDFLARE_API_TOKEN` and the settings of `.env.cloud` (no Access settings or check token).

Raw secrets never leave Alchemy: Cloudflare returns them once, they go to the encrypted state store and are encrypted
again for GitHub.

### 1. An `admin` profile (once)

Creating API tokens needs more than the everyday OAuth login, so the stack deploys with a separate Alchemy profile:

```bash
pnpm exec alchemy profile create admin
pnpm exec alchemy profile edit --profile admin
```

For Cloudflare, use the **Global API Key** (with your email), or an API token with **Account → API Tokens: Write** and
**Account → Access: Service Tokens: Write**. For GitHub, choose `gh` (GitHub CLI, needs repository admin). Treat this
profile like root: use it only for this stack.

### 2. Deploy the CI stack

```bash
pnpm ci:setup
```

It runs `alchemy deploy --config stacks/github.ts --stage ci --profile admin` and prints the outputs. Copy
`checkServiceTokenId` into `ACCESS_ALLOW_SERVICE_TOKEN_IDS` in your local `.env`: a local deploy of `prod` without it
removes the CI token from the production policy and the next CI check fails.

Re-run `pnpm ci:setup` to apply changed permissions or `.env` values. To rotate the deploy token, destroy and redeploy
the stack (`pnpm exec alchemy destroy --config stacks/github.ts --stage ci --profile admin`, then `pnpm ci:setup`).

## Operations

- **Control panel.** CI builds the control panel from `apps/web` (`pnpm build`, into `apps/web/dist/`) before each
  deploy.
- **API keys.** The deploy adds, after the Worker (the bypass depends on the Worker's output, so the old Worker
  never serves the client API without Access in front), an Access application with a Bypass policy on the client API paths (`/v1*`,
  `/openai/v1*`, `/backend-api/codex*`, `/chat/completions`, `/completions`, `/responses`), so clients reach the
  Worker with an API key and no Access sign-in ([ACCESS.md](ACCESS.md#api-keys)). From that deploy on, clients that
  send Access service token headers to those paths are refused: move them to API keys first
  ([MIGRATION.md](MIGRATION.md#5-move-clients-to-api-keys)). `cloudflared access` tokens (`cf-access-token`) keep
  working in `global` while its `access_clients` setting is on. The keys live in each org's ControlPlane (tables
  created on first use): no migration to run. With your own application (`ACCESS_AUD`) the deploy creates no bypass;
  add one yourself.
- **Platform registry and orgs.** The `Platform` Durable Object (the list of orgs, ADR 0021) is a new class that the
  next deploy adds; its tables are created on first use, so there is no migration to run, and the org `global` (slug
  `default`) exists from the start with everything the deployment stored before. Nothing has to change in `.env` or
  in GitHub: `ACCESS_ADMIN_EMAILS` and `ACCESS_ADMIN_SERVICE_TOKENS` are still read, as aliases of
  `PLATFORM_ADMIN_EMAILS` and `PLATFORM_ADMIN_SERVICE_TOKENS`, and the Worker logs a warning until they are renamed
  (rename them in `.env` and, for CI, in the GitHub variables: `pnpm ci:setup` writes the new name). The addresses of the
  panel and the management API without an org keep meaning `global`; the panel at `/` then redirects to `/o/default/`
  (see [ACCESS.md](ACCESS.md#platform-admins-and-orgs)). The model catalog's refresh lease moved to the registry; an
  unreleased one in the old place only expires.
- **State.** Deploys use the Alchemy state store in the account (`Cloudflare.state()`), shared by CI and local
  machines; `deploy --yes` also upgrades the state store when Alchemy needs a newer version.
- **Concurrency.** One deploy per stage at a time, never cancelled midway; a newer push to `main` waits for the
  running production deploy.
- **Stale previews.** If a destroy fails, rerun the job, or run `pnpm run destroy --stage pr-<number>` locally.
- **`auth_index` key.** `AUTH_INDEX_KEY` (the HMAC key of the credential handle `auth_index`,
  `apps/app/src/management/auth-index.ts`) is an Alchemy `Random` in `alchemy.run.ts`: minted on a stage's first deploy, kept in
  the (encrypted) state store and bound as a Worker secret on every deploy. No GitHub secret or manual step is needed.
  `alchemy dev` uses a fixed key (`DEV_AUTH_INDEX_KEY`), the tests the one in `apps/app/vitest.config.ts`. A Worker with Access
  configured refuses that dev key and any key shorter than 64 characters, and logs the refusal: management calls that
  need an index fail (500), while serving requests keeps working (its request log lines then carry no `authIndex`).
- **Secrets key.** Every org's stored secrets (auth files and config entries, see ARCHITECTURE.md _Stored secrets_) are
  encrypted with the org's data key, which is stored wrapped by the stage's `SECRETS_KEY`. Like the `auth_index` key it
  is an Alchemy `Random` in `alchemy.run.ts` (resource `SecretsKey`, one per generation), minted on the stage's first
  deploy and bound as a Worker secret; no GitHub secret or manual step is needed. `alchemy dev` uses
  `DEV_SECRETS_KEY`, the tests the keys in `apps/app/vitest.config.ts`; a Worker with Access configured refuses that dev key and
  any key shorter than 64 characters. Without a working key no ControlPlane starts: model traffic and management calls of
  every org fail (500) and the Worker logs `the ControlPlane cannot open the org's data key` with the reason, until a
  deploy binds the right key. **Losing the key loses every stored secret**: do not destroy the stage's state or its
  `SecretsKey` resource while the stage is in use.
- **First deploy with encryption.** Each org's ControlPlane encrypts what it stored in plain text on its first start
  after the deploy (a Durable Object SQLite migration, in one transaction; there is no D1 migration) and logs
  `created the org's data key and sealed its stored secrets`. **There is no rollback after that start**: an earlier
  version reads the sealed values as broken JSON. To go back, deploy a fix forward.
- **Rotating the secrets key.** Set `SECRETS_KEY_GENERATION` to the next number (it starts at 1) and
  `SECRETS_KEY_PREVIOUS_GENERATION` to the current one, in `.env` and as GitHub variables for CI, then deploy: the
  deploy mints the new key and binds the old one as `SECRETS_KEY_PREVIOUS`. Each ControlPlane, on its next start, wraps
  its data key under the new key (`wrapped the org's data key under the new SECRETS_KEY`); nothing else is encrypted
  again. Keep the previous generation set until every org has started (the cron trigger, every 3 hours, runs
  per-org tasks on every org's ControlPlane, so one full cron run after the deploy is enough), then unset
  `SECRETS_KEY_PREVIOUS_GENERATION` and deploy again. An org that had not started by then fails until the previous
  generation is set again. Every generation up to `SECRETS_KEY_GENERATION` stays declared in the stack (`SecretsKey`,
  `SecretsKey2`, …), so an old key is never deleted: **never lower `SECRETS_KEY_GENERATION`**, which would delete the
  newer keys from the state and, with them, every secret they protect. With `ALCHEMY_STATE=local` the keys sit in plain
  text under `.alchemy/`, like the `auth_index` key below.
- **`auth_index` values change once.** Indexes are computed on read, never stored, so the first deploy with the keyed
  index (or a new key: destroying a stage, replacing its `AuthIndexKey` resource, or a state entry that fails to
  decrypt, after which the next deploy mints a new key) changes every `auth_index` at once. With
  `ALCHEMY_STATE=local` the key sits in plain text under `.alchemy/` on that machine: protect that directory like the
  key itself, and expect a new key (and new indexes) when it is deleted or another machine deploys with its own local
  state. Nothing stored needs migrating, but bookmarked panel links `/accounts/<auth_index>`, `/usage?account=…`
  addresses and `auth_index` values saved by usage collectors from earlier exports stop matching; open the account
  from the Accounts page again. Clients that filtered usage with `auth_id` must switch to `auth_index` (the old
  parameter answers 400).

## Cutover to the Commissary stacks

The rename to Commissary (issue #122) changes every deployed and stored name: the stacks (`commissary`,
`commissary-github`), the Worker's logical ID (`Commissary`), the Commissary Cloud stage (`cloud`, settings in
`.env.cloud`), the settings (`COMMISSARY_*`, `COMMISSARY_MODE=self-hosted|cloud`), the preview label
(`cloud-preview`), the key prefixes (`cms_` for API keys, `cmsm_` for management keys), the ControlPlane tables and the
secrets-key salt. Nothing migrates: every stage starts fresh with empty storage, old keys stop working, and the old
stacks are destroyed first. A person with the `admin` profile runs it (issue #123):

1. **Save what you will re-create**, from `main` before the merge: each org's Go config (`GET /v9/management/export`),
   its members, teams, grants, spend limits and SSO settings, and the OAuth credentials to log in to again.
2. **Destroy the old stacks**, still on the code before the rename: let every open pull request with a live preview
   close, then `pnpm run destroy --stage prod`, `pnpm run destroy --stage hosted --env-file .env.hosted` and the CI stack
   (`pnpm exec alchemy destroy --config stacks/github.ts --stage ci --profile admin`). The old and new CI stacks manage
   the same GitHub environments and secrets, so the old one goes before `pnpm ci:setup` runs from the new code.
3. **Bring up the new stacks**: rename `.env.hosted` to `.env.cloud` and the settings to their `COMMISSARY_*` names
   (`.env.example`, `.env.cloud.example`), rename the label (`gh label edit hosted-preview --name cloud-preview`), run
   `pnpm ci:setup` (environments `production`, `preview` and `cloud`), then merge: CI deploys `prod` and `cloud`.
4. **Re-create and reconnect**: sign in, re-create the orgs and import their configs, log in to the OAuth credentials
   again, mint new API keys and management keys, and update every client.
