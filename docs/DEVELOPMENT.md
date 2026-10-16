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

| Script                              | Purpose                                                                                                                                                                                           |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm install`                      | Install dependencies and clone/update the Go reference checkout (`.repos/`)                                                                                                                       |
| `pnpm repos:sync`                   | Clone or fast-forward the reference repositories in `.repos/` (`tools/sync-reference-repos.sh`)                                                                                                   |
| `pnpm dev`                          | Builds the panel, then `alchemy dev`: local Worker in workerd with emulated DO/KV/D1, hot reload (`ALCHEMY_STATE=local` avoids a Cloudflare login)                                                |
| `pnpm build`                        | Build the control panel (`apps/web`) into `apps/web/dist/` (the Worker's assets, served at `/`)                                                                                                   |
| `pnpm --filter @commissary/web dev` | Vite dev server for the panel on :5173 with hot reload, forwarding `/v9` to `pnpm dev` (`COMMISSARY_DEV_URL`, default :1337)                                                                      |
| `pnpm typecheck`                    | `tsc` over every program: each package's `typecheck` (Worker, panel, packages) and the root's deploy code (`typecheck:root`, `tsconfig.infra.json`)                                               |
| `pnpm lint`                         | `lint:root`: `oxlint` over the whole repository (type-aware, with type checking, Effect and anti-slop rules) + `oxfmt --check`                                                                    |
| `pnpm format`                       | `oxfmt`                                                                                                                                                                                           |
| `pnpm test`                         | Each package's `vitest run`: the Worker's inside the Workers runtime (`@cloudflare/vitest-plugin`), the panel's and the packages' in Node.js; arguments go to every run (`pnpm test --shard=1/3`) |
| `pnpm smoke`                        | Builds the panel, boots `alchemy dev` with local state, checks a few routes, stops it (bundle + startup check)                                                                                    |
| `pnpm plan`                         | `alchemy plan`: preview infrastructure changes (needs a Cloudflare profile)                                                                                                                       |
| `pnpm run deploy`                   | `alchemy deploy` (`pnpm deploy` is a pnpm built-in; use `run`)                                                                                                                                    |
| `pnpm destroy`                      | `alchemy destroy`: delete every resource of a stage                                                                                                                                               |
| `pnpm logs`                         | `alchemy logs` (`--tail`)                                                                                                                                                                         |
| `pnpm ci:setup`                     | Deploy `stacks/github.ts`: CI's Cloudflare token, check service token and GitHub environments (`docs/DEPLOY.md`)                                                                                  |
| `pnpm catalog:sync`                 | Regenerate the bundled models.dev snapshot `apps/app/src/registry/catalog/models-dev.json` (`tools/sync-models-dev-catalog.ts [url\|file]`); the catalog additions are edited by hand             |

## Infrastructure

`alchemy.run.ts` is the composition root of the deployed resources (`stacks/github.ts`, a separate stack, holds CI's
credentials) (Alchemy v2, Effect-based); `infra/settings.ts` reads
the deploy settings (`.env`), `infra/access.ts` provisions Cloudflare Access. There is no Wrangler configuration. When you
add a binding or variable, change three places together: the Worker's `env` in `alchemy.run.ts`, the `Env` interface in
`apps/app/src/env.d.ts`, and the test bindings in `apps/app/vitest.config.ts` (which mirrors the deployed Worker: entry, compatibility
settings, Durable Objects, `*.bin` Data modules). One that `@commissary/state`'s Durable Object classes read also goes into
`StateObjectEnv` (`packages/state/src/env.ts`) and the state test Worker's bindings (`packages/state/vitest.config.ts`;
its `test/env.d.ts` follows `StateObjectEnv`).

`tools/workers/worker-configuration.d.ts` holds the Workers runtime types for the compatibility date and flags in
`alchemy.run.ts`, shared by every program that runs in workerd (`apps/app`, `packages/state`; each declares its own
`Env`). Regenerate it when those change (Wrangler is used only as a type generator here):

```bash
printf '{"name":"t","main":"apps/app/src/index.ts","compatibility_date":"2026-08-01","compatibility_flags":["nodejs_compat"]}' > /tmp/rt.json
pnpm dlx wrangler@4 types --include-env=false -c /tmp/rt.json tools/workers/worker-configuration.d.ts
```

then restore the three-line header comment. Durable Object classes are SQLite-backed; Alchemy derives their class migrations from the
`DurableObject` bindings (renaming a class needs `className`/`transferredFrom`, see the Alchemy docs).

## Layout

`ARCHITECTURE.md` ("Layout" plus one section per subsystem) is the map. The repository is a pnpm workspace
(`pnpm-workspace.yaml`): Workers and the panel in `apps/`, libraries in `packages/`, under the scope `@commissary/*`.

- `apps/app` (`@commissary/app`): the one Worker. `src/access` (the gate middleware over `@commissary/auth`),
  `src/http` (router, CORS),
  `src/handlers` (inbound protocols and the shared execution pipeline), `src/executor` (one directory per provider),
  `src/control-plane.ts` (the ControlPlane Durable Object: `@commissary/state`'s org-wide base composed with the Models
  part in `src/models`), `src/credentials` (credential pool, selection, token refresh), `src/registry` (model catalogs and `/models`),
  `src/management` and `src/oauth` (management API, panel serving, provider logins), `src/usage` and
  `src/observability` (D1 usage records, trace ids); `test/` (workerd tests and golden fixtures).
- `apps/web` (`@commissary/web`): the control panel (below).
- `packages/auth` (`@commissary/auth`): request-side authentication (#132). The principal and `AccessPrincipal`, roles,
  Access JWT verification, the cross-site checks, API and management keys (their text and the per-isolate caches of
  verified keys), admission and `syncOrgIndex`, Commissary Cloud's suspension checks and rate limit, and the two gates
  behind the entry points `authenticateClient` and `authenticateManagement`; `./sso` holds the pure parts of single sign-on,
  `./testing` the Access test helpers and an in-memory `AuthDirectory`. It reads `AuthConfig` and reaches state through
  its `AuthDirectory` service (the adapter: `@commissary/state`'s `auth-directory.ts`), never through bindings or the
  stores; the Worker passes in what its routes say (path zones, role table, org addressing: `src/management/zones.ts`,
  `policy.ts`, `org-address.ts`). It may import `@commissary/core`, `@commissary/contract`, `effect` and `jose` only.
- `packages/contract` (`@commissary/contract`): the management API contract, shared by the Worker and the panel.
- `packages/core` (`@commissary/core`): the foundation without bindings, for code that two or more packages or apps
  need (today auth and the Worker import it). `src/org.ts` (the org model: `OrgId`, `newOrgId`, `OrgSlug`, `GLOBAL_ORG`,
  `DEFAULT_ORG_SLUG`, `CurrentOrg`, org-scoped names), `src/errors.ts` (the shared tagged errors), `src/hash.ts`
  (`sha256Hex`), `src/logging.ts` (`redactHeaders`), `src/observability/` (`causeSummary`, the Workers Logs logger),
  `src/http/management.ts` (the management replies and the text, query and `If-Match` readers, `handled`),
  `src/http/route-services.ts` and `src/execution-context.ts` (`WorkerExecutionContext` over a structural
  `InvocationContext`, so core needs no Workers types, and `holdInvocation`), all behind the one export `.`. It may
  import `effect` and `node:crypto` only: no bindings, no Workers APIs, no other workspace package. The per-request
  context (`requestContext`, `src/worker-env.ts`) stays in the Worker, which provides its env views, and so do
  `bodyJson`/`bodyObject` (they return `@commissary/json` values); the ControlPlane stubs (`controlPlaneOf`,
  `controlPlane`) are `@commissary/state`.
- `packages/state` (`@commissary/state`): the org-wide state on Durable Objects (#134, #149). The ControlPlane's org-wide
  base (`src/control-plane.ts`) and its stores (`src/members`, `src/api-keys`, `src/management-keys`, `src/sso`,
  `src/secrets`, the `SessionState` instances), `composeControlPlane` (`src/compose.ts`: the base with the areas' parts,
  each reached through a method of its name, `stub.models().x()`), the Platform registry (`src/platform`), the
  general-purpose lease store (`src/lease.ts`), `SessionState` (`src/session-state`: class, client, protocol, engine),
  the stub helpers (`controlPlaneOf`, `platformOf`, `currentControlPlane`, the management routes' `controlPlane`) and
  the one `AuthDirectory` adapter, all behind the one export `.`; `./testing` holds the workerd test helpers
  (`tablesOf`, `storedText`, `alarmOf`, `withPart`, `ORG_WIDE_TABLES`). It reads its bindings through `StateEnv` and its
  classes' settings from `StateObjectEnv`, and may import `@commissary/auth`, `@commissary/core`,
  `@commissary/contract` and `effect` only: nothing from an area's code or `apps/`.
- `packages/json` (`@commissary/json`): the gjson/sjson path engine over parsed JSON, the `Json` types, `isValidJson`,
  `compactJson` and `stableStringify`. Depends on nothing.
- `packages/translation` (`@commissary/translation`): pure sync translation. `src/translator` (the `TranslatorRegistry`
  and one directory per format pair), `src/thinking`, `src/signature`, `src/tokenizer` and `src/sse.ts` are internal
  modules behind the exports `.` (the registry, the built-in translators, the model lookup, the summary hooks and the
  translator helpers the executors reuse), `./thinking`, `./signature`, `./tokenizer`, `./formats`, `./sse` and
  `./testing`. It may import `effect`, `@commissary/json` and `node:crypto` only: no Workers APIs, no other workspace
  package. Executors install the attempt's model lookup and signature cache around each synchronous translator call
  (`withModelInfoLookup`, `withSignatureContext`); the `CACHE` KV store of signatures stays in the Worker
  (`src/signature/store.ts`).
- The root stays the deploy root: `alchemy.run.ts`, `infra/`, `migrations/` (D1 schema), `stacks/`, `tools/` (with
  `tools/fixturegen`, Go programs that emit golden fixtures, see below), `go.work`, `.repos/`, `docs/` and the lint,
  format and commit configs.

## Workspace and Turborepo

Internal packages are source-only: `package.json` `exports` point at TypeScript in `src/` (`./*` → `./src/*.ts` for
the contract, named entry points for the others; `./testing` at `test/testing.ts`, "Tests" below), there is no build step, and whatever imports a package compiles it
(Alchemy's bundler, Vite, Vitest). Import a module by its subpath, e.g. `@commissary/contract/api` or
`@commissary/translation/thinking`. `apps/app` imports nothing from `apps/web`, `apps/web` imports only
`@commissary/contract` from the workspace, and packages import nothing from `apps/` (lint rule). Versions that several packages share (`effect`, `typescript`, `vitest`, …)
are pinned once in the `catalog:` of `pnpm-workspace.yaml`.

`turbo.json` declares the tasks: `typecheck`, `test` and `build` run each package's script of that name, and the root
adds `typecheck:root` (the deploy code) and `lint:root` (one `oxlint`/`oxfmt` run over the repository). The packages
depend on each other's sources, not on build output, so every package task depends on `transit`, a task with no script whose
hash covers a package's files and those of its dependencies (Turborepo's transit-node pattern): a change in
`packages/contract` re-runs the panel's, auth's, state's and the Worker's tasks, one in `packages/json` re-runs translation's and the
Worker's, one in `packages/core` or `packages/auth` re-runs state's and the Worker's (and core's auth's too), and one in
`packages/state` re-runs the Worker's. The root `typecheck` and `test` tasks also hash `tools/vitest/` (the packages' Vitest configs import it), and
`typecheck` hashes `tools/workers/` (the Workers runtime types); a
package's `turbo.json` appends the root files its tasks read (`"$TURBO_EXTENDS$"`; `apps/app`: `infra/bundle.ts`,
`infra/settings.ts`, `migrations/`). The cache is local
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
(`apps/app/src/management/zones.ts`) so the Worker serves `index.html` for it.

## Tests

Every package and app keeps its tests in `test/` (no `*.test.ts` in `src/`) with its own `vitest.config.ts`. A test
lives in the lowest package that holds all the code it exercises; a test that goes through a Worker's router or `fetch`
stays with that Worker.

- **Runtime.** A package tests in plain Node.js unless the code under test needs a binding or a Durable Object. The
  Worker's tests run in workerd (`@cloudflare/vitest-plugin`, two projects: self-hosted and Cloud), and so do
  `@commissary/state`'s (one project, `state`: a test Worker of its own, `packages/state/test/worker.ts`, exports the
  ControlPlane's base composed with two dummy area parts, the Platform registry and SessionState, on real SQLite
  storage; its bindings are declared in `test/env.d.ts`); the panel's and the other packages' run in Node.js. A test
  that restarts a ControlPlane (`evictDurableObject`) first disposes of every stub of a part it holds
  (`withPart(stub.models(), …)` from `@commissary/state/testing`); a pipelined call (`stub.models().x()`) leaves one
  held until the test ends, and the eviction never finishes.
- **Package config.** A workerd package's `vitest.config.ts` uses `cloudflareTest` with its test Worker, the deployed
  Worker's compatibility settings and the bindings its env view names; its tsconfig adds the shared Workers runtime
  types and `@cloudflare/vitest-plugin/types`. A Node.js package's `vitest.config.ts` is
  `defineConfig(nodePackageTests("<name>"))` from
  `tools/vitest/node-package.ts`: one project named after the package over `test/**/*.test.ts`, and the `binModules`
  Vite plugin, which loads `*.bin` imports as the `ArrayBuffer` a Workers `Data` module gives (the Worker bundles them
  with that module rule, so binary assets behave the same in both runtimes). It sets `passWithNoTests`: CI's shards
  reach every package, and a package with fewer test files than shards gets none in some. The package's tsconfig
  includes `src`, `test` and `vitest.config.ts` with Node.js types but no Workers types.
- **Shared helpers.** A package whose fixtures or helpers its dependants' tests need exports them as `./testing`
  (`test/testing.ts`), e.g. `@commissary/translation/testing` (the thinking and token fixtures, the structural JSON
  comparison, the golden translator harness) or `@commissary/state/testing` (a Durable Object's tables, rows and alarm,
  the ControlPlane's org-wide tables, `withPart`). There is no test-utils package. Lint allows `@commissary/*/testing`
  imports only in `test/` folders.
- **Fixtures** sit in the `test/fixtures/` of the package whose tests read them (below). A dependant reads them through
  `./testing`, never by a relative path into another package.
- **Runs.** `pnpm test` is `turbo run test`: transit nodes re-run a package's tests and its dependants' when its files
  change, and an unchanged package is answered from the cache. `pnpm test --shard=N/3` (CI's three jobs) shards
  every package's run; one package: `pnpm --filter @commissary/<name> exec vitest run [file]`.
- **Counts.** Tests move with the code they cover, none are dropped: a PR that moves tests lists the counts per project
  before and after.

## Golden fixtures (`tools/fixturegen`)

The generators run the real Go code of the reference checkout and write the `test/fixtures/` of the package whose tests
read them (`-out` defaults): `packages/json` (`jsonpath`), `packages/translation` (`thinking`, `signature`, `tokens`
and its rank files, `translator`) and `apps/app` (the others, and the translator cases with an executor context,
`translator-executor.json`). They form their own Go module (`tools/fixturegen/go.mod`, module path under the server's so they
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

`no-restricted-imports` enforces the workspace boundaries: `@commissary/*/testing` only in `test/` folders, nothing
from `apps/` in `packages/` (so the org-wide ControlPlane in `@commissary/state` imports nothing from Models code).

Errors fail lint; warnings are reported but do not. Fix findings rather than silencing them: no disable comments. A type
assertion that cannot be removed carries a `// SAFETY: <invariant>` comment on the line(s) before it.

