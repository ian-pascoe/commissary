/**
 * Callers of the state Worker retry once on a code-update reset (ADR 0030, #128). Deploying the state Worker restarts
 * its Durable Objects, and a call in flight at that moment fails with "Durable Object reset because its code was
 * updated." (in-memory state only: what the object had stored stays). {@link retryOnCodeUpdate} wraps a Worker's state
 * bindings so that every call through them is sent once more, on a new stub, when it fails that way; any other failure,
 * and a second reset, reaches the caller unchanged.
 *
 * A wrapped stub behaves as the runtime's: a call is sent when it is made, and a pipelined call
 * (`stub.models().pick(…)`) is still one round trip. The retry replays the whole chain on a new stub, because a stub
 * that threw may stay broken (Cloudflare's "Error handling" guide). A stub's `id`, `name`, `fetch` and `connect` are the
 * runtime's own, never retried: a request body is read once.
 *
 * A call the reset cut off may already have stored what it wrote, and the retry sends it again all the same: resets
 * happen only while the state Worker deploys, and #128 chose one retry over failing every call in flight.
 */
import type { StateBindings } from "./env.ts";

/** The runtime's message for a call that a deploy of the Durable Object's code cut off. */
const CODE_UPDATE_RESET = "reset because its code was updated";

/** Whether `cause` is the failure of a call that a deploy of the Durable Object's code cut off. */
export const isCodeUpdateReset = (cause: unknown): boolean =>
  cause instanceof Error && cause.message.includes(CODE_UPDATE_RESET);

/** Members of a stub that are not RPC methods, or whose calls cannot be sent twice. */
const STUB_OWN_MEMBERS: ReadonlySet<string> = new Set(["id", "name", "fetch", "connect"]);

/**
 * What a wrapped stub walks: the runtime's stub, a pipelined RPC promise, or a member of one. The runtime answers every
 * property of a stub or an RPC promise with another, and a call of a member with an RPC promise.
 */
interface Remote {
  readonly [member: string | symbol]: Remote | undefined;
  (...args: RemoteArgument[]): Remote;
}

/** An argument of an RPC call: passed on untouched, never read. */
interface RemoteArgument {
  readonly passedOn?: never;
}

/** What the proxy of a step stands for: a member that may be called, or the result of a call. */
type RemoteCall = (...args: RemoteArgument[]) => void;

/** A value of the runtime the proxy reads members of: anything but `null` and `undefined`. */
const isRemote = <V>(value: V): value is V & Remote => value !== null && value !== undefined;

/** `value` as a {@link Remote}: a stub, whose members are read and called. */
const remote = <V>(value: V): V & Remote => {
  if (isRemote(value)) return value;

  throw new TypeError("a Durable Object namespace returned no stub");
};

/** How a step of a chain is reached again on a new stub. */
type Replay = (stub: Remote) => Remote | undefined;

/**
 * A step of a call chain: what it reached on the first stub and how to reach it again on another. A member
 * (`stub.models`) also names the step it is a member of, which a call of it keeps as its receiver. A member is read only
 * when it is awaited itself: a call reads it from its receiver.
 */
interface Step {
  readonly value: () => Remote | undefined;
  readonly replay: Replay;
  readonly member?: { readonly of: Step; readonly key: string };
}

/**
 * Calls `receiver`'s member `key` (or `receiver` itself) as the caller wrote it, so the receiver stays the call's
 * `this`; calling a missing member throws. (`Function.prototype.call` would not do: an RPC member answers `call` with
 * an RPC method of that name.)
 */
const invoke = (
  receiver: Remote | undefined,
  key: string | undefined,
  args: RemoteArgument[],
): Remote => {
  const result = key === undefined ? receiver?.(...args) : receiver?.[key]?.(...args);

  if (result === undefined) throw new TypeError(`${key ?? "the value"} is not an RPC method`);

  return result;
};

/** The call of `step` with `args`: sent now on the first stub, and how to send it again on another. */
const called = (step: Step, args: RemoteArgument[]): Step => {
  const { member } = step;

  const result =
    member === undefined
      ? invoke(step.value(), undefined, args)
      : invoke(member.of.value(), member.key, args);

  return {
    value: () => result,
    replay: (stub) =>
      member === undefined
        ? invoke(step.replay(stub), undefined, args)
        : invoke(member.of.replay(stub), member.key, args),
  };
};

/** The member `key` of `step`. */
const memberOf = (step: Step, key: string): Step => ({
  value: () => step.value()?.[key],
  replay: (stub) => step.replay(stub)?.[key],
  member: { of: step, key },
});

