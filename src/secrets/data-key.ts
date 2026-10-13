/**
 * An org's data key: the random AES-256 key that seals the org's stored secrets (`cipher.ts`), kept in the org's
 * ControlPlane wrapped by the stage's secrets key (`deployment-keys.ts`). New in the Workers port.
 *
 * - **Wrapping**: the secrets key is stretched with HKDF-SHA256 into a non-extractable AES-256-GCM `CryptoKey` that can
 *   only wrap and unwrap. The data key is wrapped with a fresh 96-bit nonce and the org id as additional data, so a
 *   wrapped key copied into another org's ControlPlane does not open. Stored as `wk:v1:` + base64url(nonce ‖ wrapped
 *   key ‖ tag) in the one-row table `org_data_key`.
 * - **First start** (no data key yet, which is every ControlPlane from before encryption): a new random data key is
 *   wrapped and stored, and every secret already stored in plain text is sealed with it (`sealStored`), in one
 *   transaction. A ControlPlane therefore holds a data key exactly when its secrets are sealed.
 * - **Rotation**: a data key that the current `SECRETS_KEY` does not open but `SECRETS_KEY_PREVIOUS` does is wrapped
 *   again under the current key. The sealed values do not change.
 * - **Wrong key**: a data key that neither opens is a `SecretsKeyError`: the ControlPlane does not start, rather than
 *   start without its secrets or with another key.
 */
import { Buffer } from "node:buffer";
import { Effect } from "effect";
import type { OrgId } from "../platform/org.ts";
import { DATA_KEY_BYTES, SecretCipher, type Sealer } from "./cipher.ts";
import { SecretsKeyError, type SecretsKeys } from "./deployment-keys.ts";

const WRAPPED_PREFIX = "wk:v1:";

const NONCE_BYTES = 12;

const KEK_SALT = "cf-llm-proxy/secrets-key";

const KEK_INFO = "org-data-key-wrap/v1";

const encoder = new TextEncoder();

interface DataKeyRow {
  wrapped: string;
  [column: string]: SqlStorageValue;
}

/** What `openDataKey` needs from the ControlPlane. */
export interface DataKeyOptions {
  readonly sql: SqlStorage;
  /** Runs `body` in one storage transaction (`ctx.storage.transactionSync`). */
  readonly transaction: <T>(body: () => T) => T;
  readonly org: OrgId;
  /** The stage's secrets keys (`deploymentSecretsKeys`); a refusal throws from here. */
  readonly keys: () => SecretsKeys;
  /**
   * Seals every secret stored in plain text with the new data key and answers how many values it sealed; runs inside
   * the transaction that stores the key (first start only).
   */
  readonly sealStored: (cipher: SecretCipher) => number;
  readonly now?: () => number;
}

/** The non-extractable wrapping key of `secret`. */
const wrappingKey = async (secret: string): Promise<CryptoKey> => {
  const material = await crypto.subtle.importKey("raw", encoder.encode(secret), "HKDF", false, [
    "deriveKey",
  ]);

  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: encoder.encode(KEK_SALT),
      info: encoder.encode(KEK_INFO),
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["wrapKey", "unwrapKey"],
  );
};

const wrapParams = (org: OrgId, nonce: Uint8Array): SubtleCryptoEncryptAlgorithm => ({
  name: "AES-GCM",
  iv: nonce,
  additionalData: encoder.encode(`org-data-key/v1\u0000${org}`),
  tagLength: 128,
});

const wrap = async (dataKey: CryptoKey, kek: CryptoKey, org: OrgId): Promise<string> => {
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));

  const wrapped = new Uint8Array(
    await crypto.subtle.wrapKey("raw", dataKey, kek, wrapParams(org, nonce)),
  );

  return WRAPPED_PREFIX + Buffer.concat([nonce, wrapped]).toString("base64url");
};

/** The data key `stored` holds when `kek` wrapped it; `undefined` when another key did (or it was changed). */
const unwrap = async (
  stored: string,
  kek: CryptoKey,
  org: OrgId,
): Promise<CryptoKey | undefined> => {
  if (!stored.startsWith(WRAPPED_PREFIX))
    throw new SecretsKeyError(`the stored data key of org ${org} is not a wrapped key`);
  const bytes = Buffer.from(stored.slice(WRAPPED_PREFIX.length), "base64url");

  try {
    // Extractable so it can be wrapped again (rotation) and handed to the synchronous cipher; never exported elsewhere.
    return await crypto.subtle.unwrapKey(
      "raw",
      bytes.subarray(NONCE_BYTES),
      kek,
      wrapParams(org, bytes.subarray(0, NONCE_BYTES)),
      { name: "AES-GCM", length: 256 },
      true,
      ["encrypt", "decrypt"],
    );
  } catch {
    return undefined;
  }
};

