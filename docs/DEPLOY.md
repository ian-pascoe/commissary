# Continuous deployment

`.github/workflows/ci.yml` checks every pull request and push to `main`, then deploys with Alchemy:

| Event                                    | Stage         | Where                                                        |
| ---------------------------------------- | ------------- | ------------------------------------------------------------ |
| Push to `main`                           | `prod`        | `CF_LLM_PROXY_DOMAIN`, GitHub environment `production`       |
| Pull request from a branch of this repo  | `pr-<number>` | the Worker's `workers.dev` URL, GitHub environment `preview` |
| That pull request closed (merged or not) | `pr-<number>` | destroyed                                                    |

A preview is a hosted proxy while its pull request has the label `hosted-preview` (adding or removing the label
redeploys it in the other mode); production is one when the `production` environment sets `PROXY_MODE=hosted`
([Hosted proxy](#hosted-proxy)). Everything else in this file describes a self-hosted proxy, the default.

Deploys run only after typecheck, lint, workflow lint (actionlint, zizmor), the test shards and the smoke test pass.
Fork and Dependabot pull requests get the checks but no preview (they receive no deploy secrets). A manual run
(`workflow_dispatch`) on `main` redeploys production.

After each deploy, `tools/check-deploy.sh` checks where Access sits (ADR 0022): `/healthz` and `/v8/management/me`
answer 200 through Access with the CI service token (the second proves that the Worker accepts the Access JWT: team
domain and AUD wired); `/v1/models` and `/v1beta/models` without credentials reach the Worker, which answers
`401 Missing API key` itself (the proxy routes are outside Access, behind proxy keys); `/v1/models` with an Access JWT
in `cf-access-token` and a dummy `Authorization` key, the way `cloudflared access` clients call it, answers 200 (the
JWT is the `CF_Authorization` cookie Access set for the service token); and `/` without credentials is stopped by
Access. A hosted deploy is checked by `tools/check-hosted-deploy.sh` instead: `/healthz` answers 200,
`/api/sign-in-options` offers a provider, `/v8/management/me` answers `401 Not signed in` from the Worker, `/` redirects
to `/sign-in`, and the proxy routes answer `401 Missing API key`. The deploy job then shows
the URL on the run, and previews get a pull request comment (`tools/preview-comment.sh`) that is updated on every push.

## Preview stages

A stage named `pr-<number>` is a preview (`infra/settings.ts`):

- Its own Worker on `workers.dev`, protected by its own Access application. The Worker enrolls into it (Alchemy's
  Worker `access` prop), so Access covers the `workers.dev` URL; no custom hostname is needed. The proxy paths of that
  URL get the same bypass application as production ([ACCESS.md](ACCESS.md#1-what-the-deploy-creates)).
- Same policies as production: `ACCESS_ALLOW_*` for people, `ACCESS_ALLOW_SERVICE_TOKEN_IDS` for the CI token. Same
  platform admins (`PLATFORM_ADMIN_EMAILS`).
- Empty KV, D1 and Durable Objects, and no cron trigger. A preview has no provider credentials, so it serves the panel,
  the management API and the routes but cannot proxy real requests. Add credentials through its panel if you need to.
- `CF_LLM_PROXY_DOMAIN`, `ACCESS_AUD` and `ACCESS_SERVICE_TOKENS` are ignored.

Any machine with the deploy settings can deploy a preview by hand: `pnpm run deploy --stage pr-123`, and remove it with
`pnpm run destroy --stage pr-123`.

## Hosted proxy

A hosted proxy (ADR 0026, `PROXY_MODE=hosted`) has no Access application: the Worker signs people in with GitHub and/or
Google (Better Auth), anyone may sign up, and each new person gets a Personal org they own. Platform admins are the
people in `PLATFORM_ADMIN_EMAILS` signed in with that email verified by the provider; `PLATFORM_ADMIN_SERVICE_TOKENS`
and every `ACCESS_*` setting are ignored, and scripts use management keys ([ACCESS.md](ACCESS.md#hosted-proxy)).

| Setting                                                    | Kind        | Meaning                                                                 |
| ---------------------------------------------------------- | ----------- | ----------------------------------------------------------------------- |
| `PROXY_MODE`                                               | variable    | `hosted`; unset or `self-hosted` for a self-hosted proxy                |
| `SIGN_IN_GITHUB_CLIENT_ID`, `SIGN_IN_GITHUB_CLIENT_SECRET` | var, secret | a GitHub OAuth app (or GitHub App); offered when both are set           |
| `SIGN_IN_GOOGLE_CLIENT_ID`, `SIGN_IN_GOOGLE_CLIENT_SECRET` | var, secret | a Google OAuth client (web application); offered when both are set      |
| `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY`               | var, secret | a Cloudflare Turnstile widget for the proxy's hostname (required)       |
| `OWNED_ORG_LIMIT`                                          | variable    | orgs a person may own unless a platform admin raises it (default 3)     |
| `ORG_RATE_LIMIT`                                           | variable    | requests per minute each org may send on the proxy routes (default 600) |
| `ORG_RATE_LIMIT_NAMESPACE_ID`                              | variable    | the Workers rate-limit namespace, a positive integer (default 7201)     |

At least one provider and the Turnstile keys are required: the deploy refuses a hosted stage without them.
`BETTER_AUTH_SECRET` is minted like the `auth_index` key (an Alchemy `Random`, resource `BetterAuthSecret`); nothing to
set. Replacing it signs everyone out.

1. **OAuth apps.** Register the callback `https://<host>/api/auth/callback/github` (GitHub) and
   `https://<host>/api/auth/callback/google` (Google, "Authorized redirect URIs"), where `<host>` is
   `CF_LLM_PROXY_DOMAIN`. The Worker reads the verified email and stores no provider token. A
   GitHub OAuth app takes a single callback host, so use one app per hostname; a GitHub App takes up to ten callback
   URLs and Google any number.
2. **Turnstile.** Create a widget (Cloudflare dashboard, Turnstile) for the hostname, managed mode.
3. **Settings.** Put them in `.env` (`.env.example` lists them) for local deploys. For CI, `pnpm ci:setup` writes the
   ones `.env` sets into both GitHub environments (the ids and limits as variables, the client secrets and the
   Turnstile secret as secrets), and `PROXY_MODE=hosted` into `production` when `.env` sets it. Set them by hand in
   the GitHub environments otherwise.
4. **Deploy.** The D1 migration `0008_hosted_auth.sql` adds Better Auth's tables (`auth_user`, `auth_session`,
   `auth_account`, `auth_verification`); every deploy applies it, also on a self-hosted proxy, where they stay empty.
   The Platform registry and each ControlPlane add their new tables and columns on first use.

**Hosted previews.** A preview with the `hosted-preview` label uses the `preview` environment's sign-in settings and
serves its `workers.dev` URL, so a sign-in completes only after that URL's callback is registered with the provider
(and its hostname added to the Turnstile widget). Previews share the rate-limit namespace with each other, and with
production when the environments set the same `ORG_RATE_LIMIT_NAMESPACE_ID`: the org `global` exists on every stage
under the same id, so give `preview` its own namespace.

**Switching a stage.** Turning a self-hosted stage into a hosted one deletes its Access applications, policies and
service tokens on the next deploy, and scripts with Access service tokens stop working: issue management keys first.
Members keep their orgs and roles, and sign in with a provider account whose verified email is their membership email.
`global`'s auto-join stops admitting anyone (on a hosted proxy nobody joins `global` by signing in), so add the people
who should stay in it as members first.

## Setup

CI's credentials are code: `stacks/github.ts` is a second Alchemy stack that creates them and writes them into GitHub.
It manages:

- the GitHub environments `production` (deployments from `main` only, no reviewers: a green push deploys) and
  `preview`;
- `cf-llm-proxy-ci-deploy`, an account-owned Cloudflare API token limited to what `alchemy.run.ts` deploys: Workers Scripts,
  Workers KV Storage, D1, Secrets Store (Alchemy's state store) and Access: Apps and Policies (Write), Account Settings
  (Read), and Zone Read, DNS Write and Workers Routes Write on the zone of `CF_LLM_PROXY_DOMAIN`;
- `cf-llm-proxy-ci-check`, the Access service token of the post-deploy check;
- in both environments, the secrets `CLOUDFLARE_API_TOKEN`, `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET` and the
  variables `CLOUDFLARE_ACCOUNT_ID`, `ACCESS_*` (from `.env`) and `ACCESS_ALLOW_SERVICE_TOKEN_IDS` (the check token's
  ID); in `production` also `CF_LLM_PROXY_DOMAIN`; and a hosted proxy's settings where `.env` sets them
  ([Hosted proxy](#hosted-proxy)).

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

- **Control panel.** CI builds the control panel from `web/` (`pnpm web:build`) before each deploy; nothing else is
  installed into `public/`.
- **Proxy keys.** The deploy adds, after the Worker (the bypass depends on the Worker's output, so the old Worker
  never serves the proxy routes without Access in front), an Access application with a Bypass policy on the proxy paths (`/v1*`,
  `/openai/v1*`, `/backend-api/codex*`, `/chat/completions`, `/completions`, `/responses`), so clients reach the
  Worker with a proxy key and no Access sign-in ([ACCESS.md](ACCESS.md#proxy-keys)). From that deploy on, clients that
  send Access service token headers to those paths are refused: move them to proxy keys first
  ([MIGRATION.md](MIGRATION.md#5-move-clients-to-proxy-keys)). `cloudflared access` tokens (`cf-access-token`) keep
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
  `src/management/auth-index.ts`) is an Alchemy `Random` in `alchemy.run.ts`: minted on a stage's first deploy, kept in
  the (encrypted) state store and bound as a Worker secret on every deploy. No GitHub secret or manual step is needed.
  `alchemy dev` uses a fixed key (`DEV_AUTH_INDEX_KEY`), the tests the one in `vitest.config.ts`. A Worker with Access
  configured refuses that dev key and any key shorter than 64 characters, and logs the refusal: management calls that
  need an index fail (500), while proxying keeps working (its request log lines then carry no `authIndex`).
- **Secrets key.** Every org's stored secrets (auth files and config entries, see ARCHITECTURE.md _Stored secrets_) are
  encrypted with the org's data key, which is stored wrapped by the stage's `SECRETS_KEY`. Like the `auth_index` key it
  is an Alchemy `Random` in `alchemy.run.ts` (resource `SecretsKey`, one per generation), minted on the stage's first
  deploy and bound as a Worker secret; no GitHub secret or manual step is needed. `alchemy dev` uses
  `DEV_SECRETS_KEY`, the tests the keys in `vitest.config.ts`; a Worker with Access configured refuses that dev key and
  any key shorter than 64 characters. Without a working key no ControlPlane starts: proxying and management calls of
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
