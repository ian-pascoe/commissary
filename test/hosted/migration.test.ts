// Migration 0008 (Better Auth's tables, src/hosted/auth.ts): applied to a database in the state before it, it creates
// exactly what Better Auth expects, keeps the usage records, and a second run changes nothing.
import { env } from "cloudflare:workers";
import { getMigrations } from "better-auth/db/migration";
import { describe, expect, it } from "vitest";
import initial from "../../migrations/0001_usage_records.sql?raw";
import sessions from "../../migrations/0002_usage_sessions.sql?raw";
import orgs from "../../migrations/0003_usage_org.sql?raw";
import costs from "../../migrations/0004_usage_cost.sql?raw";
import members from "../../migrations/0005_usage_member.sql?raw";
import privates from "../../migrations/0006_usage_private.sql?raw";
import hostedAuth from "../../migrations/0008_hosted_auth.sql?raw";
import { authOptions } from "../../src/hosted/auth.ts";
import { statementsOf } from "../support/usage.ts";

const db = env.USAGE;

const tables = async (): Promise<ReadonlyArray<string>> =>
  (
    await db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all<{ name: string }>()
  ).results
    .map((row) => row.name)
    .filter((name) => !name.startsWith("_cf_") && !name.startsWith("sqlite_"));

describe("migration 0008 (hosted auth)", () => {
  it("adds Better Auth's tables to a database at 0006, keeps the usage records, and is idempotent", async () => {
    for (const statement of [initial, sessions, orgs, costs, members, privates].flatMap(
      statementsOf,
    ))
      await db.prepare(statement).run();

    await db
      .prepare(
        "INSERT INTO usage_records (request_id, requested_at, provider, executor_type, model, alias, endpoint, " +
          "principal_id, auth_id, auth_type, source, org_id) VALUES ('old', 1, 'codex', 'codex', 'gpt-5', 'gpt-5', " +
          "'POST /v1/responses', 'user:a@example.com', 'codex-a.json', 'oauth', 'a', 'global')",
      )
      .run();

    const before = await getMigrations(authOptions(env, "https://proxy.test"));
    expect(before.toBeCreated.map((table) => table.table).sort()).toEqual([
      "auth_account",
      "auth_session",
      "auth_user",
      "auth_verification",
    ]);

    for (const statement of statementsOf(hostedAuth)) await db.prepare(statement).run();

    const after = await getMigrations(authOptions(env, "https://proxy.test"));
    expect(after.toBeCreated).toEqual([]);
    expect(after.toBeAdded).toEqual([]);
    expect(await tables()).toEqual([
      "auth_account",
      "auth_session",
      "auth_user",
      "auth_verification",
      "usage_records",
    ]);

    // A second run is a no-op.
    for (const statement of statementsOf(hostedAuth)) await db.prepare(statement).run();

    const old = await db
      .prepare("SELECT request_id, private FROM usage_records")
      .all<{ request_id: string; private: number }>();

    expect(old.results).toEqual([{ request_id: "old", private: 0 }]);
  });
});
