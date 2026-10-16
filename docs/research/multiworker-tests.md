# Tests across several Workers (`@cloudflare/vitest-plugin`, Vitest projects, Turborepo)

Scope: how tests that touch more than one Worker (app, API, Cloud-only auth) can run with `@cloudflare/vitest-plugin` and
Vitest projects in a pnpm + Turborepo workspace with source-only internal packages. Answers the questions of
[#131](https://github.com/ian-pascoe/commissary/issues/131) (child of the map [#126](https://github.com/ian-pascoe/commissary/issues/126)).
Facts, options and trade-offs only; the decision belongs to a later grilling ticket.

Versions in this repository (`node_modules`): `@cloudflare/vitest-plugin` 1.4.2 (depends on `miniflare` 5.20261012.0-beta, `wrangler` 4.151.0,
`esbuild` 0.28.2), `vitest` 5.0.3, `alchemy` 2.0.0-beta.83, workerd 1.20261012.1. The workers-sdk checkout read was `main` at `e7f9e4e9` (2026-10-16).

Method: primary sources first (below), then a **throwaway prototype** (pnpm workspace + Turborepo 2.11.8 + the same Vitest/plugin versions) to verify
every claim marked "verified". The prototype is described in section 8; it is not committed.

---

## 0. Executive summary

1. **One Worker is the "runner", the others are auxiliary.** The plugin runs the tests *inside* the `main` Worker's isolate (TypeScript through Vite; `exports.default`
   from `cloudflare:workers` is that Worker). Every other Worker in the test is an auxiliary Worker (`miniflare.workers: [...]`): it must be **pre-compiled JavaScript**
   (or a hand-written JS stub), cannot import `cloudflare:test`, and is not affected by test-side global mocks. Per Vitest project there is exactly one runner.
2. **Cross-script Durable Objects and RPC service bindings work** (verified, plugin 1.4.2): a service binding `{ name, entrypoint }` to a `WorkerEntrypoint` in an
   auxiliary Worker, a DO binding `{ className, scriptName }` from the runner to a class defined in an auxiliary Worker (SQLite included), and the reverse
   (an auxiliary Worker binding a DO defined in the runner, or calling back into the runner by service binding) all work.
3. **A function service binding (`serviceBindings: { AUTH: (req) => new Response() }`) serves `fetch` only; RPC calls on it fail** (verified: `internal error`). Stubbing an RPC
   service needs an auxiliary Worker (a few lines of inline JS with a `WorkerEntrypoint` is enough; no build).
4. **Where the pre-compiled JS comes from is the open cost.** Alchemy v2 has no `build` command: it bundles with rolldown at deploy time, in memory unless
   `build.output.dir` is set. So a test build is a separate step (esbuild/rolldown/Vite/`wrangler deploy --dry-run`) or Alchemy's `bundle: false` with a prebuilt entry shared
   by deploy and tests. In Turborepo this is an ordinary task edge: `app#test` `dependsOn` `auth#build` (verified: cache invalidates correctly).
5. **Gotchas found** (all verified): an auxiliary `scriptPath` *outside the project root* (`../auth/dist/index.js`) fails with `Uncaught Error: internal error`
   at startup; use `rootPath` on the auxiliary Worker or inline `contents`. Auxiliary-Worker DO storage is isolated per test *file*, not per test.
   `durable-objects` test helpers (`runInDurableObject`, ...) only work for DOs in the runner Worker.
6. **Pure packages run in plain Node** with their own `vitest run` (verified); a root `vitest.config.ts` with `test.projects: ["apps/*", "packages/*"]` runs Workers
   and Node projects together in one process (verified).
7. **What other multi-Worker repositories do**: workers-sdk's own fixture runs end to end across three Workers with built auxiliary Workers (section 5); the
   `cloudflare/mcp-server-cloudflare` monorepo tests each Worker alone, root `projects` globs, Wrangler config per app.

---

## 1. How the plugin runs several Workers

### 1.1 The runner and `miniflare.workers`

Cloudflare's docs ([Configuration](https://developers.cloudflare.com/workers/testing/vitest-integration/configuration/), `CloudflareTestOptions.miniflare`):