const cipherOf = async (dataKey: CryptoKey): Promise<SecretCipher> => {
  const exported = await crypto.subtle.exportKey("raw", dataKey);

  if (!(exported instanceof ArrayBuffer))
    throw new SecretsKeyError("a data key exports as raw bytes");
  const raw = new Uint8Array(exported);

  try {
    return SecretCipher.fromRawKey(raw);
  } finally {
    raw.fill(0);
  }
};

/** A new random data key (extractable: it is wrapped and handed to the synchronous cipher, never exported elsewhere). */
const generateDataKey = async (): Promise<CryptoKey> => {
  const raw = crypto.getRandomValues(new Uint8Array(DATA_KEY_BYTES));

  try {
    return await crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, true, [
      "encrypt",
      "decrypt",
    ]);
  } finally {
    raw.fill(0);
  }
};

const log = (effect: Effect.Effect<void>, org: OrgId): void =>
  Effect.runSync(effect.pipe(Effect.annotateLogs({ org })));

/**
 * Opens the data key of `org` stored through `sql`, creating it (and sealing the plain-text secrets) on first start
 * and wrapping it again under the current secrets key after a rotation. Throws `SecretsKeyError` when the keys are
 * refused or open no stored data key.
 */
export const openDataKey = async (options: DataKeyOptions): Promise<SecretCipher> => {
  const { sql, org } = options;
  const now = options.now ?? Date.now;
  const keys = options.keys();
  const current = await wrappingKey(keys.current);

  sql.exec(
    `CREATE TABLE IF NOT EXISTS org_data_key (
       id INTEGER PRIMARY KEY CHECK (id = 1),
       wrapped TEXT NOT NULL,
       created_at INTEGER NOT NULL,
       wrapped_at INTEGER NOT NULL
     )`,
  );
  const row = sql.exec<DataKeyRow>("SELECT wrapped FROM org_data_key WHERE id = 1").toArray()[0];

  if (row === undefined) {
    const dataKey = await generateDataKey();
    const wrapped = await wrap(dataKey, current, org);
    const cipher = await cipherOf(dataKey);

    const sealed = options.transaction(() => {
      const at = now();

      sql.exec(
        "INSERT INTO org_data_key (id, wrapped, created_at, wrapped_at) VALUES (1, ?, ?, ?)",
        wrapped,
        at,
        at,
      );

      return options.sealStored(cipher);
    });

    log(
      Effect.logInfo("created the org's data key and sealed its stored secrets").pipe(
        Effect.annotateLogs({ sealed }),
      ),
      org,
    );

    return cipher;
  }

  const opened = await unwrap(row.wrapped, current, org);

  if (opened !== undefined) return cipherOf(opened);

  const previous =
    keys.previous === undefined
      ? undefined
      : await unwrap(row.wrapped, await wrappingKey(keys.previous), org);

  if (previous !== undefined) {
    sql.exec(
      "UPDATE org_data_key SET wrapped = ?, wrapped_at = ? WHERE id = 1",
      await wrap(previous, current, org),
      now(),
    );
    log(Effect.logInfo("wrapped the org's data key under the new SECRETS_KEY"), org);

    return cipherOf(previous);
  }

  const message =
    keys.previous === undefined
      ? `SECRETS_KEY does not open the data key of org ${org}: it is not the key the data key was wrapped with (to rotate, set the old key as SECRETS_KEY_PREVIOUS; docs/DEPLOY.md)`
      : `neither SECRETS_KEY nor SECRETS_KEY_PREVIOUS opens the data key of org ${org} (docs/DEPLOY.md)`;

  throw new SecretsKeyError(message);
};

/**
 * The secrets of one org as its ControlPlane's stores see them: a `Sealer` that works once `start` opened the data
 * key, and throws why it could not otherwise. The ControlPlane starts it in `blockConcurrencyWhile`, so no call reaches
 * a store before.
 */
export class OrgSecrets implements Sealer {
  #cipher: SecretCipher | undefined;
  #failure: unknown;

  /**
   * Opens the data key. A failure is kept, not thrown: every later seal/open throws it, so each call fails with the
   * reason and the Durable Object's input gate stays intact (a rejected `blockConcurrencyWhile` resets the object).
   */
  async start(options: DataKeyOptions): Promise<void> {
    try {
      this.#cipher = await openDataKey(options);
      this.#failure = undefined;
    } catch (error) {
      this.#failure = error;
      // The message names the key binding and the org, never a key (`SecretsKeyError`, `SealedValueError`).
      log(
        Effect.logError("the ControlPlane cannot open the org's data key").pipe(
          Effect.annotateLogs({ reason: error instanceof Error ? error.message : String(error) }),
        ),
        options.org,
      );
    }
  }

  #ready(): SecretCipher {
    if (this.#cipher !== undefined) return this.#cipher;

    if (this.#failure !== undefined) throw this.#failure;

    throw new SecretsKeyError("the org's data key is used before the ControlPlane opened it");
  }

  readonly seal = (plaintext: string, context: string): string =>
    this.#ready().seal(plaintext, context);

  readonly open = (sealed: string, context: string): string => this.#ready().open(sealed, context);
}
