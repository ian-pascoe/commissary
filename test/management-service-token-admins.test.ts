// `access.admin-service-tokens` can only be changed by a service-token administrator or a deployment admin
// (`ACCESS_ADMIN_*`): an email admin that is one only through the config gets `403 service_tokens_require_service_admin`
// on every write path (`PATCH /settings`, `PUT /settings/config`, `/config*`), and nothing is stored.
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  ADMIN,
  controlPlane,
  jsonInit,
  makeHarness,
  resetControlPlane,
  SERVICE_ADMIN,
  SERVICE_ADMIN_BINDINGS,
  serviceToken,
  token,
} from "./support/management.ts";

const harness = makeHarness();

const serviceHarness = makeHarness(undefined, SERVICE_ADMIN_BINDINGS);

afterAll(async () => {
  await harness.dispose();
  await serviceHarness.dispose();
});

beforeEach(resetControlPlane);

/** An email that is an administrator only through `access.admin-emails` of the config. */
const CONFIG_EMAIL = "config-admin@example.com";

/** A service token that is an administrator only through `access.admin-service-tokens` of the config. */
const CONFIG_SERVICE = "config-service.access";

const NEW_TOKEN = "new-token.access";

const seed = async (): Promise<number> => {
  const result = await controlPlane().putConfig(
    JSON.stringify({
      access: { "admin-emails": [CONFIG_EMAIL], "admin-service-tokens": [CONFIG_SERVICE] },
    }),
  );

  if (!result.ok) throw new Error(result.message);

  return result.version;
};

const storedTokens = async (): Promise<ReadonlyArray<string>> => {
  const { document } = await controlPlane().getConfig();

  // SAFETY: the stored document is a serialized JSON object of the config shape (seeded above).
  const parsed = JSON.parse(document ?? "{}") as {
    access?: { "admin-service-tokens"?: ReadonlyArray<string> };
  };

  return parsed.access?.["admin-service-tokens"] ?? [];
};

const yamlWith = (tokens: ReadonlyArray<string>): string =>
  `access:\n  admin-emails:\n    - ${CONFIG_EMAIL}\n  admin-service-tokens:\n${tokens
    .map((id) => `    - ${id}\n`)
    .join("")}`;

interface Write {
  readonly name: string;
  /** The request that sets the admin service tokens to `tokens`, at `version`. */
  readonly request: (
    tokens: ReadonlyArray<string>,
    version: number,
  ) => readonly [string, string, RequestInit];
}

const writes: ReadonlyArray<Write> = [
  {
    name: "PATCH /settings",
    request: (tokens, version) => [
      "PATCH",
      "/v8/management/settings",
      jsonInit("PATCH", { version, patch: { access: { "admin-service-tokens": [...tokens] } } }),
    ],
  },
  {
    name: "PUT /settings/config",
    request: (tokens, version) => [
      "PUT",
      "/v8/management/settings/config",
      jsonInit("PUT", { version, yaml: yamlWith(tokens) }),
    ],
  },
  {
    name: "POST /settings/config/check",
    request: (tokens, version) => [
      "POST",
      "/v8/management/settings/config/check",
      jsonInit("POST", { version, yaml: yamlWith(tokens) }),
    ],
  },
  {
    name: "PUT /config.yaml",
    request: (tokens) => [
      "PUT",
      "/v8/management/config.yaml",
      { method: "PUT", headers: YAML, body: yamlWith(tokens) },
    ],
  },
  {
    name: "PUT /config",
    request: (tokens) => [
      "PUT",
      "/v8/management/config",
      jsonInit("PUT", {
        access: { "admin-emails": [CONFIG_EMAIL], "admin-service-tokens": [...tokens] },
      }),
    ],
  },
  {
    name: "PATCH /config/access",
    request: (tokens) => [
      "PATCH",
      "/v8/management/config/access",
      jsonInit("PATCH", { "admin-service-tokens": [...tokens] }),
    ],
  },
  {
    name: "PUT /config/access/admin-service-tokens",
    request: (tokens) => [
      "PUT",
      "/v8/management/config/access/admin-service-tokens",
      jsonInit("PUT", [...tokens]),
    ],
  },
];

