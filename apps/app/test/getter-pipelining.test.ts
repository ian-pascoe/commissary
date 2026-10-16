// How callers reach an area's ControlPlane part (#134 "How an area's ControlPlane part works", #148), on the test-only
// GetterProbe (test/support/getter-probe.ts) in workerd with real SQLite storage.
//
// Through the cached prototype getter, the pipelined call `stub.dummy.x()` works in plain workerd (the runtime of
// `alchemy dev` and of the deployed Worker) but not here: vitest-pool-workers wraps every Durable Object of the test
// Worker and answers a property with a callable thenable instead of the part, so workerd finds no `x` on it. Awaiting
// the getter first works (two round trips), and so does a pipelined call through a method, `stub.dummyPart().x()`,
// which the rest of this file uses to cover what the split ControlPlane needs: the part's own tables, the base's view
// (`core`), the one alarm, and errors. A stub of the part the test still holds keeps `evictDurableObject` from
// finishing, so a test that restarts the object disposes of it first.
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import type { GetterProbe } from "./support/getter-probe.ts";

// SAFETY: vitest.config.ts binds GETTER_PROBE to the test Worker's GetterProbe class (test/worker.ts); the deployed
// Worker has no such binding, so `Env` does not name it.
const probes = (env as unknown as { GETTER_PROBE: DurableObjectNamespace<GetterProbe> })
  .GETTER_PROBE;

const fresh = () => probes.getByName(crypto.randomUUID());

/** The object's alarm (epoch ms), `null` when none is set. */
const alarmOf = (stub: DurableObjectStub<GetterProbe>) =>
  runInDurableObject(stub, (_instance, state) => state.storage.getAlarm());

/** Errors thrown on purpose carry this marker: vitest.config.ts ignores the unhandled rejections they cause. */
const PROVOKED = "[getter-probe]";

const HOUR_MS = 60 * 60_000;

describe("an area part behind a getter (`get dummy()`)", () => {
  // A tripwire: once vitest-pool-workers answers this call, the ControlPlane's tests could reach a getter as #134 planned.
  it("is not reached by the pipelined call stub.dummy.x() under vitest-pool-workers", async () => {
    await expect(fresh().dummy.pipelinedThroughGetter()).rejects.toThrow(
      'The RPC receiver does not implement the method "pipelinedThroughGetter".',
    );
  });

  it("is reached once the getter is awaited (two round trips)", async () => {
    const part = await fresh().dummy;

    expect(await part.pipelinedThroughGetter()).toBe("reached");
    expect(await part.add("a")).toBe(1);
    expect(await part.list()).toEqual(["a"]);
  });
});

describe("an area part behind a method (`dummyPart()`)", () => {
  it("is called as stub.dummyPart().x(), and the object constructs the part once", async () => {
    const stub = fresh();

    expect(await stub.dummyPart().add("a")).toBe(1);
    expect(await stub.dummyPart().addLater("b")).toBe(2);
    expect(await stub.dummyPart().list()).toEqual(["a", "b"]);
    expect(await stub.partsConstructed()).toBe(1);
  });

  it("keeps its own tables in the object's SQLite storage, which outlive a restart", async () => {
    const stub = fresh();
    const part = await stub.dummyPart();

    await part.add("kept");
    part[Symbol.dispose]();
    await evictDurableObject(stub);

    expect(await stub.partsConstructed()).toBe(0);
    expect(await stub.dummyPart().list()).toEqual(["kept"]);

    const tables = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'dummy\\_%' ESCAPE '\\' ORDER BY name",
        )
        .toArray()
        .map((row) => row.name),
    );

    expect(tables).toEqual(["dummy_alarm_calls", "dummy_items", "dummy_wake_ups"]);
  });

  it("reads what the base holds through core", async () => {
    const stub = fresh();

    expect(await stub.dummyPart().org()).toBeUndefined();
    await stub.setOrg("acme");
    expect(await stub.dummyPart().org()).toBe("acme");
  });

  it("sets the object's one alarm to its earliest wake-up, and the alarm calls it only when due", async () => {
    const stub = fresh();
    const later = Date.now() + 2 * HOUR_MS;
    const sooner = Date.now() + HOUR_MS;

    await stub.dummyPart().wakeAt(later);
    expect(await alarmOf(stub)).toBe(later);
    await stub.dummyPart().wakeAt(sooner);
    expect(await alarmOf(stub)).toBe(sooner);

    // Run before it is due: the part is not called, and the alarm is set again.
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await stub.dummyPart().alarmCalls()).toBe(0);
    expect(await alarmOf(stub)).toBe(sooner);
  });

  it("runs a due wake-up when the object's alarm fires, then clears the alarm", async () => {
    const stub = fresh();
    const due = Date.now() - 1;

    await stub.dummyPart().wakeAt(due);

    await vi.waitFor(
      async () => {
        expect(await stub.dummyPart().ran()).toEqual([due]);
      },
      { timeout: 5_000, interval: 20 },
    );
    expect(await stub.dummyPart().alarmCalls()).toBe(1);
    expect(await alarmOf(stub)).toBeNull();
  });

  it("passes a thrown error to the caller with its type, and the object keeps answering", async () => {
    const stub = fresh();

    await expect(stub.dummyPart().fail(`${PROVOKED} boom`)).rejects.toBeInstanceOf(RangeError);
    await expect(stub.dummyPart().fail(`${PROVOKED} boom`)).rejects.toThrow(`${PROVOKED} boom`);
    await expect(stub.dummyPart().failLater(`${PROVOKED} later`)).rejects.toThrow(
      `${PROVOKED} later`,
    );
    expect(await stub.dummyPart().add("still here")).toBe(1);
  });

  it("fails every call to the part when the base did not start", async () => {
    const stub = fresh();

    await stub.breakStart(`${PROVOKED} secrets key missing`);

    await expect(stub.dummyPart().add("x")).rejects.toThrow(`${PROVOKED} secrets key missing`);
    await expect(stub.dummyPart().list()).rejects.toThrow(`${PROVOKED} secrets key missing`);
  });
});
