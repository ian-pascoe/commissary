// The migration of the config admin lists (`access.admin-emails`, `access.admin-service-tokens`) into members of the
// org `global` (ADR 0022). Each test starts from the state a ControlPlane had before members: settings entries, or the
// single config document from before config entries.
import { runInDurableObject } from "cloudflare:test";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { ConfigStore } from "../src/config/store.ts";
import { migrateLegacyAdmins } from "../src/members/migration.ts";
import { MemberStore } from "../src/members/store.ts";
import { GLOBAL_ORG, OrgId } from "../src/platform/org.ts";
import { controlPlane, makeHarness } from "./support/management.ts";
import { orgDataKey } from "./support/secrets.ts";

const harness = makeHarness();

afterAll(harness.dispose);

/** Back to the state before members: no members, the migration not run, and no settings entries. */
const beforeMembers = async (org: OrgId = GLOBAL_ORG) => {
  await runInDurableObject(controlPlane(org), (_instance, state) => {
    for (const table of ["members", "teams", "team_members", "service_tokens", "config_settings"])
      state.storage.sql.exec(`DELETE FROM ${table}`);
    state.storage.sql.exec(
      `UPDATE membership SET admins_migrated = 0, counter = 0, index_synced = 0`,
    );
  });
};

/** Settings entries as a ControlPlane wrote them before members (sealed with the org's data key, ADR 0027). */
const seedSettings = async (org: OrgId, settings: Record<string, unknown>) => {
  await runInDurableObject(controlPlane(org), async (instance, state) => {
    await instance.started;
    const cipher = await orgDataKey(state, org);

    for (const [id, value] of Object.entries(settings))
      state.storage.sql.exec(
        `INSERT INTO config_settings (id, value, revision, updated_at, updated_by) VALUES (?, ?, 1, 0, 'test')`,
        id,
        cipher.seal(JSON.stringify(value), `config_settings/${id}`),
      );
  });
};

const settingIds = async (org: OrgId) =>
  await runInDurableObject(controlPlane(org), (_instance, state) =>
    state.storage.sql
      .exec<{ id: string }>(`SELECT id FROM config_settings ORDER BY id`)
      .toArray()
      .map((row) => row.id),
  );

const roster = async (org: OrgId = GLOBAL_ORG) => {
  const stub = controlPlane(org);

  return {
    members: (await stub.listMembers()).map(({ email, role }) => ({ email, role })),
    tokens: (await stub.listServiceTokens()).map(({ clientId, role }) => ({ clientId, role })),
  };
};

beforeEach(async () => {
  await beforeMembers();
});

