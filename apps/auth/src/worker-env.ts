/**
 * The auth Worker's bindings as its code reads them (#134 "How packages get their bindings"): its own view
 * ({@link AuthWorkerEnv}: Better Auth's database and settings, the app origin, Turnstile) and the port
 * `@commissary/auth` reaches state through (`AuthDirectory`, over the state Worker's Durable Objects). It runs no
 * gate, so it reads no `AuthConfig`.
 */
import { Context } from "effect";
import { AuthDirectory } from "@commissary/auth";
import { WorkerExecutionContext } from "@commissary/core";
import { stateAuthDirectory, type StateBindings } from "@commissary/state";
import type { SignInBindings } from "./sign-in/auth.ts";

/** What the auth Worker's own code reads besides the state namespaces. */
export interface AuthWorkerBindings extends SignInBindings, StateBindings {
  /** Cloudflare Turnstile widget keys guarding sign-in and sign-up (`http/sign-in-routes.ts`). */
  readonly TURNSTILE_SITE_KEY?: string;
  readonly TURNSTILE_SECRET_KEY?: string;
}

/**
 * The auth Worker's bindings of the current invocation. Provided per request through the `Context` handed to the web
 * handler ({@link requestContext}), never through a long-lived layer: bindings must not be captured across requests.
 */
export class AuthWorkerEnv extends Context.Service<AuthWorkerEnv, AuthWorkerBindings>()(
  "commissary/auth-worker/AuthWorkerEnv",
) {}

/** The services {@link requestContext} provides. */
export type EnvServices = AuthWorkerEnv | AuthDirectory | WorkerExecutionContext;

/** The per-request context passed as the second argument of the web handler. */
export const requestContext = (
  env: AuthWorkerBindings,
  ctx: ExecutionContext,
): Context.Context<EnvServices> =>
  Context.make(AuthWorkerEnv, env).pipe(
    Context.add(AuthDirectory, stateAuthDirectory(env)),
    Context.add(WorkerExecutionContext, ctx),
  );