- `main`: "Entry point to Worker run in the same isolate/context as tests … This file goes through Vite transforms and can be TypeScript."
- `miniflare.workers`: "configure auxiliary Workers that run in the same `workerd` process as your tests and can be bound to. Auxiliary Workers are configured using the
  `workers` array, containing regular Miniflare `WorkerOptions` objects. Note that unlike the `main` Worker, auxiliary Workers:
  - Cannot have TypeScript entrypoints. You must compile auxiliary Workers to JavaScript first. You can use the `wrangler deploy --dry-run --outdir dist` command for this.
  - Use regular Workers module resolution semantics.
  - Cannot access the `cloudflare:test` module.
  - Do not require specific compatibility dates or flags.
  - Can be written with the Service Worker syntax.
  - Are not affected by global mocks defined in your tests."
- [Isolation and concurrency](https://developers.cloudflare.com/workers/testing/vitest-integration/isolation-and-concurrency/): "A copy of all auxiliary `workers` exists in each
  `workerd` process"; storage isolation is "per test file"; each Worker has its own module cache.

Source (`dist/pool/index.mjs` 1.4.2, `buildProjectWorkerOptions`): the runner is `[runnerWorker, ...auxiliaryWorkers]`; auxiliary names must be non-empty and must not
start with `vitest-plugin-`; the runner is named `vitest-plugin-runner-<project name with [^a-z0-9-] → _>`. Miniflare 5 `workers[]` entries are "legacy" `WorkerOptions`
converted by the plugin (calling `new Miniflare(workerOptions)` directly no longer works in miniflare 5; use the plugin).

### 1.2 Auxiliary Workers cannot load a Wrangler config

The workers-sdk fixture comment: "auxiliary Workers cannot load their configuration from `wrangler.toml` files, and must be configured with Miniflare `WorkerOptions`"
([fixtures/vitest-plugin-examples/multiple-workers/vitest.config.ts](https://github.com/cloudflare/workers-sdk/blob/main/fixtures/vitest-plugin-examples/multiple-workers/vitest.config.ts)).
Only the runner can use `wrangler.configPath` (merged under `miniflare`, `miniflare` wins). Commissary has no Wrangler config (Alchemy), so every Worker's test
options (compatibility date/flags, bindings, DO classes, modules rules, `assets`) are written in `vitest.config.ts`, as `vitest.config.ts` already does for the single Worker.

### 1.3 Why this matters for Commissary's current tests

- Today every test runs against one runner Worker (`main: ./src/index.ts`) and stubs outbound calls with the **global `fetch`** (e.g. GitHub/Google sign-in in
  `test/hosted/`). Global mocks do not reach auxiliary Workers (docs above). In a split, whichever Worker hosts Better Auth should be the **runner** of the tests that stub its outbound
  `fetch`, or its outbound calls must be stubbed with the Miniflare `outboundService` option of the auxiliary Worker (a Node-side handler; the workers-sdk fixture does exactly this
  for its auth service).
- `exports.default.fetch(...)` and `import { env } from "cloudflare:workers"` always address the runner; auxiliary Workers are reached through bindings on `env`.
- The runner is bundled by Vite (aliases such as `BUNDLE_ALIASES` in `vitest.config.ts`); auxiliary Workers are whatever was built. A test of the runner therefore exercises
  Vite-transformed code, and a test through an auxiliary Worker exercises the built bundle (closer to production, see the fixture README footnote).

---

## 2. Building the auxiliary Workers

### 2.1 What the docs and fixtures do

- Docs: `wrangler deploy --dry-run --outdir dist` (needs a Wrangler config per Worker; Commissary has none, so a minimal `wrangler.jsonc` per Worker would exist only for this).
- workers-sdk `multiple-workers` fixture: a Vitest `globalSetup` that runs `wrangler build` in each auxiliary Worker's directory before the run
  ([global-setup.ts](https://github.com/cloudflare/workers-sdk/blob/main/fixtures/vitest-plugin-examples/multiple-workers/global-setup.ts)); the config points `scriptPath: "./auth-service/dist/index.js"`.
  The fixture README notes the consequence: "requires you to build your worker ahead-of-time. This means your tests won't re-run automatically if you change your worker's source code."

### 2.2 Alchemy v2 (`alchemy` 2.0.0-beta.83)

- Subcommands: `provider prisma deploy dev destroy plan logs profile state drift`. **No `build` command**; nothing builds a Worker without running a stack (a deploy or `alchemy dev`).
- `Cloudflare.Worker` bundles `main` with **rolldown** at deploy time (`Worker.d.ts`: "`main` is bundled with rolldown at deploy time"; `build.input.resolve.alias` for module replacements).
  The bundle stays in memory unless `build.output.dir`/`file` is set (`lib/Bundle/Bundle.d.ts`: `hasOutputLocation`, `outputDirectory` → `.alchemy/bundles/<stack>-<stage>-<fqn>` only when the caller
  chooses a location). Hence "feed the test from the Alchemy build" is only possible after a deploy/dev run, which is not a test-time step.
- **`bundle: false` (prebuilt Workers)**: `Worker.d.ts` documents it for an entry that is "a complete, runtime-ready ESM Worker produced by an external tool … uploaded byte-for-byte";
  "Durable Object and Workflow classes must be exported by the prebuilt entry itself — `exports` is not applied when `bundle` is `false`"; module rules mirror Wrangler's `no_bundle`
  (`Sources/Prebuilt.d.ts`). This makes **one build per Worker consumed by both Alchemy and the Vitest auxiliary config** possible (the tested artifact is the deployed artifact).
  Not exercised in this research: it is a declared option, with the cost that Commissary's rolldown aliases/`BUNDLE_ALIASES` and module rules move into the Worker's own build step.
- Commissary's Workers are plain module Workers (`export default { fetch, scheduled }`, `export { ControlPlane, Platform, SessionState }` in `src/index.ts`), not Alchemy-Effect Worker classes,
  so a standalone build of an entry is a normal ESM Worker (an esbuild bundle with `cloudflare:workers` external loaded fine in the prototype).

### 2.3 Options to produce the JS (trade-offs)

| Option | Needs | Notes |
| --- | --- | --- |
| esbuild/rolldown script per Worker (`build` script in the Worker's `package.json`) | `esbuild` is already a dependency of the plugin (0.28.2); `rolldown` comes with Alchemy | Verified in the prototype (esbuild, `--platform=neutral --external:cloudflare:workers`, workspace source packages bundled). A second build next to Alchemy's: tested artifact ≠ deployed artifact unless aliases/plugins/define are shared. |
| `wrangler deploy --dry-run --outdir dist` | A `wrangler.jsonc` per Worker (none exist) | The path in Cloudflare's docs; wrangler 4.151.0 is already installed as a plugin dependency. Wrangler's own esbuild pipeline, a third bundler. |
| Vite build (`@cloudflare/vite-plugin`, or `vite build` with a Worker environment) | Vite 8 already present (panel) | The panel already builds with Vite (`web:build`). Not tried. |
| Alchemy `bundle: false` + shared prebuilt entry | A build step per Worker that Alchemy then uploads unchanged | Single artifact; moves bundling config out of `alchemy.run.ts`. Declared in Alchemy's types, not tried. |
| Hand-written JS stub Worker (inline `modules: [{ type: "ESModule", path, contents }]`) | Nothing built | Verified: an inline `WorkerEntrypoint` stub works as an RPC service. Tests the caller only; the callee is a fake. |
| `serviceBindings: { X: (req) => Response }` function | Nothing built | `fetch` only; RPC fails (verified). |

### 2.4 Gotcha: `scriptPath` outside the project root fails (verified)

With the Vitest project in `apps/app` and `{ name: "auth", modules: true, scriptPath: "../auth/dist/index.js" }` (relative or absolute), the runtime fails to start:
`service core:user:auth: Uncaught Error: internal error`. The same file under the project directory loads. Working forms:

```ts
{ name: "auth", modules: true, rootPath: "../auth", scriptPath: "dist/index.js" }                         // rootPath
{ name: "auth", modules: [{ type: "ESModule", path: "index.js",                                           // inline contents
    contents: readFileSync(new URL("../auth/dist/index.js", import.meta.url), "utf8") }] }
```

(The workers-sdk fixture avoids it by keeping each auxiliary Worker's `dist/` under the Vitest project root.) If a Worker is tested from its own package and its siblings live in
other packages, this applies to every sibling.

---

## 3. Cross-Worker bindings in the test pool (verified, plugin 1.4.2)

Prototype config (runner = `app`, auxiliary = `auth` built by esbuild):

```ts
cloudflareTest({
  main: "./src/index.ts",
  miniflare: {
    compatibilityDate: "2026-08-01", compatibilityFlags: ["nodejs_compat"],
    serviceBindings: { AUTH: { name: "auth", entrypoint: "Auth" } },                       // RPC WorkerEntrypoint
    durableObjects: { CP: { className: "ControlPlane", scriptName: "auth", useSQLite: true } }, // DO defined in `auth`
    workers: [{ name: "auth", modules: true, rootPath: "../auth", scriptPath: "dist/index.js",
      compatibilityDate: "2026-08-01", compatibilityFlags: ["nodejs_compat"],
      durableObjects: { CP: { className: "ControlPlane", useSQLite: true } } }],         // the defining Worker also declares it
}})
```

| Case | Result |
| --- | --- |
| Runner → `env.AUTH.verify("good")` (RPC on `{ name, entrypoint }` service binding to an auxiliary `WorkerEntrypoint`) | works |
| Runner → DO defined in an auxiliary Worker via `{ className, scriptName }` (SQLite storage, RPC method `bump()`) | works |
| Auxiliary → DO defined in the runner: `durableObjects: { SS: { className, scriptName: "vitest-plugin-runner-<project>" } }` | works |
| Auxiliary → runner by service binding `serviceBindings: { APP: "vitest-plugin-runner-<project>" }` | works |
| Source-only workspace package (`exports: "./src/index.ts"`) imported by the runner (Vite) and by the auxiliary Worker (bundled by esbuild) | works |
| Function service binding called with RPC (`env.AUTH.verify()`) | fails: `internal error` |
| Miniflare `entrypoint` binding to a name the Worker does not export | runtime refuses to start (`has no such named entrypoint`) |

Notes:

- The runner-name form (`vitest-plugin-runner-<project name>`) is an implementation detail of the plugin (`getRunnerName`, `WORKER_NAME_PREFIX = "vitest-plugin-"`); set `test.name` in the project to
  make it stable. A Worker that is the runner cannot be named by an auxiliary Worker through any documented option.
- Miniflare README ([packages/miniflare/README.md](https://github.com/cloudflare/workers-sdk/blob/main/packages/miniflare/README.md)): `durableObjects` designators are `string | { className, scriptName?, useSQLite? }`
  — "if `scriptName` is `undefined`, `className` must be a class exported by this Worker"; otherwise by the Worker named `scriptName`. `serviceBindings` accept `{ name, entrypoint? }`.
- The pool's DO bookkeeping (`src/pool/index.ts`, `getDurableObjectClasses`, `src/worker/durable-objects.ts`) treats a designator **with** `scriptName` as "another worker" and leaves it alone.
  Consequence: the DO test helpers (`runInDurableObject`, `runDurableObjectAlarm`, `listDurableObjectIds`, ...) throw "can only be used with stubs pointing to objects defined within the same worker" for
  a DO that lives in an auxiliary Worker. Tests of DO *internals* belong to the project whose runner defines the class; cross-Worker tests can only call through RPC/fetch.
- Commissary's current layout (ControlPlane, SessionState and Platform defined in one Worker, bound by the others by `scriptName`) maps to: the defining Worker is the runner for DO-internal tests, or an auxiliary
  Worker with `durableObjects` declared on it and bound by the runner with `scriptName`.
- Storage isolation: DO storage of an **auxiliary** Worker is reset per test **file** (verified: file b started at counter 1 after file a had reached 2, with and without file parallelism), not per test
  (verified: the second test in a file saw the first test's write). With `--no-isolate --max-workers=1` state is shared across files (counter 3). This matches the docs ("Storage isolation is per test file"; "make test files share
  the same storage … `--max-workers=1 --no-isolate`").
- Startup cost: "A copy of all auxiliary `workers` exists in each `workerd` process", and each Vitest project starts its own; two projects (self-hosted, cloud) × several Workers means every project pays for every
  auxiliary Worker unless a project lists only the Workers it needs.

---

## 4. Turborepo and Vitest in the workspace

### 4.1 Task graph for the build → test edge (verified, turbo 2.11.8)

Docs: [`dependsOn`](https://turborepo.dev/docs/reference/configuration) supports `^task` (dependencies' tasks), same-package tasks and **arbitrary `package#task` edges**
(`"web#lint": { "dependsOn": ["utils#build"] }`). A working shape:

```jsonc
{ "tasks": {
    "build": { "dependsOn": ["^build"], "outputs": ["dist/**"] },
    "test":  { "dependsOn": [] },
    "@p/app#test": { "dependsOn": ["@p/auth#build"] }   // the auxiliary Worker's build feeds the app's tests
} }
```

Observed: `turbo run test` ran `auth#build` first, then `app#test`; with git-tracked sources and `dist` ignored, a rerun was fully cached; editing `auth`'s source rebuilt `auth` and re-ran `app#test`
with **no extra `inputs`** (the dependency task's hash is part of the dependent's hash); editing only `app` re-ran only `app#test`; editing a source-only package both Workers use re-ran both.
Without a `.gitignore` covering `dist`/`.turbo`, the second run missed the cache (untracked build output changed the hash): `outputs` must be declared and build output ignored by git.

If the building Worker is a *dependency* of the testing Worker in `package.json` (e.g. app lists `@commissary/auth` for its RPC types), `"test": { "dependsOn": ["^build"] }` is enough, but then
`^build` also builds every source-only package, which has no build. Turborepo's [Vitest guide](https://turborepo.dev/docs/guides/tools/vitest) recommends a **`transit`** task
(`"test": { "dependsOn": ["transit"] }, "transit": { "dependsOn": ["^transit"] }`) so that a change in an internal package invalidates dependents' tests without a build step; this is the right edge for
source-only packages, and the Worker build edge is added on top.

### 4.2 Two ways to run Vitest (Turborepo guide)

| | Per-package `vitest run` through `turbo run test` | Root `vitest` with `test.projects` |
| --- | --- | --- |
| Cache | per package, only changed packages run | none (one process) |
| Coverage | merge yourself | merged out of the box |
| Watch | one `vitest` per package | one root watch |
| Config | each package its own `vitest.config.ts` | root config lists projects; project configs cannot `extends` a root with `projects` (guide: use a shared file such as `vitest.shared.ts`) |

Vitest ([projects](https://vitest.dev/guide/projects)): `projects` accepts globs and inline configs; a folder without a config is a project; names must be unique; `extends: true` inherits root options
(Commissary's `vitest.config.ts` uses it). Verified: a root config `projects: ["apps/*", "packages/*"]` ran the Workers-pool project (`apps/app`) and the Node project (`packages/shared`) in one
`vitest run`. The two modes can coexist (per-package scripts for Turborepo/CI, root config for editor and watch), which is what `cloudflare/mcp-server-cloudflare` does (section 5).

### 4.3 Pure packages in plain Node (verified)

A package with no Workers imports needs only `vitest` and a script `"test": "vitest run"`; no plugin, default `node` environment (the prototype `packages/shared` test passed and
saw `process.versions.node`). Source-only packages (`"exports": { ".": "./src/index.ts" }`) are consumed as TypeScript by Vite in both Node and runner projects, and by esbuild in an auxiliary
Worker build, with no package build step. Code that must run under both (Effect services without `cloudflare:*` imports) can be tested twice: in Node for speed and in workerd through a Worker's tests
for runtime fidelity (workerd has `nodejs_compat` injected by the plugin, so Node-only APIs pass in tests even if production lacks the flag: Isolation page's caution).

### 4.4 Plugin and Vitest compatibility already in play

`docs/DEVELOPMENT.md` already records that `@cloudflare/vitest-plugin` is the successor of `@cloudflare/vitest-pool-workers` and is used because it supports Vitest 5 (needed by `@effect/vitest@4`).
Every Workers test project in the workspace must use the same Vitest major (`@effect/vitest` pins it).

---

## 5. What other multi-Worker repositories do

| Repository | Approach | Source |
| --- | --- | --- |
| `cloudflare/workers-sdk` fixture `vitest-plugin-examples/multiple-workers` | **End to end across Workers**: runner = `api-service` (Wrangler config, TS), auxiliary `auth-service`, `database-service` (built by `wrangler build` in `globalSetup`), a stub tail consumer; `outboundService` mocks the auth Worker's outbound `fetch`; assertions through `exports.default.fetch` and `env.DATABASE_SERVICE.fetch` | [fixture](https://github.com/cloudflare/workers-sdk/tree/main/fixtures/vitest-plugin-examples/multiple-workers) |
| `cloudflare/workers-sdk` fixture `vitest-plugin-examples/rpc`, `basics-integration-auxiliary` | Named entrypoints / DOs / RPC in one Worker (`rpc`); one auxiliary Worker as the unit under test with a pre-built `dist/` (`basics-integration-auxiliary`) | [rpc](https://github.com/cloudflare/workers-sdk/tree/main/fixtures/vitest-plugin-examples/rpc), [auxiliary](https://github.com/cloudflare/workers-sdk/tree/main/fixtures/vitest-plugin-examples/basics-integration-auxiliary) |
| `cloudflare/mcp-server-cloudflare` (18 Workers under `apps/*`, shared `packages/*`, pnpm + Turborepo) | **Each Worker tested alone** (checked `apps/workers-observability`): one `vitest.config.ts` per app using `cloudflareTest({ wrangler: { configPath }, miniflare: { bindings: mocks } })`, `remoteBindings: false`; no auxiliary Workers there; root `vitest.config.ts` with `projects: ['apps/*/vitest.config.ts', 'apps/*/vitest.config.node.ts', 'packages/*/vitest.config.ts', 'packages/*/vitest.config.node.ts']`; Turborepo drives type/lint checks (`turbo.json` has no `test` task), tests run from the root `vitest run` | [vitest.config.ts](https://github.com/cloudflare/mcp-server-cloudflare/blob/main/vitest.config.ts), [turbo.json](https://github.com/cloudflare/mcp-server-cloudflare/blob/main/turbo.json) |
| Cloudflare docs | Auxiliary Workers are the documented way for multiple Workers ("projects with multiple Workers") | [Configuration](https://developers.cloudflare.com/workers/testing/vitest-integration/configuration/) |

Two usable patterns follow, combinable:

1. **Alone with stubbed bindings**: each Worker's project has only its own Worker as runner; other Workers' bindings are replaced by Miniflare function bindings (fetch) or small inline stub Workers
   (RPC, DOs). No cross-Worker build, fast, and the contract with the neighbour is a hand-kept fake.
2. **End to end across Workers**: the runner is the Worker under test, real neighbours are built auxiliary Workers (section 2). Catches contract drift (RPC shape, cross-script DO), costs a build and
   a copy of every neighbour per workerd process.

A cheap drift guard for pattern 1: the stub imports the neighbour's exported TypeScript interface (the contract package) so type checking, not runtime, ties it to the real Worker.

---

## 6. Interactions specific to Commissary's split

- **RPC auth Worker (Cloud only)**: the app Worker's tests that cross the session-verify RPC need the auth Worker as an auxiliary Worker (built) or an inline `WorkerEntrypoint` stub; a function binding is not
  enough. Better Auth's global-`fetch` stubs (GitHub/Google/Turnstile in `test/hosted/`) only work when the auth Worker is the **runner** of that project; as an auxiliary Worker its outbound calls need `outboundService`.
- **Two Vitest projects (self-hosted, cloud)**: the self-hosted project has no auth Worker at all, so the auxiliary list (and its build dependency) differs per project; in Turborepo that is a per-project config but
  one `test` task per package, so the `auth#build` edge applies to the whole package's `test` even when only the cloud project needs it (two scripts/tasks, e.g. `test` and `test:cloud`, avoid that).
- **ControlPlane/SessionState/Platform bound across Workers by `scriptName`**: works in the pool as in section 3, with the DO-helper limitation. Alchemy's side (declaring the DO once and binding it from the others) is outside this ticket.
- **Assets** (`assets` + `routerConfig` in `vitest.config.ts`) apply to the runner project only; panel assets (`./public`, produced by `web:build`) are an input of the app Worker's tests, not of the others.
- **Compatibility settings** must be repeated per Worker in `vitest.config.ts` (`COMPATIBILITY` in `alchemy.run.ts` is "kept in sync" by hand today); a shared constant in a source-only package would serve
  `alchemy.run.ts` and every `vitest.config.ts` (plugin and Alchemy both run in Node).
- **Free plan / CPU**: not affected by the test pool (no CPU limits locally); see the map's "Not yet specified" list.

---

## 7. Option sketches (no recommendation)

| Option | Cross-Worker coverage | Build cost | Fidelity to production | Main risk |
| --- | --- | --- | --- | --- |
| A. Each Worker alone, neighbours stubbed (fetch functions + inline stub Workers) | contract only by types | none | runner code is Vite-transformed | stubs drift from the real Worker |
| B. Runner + built auxiliary neighbours (esbuild/rolldown script, `dependsOn` edge) | real RPC, real DO | one extra build per neighbour per change | auxiliary side = built bundle | second bundler config next to Alchemy's |
| C. As B with Alchemy `bundle: false` sharing the prebuilt artifact | real | one build per Worker, used by deploy and tests | tested = deployed | moves rolldown aliases/rules out of `alchemy.run.ts`; untested here |
| D. A dedicated integration project (runner = app, auxiliary = api, auth), few tests; unit tests alone (A) | real, at a few seams | one build set, run in CI | mixed | two kinds of Worker tests to maintain |

All options keep pure packages in Node projects.

---

## 8. The prototype (how the verified claims were checked)

pnpm workspace (`apps/app`, `apps/auth`, `packages/shared`), Vitest 5.0.3, `@cloudflare/vitest-plugin` 1.4.2, esbuild 0.28.2, Turborepo 2.11.8.

- `packages/shared`: `{ "exports": { ".": "./src/index.ts" } }`, `greet()`; own Node `vitest run` test.
- `apps/auth` (built with `esbuild src/index.ts --bundle --format=esm --platform=neutral --external:cloudflare:workers --outfile=dist/index.js`): `Auth extends WorkerEntrypoint` (`verify`), `ControlPlane extends DurableObject`
  (SQLite storage counter), default `fetch` calling back into the runner.
- `apps/app` (runner): TS `main` importing `@p/shared`; the config of section 3; tests through `exports.default.fetch` and `env`.
- Variants run: `scriptPath` inside/outside the project root, `rootPath`, inline `contents`, function service binding with RPC, auxiliary → runner service/DO bindings, `--no-file-parallelism`, `--no-isolate --max-workers=1`,
  root `projects` run, Turborepo cache runs (rerun, auxiliary source edit, shared source edit, runner source edit).

---

## Sources

- Cloudflare docs: [Vitest integration → Configuration](https://developers.cloudflare.com/workers/testing/vitest-integration/configuration/), [Isolation and concurrency](https://developers.cloudflare.com/workers/testing/vitest-integration/isolation-and-concurrency/).
- cloudflare/workers-sdk (`main` `e7f9e4e9`): `fixtures/vitest-plugin-examples/{multiple-workers,rpc,basics-integration-auxiliary}`, `packages/vitest-plugin/src/{pool/index.ts,pool/config.ts,worker/durable-objects.ts}`, `packages/miniflare/README.md`.
- Installed: `node_modules/@cloudflare/vitest-plugin/dist/pool/index.mjs` (1.4.2: `parseCustomPoolOptions`, `buildProjectWorkerOptions`, `getRunnerName`), `node_modules/alchemy/lib/Cloudflare/Workers/{Worker.d.ts,Sources/Prebuilt.d.ts,Sources/Rolldown.d.ts}`, `lib/Bundle/Bundle.d.ts`, `npx alchemy --help`.
- Vitest: [Test projects](https://vitest.dev/guide/projects).
- Turborepo: [Configuring turbo.json](https://turborepo.dev/docs/reference/configuration) (`dependsOn`, `inputs`, `outputs`), [Vitest guide](https://turborepo.dev/docs/guides/tools/vitest).
- cloudflare/mcp-server-cloudflare: [`vitest.config.ts`](https://github.com/cloudflare/mcp-server-cloudflare/blob/main/vitest.config.ts), [`turbo.json`](https://github.com/cloudflare/mcp-server-cloudflare/blob/main/turbo.json), `apps/workers-observability/vitest.config.ts`.