describe("the global migration of the admin lists", () => {
  it("makes the config admins org admins and the admin service tokens org owners", async () => {
    await seedSettings(GLOBAL_ORG, {
      "access.admin-emails": ["Ops@Example.com", "lead@example.com"],
      "access.admin-service-tokens": ["robot.access"],
      "routing.strategy": "fill-first",
    });

    expect(await roster()).toEqual({
      members: [
        { email: "lead@example.com", role: "admin" },
        { email: "ops@example.com", role: "admin" },
      ],
      tokens: [{ clientId: "robot.access", role: "owner" }],
    });

    // The lists are gone from the config; the other settings stay.
    expect(await settingIds(GLOBAL_ORG)).toEqual(["routing.strategy"]);
    const config = JSON.parse((await controlPlane().getConfig()).document ?? "{}");
    expect(config.access["admin-emails"]).toEqual([]);
    expect(config.routing.strategy).toBe("fill-first");
  });

  it("runs once: a second start changes nothing, and a later import does not grant admin rights", async () => {
    await seedSettings(GLOBAL_ORG, { "access.admin-emails": ["ops@example.com"] });
    const first = await roster();
    const version = (await controlPlane().getConfig()).version;

    expect(await roster()).toEqual(first);
    expect((await controlPlane().getConfig()).version).toBe(version);

    const imported = await controlPlane().importConfig(
      JSON.stringify({ access: { "admin-emails": ["intruder@example.com"] } }),
      "test",
    );

    expect(imported).toMatchObject({ ok: true, notApplied: ["access.admin-emails"] });
    expect(await roster()).toEqual(first);
    expect(await settingIds(GLOBAL_ORG)).toEqual([]);
  });

  it("imports the lists of a config document from before config entries", async () => {
    // A fresh object, so its config has never been read: the stores of `global` run on its storage.
    const freshOrg = OrgId.make(`fresh-${crypto.randomUUID().slice(0, 8)}`);
    const fresh = controlPlane(freshOrg);

    const migrated = await runInDurableObject(fresh, async (instance, state) => {
      await instance.started;
      const cipher = await orgDataKey(state, freshOrg);
      const sql = state.storage.sql;
      const transaction = <T>(body: () => T): T => state.storage.transactionSync(body);
      sql.exec(
        `CREATE TABLE IF NOT EXISTS config (
           id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL, document TEXT NOT NULL,
           updated_at INTEGER NOT NULL
         )`,
      );
      sql.exec(
        `INSERT OR REPLACE INTO config (id, version, document, updated_at) VALUES (1, 7, ?, 1000)`,
        cipher.seal(
          JSON.stringify({
            access: {
              "admin-emails": ["legacy@example.com"],
              "admin-service-tokens": ["old.access"],
            },
            routing: { strategy: "fill-first" },
          }),
          "config/1",
        ),
      );
      const config = new ConfigStore(sql, GLOBAL_ORG, transaction, cipher);
      const members = new MemberStore(sql, GLOBAL_ORG, transaction);
      migrateLegacyAdmins(config, members, ["Boss@example.com"]);

      return {
        members: members.members().map(({ email, role }) => ({ email, role })),
        tokens: members.serviceTokens().map(({ clientId, role }) => ({ clientId, role })),
        settings: sql
          .exec<{ id: string }>(`SELECT id FROM config_settings ORDER BY id`)
          .toArray()
          .map((row) => row.id),
      };
    });

    expect(migrated).toEqual({
      members: [
        { email: "boss@example.com", role: "owner" },
        { email: "legacy@example.com", role: "admin" },
      ],
      tokens: [{ clientId: "old.access", role: "owner" }],
      settings: ["routing.strategy"],
    });
  });

  it("keeps a member who joined before the migration, raising a plain member to admin", async () => {
    await seedSettings(GLOBAL_ORG, { "access.admin-emails": ["early@example.com"] });

    await runInDurableObject(controlPlane(), (_instance, state) => {
      const store = new MemberStore(state.storage.sql, GLOBAL_ORG, (body) =>
        state.storage.transactionSync(body),
      );

      store.admit({ kind: "user", email: "early@example.com" }, true);
    });

    expect((await roster()).members).toEqual([{ email: "early@example.com", role: "admin" }]);
  });

  it("makes the platform admins of the time org owners, also when they were config admins", async () => {
    const owners = await runInDurableObject(controlPlane(), (_instance, state) => {
      const store = new MemberStore(state.storage.sql, GLOBAL_ORG, (body) =>
        state.storage.transactionSync(body),
      );

      store.migrateAdmins({
        owners: ["Boss@example.com"],
        admins: ["boss@example.com", "ops@example.com"],
        serviceTokens: [],
      });

      return store.members().map(({ email, role }) => ({ email, role }));
    });

    expect(owners).toEqual([
      { email: "boss@example.com", role: "owner" },
      { email: "ops@example.com", role: "admin" },
    ]);
  });
});

describe("another org's admin lists", () => {
  it("are removed without granting anything: they never applied outside global", async () => {
    const org = OrgId.make(`legacy-${crypto.randomUUID().slice(0, 8)}`);
    await beforeMembers(org);
    await seedSettings(org, { "access.admin-emails": ["ops@example.com"] });

    expect(await roster(org)).toEqual({ members: [], tokens: [] });
    expect(await settingIds(org)).toEqual([]);
  });
});
