/**
 * Dev only (`alchemy dev`); no deployed bundle imports this module (`@commissary/state/dev-state-bridge`, not the
 * package's root). It lets the API Worker reach the Durable Objects the app Worker hosts locally under `alchemy dev`.
 *
 * There every Worker runs in its own workerd, and a cross-script Durable Object binding goes through miniflare's dev
 * registry, which reaches the object by its hex id and drops `ctx.id.name`
 * ([cloudflare/workerd#7286](https://github.com/cloudflare/workerd/issues/7286)), the name a ControlPlane learns its org
 * from. So under `alchemy dev` the app Worker hosts the objects itself (apps/app/src/dev.ts) and also exports
 * {@link DevStateBridge}, and the API Worker's dev entry (apps/api/src/dev.ts) binds that entrypoint as a service and
 * replaces its state namespaces with {@link devBridgedNamespace}s. Each stub of those records the call chain the caller
 * writes (`stub.models().pick(…)`) and sends it over the service binding with the object's name, as plain arguments,
 * and {@link replayDevChain} replays it on the app Worker's own stub. Both Workers then share one copy of each object.
 * Deployed Workers bind the state Worker's namespaces by script name (alchemy.run.ts) and never use this.
 *
 * Limits, acceptable in dev: a call is sent at the end of the turn it was made in, as one chain with the calls chained
 * onto it in that turn (a member read is sent only when awaited); a call chained onto one later is sent again with
 * that call. A stub's `id`, `fetch` and `connect` are not bridged.
 */
import { WorkerEntrypoint } from "cloudflare:workers";
import type { StateBindings } from "./env.ts";

/** The state namespaces the bridge reaches. */
export type DevStateBinding = keyof StateBindings;

/** An argument of a bridged call, of any type: passed on untouched and never read. */
export interface DevChainArgument {
  readonly opaque?: never;
}

/** A member read (`stub.models`), or a call of the step before it (`(…)`). */
export type DevChainStep =
  | { readonly kind: "member"; readonly key: string }
  | { readonly kind: "call"; readonly args: ReadonlyArray<DevChainArgument> };

/**
 * What a chain walks: the runtime's stub, an RPC promise or a member of one. The runtime answers every member of a
 * stub or an RPC promise with another, and a call of a member with an RPC promise.
 */
export interface DevRemote {
  readonly [member: string]: DevRemote | undefined;
  (...args: DevChainArgument[]): DevRemote;
}

/** The {@link DevStateBridge} entrypoint as its caller's service binding answers it. */
export interface DevStateBridgeRpc {
  call(
    binding: DevStateBinding,
    name: string,
    chain: ReadonlyArray<DevChainStep>,
  ): Promise<DevRemote | undefined>;
}

/** A namespace as the replay reads it: the stub of a name. */
interface NamedObjects {
  getByName(name: string): object;
}

/**
 * Replays `chain` on the stub `namespace` names `name` and answers what it reached, settled. A call keeps the member
 * it calls as written (`stub.models()` calls `models` on the stub), so the stub stays its receiver.
 */
export const replayDevChain = async (
  namespace: NamedObjects,
  name: string,
  chain: ReadonlyArray<DevChainStep>,
): Promise<DevRemote | undefined> => {
  // SAFETY: a Durable Object stub answers every member read with an RPC member, and a call of one with an RPC promise,
  // whose members are the same; a member that is no function throws when called, as it would on the stub.
  let value = namespace.getByName(name) as DevRemote | undefined;

  // The step a call is a member of, and the member's name.
  let receiver: DevRemote | undefined;
  let member: string | undefined;

  for (const step of chain) {
    if (step.kind === "member") {
      receiver = value;
      member = step.key;
      value = value?.[step.key];
      continue;
    }

    const result =
      member === undefined ? value?.(...step.args) : receiver?.[member]?.(...step.args);

    if (result === undefined) throw new TypeError(`${member ?? "the value"} is not an RPC method`);
    value = result;
    receiver = undefined;
    member = undefined;
  }

  return await Promise.resolve(value);
};

/** The app Worker's dev entrypoint the API Worker's dev entry binds (`alchemy dev` only). */
export class DevStateBridge extends WorkerEntrypoint<StateBindings> {
  async call(
    binding: DevStateBinding,
    name: string,
    chain: ReadonlyArray<DevChainStep>,
  ): Promise<DevRemote | undefined> {
    return await replayDevChain(this.env[binding], name, chain);
  }
}

/** Sends a chain of the object `name` names. */
type Send = (chain: ReadonlyArray<DevChainStep>) => Promise<DevRemote | undefined>;

