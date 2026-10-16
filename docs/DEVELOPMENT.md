# Development guide

Developer notes for the TypeScript/Effect Worker. User-facing docs: [`README.md`](../README.md).
Design decisions: [`ARCHITECTURE.md`](ARCHITECTURE.md) (module layout, runtime topology, per-subsystem behaviour and
where it differs from Go).

The Go server ([router-for-me/CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)) is a reference, not the
authority (ADR 0019). It is not part of this repository: `pnpm install` (the `prepare` script, skipped when `CI` is set) clones it into
`.repos/CLIProxyAPI` as a read-only reference. pnpm skips `prepare` when dependencies are already up to date, so refresh
it with `pnpm repos:sync` (`tools/sync-reference-repos.sh`, a fast-forward of upstream `main`).
Go paths cited in code and docs (`internal/...`, `sdk/...`) are relative to that checkout.

## Requirements

- Node.js 22+ (CI uses the version in `.node-version`) and pnpm (`devEngines.packageManager` in `package.json`).
- Go (only for `tools/fixturegen`) and the reference checkout above.

## Commands

Run from the repository root. `typecheck`, `lint`, `test` and `build` run through Turborepo (`turbo.json`), which
caches each task: run again with no change, a task replays its logs (and `build` its output) instead of running. See
"Workspace and Turborepo" below.