/**
 * What `step` reached, settled: its value, or, when that failed with a code-update reset, the same chain replayed once
 * on a new stub.
 */
const settle = async (step: Step, fresh: () => Remote): Promise<Remote | undefined> => {
  try {
    return await Promise.resolve(step.value());
  } catch (cause) {
    if (!isCodeUpdateReset(cause)) throw cause;

    return await Promise.resolve(step.replay(fresh()));
  }
};

/** A member of the runtime's `value` read as it is; a method keeps `value` as its receiver. */
const ownMember = (value: Remote, key: string | symbol): Remote | undefined => {
  const member = value[key];

  return member instanceof Function ? member.bind(value) : member;
};

/** The target of every proxy past the stub, never called itself: a function only so that a proxy can be called. */
const callable: RemoteCall = () => {};

/** The proxy of a step past the stub: a member or a call result, which is a promise and whose members are steps. */
const proxyOf = (step: Step, fresh: () => Remote): RemoteCall => {
  let settled: Promise<Remote | undefined> | undefined;

  const settledOnce = (): Promise<Remote | undefined> => (settled ??= settle(step, fresh));

  const handler: ProxyHandler<RemoteCall> = {
    get: (_target, key) => {
      switch (key) {
        case "then":
          return (
            onFulfilled?: (value: Remote | undefined) => Remote,
            onRejected?: (cause: unknown) => Remote,
          ) => settledOnce().then(onFulfilled, onRejected);
        case "catch":
          return (onRejected?: (cause: unknown) => Remote) => settledOnce().catch(onRejected);
        case "finally":
          return (onFinally?: () => void) => settledOnce().finally(onFinally);
        default:
          if (typeof key === "symbol") {
            const value = step.value();

            return value && ownMember(value, key);
          }

          return proxyOf(memberOf(step, key), fresh);
      }
    },
    apply: (_target, _receiver, args: RemoteArgument[]) => proxyOf(called(step, args), fresh),
  };

  return new Proxy(callable, handler);
};

/** A stub from `connect` whose RPC calls are retried once on a code-update reset ({@link retryOnCodeUpdate}). */
const retryingStub = <T extends Rpc.DurableObjectBranded | undefined>(
  connect: () => DurableObjectStub<T>,
): DurableObjectStub<T> => {
  const fresh = (): Remote => remote(connect());

  const stub = connect();

  const root: Step = { value: () => remote(stub), replay: (next) => next };

  return new Proxy(stub, {
    get: (_target, key) =>
      // The stub is no promise, and answers its own members; every other member is an RPC method.
      key === "then"
        ? undefined
        : typeof key === "symbol" || STUB_OWN_MEMBERS.has(key)
          ? ownMember(remote(stub), key)
          : proxyOf(memberOf(root, key), fresh),
  });
};

/** `namespace`, its stubs retrying each RPC call once on a code-update reset. */
export const retryingNamespace = <T extends Rpc.DurableObjectBranded | undefined>(
  namespace: DurableObjectNamespace<T>,
): DurableObjectNamespace<T> => ({
  newUniqueId: (options) => namespace.newUniqueId(options),
  idFromName: (name) => namespace.idFromName(name),
  idFromString: (id) => namespace.idFromString(id),
  get: (id, options) => retryingStub(() => namespace.get(id, options)),
  getByName: (name, options) => retryingStub(() => namespace.getByName(name, options)),
  jurisdiction: (jurisdiction) => retryingNamespace(namespace.jurisdiction(jurisdiction)),
});

const wrapped = new WeakMap<StateBindings, StateBindings>();

/**
 * `env` with the state Worker's namespaces (`CONTROL_PLANE`, `PLATFORM`, `SESSION_STATE`) wrapped so that each RPC call
 * is retried once on a code-update reset; the same copy for the same `env`, so caches keyed by `env` keep working. A
 * caller Worker's entry applies it to the `env` of every invocation.
 */
export const retryOnCodeUpdate = <E extends StateBindings>(env: E): E => {
  const known = wrapped.get(env);

  if (known !== undefined) {
    // SAFETY: `wrapped` maps an `env` only to the copy below made of that same `env`, which has its type.
    return known as E;
  }

  const copy: E = {
    ...env,
    CONTROL_PLANE: retryingNamespace(env.CONTROL_PLANE),
    PLATFORM: retryingNamespace(env.PLATFORM),
    SESSION_STATE: retryingNamespace(env.SESSION_STATE),
  };

  wrapped.set(env, copy);

  return copy;
};
