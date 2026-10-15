# pi-durable agents on Durable Objects, and where their tools run

Research for ticket #114 (map #101). Researched 2026-10-15. Terms follow `GLOSSARY.md` (org, member, proxy key, spend limit, …).
This note lays out facts, options and trade-offs; it decides nothing.

Package versions studied: `@earendil-works/pi-durable` 1.2.0 (published 2026-10-12), `@earendil-works/pi-ai` 1.2.0,
`@earendil-works/pi-env` 1.2.0, `just-bash` 3.6.0 (npm, 2026-10-01). Read from the published tarballs (`npm pack`) and
`github.com/earendil-works/pi`, `packages/durable`.

## Answer

1. **Yes, pi-durable runs on a SQLite-backed Durable Object, one agent per object, and resumes after eviction.** A throwaway
   spike (`spikes/pi-durable/`, workerd via `@cloudflare/vitest-plugin`) ran a Harness on `ctx.storage` through
   `openDurableObjectSqliteStorage`. It answered through an OpenAI-compatible proxy route with a proxy-key bearer token and ran
   two bash tool calls. It also killed the object mid-run (`abortAllDurableObjects()`), and a new instance continued the run
   without re-running the finished tool call. Caveat: the model, the container and the eviction were all simulated, and
   nothing woke a dead object by itself (see "What is not proven").
2. **The API is explicitly unstable.** The README opens with "Experimental. The API changes without notice between releases."
   Version 1.0.0 shipped 2026-10-01; 1.0.3, 1.0.4, 1.1.0 and 1.2.0 each list "Breaking Changes". The Durable Object storage
   adapter is only 8 days old (added in 1.1.0, 2026-10-07). Pin exact versions and budget for churn.
3. **A custom `ExecutionEnv` is how tools are routed.** `Harness.open(storage, { env })` takes a function called per tool call
   that returns the environment. The `bash`/`read`/`write`/`edit` tools only touch `env.exec`, `readTextFile`,
   `openBinaryReader`, `writeFile`, `fileInfo`, `exists`, `absolutePath`, `canonicalPath` and `joinPath`. The spike's router
   sent a light command to a just-bash interpreter over files held in the object's SQLite, and a `npm …` command to a
   (stubbed) container.
4. **"Cloudflare Artifacts" is real and is not a shell.** It is Git-compatible versioned storage (repos created
   programmatically, tokens, forks, a Workers binding, a Git remote). It is in open beta since 2026-10-01 and billed from
   2026-10-14, on Workers Paid only. The Workers binding can create/fork/import repos, mint tokens and *read* files, but
   cannot write files; writing needs a Git client (isomorphic-git in a Worker, or git in a container). So "Artifacts for files"
   means a versioned workspace store that a mocked shell or a container syncs with, not a replacement for a filesystem.
5. **Heavy commands need a container (or a remote host).** Cloudflare Containers/Sandbox give a Linux microVM per Durable
   Object with `ctx.container.exec()`, snapshots of the filesystem, and an outbound-egress allow-list. `@earendil-works/pi-env`
   cannot run inside a Worker: its transport spawns `ssh`/a local daemon with `node:child_process`. It fits a Node host, such as
   a container that itself hosts pi-durable, not the Worker.
6. **Reaching Commissary's own models:** pi-ai can point a provider at any OpenAI-/Anthropic-compatible `baseUrl` with a key.
   A hosted agent can therefore call the proxy's own routes with a proxy key, or in-process/over a service binding. Options and
   trade-offs are in section 5. Tools (MCP) and Browser are not built yet; pi ships an MCP client (`@earendil-works/pi-mcp`,
   Streamable HTTP, injectable `fetch`) that works over plain `fetch`.

## 1. pi-durable on a Durable Object

### What it is

A durable agent harness: transcripts of immutable entries, typed documents, and tasks that checkpoint every step, all in one
`Storage`. `Harness.open(storage, { models, registry, env }, context)`, then `harness.root()`, `root.submit({ type: "input",
content, requestId })`, `submission.wait()`. "Work interrupted by a crash or close stays pending. `resume()` starts the task
scheduler." Resubmitting with the same `requestId` returns the existing submission. (README, "Persist and Resume"; Concepts.)
Source: README in the npm tarball of `@earendil-works/pi-durable@1.2.0`.

### The Durable Object backend