| Script                              | Purpose                                                                                                                                                                               |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm install`                      | Install dependencies and clone/update the Go reference checkout (`.repos/`)                                                                                                           |
| `pnpm repos:sync`                   | Clone or fast-forward the reference repositories in `.repos/` (`tools/sync-reference-repos.sh`)                                                                                       |
| `pnpm dev`                          | Builds the panel, then `alchemy dev`: local Worker in workerd with emulated DO/KV/D1, hot reload (`ALCHEMY_STATE=local` avoids a Cloudflare login)                                    |
| `pnpm build`                        | Build the control panel (`apps/web`) into `apps/web/dist/` (the Worker's assets, served at `/`)                                                                                       |
| `pnpm --filter @commissary/web dev` | Vite dev server for the panel on :5173 with hot reload, forwarding `/v9` to `pnpm dev` (`COMMISSARY_DEV_URL`, default :1337)                                                          |
| `pnpm typecheck`                    | `tsc` over every program: each package's `typecheck` (Worker, panel, contract) and the root's deploy code (`typecheck:root`, `tsconfig.infra.json`)                                   |
| `pnpm lint`                         | `lint:root`: `oxlint` over the whole repository (type-aware, with type checking, Effect and anti-slop rules) + `oxfmt --check`                                                        |
| `pnpm format`                       | `oxfmt`                                                                                                                                                                               |
| `pnpm test`                         | Each package's `vitest run`: the Worker's inside the Workers runtime (`@cloudflare/vitest-plugin`), the panel's in Node.js; arguments go to every run (`pnpm test --shard=1/3`)       |
| `pnpm smoke`                        | Builds the panel, boots `alchemy dev` with local state, checks a few routes, stops it (bundle + startup check)                                                                        |
| `pnpm plan`                         | `alchemy plan`: preview infrastructure changes (needs a Cloudflare profile)                                                                                                           |
| `pnpm run deploy`                   | `alchemy deploy` (`pnpm deploy` is a pnpm built-in; use `run`)                                                                                                                        |
| `pnpm destroy`                      | `alchemy destroy`: delete every resource of a stage                                                                                                                                   |
| `pnpm logs`                         | `alchemy logs` (`--tail`)                                                                                                                                                             |
| `pnpm ci:setup`                     | Deploy `stacks/github.ts`: CI's Cloudflare token, check service token and GitHub environments (`docs/DEPLOY.md`)                                                                      |
| `pnpm catalog:sync`                 | Regenerate the bundled models.dev snapshot `apps/app/src/registry/catalog/models-dev.json` (`tools/sync-models-dev-catalog.ts [url\|file]`); the catalog additions are edited by hand |

## Infrastructure

`alchemy.run.ts` is the composition root of the deployed resources (`stacks/github.ts`, a separate stack, holds CI's
credentials) (Alchemy v2, Effect-based); `infra/settings.ts` reads
the deploy settings (`.env`), `infra/access.ts` provisions Cloudflare Access. There is no Wrangler configuration. When you
add a binding or variable, change three places together: the Worker's `env` in `alchemy.run.ts`, the `Env` interface in
`apps/app/src/env.d.ts`, and the test bindings in `apps/app/vitest.config.ts` (which mirrors the deployed Worker: entry, compatibility
settings, Durable Objects, `*.bin` Data modules).

`apps/app/worker-configuration.d.ts` holds the Workers runtime types for the compatibility date and flags in `alchemy.run.ts`.
Regenerate it when those change (Wrangler is used only as a type generator here):

```bash
printf '{"name":"t","main":"apps/app/src/index.ts","compatibility_date":"2026-08-01","compatibility_flags":["nodejs_compat"]}' > /tmp/rt.json
pnpm dlx wrangler@4 types --include-env=false -c /tmp/rt.json apps/app/worker-configuration.d.ts
```

then restore the three-line header comment. Durable Object classes are SQLite-backed; Alchemy derives their class migrations from the
`DurableObject` bindings (renaming a class needs `className`/`transferredFrom`, see the Alchemy docs).

## Layout

`ARCHITECTURE.md` ("Layout" plus one section per subsystem) is the map. The repository is a pnpm workspace
(`pnpm-workspace.yaml`): Workers and the panel in `apps/`, libraries in `packages/`, under the scope `@commissary/*`.

- `apps/app` (`@commissary/app`): the one Worker. `src/access` (Access JWT gate), `src/http` (router, CORS, SSE),
  `src/handlers` (inbound protocols and the shared execution pipeline), `src/translator` and `src/thinking` (pure sync
  translation), `src/executor` (one directory per provider), `src/credentials` (ControlPlane Durable Object, token
  refresh), `src/session-state` (SessionState Durable Object), `src/registry` (model catalogs and `/models`),
  `src/management` and `src/oauth` (management API, panel serving, provider logins), `src/usage` and
  `src/observability` (D1 usage records, trace ids); `test/` (workerd tests and golden fixtures).
- `apps/web` (`@commissary/web`): the control panel (below).
- `packages/contract` (`@commissary/contract`): the management API contract, shared by the Worker and the panel.
- The root stays the deploy root: `alchemy.run.ts`, `infra/`, `migrations/` (D1 schema), `stacks/`, `tools/` (with
  `tools/fixturegen`, Go programs that emit golden fixtures, see below), `go.work`, `.repos/`, `docs/` and the lint,
  format and commit configs.

## Workspace and Turborepo

Internal packages are source-only: `package.json` `exports` map `./*` to `./src/*.ts`, there is no build step, and
whatever imports a package compiles it (Alchemy's bundler, Vite, Vitest). Import a module by its subpath, e.g.
`@commissary/contract/api`. `apps/app` imports nothing from `apps/web`, and `apps/web` imports only
`@commissary/contract` from the workspace. Versions that several packages share (`effect`, `typescript`, `vitest`, …)
are pinned once in the `catalog:` of `pnpm-workspace.yaml`.

`turbo.json` declares the tasks: `typecheck`, `test` and `build` run each package's script of that name, and the root
adds `typecheck:root` (the deploy code) and `lint:root` (one `oxlint`/`oxfmt` run over the repository). The packages
depend on each other's sources, not on build output, so every package task depends on `transit`, a task with no script whose
hash covers a package's files and those of its dependencies (Turborepo's transit-node pattern): a change in
`packages/contract` re-runs the panel's and the Worker's tasks. A package's `turbo.json` adds the root files its tasks
read (`apps/app`: `infra/bundle.ts`, `infra/settings.ts`, `migrations/`). The cache is local
(`.turbo/cache`, one per git worktree: `cacheDir` keeps a worktree from writing into the main checkout's); there is
no remote cache. `pnpm exec turbo run <task> --force`
ignores it, `--dry` shows what would run and why.

## Model catalog

Every provider's models come from models.dev plus the catalog additions (ADR 0020; `docs/ARCHITECTURE.md`, "Model registry
and `/models` endpoints"). Three things are checked in under `apps/app/src/registry/catalog/`:

- `models-dev.json`: the trimmed models.dev snapshot a fresh deploy starts from. `pnpm catalog:sync` regenerates it from
  `https://models.dev/api.json` (or a URL or saved file given as argument); syncing a trimmed file rewrites it unchanged.
  A deployed Worker refreshes its own copy every 3 hours and from the Models page ("Refresh catalog").
- `additions.json`: what models.dev lacks (models it does not list, facts such as `thinking.dynamicAllowed`, Codex plans,
  `include`/`exclude` patterns). Edited by hand; the format and precedence ("an addition only fills gaps") are in the header
  of `apps/app/src/registry/catalog-additions.ts`. A wrong value for a model models.dev lists is fixed at models.dev, not overridden here.
- `codex_client_models.json`: the Codex client catalog, kept in its own format.

`apps/app/test/catalog-build.test.ts` checks the trim, the build, the additions' rules and that every id the Go server served is
still served.

## Control panel (`apps/web`)

React 19 + Vite, Effect Atom (`effect/reactivity`, `@effect/atom-react`) for server state and TanStack Router (code-based
routes in `apps/web/src/router.tsx`). It calls the management API through the shared Effect `HttpApi` contract in
`packages/contract` (imported as `@commissary/contract/*`; the contract imports `effect` only, so it stays browser-safe,
and its own `tsconfig.json` checks it with neither DOM nor Workers types). `apps/web/tsconfig.app.json` type-checks the
panel with DOM types, `tsconfig.node.json` the Vite and Vitest configs and the tests. The tests (`apps/web/test/`)
cover the DOM-free modules of `src/lib` and run in Node.js, in UTC. Design context: `PRODUCT.md` and `.impeccable/`.

Local loop: `pnpm dev` in one terminal, `pnpm --filter @commissary/web dev` in another, open http://localhost:5173 (the
dev Access bypass applies). The build output in `apps/web/dist/` is gitignored; `pnpm dev` and `pnpm smoke` build it
first, CI before smoke and deploy. A new top-level page needs its path segment in `PANEL_SECTIONS`
(`apps/app/src/access/routes.ts`) so the Worker serves `index.html` for it.

## Golden fixtures (`tools/fixturegen`)

The generators run the real Go code of the reference checkout and write `apps/app/test/fixtures/`. They form their own Go module (`tools/fixturegen/go.mod`, module path under the server's so they
may import its `internal/` packages) tied to `.repos/CLIProxyAPI` by a `replace` and the root `go.work`. Run them from the
repository root, e.g. `go run ./tools/fixturegen/translator` (use `TZ=UTC` for the translator). The model catalogs are no
longer generated from Go (ADR 0020): `…/registry` only records the listing fixtures, and `apps/app/test/fixtures/go-catalog-served.json`
(the ids Go served when the catalog moved to models.dev) is pinned, it does not follow the reference checkout.

The reference checkout follows upstream `main`, so regenerating after `pnpm repos:sync` shows what changed upstream: a
fixture diff is a change to consider (port the Go change and commit the new fixtures, or keep Commissary's behaviour and
leave the fixture as it is), not noise to commit blindly. Some
fixtures contain generated ids or timestamps that differ on every run; the tests mask those.

`tools/fixturegen/UPSTREAM_COMMIT` records the reference commit the committed fixtures were generated from (the last
ported upstream state). `tools/upstream-drift.sh` syncs the reference, regenerates every fixture, runs the tests on
them and reports the upstream commits since that commit and the test files that fail; the weekly
`.github/workflows/upstream-drift.yml` keeps one `upstream-drift` issue with that report. After porting, set
`UPSTREAM_COMMIT` to the reference commit you ported up to and commit the regenerated fixtures.

## Git hooks

`pnpm install` enables the Husky hooks in `.husky/` (the `prepare` script runs `husky`):

- `pre-commit`: lint-staged formats staged files with `oxfmt` and lints staged scripts with `oxlint --quiet` (errors
  only).
- `commit-msg`: commitlint with `@commitlint/config-conventional` (`feat:`, `fix:`, `chore:`, `docs:`, `refactor:`,
  `style:`, `test:`, `ci:`, …; header and body lines up to 100 characters).
- `pre-push`: `pnpm typecheck && pnpm lint`. The test suite runs in CI.

Skip them once with `git commit --no-verify` / `git push --no-verify`, or for a whole shell with `HUSKY=0`.

## CI and deployment

`.github/workflows/ci.yml` runs typecheck, lint, actionlint and zizmor, the tests in three shards, and the smoke test;
then deploys a preview per pull request and production from `main`. Setup and behaviour: [DEPLOY.md](DEPLOY.md).
Actions are pinned by commit SHA (Dependabot updates them weekly, `.github/dependabot.yml`), jobs get only the
permissions they need, and deploy jobs use no dependency cache.

## Lint and format

`pnpm lint` runs oxlint and `oxfmt --check`. oxlint (`.oxlintrc.json`) is type-aware (`options.typeAware`, via
`oxlint-tsgolint`) and also reports TypeScript errors (`options.typeCheck`); on top of its own rules it runs:

- **Effect tsgo** (`@effect/tsgo`, recommended preset): Effect-specific diagnostics. The `prepare` script
  (`effect-tsgo patch --no-typescript --oxlint`) patches the installed oxlint/tsgolint binaries after every install;
  `oxlint`, `oxlint-tsgolint` and `@effect/tsgo` are pinned to versions the patch supports, so upgrade them together.
- **anti-slop** (vendored in `tools/oxlint/anti-slop/`, provenance in its `UPSTREAM.md`): the copy belongs to this
  repository; edit its rules there.

Rules downgraded to warnings on purpose (reported, not failing): `effecttsgo/unstable-api-usage` (the HTTP stack is
`effect/unstable/http`), `anti-slop-effect/no-service-constructor-imports` (flags every `make*` function),
`anti-slop/no-runtime-typeof` (the translators walk arbitrary JSON like Go's gjson; `typeof` is the parse step) and
`anti-slop/no-conditional-empty-object-spread` (the `...(x === undefined ? {} : { x })` idiom required by
`exactOptionalPropertyTypes`). In `test/` folders the type-assertion and
dictionary-type rules are off (fake bindings and loose fixtures).

Errors fail lint; warnings are reported but do not. Fix findings rather than silencing them: no disable comments. A type
assertion that cannot be removed carries a `// SAFETY: <invariant>` comment on the line(s) before it.

## Conventions

- Per-request Cloudflare `env` / `ctx` are passed as the `Context` argument of the web handler
  (`handler(request, requestContext(env, ctx))`); routes read them via `yield* WorkerEnv`. Never capture them in a layer.
- Add routes as `HttpRouter.add(...)` layers and merge them into `AppLayer` in `apps/app/src/http/app.ts`.
- Never log tokens, API keys, JWTs or bodies; use `redactHeaders` when headers must be logged.
- No wall-clock sleeps in tests; use Effect `TestClock` or injected clocks.
- The Worker's tests live in `apps/app/test/*.test.ts` and run in workerd. Use `@effect/vitest` (`it.effect`) for Effect code and
  `exports.default.fetch(...)` (`cloudflare:workers`) for end-to-end Worker requests.
- `alchemy.run.ts` keeps `workersDev: false` (no `workers.dev` or preview URLs) so Cloudflare Access cannot be bypassed.

## Dependency notes

- TypeScript 7 (native `tsc`). Each program has its own tsconfig extending `tsconfig.base.json`: `apps/app/tsconfig.json`
  (Worker, workerd types), `apps/web/tsconfig.app.json` (panel, DOM types) and `tsconfig.node.json` (its Node.js side),
  `packages/contract/tsconfig.json` (no runtime types) and the root's `tsconfig.infra.json` (deploy code, Node.js
  types). `tsc` only checks (`noEmit`); Turborepo caches it. `capnp-es` (via Alchemy) declares a TypeScript 5/6 peer
  range; it only ships types, so the peer warning is harmless.
- `@cloudflare/vitest-plugin` (successor of `@cloudflare/vitest-pool-workers`) is used because it supports vitest 5,
  which `@effect/vitest@4` requires.
- `alchemy` (2.0.0 beta, pinned) needs `@effect/platform-node` for its CLI; `@distilled.cloud/cloudflare` is pinned to
  the version Alchemy uses (the Access settings step calls the Cloudflare API with Alchemy's credentials).
