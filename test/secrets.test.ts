// Stored secrets sealed with a data key per org (src/secrets/): the sealed value format, the stage's secrets keys,
// and the real ControlPlane Durable Object, started from each state it can find in production (new, before
// encryption, after a rotation, under another key) by restarting it (`evictDurableObject`).
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import type { ControlPlane } from "../src/index.ts";
import type { PickResult } from "../src/credentials/selection/types.ts";
import { OrgId } from "../src/platform/org.ts";
import { SealedValueError, SecretCipher, isSealed } from "../src/secrets/cipher.ts";
import { openDataKey } from "../src/secrets/data-key.ts";
import { SecretsKeyError, deploymentSecretsKeys } from "../src/secrets/deployment-keys.ts";
import { DEV_SECRETS_KEY } from "../src/secrets/key.ts";
import { orgAuthIndexer } from "../src/management/auth-index.ts";
import { controlPlane } from "./support/management.ts";
import {
  UNRELATED_SECRETS_KEY,
  asBeforeEncryption,
  restart,
  storedText,
  wrapDataKeyUnder,
  wrappedDataKey,
} from "./support/secrets.ts";

const newOrg = (): OrgId => OrgId.make(`secrets-${crypto.randomUUID().slice(0, 8)}`);

// Secrets an org stores: an auth file's tokens, and API keys and a secret header in its config entries.
const ACCESS_TOKEN = "sk-ant-oat-plain-access-4f1d";

const REFRESH_TOKEN = "plain-refresh-token-9c2e";

const API_KEY = "sk-ant-api-plain-key-77ab";

const COMPAT_KEY = "sk-compat-plain-key-31cd";

const HEADER_SECRET = "Bearer plain-header-secret-58ef";

const SECRETS = [ACCESS_TOKEN, REFRESH_TOKEN, API_KEY, COMPAT_KEY, HEADER_SECRET];

const AUTH_FILE = {
  type: "claude",
  email: "me@x.com",
  access_token: ACCESS_TOKEN,
  refresh_token: REFRESH_TOKEN,
  expired: "2999-01-01T00:00:00Z",
};

const CONFIG = `
routing:
  strategy: fill-first
api-keys:
  claude:
    - base-url: https://api.anthropic.com
      headers:
        X-Upstream-Auth: "${HEADER_SECRET}"
      keys:
        - api-key: ${API_KEY}
  openai-compatibility:
    - name: acme
      base-url: https://api.acme.test/v1
      keys:
        - api-key: ${COMPAT_KEY}
`;

/** A ControlPlane of a new org holding an auth file and config API keys. */
const stocked = async () => {
  const org = newOrg();
  const stub = controlPlane(org);

  expect(await stub.importAuthFile("claude-a.json", AUTH_FILE)).toMatchObject({ ok: true });
  expect(await stub.importConfig(CONFIG, "test")).toMatchObject({ ok: true });

  return { org, stub };
};

/** What the org's secrets read as through the ControlPlane, with the auth index of every credential. */
const readable = async (stub: ReturnType<typeof controlPlane>, org: OrgId) => {
  const index = orgAuthIndexer(env, org);
  const credentials = (await stub.listCredentials()).map(({ id }) => ({ id, index: index(id) }));
  const picked: PickResult = await stub.pick({ providers: ["claude"], model: "claude-sonnet-4-5" });

  return {
    credentials: credentials.toSorted((a, b) => a.id.localeCompare(b.id)),
    file: await stub.getCredentialFile("claude-a.json"),
    document: (await stub.getConfig()).document,
    token: picked.ok ? picked.credential.metadata.access_token : picked.failure.code,
  };
};

/**
 * Runs `body` against the ControlPlane instance once it started. Failing calls are checked here rather than over RPC:
 * the Workers test pool reports an exception thrown out of a Durable Object RPC method as an unhandled error.
 */
