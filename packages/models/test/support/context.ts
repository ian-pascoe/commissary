// The per-request context of Models' tests, as a Worker builds it (its `requestContext`): each view of `env` Models and
// the packages below it read, auth's ports over it, the invocation's context and the org. The test Worker is
// self-hosted, so no Better Auth session ever signs anyone in (`SignInSessions`).
import { Context, Effect } from "effect";
import { type AuthBindings, AuthConfig, AuthDirectory, SignInSessions } from "@commissary/auth";
import { CurrentOrg, GLOBAL_ORG, WorkerExecutionContext } from "@commissary/core";
import { stateAuthDirectory, type StateBindings, StateEnv } from "@commissary/state";
import { type ModelsBindings, ModelsEnv } from "../../src/env.ts";

/** Every view of `env` the tests provide; the test Worker's `env` satisfies it. */
export type TestBindings = AuthBindings & StateBindings & ModelsBindings;

/** The services {@link envContext} provides. */
export type EnvServices = AuthConfig | StateEnv | ModelsEnv | AuthDirectory | SignInSessions;

const noSessions = SignInSessions.of({ person: () => Effect.succeed(undefined) });

/** Each view of `env`, as its service, and auth's directory over the Durable Object stubs. */
export const envContext = (env: TestBindings): Context.Context<EnvServices> =>
  Context.make(AuthConfig, env).pipe(
    Context.add(StateEnv, env),
    Context.add(ModelsEnv, env),
    Context.add(AuthDirectory, stateAuthDirectory(env)),
    Context.add(SignInSessions, noSessions),
  );

/** {@link envContext} with the invocation's context and the org `global`, as the web handler receives it. */
export const requestContext = (
  env: TestBindings,
  ctx: ExecutionContext,
): Context.Context<EnvServices | WorkerExecutionContext | CurrentOrg> =>
  envContext(env).pipe(
    Context.add(WorkerExecutionContext, ctx),
    Context.add(CurrentOrg, GLOBAL_ORG),
  );