## Conventions

- Per-request Cloudflare `env` / `ctx` are passed as the `Context` argument of the web handler
  (`handler(request, requestContext(env, ctx))`); code reads the view of its package (`yield* AuthConfig`,
  `StateEnv`, `ModelsEnv`, or `AppEnv` for code that stays in the Worker; `apps/app/src/worker-env.ts`), never the
  global `Env`. Never capture them in a layer.
- Add routes as `HttpRouter.add(...)` layers and merge them into `AppLayer` in `apps/app/src/http/app.ts`.
- Never log tokens, API keys, JWTs or bodies; use `redactHeaders` when headers must be logged.
- No wall-clock sleeps in tests; use Effect `TestClock` or injected clocks.
- The Worker's tests live in `apps/app/test/*.test.ts` and run in workerd ("Tests" above). Use `@effect/vitest`
  (`it.effect`) for Effect code and `exports.default.fetch(...)` (`cloudflare:workers`) for end-to-end Worker requests.
- `alchemy.run.ts` keeps `workersDev: false` (no `workers.dev` or preview URLs) so Cloudflare Access cannot be bypassed.

## Dependency notes

- TypeScript 7 (native `tsc`). Each program has its own tsconfig extending `tsconfig.base.json`: `apps/app/tsconfig.json`
  (Worker, workerd types), `apps/web/tsconfig.app.json` (panel, DOM types) and `tsconfig.node.json` (its Node.js side),
  `packages/contract/tsconfig.json` (no runtime types), `packages/auth`, `packages/core`, `packages/json` and `packages/translation` (Node.js types,
  no Workers types) and the root's `tsconfig.infra.json` (deploy code, Node.js types). `tsc` only checks (`noEmit`); Turborepo caches it. `capnp-es` (via Alchemy) declares a TypeScript 5/6 peer
  range; it only ships types, so the peer warning is harmless.
- `@cloudflare/vitest-plugin` (successor of `@cloudflare/vitest-pool-workers`) is used because it supports vitest 5,
  which `@effect/vitest@4` requires.
- `alchemy` (2.0.0 beta, pinned) needs `@effect/platform-node` for its CLI; `@distilled.cloud/cloudflare` is pinned to
  the version Alchemy uses (the Access settings step calls the Cloudflare API with Alchemy's credentials).