const inside = (
  stub: ReturnType<typeof controlPlane>,
  body: (plane: ControlPlane) => Promise<void>,
) =>
  runInDurableObject(stub, async (plane) => {
    await plane.started;
    await body(plane);
  });

/** The outcome of a call, sync or async, as a promise. */
const called = async <A>(call: () => A | Promise<A>): Promise<A> => call();

const expectNoPlaintext = (stored: string) => {
  for (const secret of SECRETS) expect(stored).not.toContain(secret);
};

describe("SecretCipher", () => {
  const raw = () => crypto.getRandomValues(new Uint8Array(32));

  it("seals with a fresh nonce per value and opens to the original", () => {
    const cipher = SecretCipher.fromRawKey(raw());
    const first = cipher.seal(ACCESS_TOKEN, "credentials/a");
    const second = cipher.seal(ACCESS_TOKEN, "credentials/a");

    expect(isSealed(first)).toBe(true);
    expect(first).not.toBe(second);
    expect(first).not.toContain(ACCESS_TOKEN);
    expect(cipher.open(first, "credentials/a")).toBe(ACCESS_TOKEN);
    expect(cipher.open(second, "credentials/a")).toBe(ACCESS_TOKEN);
  });

  it("is AES-256-GCM: WebCrypto opens it with the key, a 96-bit nonce and the context as additional data", async () => {
    const key = raw();
    const copy = key.slice();
    const sealed = SecretCipher.fromRawKey(key).seal(API_KEY, "config_api_keys/k1");

    // The caller wipes its copy of the key; the cipher keeps its own.
    key.fill(0);
    expect(sealed.startsWith("enc:v1:")).toBe(true);
    const bytes = Buffer.from(sealed.slice("enc:v1:".length), "base64url");
    const imported = await crypto.subtle.importKey("raw", copy, "AES-GCM", false, ["decrypt"]);

    const opened = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: bytes.subarray(0, 12),
        additionalData: new TextEncoder().encode("enc:v1\u0000config_api_keys/k1"),
        tagLength: 128,
      },
      imported,
      bytes.subarray(12),
    );

    expect(new TextDecoder().decode(opened)).toBe(API_KEY);
  });

  it("refuses another key, another context, a changed value and a plain one, instead of returning garbage", () => {
    const cipher = SecretCipher.fromRawKey(raw());
    const sealed = cipher.seal(API_KEY, "credentials/a");
    const bytes = Buffer.from(sealed.slice("enc:v1:".length), "base64url");

    bytes[20] = (bytes[20] ?? 0) ^ 1;
    const changed = `enc:v1:${bytes.toString("base64url")}`;

    expect(() => SecretCipher.fromRawKey(raw()).open(sealed, "credentials/a")).toThrow(
      SealedValueError,
    );
    expect(() => cipher.open(sealed, "credentials/b")).toThrow(SealedValueError);
    expect(() => cipher.open(changed, "credentials/a")).toThrow(SealedValueError);
    expect(() => cipher.open(API_KEY, "credentials/a")).toThrow(SealedValueError);
    expect(() => cipher.open("enc:v1:AAAA", "credentials/a")).toThrow(SealedValueError);
  });

  it("names the context in an error, never the value", () => {
    const cipher = SecretCipher.fromRawKey(raw());

    expect(() => cipher.open(API_KEY, "credentials/a")).toThrow(/credentials\/a/);
    expect(() => cipher.open(API_KEY, "credentials/a")).not.toThrow(API_KEY);
  });
});