/** What the proxy of a chain stands for: a member that may be called, or the result of a call. */
type ChainCall = (...args: DevChainArgument[]) => void;

/** Never called itself: a function of the proxies' own, only so that a proxy can be called (`apply` of its handler). */
const chainTarget: ChainCall = () => undefined;

/** A member every object has (`toString`, `constructor`, …) or `toJSON`, which serializers look up: never bridged. */
const isObjectMember = (key: string): boolean => key in Object.prototype || key === "toJSON";

/**
 * The proxy of `chain`: awaiting it sends it, a member read or a call of it extends it. A chain that ends in a call is
 * sent at the end of the turn unless the turn extended it, as the runtime sends a call when it is made.
 */
const chainProxy = (send: Send, chain: ReadonlyArray<DevChainStep>): ChainCall => {
  let sent: Promise<DevRemote | undefined> | undefined;
  let extended = false;

  const settled = (): Promise<DevRemote | undefined> => (sent ??= send(chain));

  if (chain.at(-1)?.kind === "call")
    queueMicrotask(() => {
      // A failure reaches whoever awaits the call; one nobody awaits is dropped, as the runtime drops it.
      if (!extended) settled().catch(() => undefined);
    });

  const extend = (step: DevChainStep): ChainCall => {
    extended = true;

    return chainProxy(send, [...chain, step]);
  };

  const handler: ProxyHandler<ChainCall> = {
    get: (_target, key) => {
      switch (key) {
        case "then":
          return (
            onFulfilled?: (value: DevRemote | undefined) => DevRemote,
            onRejected?: (cause: Error) => DevRemote,
          ) => settled().then(onFulfilled, onRejected);
        case "catch":
          return (onRejected?: (cause: Error) => DevRemote) => settled().catch(onRejected);
        case "finally":
          return (onFinally?: () => void) => settled().finally(onFinally);
        default:
          return typeof key === "symbol" || isObjectMember(key)
            ? undefined
            : extend({ kind: "member", key });
      }
    },
    apply: (_target, _receiver, args: DevChainArgument[]) => extend({ kind: "call", args }),
  };

  return new Proxy(chainTarget, handler);
};

/** Members of a stub the bridge does not carry. */
const NOT_BRIDGED: ReadonlySet<string> = new Set(["id", "fetch", "connect"]);

/** A stub of the object `name` names, whose calls go over `bridge`. */
const bridgedStub = <T extends Rpc.DurableObjectBranded | undefined>(
  bridge: DevStateBridgeRpc,
  binding: DevStateBinding,
  name: string,
): DurableObjectStub<T> => {
  const send: Send = (chain) => bridge.call(binding, name, chain);

  // SAFETY: the proxy answers every member but the ones below with a bridged chain, which `DevStateBridge` replays on
  // the real stub of `name`, so it answers the RPC calls of the object's type.
  const target = {} as DurableObjectStub<T>;

  return new Proxy(target, {
    get: (_target, key) => {
      if (key === "name") return name;

      if (key === "then" || typeof key === "symbol" || isObjectMember(key)) return undefined;

      if (NOT_BRIDGED.has(key))
        throw new TypeError(`${key} of a Durable Object stub is not bridged under alchemy dev`);

      return chainProxy(send, [{ kind: "member", key }]);
    },
  });
};

/** `binding`'s namespace over `bridge`: only `getByName`, the one way Commissary reaches its objects. */
export const devBridgedNamespace = <T extends Rpc.DurableObjectBranded | undefined>(
  bridge: DevStateBridgeRpc,
  binding: DevStateBinding,
): DurableObjectNamespace<T> => {
  const unsupported = (what: string) => (): never => {
    throw new TypeError(`${binding}.${what} is not bridged under alchemy dev; use getByName`);
  };

  return {
    newUniqueId: unsupported("newUniqueId"),
    idFromName: unsupported("idFromName"),
    idFromString: unsupported("idFromString"),
    get: unsupported("get"),
    jurisdiction: unsupported("jurisdiction"),
    getByName: (name) => bridgedStub<T>(bridge, binding, name),
  };
};

/** The binding of the app Worker's {@link DevStateBridge} in the API Worker under `alchemy dev`. */
export interface DevStateBridgeBindings {
  readonly DEV_STATE_BRIDGE: DevStateBridgeRpc;
}

/** The `env` of a Worker that reaches the state over the bridge: its own (`E`) without the state namespaces. */
export type DevBridgedEnv<E extends StateBindings> = Omit<E, DevStateBinding> &
  DevStateBridgeBindings;
