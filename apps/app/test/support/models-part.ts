// The ControlPlane's Models part in tests that restart the object (#148): a stub of the part the test still holds keeps
// `evictDurableObject` from finishing, and a pipelined call (`stub.models().x()`) leaves one held until the test ends.
import { withPart } from "@commissary/state/testing";
import type { ControlPlane } from "../../src/index.ts";

/** A stub of the Models part, as `await stub.models()` answers it. */
export type ModelsPartStub = Awaited<ReturnType<DurableObjectStub<ControlPlane>["models"]>>;

/** Runs `call` on the Models part of `stub`, then disposes of the part's stub (also when `call` fails). */
export const withModelsPart = <R>(
  stub: DurableObjectStub<ControlPlane>,
  call: (part: ModelsPartStub) => R,
): Promise<Awaited<R>> => withPart(stub.models(), call);
