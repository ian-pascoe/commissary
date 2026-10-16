// Zero data retention (ADR 0027) and Spend limits (issue #71): what a member's or an API key's Spend limits and counters
// are is deleted with them, and an org's go with the org. Through the real ControlPlane and org deletion.
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import type { Viewer } from "@commissary/auth";
import { FULL_ACCESS } from "../src/models/credentials/ownership.ts";
import { deleteOrgModels } from "../src/models/org-deletion.ts";
import { deleteOrg } from "../src/platform/org-deletion.ts";
import { OrgId } from "@commissary/core";
import { controlPlaneOf } from "@commissary/state";
import { claudeFile } from "./support/management.ts";
import { USD } from "./support/spend.ts";
import { resetUsageDb } from "./support/usage.ts";

const OWNER = { role: "owner", sensitive: true } as const;

const REQUEST = { providers: ["claude"], model: "claude-sonnet-4-5" };

beforeAll(async () => {
  await resetUsageDb();
});

/** An org with an admin, two members with an API key each, a shared account, and Spend that was used by every one. */
const spendingOrg = async () => {
  const org = OrgId.make(`spend-zdr-${crypto.randomUUID().slice(0, 8)}`);
  const stub = controlPlaneOf(env, org);

  const member = async (email: string, role: "admin" | "member" = "member") => {
    const added = await stub.addMember({ email, role }, OWNER, "test");

    if (!added.ok) throw new Error(added.message);

    return added.value;
  };

  const admin = await member("admin@example.com", "admin");
  const alice = await member("alice@example.com");
  const bob = await member("bob@example.com");
  const viewer: Viewer = { member: admin.id, admin: true };

  const key = async (owner: { readonly id: string }, name: string, expiresAt?: number) => {
    const made = await stub.createApiKey(
      { memberId: owner.id, name, ...(expiresAt === undefined ? {} : { expiresAt }) },
      Date.now(),
    );

    if (!made.ok) throw new Error(made.message);

    return made.value.record;
  };

  const limit = async (kind: "member" | "key" | "org", subject: string) => {
    const made = await stub
      .models()
      .createSpendLimit(
        viewer,
        { kind, subject, period: "day", amountMicros: 100 * USD },
        "test@example.com",
      );

    if (!made.ok) throw new Error(`${made.error}: ${made.message}`);
  };

  const spend = async (memberId: string, apiKeyId: string) => {
    const picked = await stub.models().pick({ ...REQUEST, memberId, apiKeyId });

    if (!picked.ok) throw new Error(picked.failure.code);
    await stub.models().report(picked.lease, { success: true, httpStatus: 200, costMicros: USD });
  };

  expect(
    (
      await stub
        .models()
        .importAuthFile("claude-a.json", JSON.stringify(claudeFile()), {}, FULL_ACCESS)
    ).ok,
  ).toBe(true);

  const aliceKey = await key(alice, "alice laptop");
  const bobKey = await key(bob, "bob laptop");

  for (const [who, apiKey] of [
    [alice, aliceKey],
    [bob, bobKey],
  ] as const) {
    await limit("member", who.id);
    await limit("key", apiKey.id);
    await spend(who.id, apiKey.id);
  }

  await limit("org", "");

  return { org, stub, admin, alice, bob, aliceKey, bobKey, key, limit, spend };
};

type Org = Awaited<ReturnType<typeof spendingOrg>>;

/** The Spend rows of `subject` in an org: limits and counters. */
const spendRows = async (org: Org, kind: string, subject: string) =>
  await runInDurableObject(controlPlaneOf(env, org.org), (_instance, state) => {
    const count = (table: string) =>
      state.storage.sql
        .exec<{ n: number }>(
          `SELECT COUNT(*) AS n FROM ${table} WHERE subject_kind = ? AND subject_id = ?`,
          kind,
          subject,
        )
        .one().n;

    return { limits: count("spend_limits"), counters: count("spend_counters") };
  });

const HELD = { limits: 1, counters: 1 };

const GONE = { limits: 0, counters: 0 };

describe("Spend data of a member who leaves", () => {
  it("is deleted with the member and with their API keys, and nothing of anyone else is", async () => {
    const org = await spendingOrg();

    expect(await spendRows(org, "member", org.alice.id)).toEqual(HELD);
    expect(await spendRows(org, "key", org.aliceKey.id)).toEqual(HELD);

    expect((await org.stub.removeMember(org.alice.id, OWNER)).ok).toBe(true);

    expect(await spendRows(org, "member", org.alice.id)).toEqual(GONE);
    expect(await spendRows(org, "key", org.aliceKey.id)).toEqual(GONE);
    expect(await spendRows(org, "member", org.bob.id)).toEqual(HELD);
    expect(await spendRows(org, "key", org.bobKey.id)).toEqual(HELD);
  });

  it("is deleted when the person deletes their account too", async () => {
    const org = await spendingOrg();

    expect(await org.stub.leaveOrg("bob@example.com")).toEqual({ left: true });
    expect(await spendRows(org, "member", org.bob.id)).toEqual(GONE);
    expect(await spendRows(org, "key", org.bobKey.id)).toEqual(GONE);
    expect(await spendRows(org, "member", org.alice.id)).toEqual(HELD);
  });
});

describe("Spend data of an API key that is deleted", () => {
  it("goes with the key when it is revoked", async () => {
    const org = await spendingOrg();

    expect((await org.stub.revokeApiKey(org.aliceKey.id, Date.now())).ok).toBe(true);
    expect(await spendRows(org, "key", org.aliceKey.id)).toEqual(GONE);
    expect(await spendRows(org, "key", org.bobKey.id)).toEqual(HELD);
    expect(await spendRows(org, "member", org.alice.id)).toEqual(HELD);
  });

  it("goes with the key when it has expired and is purged", async () => {
    const org = await spendingOrg();
    const expiring = await org.key(org.alice, "short", Date.now() + 60_000);

    await org.limit("key", expiring.id);
    await org.spend(org.alice.id, expiring.id);
    expect(await spendRows(org, "key", expiring.id)).toEqual(HELD);

    expect(await org.stub.purgeExpiredApiKeys(Date.now() + 120_000)).toBe(1);
    expect(await spendRows(org, "key", expiring.id)).toEqual(GONE);
    expect(await spendRows(org, "key", org.aliceKey.id)).toEqual(HELD);
  });
});

describe("Spend data of an org that is deleted", () => {
  it("leaves no limit, counter or setting behind", async () => {
    const org = await spendingOrg();
    const other = await spendingOrg();

    expect(await deleteOrg(env, [deleteOrgModels(env)], org.org, { now: Date.now() })).toEqual({
      state: "deleted",
    });

    // The wiped object holds no table at all, so no Spend table and no row of one.
    const tables = await runInDurableObject(controlPlaneOf(env, org.org), (_instance, state) =>
      state.storage.sql
        .exec<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'spend_%'",
        )
        .toArray(),
    );

    expect(tables).toEqual([]);
    expect(await spendRows(other, "member", other.alice.id)).toEqual(HELD);
  });
});