const YAML = { "content-type": "application/yaml" };

const grown = [CONFIG_SERVICE, NEW_TOKEN];

describe("admin service tokens: who may change them", () => {
  for (const write of writes)
    it(`${write.name}: an email admin from the config is refused and nothing is stored`, async () => {
      const version = await seed();
      const [, path, init] = write.request(grown, version);
      const reply = await harness.json(path, { ...init, auth: await token(CONFIG_EMAIL) });

      expect(reply.status).toBe(403);

      expect(reply.body).toMatchObject({
        error: "service_tokens_require_service_admin",
        message: expect.stringContaining("service token") as unknown,
      });

      expect((await controlPlane().getConfig()).version).toBe(version);
      expect(await storedTokens()).toEqual([CONFIG_SERVICE]);
    });

  it("DELETE /config/access/admin-service-tokens: an email admin from the config is refused", async () => {
    const version = await seed();

    const reply = await harness.json("/v8/management/config/access/admin-service-tokens", {
      method: "DELETE",
      auth: await token(CONFIG_EMAIL),
    });

    expect(reply).toMatchObject({
      status: 403,
      body: { error: "service_tokens_require_service_admin" },
    });

    expect((await controlPlane().getConfig()).version).toBe(version);
    expect(await storedTokens()).toEqual([CONFIG_SERVICE]);
  });

  for (const write of writes.filter((candidate) => !candidate.name.endsWith("/check"))) {
    it(`${write.name}: a service token that is an admin through the config may change them`, async () => {
      const version = await seed();
      const [, path, init] = write.request(grown, version);
      const reply = await harness.json(path, { ...init, auth: await serviceToken(CONFIG_SERVICE) });

      expect(reply.status).toBe(200);
      expect(await storedTokens()).toEqual(grown);
    });

    it(`${write.name}: a deployment admin (ACCESS_ADMIN_EMAILS) may change them`, async () => {
      const version = await seed();
      const [, path, init] = write.request(grown, version);
      const reply = await harness.json(path, { ...init, auth: await token(ADMIN) });

      expect(reply.status).toBe(200);
      expect(await storedTokens()).toEqual(grown);
    });

    it(`${write.name}: a deployment service admin (ACCESS_ADMIN_SERVICE_TOKENS) may change them`, async () => {
      const version = await seed();
      const [, path, init] = write.request(grown, version);

      const reply = await serviceHarness.json(path, {
        ...init,
        auth: await serviceToken(SERVICE_ADMIN),
      });

      expect(reply.status).toBe(200);
      expect(await storedTokens()).toEqual(grown);
    });
  }

  it("lets an email admin write the same tokens again and change anything else", async () => {
    const version = await seed();
    const auth = await token(CONFIG_EMAIL);

    const same = await harness.json("/v8/management/settings", {
      ...jsonInit("PATCH", {
        version,
        patch: { access: { "admin-service-tokens": [CONFIG_SERVICE] } },
      }),
      auth,
    });

    expect(same).toMatchObject({ status: 200, body: { version: version + 1 } });

    const other = await harness.json("/v8/management/settings", {
      ...jsonInit("PATCH", {
        version: version + 1,
        patch: { routing: { strategy: "fill-first" } },
      }),
      auth,
    });

    expect(other.status).toBe(200);

    const yaml = await harness.json("/v8/management/config.yaml", {
      method: "PUT",
      headers: YAML,
      body: yamlWith([CONFIG_SERVICE]),
      auth,
    });

    expect(yaml.status).toBe(200);
    expect(await storedTokens()).toEqual([CONFIG_SERVICE]);
  });
});