- README, "Storage": `openDurableObjectSqliteStorage(ctx.storage)` from `@earendil-works/pi-durable/storage/sqlite/cloudflare`
  is "The SQLite storage of one SQLite-backed Durable Object; commits are its storage transactions." "One process owns a
  storage at a time; there is no cross-process locking", which matches one Durable Object per agent.
- The adapter (`dist/storage/sqlite/cloudflare.js`) wraps `ctx.storage.sql.exec` and `ctx.storage.transaction()`, serializes all
  operations through a queue, and throws on a `bigint` outside the safe-integer range. It was added in 1.1.0 (CHANGELOG, 2026-10-07).
- Upstream tests the adapter against a `node:sqlite` stand-in for `ctx.storage` (`packages/durable/test/sqlite-cloudflare.test.ts`),
  not workerd. The spike ran it in real workerd (miniflare's SQLite Durable Object) and the whole flow worked.
- Errors: any `Storage` error fails the whole Session, which closes itself; every later call rejects with `SessionFailed`
  (README, "Errors"; 1.2.0 breaking change). A host reopens (`harness.closed.then(...)`). In a Durable Object that means
  dropping the cached Harness promise and letting the next call reopen.
- Durable Object SQL limits that bite pi-durable's rows: string/BLOB/row ≤ 2 MB, ≤ 100 bound parameters per query, 100 KB
  statement, 10 GB per object
  ([DO limits](https://developers.cloudflare.com/durable-objects/platform/limits/index.md), updated 2026-06-01). The README lists
  no cap on transcript size; compaction exists (README "Compaction"). I did not measure a long transcript.

### Resume after eviction

- A Durable Object is evicted after about 10 s idle if it can hibernate, or after 70–140 s idle otherwise; pending I/O
  (outbound `fetch`, RPC, `waitUntil`, timers) keeps it in memory for up to 15 minutes **per operation**; deployments and runtime
  updates restart it at any time; in-flight HTTP/RPC requests that touch storage are stopped
  ([lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/index.md), updated 2026-09-30).
  So a running agent is not evicted while it awaits a model call, but it will be restarted on deploy.
- On restart, the constructor runs again and nothing runs until an event arrives. pi-durable continues "any run the last
  process left unfinished" only when the host reopens the Harness and calls `resume()` (README). **A Durable Object that has
  been killed will not reopen itself**; the host has to wake it (a client request, or a Durable Object alarm). I did not build
  the alarm.
- Spike result (workerd): kill the object while the second model call is in flight (tool call 1 already ran). The first RPC
  rejected with `Application called abortAllDurableObjects()`. A new instance with the same `requestId` finished the run:
  3 model calls in total (original, hung, resumed), the `echo` tool call was not repeated, history was intact, and the file
  written by the tool was still there (`spikes/pi-durable/test/midrun.test.ts`).
  A second test evicted an idle object: history and files rehydrated from SQLite, and resubmitting the same `requestId`
  triggered no model call (`test/agent.test.ts`).
- Tools that are not marked replay-safe have their unfinished calls abandoned after a restart rather than rerun
  (1.2.0: `TaskOptions.abandonOnRestart`; "a caller that is not replay-safe has its unfinished nested calls abandoned").
  Whether a half-finished `bash` call is rerun is therefore a per-tool policy, to be checked before depending on it.

### CPU, wall-clock, memory, size

- CPU: Durable Objects count CPU per request, 30 s default, configurable up to 5 min of active CPU time
  ([DO limits](https://developers.cloudflare.com/durable-objects/platform/limits/index.md);
  [Workers limits](https://developers.cloudflare.com/workers/platform/limits/index.md), updated 2026-10-12). Waiting on `fetch`
  does not count as CPU. Memory is 128 MB per isolate.
- Wall-clock: Durable Objects bill duration (wall-clock GB-s) while active or idle-but-unable-to-hibernate
  ([pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/index.md), updated 2026-09-30): $12.50 per million
  GB-s beyond 400,000 GB-s/month on Paid. A long agent run that awaits models for minutes is billed for all of it. I found no
  fixed wall-clock cap on an RPC; the 15-minute-per-operation eviction guard is the documented bound. I did not test a run
  longer than a few seconds.
- pi-durable cost notes: the README says the package root costs "about 4 MB in a tree-shaken bundle" of peak RSS; the image
  processor (Photon WebAssembly) decodes "the image's full size in WebAssembly memory", so "leave the processor out on
  memory-constrained hosts such as Cloudflare Workers unless images stay small". Without the processor, `read` passes
  images through only when they already fit the model's limits (2000x2000 px, 4.5 MB base64 by default; 1.2.0 changelog).
- Bundle size, measured locally (`wrangler deploy --dry-run --outdir`, nothing uploaded): the spike Worker is
  **3,722 KiB, 758 KiB gzip**, including just-bash. An esbuild minified bundle (2.2 MB) breaks down as just-bash 1,235 KiB,
  `openai` SDK 275 KiB, `@mixmark-io/domino` 231 KiB (a just-bash dependency), typebox 171 KiB, pi-durable 166 KiB, pi-ai
  66 KiB, chord 43 KiB. The Worker size limit is 64 MiB on both plans, and startup must stay under 1 s (Workers limits page).
  I did not measure startup time. For comparison, Commissary's current Worker already ships its translators and tokenizer.
- Concurrency: QuickJS-based **codemode** scripts block the object's thread. pi-codemode measured (October 2026) that a
  10 s compute script delayed every other request to the session object by 10 s, and ran it in a *separate* Worker's Durable
  Object (`RemoteCodemodeSandbox`) to cut that to ~50 ms (pi-codemode README, "Usage on Cloudflare Workers"). Relevant if
  Commissary exposes codemode. It is optional in pi-durable.

### Stability of the experimental API

- Release cadence (npm registry `time`): 0.86.0 on 2026-09-19 to 1.2.0 on 2026-10-12, 17 releases in 24 days. 1.0.0 was
  2026-10-01 while the README still says "Experimental".
- Breaking changes relevant to a host: `FileSystem` gained required methods (1.0.3: `openBinaryReader`, `openDirReader`,
  `watch`, argv `exec`, stream info), the env conformance suite gained checks (1.0.4), `Storage` must honor a new `order`
  field (1.1.0), tool task records changed shape, with `pi.tool` v2 migrating live v1 tasks (1.2.0), and storage failures now fail
  the Session (1.2.0). Stored data has been migrated on upgrade at least once, so a host should expect to depend on those
  migrations, and on in-flight tasks across a deploy.
- License MIT; maintained by Earendil Works; the `engines` field says Node ≥ 22.19 (the Workers adapter does not need it).
- The package ships conformance suites (`registerStorageConformance`, `registerEnvConformance` in `/testing`) that a custom
  storage or env can run, which is the main guard against interface drift.

## 2. Bash and files: what a mocked shell can do

### Where the tools reach the outside

Tools "reach files and processes only through the environment the Harness builds for each call" (example 17, README
"Environment"). `env` receives the conversation id, its `cwd`, and committed reads, so one function can serve a
virtual workspace per conversation or a container per conversation; "A custom `ExecutionEnv` sets `id` so that equal ids see the
same files at the same paths, for example one id per container." The environment interface is `FileSystem` (about 25 methods)
plus `Shell.exec(command | argv, options, context)`, results as `Result<_, FileError | ExecutionError>`
(`dist/env/index.d.ts`). The built-in tools use only the nine methods listed in the Answer, but the interface requires the
rest; implementing all of it correctly is the real cost (the `registerEnvConformance` suite is the yardstick).

### just-bash (the "mocked shell")

- `just-bash` (Vercel Labs, Apache-2.0): "A simulated bash environment with virtual filesystem"; broad POSIX commands, `jq`,
  `yq`, `xan`, optional `curl`; pluggable filesystems (`InMemoryFs`, overlay, mountable, custom `IFileSystem`). Source: its
  README in the npm package.
- It has a browser build (`just-bash/browser`) that "works in browser environments"; **`python3`, `sqlite3`, `js-exec`,
  `OverlayFs`/`ReadWriteFs` are Node-only** and unavailable there (README). It ran in workerd in the spike (`Bash`,
  `InMemoryFs`: `echo hello > a.txt && cat a.txt` returned `hello`).
- It cannot run native programs, spawn real processes, or run `npm`, `git`, compilers or test runners. Anything needing those goes to
  the heavy side. It also has execution limits (call depth, loop counts) against runaway scripts, and network is off unless configured.
- Its README warns that the opt-in Python/JS/SQLite add-ons are extra attack surface and that memory limits do not reliably cap
  their WebAssembly memory; the Node-only add-ons are not available in a Worker anyway.
- Where files live in the spike: an in-memory tree rebuilt from an `env_files` table in the object's SQLite on construction,
  written through on every `writeFile` and after every command. Caveats found: the interpreter seeds system paths
  (`/bin`, `/proc`, …), so the 'sync to container' step must filter them (the stub reported "176 files synced in"); whole-tree
  scans per command do not scale; one row per file hits the 2 MB row cap; binary files were not handled.

### Where files can persist

| Store | Fit | Limits / notes (source) |
|---|---|---|
| Durable Object SQLite, same object as the transcript | Simplest; atomic with the agent; no extra hop | 10 GB per object, 2 MB per row/blob ([DO limits](https://developers.cloudflare.com/durable-objects/platform/limits/index.md)); competes with transcript for the same object's storage; needs chunking for big files |
| R2 | Large and binary files | Not researched against Cloudflare's docs in this spike; as an object store it has no directories or multi-file atomic commits, so a sync layer would be needed |
| **Artifacts** | Versioned workspaces: fork a baseline per agent, commit, diff, hand a remote to a container or a human; every session a repo | Git semantics; ≤ 1 GB per repo, ≤ 32 MB per blob; 2,000 git requests per 10 s per repo; binding reads files but cannot write them ([limits](https://developers.cloudflare.com/artifacts/platform/limits/index.md), [binding](https://developers.cloudflare.com/artifacts/api/workers-binding/index.md)) |
| Container disk + snapshots | Real filesystem for heavy work | `durable_object` scheduling policy (public beta) only; snapshots save the filesystem, not memory/processes, ≤ 20 GB, kept 30 days from last restore, tied to one image version ([snapshots](https://developers.cloudflare.com/containers/guides/snapshots/index.md), [limits](https://developers.cloudflare.com/containers/platform/limits/index.md), updated 2026-10-12) |

### What Cloudflare Artifacts actually is

- Cloudflare's definition: "Versioned storage that speaks Git … store and version files, code, and projects behind a
  Git-compatible interface. Create repositories programmatically, import existing repositories, and connect using Workers, the
  REST API, or standard Git clients." (https://developers.cloudflare.com/artifacts/, updated 2026-10-01).
- Launch post: "a versioned file system that speaks Git", built so that "every agent session" or "every sandbox instance" can
  have a repo; "tens of millions of repos"; clone with `git clone https://x:${TOKEN}@<id>.artifacts.cloudflare.net/git/<repo>.git`
  (https://blog.cloudflare.com/artifacts-git-for-agents-beta/). The post announces a private beta targeting "public beta by early
  May"; the changelog records open beta on 2026-10-01, so the post's date and the timeline differ. I did not find the post date.
- Status and price: open beta since 2026-10-01; Workers Paid only; billing began 2026-10-14: first 10,000 operations/month
  free then $0.15 per 1,000; first 1 GB-mo free then $0.50/GB-mo ([pricing](https://developers.cloudflare.com/artifacts/platform/pricing/index.md),
  [changelog](https://developers.cloudflare.com/artifacts/platform/changelog/index.md)).
- Access model: repo-scoped `read`/`write` tokens that "your Worker or API layer decides when to mint" (how-artifacts-works), with a
  TTL (`createToken("read", 3600)`). Data localization (EU/US jurisdictions per namespace) since 2026-08-13.
- From a Worker, the isomorphic-git example (updated 2026-05-21) says the binding "cannot read or write files inside" repos, but
  the binding page (updated 2026-10-01) now lists `readFile`/`readBlob`/`readTree`/`log`, so the example is stale on reads; no
  binding method writes files. Writes go through the Git protocol:
  isomorphic-git with an in-memory FS (documented example) or `git` inside a sandbox (the `git-repo-per-sandbox` Sandbox SDK template,
  which injects an authenticated remote as `ARTIFACTS_GIT_REMOTE`). ArtifactFS (a FUSE mount, Go, `cloudflare/artifact-fs`)
  mounts a repo lazily inside a container.
- Not what the ticket's "mocked shell with Artifacts" might suggest: Artifacts runs no commands. What I could not confirm is
  any published account of people pairing a mocked shell with Artifacts; only Cloudflare's own sandbox + Artifacts example exists.

### Containers and the Sandbox SDK (the heavy side)

- Containers: a container image per Durable Object, "Available on Workers Paid plan". Instance types from `lite` (1/16 vCPU, 256 MiB,
  2 GB disk) to `standard-4` (4 vCPU, 12 GiB, 20 GB); billed per 10 ms active (CPU on active use, memory and disk on provisioned
  size); 25 GiB-h memory, 375 vCPU-min and 200 GB-h disk included, then $0.0000025/GiB-s, $0.000020/vCPU-s, $0.00000007/GB-s;
  egress $0.025/GB in NA/EU after 1 TB ([pricing](https://developers.cloudflare.com/containers/pricing/index.md), 2026-10-05).
- Sandboxes page (2026-09-30): two environments reachable from a Worker, **Containers** (full Linux microVM, per-instance
  kernel/network, `durable_object` policy in public beta) and **Dynamic Workers** (new Workers created at runtime for
  JS/Python/Wasm, "a lightweight alternative to containers"; no shell or native tools). `container.exec([...])` runs a
  process and `process.output()` returns exit code and output
  ([sandbox](https://developers.cloudflare.com/sandbox/index.md), [execute commands](https://developers.cloudflare.com/containers/guides/execute-commands/index.md)).
- Cloudflare's own "coding agent runner" tutorial keeps credentials out of the sandbox: the Worker adds the gateway token on
  outbound requests and the sandbox can reach only the gateway and `github.com`
  ([tutorial](https://developers.cloudflare.com/sandbox/get-started/build-a-coding-agent-runner/index.md), 2026-10-13). This is the same
  shape as keeping provider credentials in a ControlPlane.
- Local dev of containers needs Docker (same tutorial). I did not run a container in the spike, so the container leg was a stub.
- Cold start, sleep timeouts and `exec` behaviour under an agent loop are unmeasured here.
- The Sandbox SDK moved to a new major (`@cloudflare/sandbox` 0.x has a migration page), another unstable surface.

### `@earendil-works/pi-env` (remote over SSH)

- Purpose (README): "an agent's tools run on another machine, usually over SSH, while the Durable worker, its storage and
  credentials stay local." A Rust daemon (`pi-env`, shipped for Linux/macOS/Android/Windows, x86-64 and arm64) speaks a framed
  protocol over stdin/stdout; `RemoteExecutionEnv` is a full `ExecutionEnv` (files, exec, watch, `listFiles`) whose results match `NodeExecutionEnv`.
- The transport is `node:child_process` `spawn` of `ssh` or of a local daemon (`dist/connection.js`, `dist/ssh.js`); `Connection`
  takes a `command` array, not a socket. **It cannot run in a Worker or Durable Object as shipped.** Reaching a remote box from
  a Worker would need a different `Connection` (the protocol is documented in `docs/protocol.md`) over a TCP/WebSocket path, which
  I did not evaluate. Fine if pi-durable itself runs on Node (for example inside a container), then SSH to the user's machine.
- Relevant to self-hosting: it fits "bring your own box" (a user's workstation/GPU host) more than a hosted multi-tenant
  service, and it needs host-key trust management (`scanHostKey`/`acceptHostKey`) per target.

### How an ExecutionEnv would route (shown in the spike)

```
Harness env: (target) => router               // one router per conversation; id = "do:<object id>"
  router.readTextFile / writeFile / ...  ->  workspace in DO SQLite (just-bash InMemoryFs, write-through)
  router.exec(cmd):
     light (echo, cat, grep, jq, sed, file edits)   -> just-bash on the same workspace
     heavy (npm, git, python, node, make, ...)      -> HeavyEnv.run(cmd, workspace) -> container.exec, sync files back
```

Code: `spikes/pi-durable/src/router-env.ts` (about 150 lines; the heavy side is a stub; routing is a regex; unsupported
`FileSystem` methods answer `not_supported`). Open design questions the spike did not answer: how files cross to the
container and back (git via Artifacts, a snapshot, `container.exec` with stdin tar, R2); who decides light vs heavy (regex,
the model via two tools, or a fallback when just-bash reports "command not found"); one container per conversation (the
pi-durable `id` rule: equal ids see the same files) and its idle cost; and cancellation, since a killed `exec` leaves unknown state.

## 3. What was proven locally (spike)

Location: `spikes/pi-durable/` (own `package.json`; `npx vitest run` there; `wrangler.jsonc` is only for the dry-run bundle
measurement). Nothing was deployed or uploaded.

| Claim | Evidence |
|---|---|
| A Harness opens on a DO's `ctx.storage` in workerd | `test/agent.test.ts` passes |
| The agent calls an OpenAI-compatible `…/v1/chat/completions` with `Authorization: Bearer <proxy key>` (pi-ai `createProvider` + `openAICompletionsApi`, `baseUrl` = proxy) | asserted on the stubbed `fetch`, first request |
| Two tool calls, one per environment | routed `["virtual","heavy"]`; transcript holds `hello` and `[container] ran: npm run build # heavy …` |
| Idle eviction: history and files persist, same `requestId` reuses the answer | `abortAllDurableObjects()`; 0 extra model calls |
| Mid-run eviction resumes without repeating a finished tool call | `test/midrun.test.ts`; 3 model calls total |
| A full run is quick | about 2 s wall including cold start and bundle load in the test runner (not a performance claim) |

Not proven: a real model through the real Commissary routes (the proxy was a `fetch` stub, so spend limits, grants and the
proxy gate were not exercised); a real container; Artifacts; alarm-driven resume; real deploy-time eviction; long
transcripts; CPU time per run; startup time; behaviour under many concurrent agents; `abandonOnRestart` semantics for `bash`.

## 4. Hosted agents reaching Commissary's own models, tools and browser

Facts first. Commissary's proxy gate authenticates a proxy route by a proxy key (`cfp_<org>_<key id>_<secret>`) belonging to a
member; hosted proxies take proxy keys only and rate-limit per org (429 + `Retry-After`); usage and spend limits attach to
member/team/org/credential/proxy key (`docs/ARCHITECTURE.md` "Proxy keys", "Hosted proxy", "Spend limits"). Org state lives in a
per-org `ControlPlane` Durable Object; the Worker already uses JS RPC to it. The existing `SessionState` Durable Object holds
per-caller session state.

- **Models.** pi-ai `createProvider({ baseUrl, auth: { apiKey: … }, api: openAICompletionsApi() })` makes any
  OpenAI-compatible endpoint a provider; there are also Anthropic and Responses APIs, so the agent can speak whichever Commissary
  route fits. Options:
  - *Over HTTP with a proxy key* (what the spike did). Pros: exercises the gate, spend limits and usage accounting
    unchanged, agent code needs nothing special, same path a user's client takes. Cons: an extra network hop to itself
    (a Worker calling its own public URL needs a service binding or custom-domain loop), and the per-org rate limit and spend
    limits will count agent traffic as ordinary traffic (probably wanted). The agent holds a bearer secret; it needs an
    owner (a member? a special agent principal?) and a revocation story.
  - *Service binding / in-process call to the same handler with a trusted principal.* Pros: no key in the agent's storage,
    no hop. Cons: a new principal kind and a bypass of the gate that must still apply grants and spend limits; more code in the
    core.
  - Either way: pi-durable's pi-ai `models` is the only place model calls happen, and tool/hook code gets the same
    `models` (`ToolExecutionApi.models`, 1.1.0), so model access for subagents and compaction follows one provider setup.
- **Tools (MCP gateway).** pi ships `@earendil-works/pi-mcp`: a client with stdio and Streamable HTTP transports, OAuth subset,
  an injectable `fetch`, and `toLlmContent()`. Only the HTTP transport can run in a Worker. pi-durable tools are registered via
  `ToolRegistration` and can be namespaced for codemode (`mcp__github__` example in the README); `callers` and `deferred` control
  who may call a tool and keep large tool lists out of the prompt (`tool_search`, 1.2.0). A Commissary Tools gateway would appear
  to the agent as one Streamable-HTTP MCP endpoint authenticated with the same kind of key; unresolved: per-tool grants (the
  glossary's grant) and tool call attribution/spend.
- **Browser.** Not researched beyond the interface: if Browser is exposed as MCP tools or an HTTP API, it is just another tool
  the router hands to the model; if it needs CDP, the connection runs from a Worker/container. Left to the Browser tickets.
- Credential isolation: following Cloudflare's own sandbox tutorial, secrets (model keys) stay in the Worker/ControlPlane and
  the sandbox gets only a short-lived, scoped credential or an outbound proxy that injects it. The same applies to a container
  running agent-written commands: it should get no proxy key and no Artifacts write token beyond one repo's.

## 5. Options and trade-offs (not decisions)

| Question | Option | For | Against |
|---|---|---|---|
| Agent host | pi-durable in one Durable Object per agent | Matches Commissary's existing per-org Durable Object pattern; SQLite local, transactional; no new infra | Experimental package, adapter 8 days old; object CPU/memory limits shared with tools; deploys restart agents; needs an alarm to resume |
| | pi-durable in a container (Node) | Real Node APIs, `pi-env`/SSH works, no 128 MB cap | Cost per idle agent, cold starts, `durable_object` policy still beta; own storage (SQLite file or JSONL) needs persistence/snapshots |
| Light commands | just-bash over DO files | Zero extra infra, instant, safe by construction | Not real bash; no native programs; Node-only extras unavailable; 1.2 MB of bundle; file model (2 MB rows) to design |
| Heavy commands | Cloudflare Container per conversation | Real Linux, snapshots, egress control, same platform and billing | Paid-plan only (self-hosters on Free cannot use it); beta scheduling policy; Docker for local dev; cost; file sync |
| | Remote host over `pi-env` | Bring-your-own machine, no Cloudflare cost | Node-only transport (not from a Worker); host-key trust; unfit for a hosted free tier |
| | Dynamic Workers (JS/Wasm only) | Millisecond start, cheap | No shell; only JS/Python/Wasm code |
| Workspace store | DO SQLite only | Simple, atomic with transcript | 10 GB / 2 MB-row limits; invisible to a container without a sync |
| | Artifacts | Versioned, forkable, Git for the container and for human review | Beta; paid; Git write path (isomorphic-git or git binary) adds CPU/complexity; 1 GB/repo |
| | R2 | Size | Not verified here; likely no history or atomic multi-file writes |
| Model access | proxy key over HTTP vs in-process | see section 4 | |

Consequences for self-hosted versus Commissary Cloud: Artifacts, Containers and the Sandbox are Workers Paid features, so
a self-hosted deployment on Workers Free gets at most the Durable-Object-plus-just-bash tier; Commissary Cloud pays for the
containers on its own account and would have to meter them (the glossary's spend limit covers model spend today, not container
seconds).

## Sources

- pi-durable README, CHANGELOG, `dist/` (npm `@earendil-works/pi-durable@1.2.0`); spec: https://github.com/earendil-works/pi/blob/main/packages/durable/docs/spec.md
- pi-env README, `dist/connection.js`, `dist/ssh.js` (npm `@earendil-works/pi-env@1.2.0`); pi-codemode README and
  `examples/cloudflare`, pi-mcp README, pi-ai README: https://github.com/earendil-works/pi/tree/main/packages
- Durable Object test for the adapter: https://github.com/earendil-works/pi/blob/main/packages/durable/test/sqlite-cloudflare.test.ts
- just-bash: https://github.com/vercel-labs/just-bash (README in npm `just-bash@3.6.0`)
- Artifacts: https://developers.cloudflare.com/artifacts/ (+ `/api/workers-binding/`, `/platform/pricing/`, `/platform/limits/`,
  `/platform/changelog/`, `/concepts/how-artifacts-works/`, `/examples/isomorphic-git/`, `/examples/sandbox-sdk-artifacts/`,
  `/guides/artifact-fs/`); https://blog.cloudflare.com/artifacts-git-for-agents-beta/; https://www.cloudflare.com/products/artifacts
- Durable Objects: https://developers.cloudflare.com/durable-objects/platform/limits/ , `/platform/pricing/`, `/concepts/durable-object-lifecycle/`
- Workers limits: https://developers.cloudflare.com/workers/platform/limits/
- Containers/Sandbox: https://developers.cloudflare.com/containers/ (`/platform/limits/`, `/pricing/`, `/configuration/scheduling-policy/`,
  `/guides/snapshots/`, `/guides/execute-commands/`), https://developers.cloudflare.com/sandbox/ ,
  https://developers.cloudflare.com/sandbox/get-started/build-a-coding-agent-runner/ , https://developers.cloudflare.com/dynamic-workers/
- Commissary internals: `docs/ARCHITECTURE.md` ("Runtime topology", "Proxy keys", "Hosted proxy"), `GLOSSARY.md`