describe("deploymentSecretsKeys", () => {
  const minted = "a".repeat(64);
  const deployed = { ACCESS_TEAM_DOMAIN: "team", ACCESS_AUD: "aud" };

  it("reads SECRETS_KEY and, during a rotation, SECRETS_KEY_PREVIOUS", () => {
    expect(deploymentSecretsKeys({ SECRETS_KEY: env.SECRETS_KEY })).toEqual({
      current: env.SECRETS_KEY,
    });
    expect(
      deploymentSecretsKeys({
        ...deployed,
        SECRETS_KEY: minted,
        SECRETS_KEY_PREVIOUS: "b".repeat(64),
      }),
    ).toEqual({ current: minted, previous: "b".repeat(64) });
    // An empty previous key, or the current one again, is no rotation.
    expect(deploymentSecretsKeys({ SECRETS_KEY: minted, SECRETS_KEY_PREVIOUS: "" })).toEqual({
      current: minted,
    });
    expect(deploymentSecretsKeys({ SECRETS_KEY: minted, SECRETS_KEY_PREVIOUS: minted })).toEqual({
      current: minted,
    });
  });

  it("fails closed without a key or with a short one, deployed or not", () => {
    for (const SECRETS_KEY of [undefined, "", "short-key"]) {
      expect(() => deploymentSecretsKeys({ SECRETS_KEY })).toThrow(SecretsKeyError);
      expect(() => deploymentSecretsKeys({ ...deployed, SECRETS_KEY })).toThrow(SecretsKeyError);
    }

    expect(() =>
      deploymentSecretsKeys({ SECRETS_KEY: minted, SECRETS_KEY_PREVIOUS: "short" }),
    ).toThrow(SecretsKeyError);
  });

  it("refuses the development key and keys under 256 bits on a deployed stage", () => {
    // `alchemy dev` and tests may use the development key...
    expect(deploymentSecretsKeys({ SECRETS_KEY: DEV_SECRETS_KEY })).toEqual({
      current: DEV_SECRETS_KEY,
    });

    // ...a stage with Access configured may not, nor a key shorter than the 64 hex characters the deploy mints.
    for (const access of [{ ACCESS_TEAM_DOMAIN: "team" }, { ACCESS_AUD: "aud" }]) {
      expect(() => deploymentSecretsKeys({ ...access, SECRETS_KEY: DEV_SECRETS_KEY })).toThrow(
        /refused because ACCESS_TEAM_DOMAIN\/ACCESS_AUD are set/,
      );
      expect(() => deploymentSecretsKeys({ ...access, SECRETS_KEY: "c".repeat(63) })).toThrow(
        SecretsKeyError,
      );
      expect(() =>
        deploymentSecretsKeys({
          ...access,
          SECRETS_KEY: minted,
          SECRETS_KEY_PREVIOUS: DEV_SECRETS_KEY,
        }),
      ).toThrow(/SECRETS_KEY_PREVIOUS is refused/);
    }
  });

  it("never puts a key into its error", () => {
    expect(() => deploymentSecretsKeys({ ...deployed, SECRETS_KEY: "c".repeat(40) })).not.toThrow(
      "c".repeat(40),
    );
  });
});

