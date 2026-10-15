# AGENTS.md

TypeScript + Effect v4 (`effect@4.0.2`) port of [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) on plain Cloudflare Workers, behind Cloudflare Access. One pnpm package at the repository root; the control panel served at `/` lives in `web/` (React + Effect Atom, talks to the management API through `src/management/contract/`; design system in `DESIGN.md`, product context in `PRODUCT.md`, surface briefs in `.impeccable/`). Design: `docs/ARCHITECTURE.md` (layout, per-subsystem behaviour, where it differs from Go); developer notes: `docs/DEVELOPMENT.md`.

## Commands

- Run before finishing: `pnpm typecheck && pnpm lint && pnpm test && pnpm smoke`; `pnpm format` formats.
- Never run `pnpm run deploy`/`pnpm destroy` (Alchemy) against a real account unless asked. CI deploys previews (`pr-<number>`) and, from `main`, production (`prod`, self-hosted) and Commissary Cloud (`hosted`): `docs/DEPLOY.md`.
- Commits follow Conventional Commits (`feat:`, `fix:`, `chore:`, …); Husky hooks format/lint staged files, check commit messages and run `pnpm typecheck && pnpm lint` before push. Fix hook failures instead of bypassing them.

## Go reference

- The Go server is a reference, not the authority (ADR 0019): a source of ideas and tested behaviour that Commissary copies by choice. It lives in the read-only reference checkout `.repos/CLIProxyAPI`; Go paths in code and docs (`internal/...`, `sdk/...`) are relative to it. Read it there; change only this repository.
- Golden fixtures come from `tools/fixturegen` (Go programs run against the reference checkout, see `docs/DEVELOPMENT.md`). A fixture diff after a reference update shows an upstream change to consider, not one that must be ported.

## Learning more about Effect

This repository uses the Effect Typescript library.

Before writing any Effect code, first read `node_modules/effect/AGENTS.md`
**completely**, and follow the links in the file when required.

If you need to learn more about particular Effect apis and concepts that the
guide doesn't cover, search through the source code in `node_modules/effect/src`.
Effect v4 APIs differ from Effect 3.

## Conventions

- Infrastructure is Alchemy v2 (`alchemy.run.ts`, `infra/`); there is no Wrangler config. A new binding/variable goes in the Worker `env` in `alchemy.run.ts`, `src/env.d.ts` and `vitest.config.ts` together.
- Tests under `test/` run in workerd via `@cloudflare/vitest-plugin` (`exports.default.fetch` from `cloudflare:workers`); use `@effect/vitest` for Effect code.
- Per-request `env`/`ctx` are provided as `WorkerEnv`/`WorkerExecutionContext` services via the web handler's `Context` (`requestContext`); layers stay free of them.
- Translators/thinking/payload rules are pure sync functions over parsed JSON; cite the Go source path at the top of each module that copies Go. Payload rules stay the final mutation before upstream requests.
- Lint (`docs/DEVELOPMENT.md` "Lint and format") must have zero errors; fix findings instead of silencing them. An unavoidable type assertion gets a `// SAFETY: <invariant>` comment before it.
- Redact tokens/API keys/JWTs in logs (`redactHeaders`); drive time in tests with `TestClock`; justify every `any` with a comment.
- A difference from Go is an ordinary design decision (ADR 0019): note it in `docs/ARCHITECTURE.md` where it helps a reader. Cite a Go source path only where the code actually copies Go.

## Reference repositories

The `pnpm install` command materializes these read-only references in `.repos/`.
Run `pnpm repos:sync` (`./tools/sync-reference-repos.sh`) to refresh them; `pnpm install` skips it when dependencies are up to date.

| Repository                                                                                                          | Path                                     | Useful for                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`router-for-me/CLIProxyAPI`](https://github.com/router-for-me/CLIProxyAPI)                                         | `.repos/CLIProxyAPI`                     | The Go server this project ports: the reference (ADR 0019) for translators, thinking, payload rules, executors, credential selection/refresh and the management API; `tools/fixturegen` builds against it to generate golden fixtures. Its model catalogs are not a source any more: the catalog comes from models.dev plus our catalog additions (`pnpm catalog:sync`, ADR 0020). |
| [`router-for-me/Cli-Proxy-API-Management-Center`](https://github.com/router-for-me/Cli-Proxy-API-Management-Center) | `.repos/Cli-Proxy-API-Management-Center` | The upstream management web UI for CLIProxyAPI: a reference for the `web/` control panel's feature set and flows (provider keys, auth files, OAuth login, config/YAML editing, quotas, logs, dashboard) and for how a client consumes the management API. Ideas to adapt, not a design to copy: `web/` follows `DESIGN.md`/`PRODUCT.md`.                                           |

## Agent skills

### Issue tracker

Issues live in this repo's GitHub Issues, managed with the `gh` CLI (it reads the repo from `git remote`). See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: root `GLOSSARY.md` + `docs/adr/`, created lazily. See `docs/agents/domain.md`.
