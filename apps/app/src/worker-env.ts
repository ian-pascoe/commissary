/**
 * The Worker's bindings as its code reads them (#134 "How packages get their bindings"): every future package reads
 * only its own view ({@link AuthConfig}, {@link StateEnv}, {@link ModelsEnv}; `core` reads none), and the code that
 * stays in the Worker reads {@link AppEnv}. The request context provides each of them from the invocation's `env`, which
 * satisfies every view (`WorkerBindings`).
 */
import { Context } from "effect";
import { type AuthBindings, AuthConfig } from "./auth/config.ts";
import type { SignInBindings } from "./hosted/auth.ts";
import { type ModelsBindings, ModelsEnv } from "./models/env.ts";
import { WorkerExecutionContext } from "./platform/env.ts";
import { CurrentOrg, GLOBAL_ORG } from "./platform/org.ts";
import { type StateBindings, StateEnv } from "./state/env.ts";

/**
 * What the Worker's own code reads (the panel's assets, its hosts, Better Auth's sign-in, the owned-org limit): code
 * that stays in an app when the packages move.
 */
export interface AppBindings extends SignInBindings {
  /** Static assets (management panel, `management/web-panel.ts`). */
  readonly ASSETS: Fetcher;
  /** The app host (`http/hosts.ts`, ADR 0028). */
  readonly APP_DOMAIN?: string;
  /** The API host (`http/hosts.ts`, ADR 0028). */
  readonly API_DOMAIN?: string;
  /** Hosted: how many orgs a person may own unless a platform admin raised their limit (`hosted/standing.ts`). */
  readonly OWNED_ORG_LIMIT?: string;
  /** Hosted: Cloudflare Turnstile widget keys guarding sign-in and sign-up (`hosted/routes.ts`). */
  readonly TURNSTILE_SITE_KEY?: string;
  readonly TURNSTILE_SECRET_KEY?: string;
}

/**
 * The Worker's own bindings of the current invocation. Provided per request through the `Context` handed to the web
 * handler ({@link requestContext}), never through a long-lived layer: bindings must not be captured across requests.
 */
export class AppEnv extends Context.Service<AppEnv, AppBindings>()("commissary/worker/AppEnv") {}

/** Every view of the Worker's `env`; the global `Env` satisfies it. */
export type WorkerBindings = AuthBindings & StateBindings & ModelsBindings & AppBindings;

/** The services {@link envContext} provides. */
export type EnvServices = AuthConfig | StateEnv | ModelsEnv | AppEnv;

/** Each view of `env`, as its service. */
export const envContext = (env: WorkerBindings): Context.Context<EnvServices> =>
  Context.make(AuthConfig, env).pipe(
    Context.add(StateEnv, env),
    Context.add(ModelsEnv, env),
    Context.add(AppEnv, env),
  );

/**
 * Builds the per-request context passed as the second argument of the web handler. Every request belongs to the org
 * `global` for now (ADR 0021); resolving the org from the request replaces this default later.
 */
export const requestContext = (
  env: WorkerBindings,
  ctx: ExecutionContext,
): Context.Context<EnvServices | WorkerExecutionContext | CurrentOrg> =>
  envContext(env).pipe(
    Context.add(WorkerExecutionContext, ctx),
    Context.add(CurrentOrg, GLOBAL_ORG),
  );
