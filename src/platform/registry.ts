/**
 * The Worker's side of the Platform registry (ADR 0021): {@link platformOf} is the only place that turns the deployment
 * into a `Platform` stub, as `controlPlaneOf` is for an org's ControlPlane.
 */
import { Data, Effect } from "effect";
import { WorkerEnv } from "./env.ts";
import type { OrgRecord } from "./registry-store.ts";

export type PlatformStub = ReturnType<Env["PLATFORM"]["getByName"]>;

/** The one Platform object of the deployment is named like this. */
export const PLATFORM_NAME = "platform";

export const platformOf = (env: Env): PlatformStub => env.PLATFORM.getByName(PLATFORM_NAME);

/** The Platform registry could not be reached; carries no payload, the cause is logged by the caller. */
export class PlatformUnavailable extends Data.TaggedError("PlatformUnavailable")<{
  readonly message: string;
}> {}

/** Calls the Platform registry; a failed RPC is a {@link PlatformUnavailable} (RPC results are plain data after `await`). */
export const platform = <R>(
  label: string,
  call: (stub: PlatformStub) => R,
): Effect.Effect<Awaited<R>, PlatformUnavailable, WorkerEnv> =>
  Effect.gen(function* () {
    const stub = platformOf(yield* WorkerEnv);

    return yield* Effect.tryPromise({
      try: async (): Promise<Awaited<R>> => await call(stub),
      catch: (cause) =>
        new PlatformUnavailable({
          message: `${label}: ${cause instanceof Error ? cause.message : "unknown error"}`,
        }),
    });
  });

/** The org with this id, if the registry lists it. */
export const orgById = (
  id: string,
): Effect.Effect<OrgRecord | undefined, PlatformUnavailable, WorkerEnv> =>
  platform("getOrgById", (stub) => stub.getOrgById(id));
