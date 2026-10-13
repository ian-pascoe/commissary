# Continuous deployment

`.github/workflows/ci.yml` checks every pull request and push to `main`, then deploys with Alchemy:

| Event                                    | Stage         | Where                                                        |
| ---------------------------------------- | ------------- | ------------------------------------------------------------ |
| Push to `main`                           | `prod`        | `CF_LLM_PROXY_DOMAIN`, GitHub environment `production`       |
| Pull request from a branch of this repo  | `pr-<number>` | the Worker's `workers.dev` URL, GitHub environment `preview` |
| That pull request closed (merged or not) | `pr-<number>` | destroyed                                                    |

Deploys run only after typecheck, lint, workflow lint (actionlint, zizmor), the test shards and the smoke test pass.
Fork and Dependabot pull requests get the checks but no preview (they receive no deploy secrets). A manual run
(`workflow_dispatch`) on `main` redeploys production.

After each deploy, `tools/check-deploy.sh` calls `/healthz` and `/v1/models` through Access with the CI service token;
the second route proves that the Worker accepts the Access JWT (team domain and AUD wired). The deploy job then shows
the URL on the run, and previews get a pull request comment (`tools/preview-comment.sh`) that is updated on every push.

## Preview stages

A stage named `pr-<number>` is a preview (`infra/settings.ts`):

- Its own Worker on `workers.dev`, protected by its own Access application. The Worker enrolls into it (Alchemy's
  Worker `access` prop), so Access covers the `workers.dev` URL; no custom hostname is needed.
- Same policies as production: `ACCESS_ALLOW_*` for people, `ACCESS_ALLOW_SERVICE_TOKEN_IDS` for the CI token. Same
  platform admins (`PLATFORM_ADMIN_EMAILS`).
- Empty KV, D1 and Durable Objects, and no cron trigger. A preview has no provider credentials, so it serves the panel,
  the management API and the routes but cannot proxy real requests. Add credentials through its panel if you need to.
- `CF_LLM_PROXY_DOMAIN`, `ACCESS_AUD` and `ACCESS_SERVICE_TOKENS` are ignored.

Any machine with the deploy settings can deploy a preview by hand: `pnpm run deploy --stage pr-123`, and remove it with
`pnpm run destroy --stage pr-123`.

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
  ID); in `production` also `CF_LLM_PROXY_DOMAIN`.

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
  generation is set again. The old `SecretsKey` resource stays in the state; it is harmless.
- **`auth_index` values change once.** Indexes are computed on read, never stored, so the first deploy with the keyed
  index (or a new key: destroying a stage, replacing its `AuthIndexKey` resource, or a state entry that fails to
  decrypt, after which the next deploy mints a new key) changes every `auth_index` at once. With
  `ALCHEMY_STATE=local` the key sits in plain text under `.alchemy/` on that machine: protect that directory like the
  key itself, and expect a new key (and new indexes) when it is deleted or another machine deploys with its own local
  state. Nothing stored needs migrating, but bookmarked panel links `/accounts/<auth_index>`, `/usage?account=…`
  addresses and `auth_index` values saved by usage collectors from earlier exports stop matching; open the account
  from the Accounts page again. Clients that filtered usage with `auth_id` must switch to `auth_index` (the old
  parameter answers 400).
