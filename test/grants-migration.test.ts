// The upgrade to grants (ADR 0023): each test starts from the storage a ControlPlane had before grants (no grant tables),
// restarts it so its constructor migrates, and checks that nothing a member could do changed: the default grant
// ("everyone, every shared credential, every model") exists once and is not made again after an org admin removed it.
import { runInDurableObject } from "cloudflare:test";
import { afterAll, describe, expect, it } from "vitest";
import { FULL_ACCESS } from "../src/credentials/ownership.ts";
import { DEFAULT_GRANT } from "../src/grants/grant.ts";
import { GLOBAL_ORG, OrgId } from "../src/platform/org.ts";
import { claudeFile, controlPlane, makeHarness } from "./support/management.ts";
import { restart } from "./support/secrets.ts";

const harness = makeHarness();

afterAll(harness.dispose);

const freshOrg = () => OrgId.make(`grants-${crypto.randomUUID().slice(0, 8)}`);

type Stub = ReturnType<typeof controlPlane>;

/** The storage of a ControlPlane before grants: its accounts, and no grant tables. */
const beforeGrants = async (stub: Stub): Promise<void> => {
  await stub.importAuthFile("old-a.json", claudeFile({ email: "a@example.com" }), {}, FULL_ACCESS);

  await runInDurableObject(stub, async (instance, state) => {
    await instance.started;
    state.storage.sql.exec("DROP TABLE grants");
    state.storage.sql.exec("DROP TABLE grant_state");
  });

  await restart(stub);
};

const picks = async (stub: Stub, member: string | undefined, model = "claude-opus-4-1") =>
  (
    await stub.pick({
      providers: ["claude"],
      model,
      ...(member === undefined ? {} : { memberId: member }),
    })
  ).ok;

describe("an org stored before grants", () => {
  it("gets the default grant, so every member keeps every model of every shared credential", async () => {
    const stub = controlPlane(freshOrg());

    await beforeGrants(stub);

    const { grants } = await stub.grantEntries();

    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject(DEFAULT_GRANT);
    expect(await picks(stub, "member-1")).toBe(true);
    expect(await picks(stub, "member-2", "claude-sonnet-4-5")).toBe(true);
    expect(await picks(stub, undefined)).toBe(true);
  });

  it("is migrated once: restarting again changes neither the grant nor its revision", async () => {
    const stub = controlPlane(freshOrg());

    await beforeGrants(stub);

    const first = await stub.grantEntries();

    for (let restarts = 0; restarts < 2; restarts += 1) {
      await restart(stub);

      expect(await stub.grantEntries()).toEqual(first);
    }
  });

  it("does not bring back a default grant an org admin removed", async () => {
    const stub = controlPlane(freshOrg());

    await beforeGrants(stub);

    const [initial] = (await stub.grantEntries()).grants;

    expect(initial).toBeDefined();

    const removed = await stub.writeGrant(
      { id: initial?.id ?? "", revision: initial?.revision ?? 0, value: null },
      "admin-1",
    );

    expect(removed.ok).toBe(true);

    await restart(stub);

    expect((await stub.grantEntries()).grants).toEqual([]);
    expect(await picks(stub, "member-1")).toBe(false);
  });
});

describe("a new org", () => {
  it("starts with the default grant, so its members reach what its admins add", async () => {
    const stub = controlPlane(freshOrg());

    await stub.importAuthFile("new-a.json", claudeFile(), {}, FULL_ACCESS);

    const { grants } = await stub.grantEntries();

    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject(DEFAULT_GRANT);
    expect(await picks(stub, "member-1")).toBe(true);
  });
});

describe("the global org stored before grants", () => {
  it("keeps serving its members and its service tokens (requests without a member)", async () => {
    const stub = controlPlane(GLOBAL_ORG);

    await beforeGrants(stub);

    expect((await stub.grantEntries()).grants).toHaveLength(1);
    expect(await picks(stub, undefined)).toBe(true);
    expect(await picks(stub, "member-1")).toBe(true);

    await restart(stub);

    expect((await stub.grantEntries()).grants).toHaveLength(1);
    expect(await picks(stub, undefined)).toBe(true);
  });
});
