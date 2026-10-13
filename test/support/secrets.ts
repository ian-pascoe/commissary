// Stored secrets (src/secrets/): the raw rows of a ControlPlane, and the states it can start from (before encryption,
// a data key wrapped by another secrets key), reached through its storage and a restart (`evictDurableObject`).
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { ControlPlane } from "../../src/index.ts";
import type { OrgId } from "../../src/platform/org.ts";
import { openDataKey } from "../../src/secrets/data-key.ts";
import { deploymentSecretsKeys, type SecretsKeys } from "../../src/secrets/deployment-keys.ts";

type Stub = DurableObjectStub<ControlPlane>;

/** The columns that hold sealed values, with the context each value is sealed for. */
const SEALED: ReadonlyArray<{ readonly table: string; readonly column: string }> = [
  { table: "credentials", column: "metadata" },
  { table: "config_settings", column: "value" },
  { table: "config_key_groups", column: "value" },
  { table: "config_api_keys", column: "value" },
  { table: "config_model_aliases", column: "value" },
  { table: "config_model_exclusions", column: "value" },
  { table: "config_payload_rules", column: "value" },
];

/** A secrets key nobody configured: the data key does not open under it. */
export const UNRELATED_SECRETS_KEY =
  "cf-llm-proxy-test-unrelated-secrets-key-0123456789abcdef0123456789";

/** The data key of `org`'s ControlPlane, opened from its storage under `keys` (the test bindings by default). */
const openStored = (state: DurableObjectState, org: OrgId, keys: SecretsKeys) =>
  openDataKey({
    sql: state.storage.sql,
    transaction: (body) => state.storage.transactionSync(body),
    org,
    keys: () => keys,
    sealStored: () => {
      throw new Error("the ControlPlane has no data key yet");
    },
  });

/** The data key of `org`'s ControlPlane under the test secrets key, for a store a test constructs over its storage. */
export const orgDataKey = (state: DurableObjectState, org: OrgId) =>
  openStored(state, org, deploymentSecretsKeys(env));

/** Restarts the ControlPlane: the next call constructs it again from its storage. */
export const restart = async (stub: Stub): Promise<void> => {
  await evictDurableObject(stub);
};

/** Every row of every table of the ControlPlane, as JSON text (what browsing its storage shows). */
export const storedText = (stub: Stub): Promise<string> =>
  runInDurableObject(stub, (_instance, state) => {
    const tables = state.storage.sql
      .exec<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'",
      )
      .toArray()
      .map(({ name }) => name);

    return JSON.stringify(
      Object.fromEntries(
        tables.map((table) => [
          table,
          state.storage.sql.exec(`SELECT * FROM "${table}"`).toArray(),
        ]),
      ),
    );
  });

/** The stored (wrapped) data key of the ControlPlane. */
export const wrappedDataKey = (stub: Stub): Promise<string | undefined> =>
  runInDurableObject(
    stub,
    (_instance, state) =>
      state.storage.sql
        .exec<{ wrapped: string }>("SELECT wrapped FROM org_data_key WHERE id = 1")
        .toArray()[0]?.wrapped,
  );

/**
 * Brings the ControlPlane of `org` back to what the code before encryption stored: every sealed value in plain text and
 * no data key. `before` then writes more of that state (e.g. the legacy config document); the ControlPlane restarts.
 */
export const asBeforeEncryption = async (
  stub: Stub,
  org: OrgId,
  before: (sql: SqlStorage) => void = () => undefined,
): Promise<void> => {
  await runInDurableObject(stub, async (_instance, state) => {
    const cipher = await openStored(state, org, deploymentSecretsKeys(env));
    const { sql } = state.storage;

    for (const { table, column } of SEALED) {
      for (const row of sql
        .exec<{ id: string; sealed: string }>(`SELECT id, ${column} AS sealed FROM ${table}`)
        .toArray()) {
        sql.exec(
          `UPDATE ${table} SET ${column} = ? WHERE id = ?`,
          cipher.open(row.sealed, `${table}/${row.id}`),
          row.id,
        );
      }
    }

    sql.exec("DROP TABLE org_data_key");
    before(sql);
  });
  await restart(stub);
};

/**
 * Wraps the ControlPlane's data key under `secret` instead of the test key, as a stage whose secrets key was `secret`
 * left it, and answers the wrapped key it stored; the ControlPlane restarts.
 */
export const wrapDataKeyUnder = async (stub: Stub, org: OrgId, secret: string): Promise<string> => {
  const wrapped = await runInDurableObject(stub, async (_instance, state) => {
    // A rotation from the test key to `secret` (`openDataKey` wraps it again under the current key).
    await openStored(state, org, { current: secret, previous: env.SECRETS_KEY });

    return state.storage.sql
      .exec<{ wrapped: string }>("SELECT wrapped FROM org_data_key WHERE id = 1")
      .one().wrapped;
  });

  await restart(stub);

  return wrapped;
};
