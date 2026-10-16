/**
 * The ControlPlane a Worker binds (`CONTROL_PLANE`, one object per org): the org-wide base ({@link OrgControlPlane})
 * composed with the areas' parts (#134 "How an area's ControlPlane part works", #148). The Worker lists its areas
 * explicitly, `export class ControlPlane extends composeControlPlane({ models: (ctx, env, core) => new ModelsPart(ctx,
 * env, core) }) {}`; there is no registry.
 *
 * Each part is reached through a method of its name, so a caller reaches it in one pipelined round trip,
 * `stub.models().pick(…)`, under vitest-pool-workers too (which answers a getter of a Durable Object stub with a
 * function, #148). The object constructs each part once. A test that evicts the object first disposes of any stub of a
 * part it holds.
 */
import {
  type ControlPlanePart,
  type ControlPlaneParts,
  OrgControlPlane,
  type OrgCore,
  type PartFactories,
} from "./control-plane.ts";
import type { StateObjectEnv } from "./env.ts";

/** How the composed ControlPlane constructs an area's part (`new ModelsPart(ctx, env, core)`). */
export type PartMaker<E> = (ctx: DurableObjectState, env: E, core: OrgCore) => ControlPlanePart;

/** The makers of the areas' parts, by name. */
export type PartMakers<E> = Readonly<Record<string, PartMaker<E>>>;

/** The parts `M` makes, by name. */
export type PartsOf<M extends PartMakers<never>> = { readonly [K in keyof M]: ReturnType<M[K]> };

/** The method of each part's name that answers the part: `stub.models().x()`. */
export type PartMethods<P extends ControlPlaneParts> = { [K in keyof P]: () => P[K] };

/** The composed ControlPlane class, constructed by the runtime with the Worker's `env` (`E`: what the parts read). */
export type ComposedControlPlane<P extends ControlPlaneParts, E> = new (
  ctx: DurableObjectState,
  env: E,
) => OrgControlPlane<P> & PartMethods<P>;

/** What the base sets on each instance (`DurableObject`'s `ctx` and `env`, its own fields): a part's method would be hidden. */
const INSTANCE_MEMBERS: ReadonlySet<string> = new Set(["ctx", "env", "parts", "started"]);

/**
 * The org-wide base with the parts `makers` construct, each reached through a method of its name. Each maker gets the
 * Worker's `env` as its part's view (`E`); the class is constructed with an `env` that is also {@link StateObjectEnv}.
 * A name the base already answers (one of its methods or fields, `alarm`, `env`, …) is refused: the part would hide it,
 * or be hidden.
 */
export const composeControlPlane = <E, M extends PartMakers<E>>(
  makers: M & PartMakers<E>,
): ComposedControlPlane<PartsOf<M>, StateObjectEnv & E> => {
  const names = Object.keys(makers);

  for (const name of names)
    if (name in OrgControlPlane.prototype || INSTANCE_MEMBERS.has(name))
      throw new Error(
        `a ControlPlane part cannot be named "${name}": the base has a member of that name`,
      );

  class ControlPlane extends OrgControlPlane<PartsOf<M>> {
    constructor(ctx: DurableObjectState, env: StateObjectEnv & E) {
      super(ctx, env, factories(makers, ctx, env));
    }

    static {
      for (const name of names)
        Object.defineProperty(ControlPlane.prototype, name, {
          value: function part(this: ControlPlane) {
            return this.parts[name];
          },
          writable: true,
          configurable: true,
        });
    }
  }

  // SAFETY: the static block gave the class one method per name of `makers`, each answering the part of that name.
  return ControlPlane as ComposedControlPlane<PartsOf<M>, StateObjectEnv & E>;
};

/** The base's factories: each makes its part with the object's state and `env`. */
const factories = <E, M extends PartMakers<E>>(
  makers: M,
  ctx: DurableObjectState,
  env: E,
): PartFactories<PartsOf<M>> => {
  const made: Partial<Record<string, (core: OrgCore) => ControlPlanePart>> = {};

  for (const [name, make] of Object.entries<PartMaker<E>>(makers))
    made[name] = (core) => make(ctx, env, core);

  // SAFETY: `made` holds one factory for each name of `makers`, making that name's part.
  return made as PartFactories<PartsOf<M>>;
};