describe("ControlPlane stored secrets", () => {
  it("stores no secret in plain text and reads every one back", async () => {
    const { org, stub } = await stocked();
    const stored = await storedText(stub);

    expectNoPlaintext(stored);
    expect(await wrappedDataKey(stub)).toMatch(/^wk:v1:/);

    const read = await readable(stub, org);
    expect(read.file).toEqual(AUTH_FILE);
    expect(read.token).toBe(ACCESS_TOKEN);

    for (const secret of [API_KEY, COMPAT_KEY, HEADER_SECRET])
      expect(read.document).toContain(secret);

    // After a restart the same rows open with the same data key.
    await restart(stub);
    expect(await readable(stub, org)).toEqual(read);
    expect(await storedText(stub)).toBe(stored);
  });

  it("gives every org its own data key", async () => {
    const a = await stocked();
    const b = await stocked();

    expect(await wrappedDataKey(a.stub)).not.toBe(await wrappedDataKey(b.stub));

    // Org a's sealed auth file, stored under the same name in org b, does not open there.
    const sealed = await runInDurableObject(
      a.stub,
      (_instance, state) =>
        state.storage.sql
          .exec<{ metadata: string }>("SELECT metadata FROM credentials WHERE id = 'claude-a.json'")
          .one().metadata,
    );

    await runInDurableObject(b.stub, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE credentials SET metadata = ? WHERE id = 'claude-a.json'",
        sealed,
      );
    });
    await restart(b.stub);

    await inside(b.stub, async (plane) => {
      await expect(called(() => plane.getCredentialFile("claude-a.json"))).rejects.toThrow(
        /credentials\/claude-a\.json: the sealed value does not open with the org's data key/,
      );
    });
    expect(await a.stub.getCredentialFile("claude-a.json")).toEqual(AUTH_FILE);
  });

  it("does not start under another SECRETS_KEY, instead of reading garbage", async () => {
    const { org, stub } = await stocked();

    await wrapDataKeyUnder(stub, org, UNRELATED_SECRETS_KEY);

    const refusal = new RegExp(
      `neither SECRETS_KEY nor SECRETS_KEY_PREVIOUS opens the data key of org ${org}`,
    );

    await inside(stub, async (plane) => {
      await expect(called(() => plane.listCredentials())).rejects.toThrow(refusal);
      await expect(called(() => plane.getConfig())).rejects.toThrow(refusal);
    });
    // Every later start fails the same way (nothing was rewritten under the wrong key).
    await restart(stub);
    await inside(stub, async (plane) => {
      await expect(called(() => plane.getCredentialFile("claude-a.json"))).rejects.toThrow(refusal);
    });
  });

  it("wraps the data key again under SECRETS_KEY when SECRETS_KEY_PREVIOUS opens it, keeping every secret", async () => {
    const { org, stub } = await stocked();
    const before = await readable(stub, org);

    const sealedRows = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql.exec("SELECT id, metadata FROM credentials").toArray(),
    );

    // The stage rotated: its data key was wrapped under what is now SECRETS_KEY_PREVIOUS.
    const wrappedBefore = await wrapDataKeyUnder(stub, org, env.SECRETS_KEY_PREVIOUS ?? "");

    expect(await readable(stub, org)).toEqual(before);
    expect(await wrappedDataKey(stub)).not.toBe(wrappedBefore);

    // The data is not encrypted again, and the data key now opens under SECRETS_KEY alone.
    expect(
      await runInDurableObject(stub, async (_instance, state) => {
        await openDataKey({
          sql: state.storage.sql,
          transaction: (body) => state.storage.transactionSync(body),
          org,
          keys: () => ({ current: env.SECRETS_KEY }),
          sealStored: () => {
            throw new Error("no new data key expected");
          },
        });

        return state.storage.sql.exec("SELECT id, metadata FROM credentials").toArray();
      }),
    ).toEqual(sealedRows);
  });

  it("seals what a ControlPlane stored before encryption on its first start, keeping auth indexes", async () => {
    const { org, stub } = await stocked();
    expect(
      await stub.importAuthFile("claude-b.json", { ...AUTH_FILE, email: "b@x.com" }),
    ).toMatchObject({ ok: true });
    const before = await readable(stub, org);

    let plain = "";

    await asBeforeEncryption(stub, org, (sql) => {
      // The state the previous code left: plain-text secrets and no data key.
      plain = JSON.stringify([
        sql.exec("SELECT metadata FROM credentials").toArray(),
        sql.exec("SELECT value FROM config_api_keys").toArray(),
        sql.exec("SELECT value FROM config_key_groups").toArray(),
      ]);
    });

    for (const secret of SECRETS) expect(plain).toContain(secret);
    expect(await wrappedDataKey(stub)).toMatch(/^wk:v1:/);

    const after = await readable(stub, org);
    expect(after).toEqual(before);
    expect(after.credentials.length).toBeGreaterThanOrEqual(4);
    expectNoPlaintext(await storedText(stub));

    // Idempotent: the next start finds the data key and seals nothing again.
    const stored = await storedText(stub);
    await restart(stub);
    expect(await readable(stub, org)).toEqual(before);
    expect(await storedText(stub)).toBe(stored);
  });
});
