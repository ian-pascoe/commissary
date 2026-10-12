// GET /config* serve the configuration masked like GET /settings/config, and every /config* write refuses masked
// placeholders (`422 masked_value`), storing nothing.
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { isJsonObject, type Json, type JsonObject } from "../src/json/index.ts";
import { controlPlane, jsonInit, makeHarness, resetControlPlane } from "./support/management.ts";

const harness = makeHarness();

afterAll(harness.dispose);

beforeEach(resetControlPlane);

const { call, json } = harness;

const CONFIG = "/v8/management/config";

const random = () => crypto.randomUUID().replaceAll("-", "");

/** Secrets for one round: random, so no assertion can pass by matching a fixed string elsewhere. */
const makeSecrets = () => {
  return {
    key: `sk-ant-${random()}`,
    keyTwo: `sk-ant-${random()}`,
    compatKey: `sk-or-${random()}`,
    header: `Bearer ${random()}`,
    customHeader: random(),
    patternHeader: `Bearer ${random()}`,
    client: `client-${random()}`,
    proxyPass: `pass${random()}`,
    baseUser: `user${random()}`,
    baseToken: `tok${random()}`,
    fragmentToken: `frag${random()}`,
    paramKey: `pk-${random()}`,
    rawKey: `sk-raw-${random()}`,
    zenKey: `sk-zen-${random()}`,
    goKey: `sk-go-${random()}`,
    zenHeader: `Bearer ${random()}`,
  };
};

type Secrets = ReturnType<typeof makeSecrets>;

/** A config holding every kind of secret position. */
const seededDocument = (secrets: Secrets): JsonObject => ({
  access: { "api-keys": [secrets.client] },
  routing: { strategy: "fill-first" },
  requests: {
    "proxy-url": `http://proxy-user:${secrets.proxyPass}@proxy.test:8080`,
    payload: {
      default: [
        {
          models: [{ name: "gpt-*", headers: { Authorization: secrets.patternHeader } }],
          params: { temperature: 0 },
        },
      ],
      override: [{ models: [{ name: "gpt-*" }], params: { "metadata.api_key": secrets.paramKey } }],
      // A raw parameter whose JSON text names a secret-looking key is one whole secret.
      "override-raw": [
        {
          models: [{ name: "gpt-*" }],
          params: { extra_body: JSON.stringify({ metadata: { api_key: secrets.rawKey } }) },
        },
      ],
    },
  },
  "api-keys": {
    claude: [
      {
        name: "main",
        "base-url": "https://api.anthropic.com",
        headers: { Authorization: secrets.header, "User-Agent": "cliproxy-test" },
        keys: [{ "api-key": secrets.key }, { "api-key": secrets.keyTwo }],
      },
    ],
    "opencode-zen": [
      {
        headers: { Authorization: secrets.zenHeader },
        models: [{ name: "claude-haiku-4-5", protocol: "messages" }],
        keys: [{ "api-key": secrets.zenKey }],
      },
    ],
    "opencode-go": [{ keys: [{ "api-key": secrets.goKey }] }],
    "openai-compatibility": [
      {
        name: "Router",
        "base-url": `https://${secrets.baseUser}@router.example/v1?api_key=${secrets.baseToken}#access_token=${secrets.fragmentToken}`,
        headers: { "X-Portkey-Virtual-Key": secrets.customHeader },
        keys: [{ "api-key": secrets.compatKey }],
      },
    ],
  },
});

const seed = async (document: JsonObject): Promise<number> => {
  const result = await controlPlane().putConfig(JSON.stringify(document));

  if (!result.ok) throw new Error(result.message);

  return result.version;
};

const storedText = async (): Promise<string> => (await controlPlane().getConfig()).document ?? "{}";

const stored = async (): Promise<JsonObject> => JSON.parse(await storedText()) as JsonObject;

/** Every path the `/config/<path>` route can address in `value` (object keys only; lists are leaves). */
const addressable = (value: Json, prefix: ReadonlyArray<string> = []): string[][] =>
  isJsonObject(value)
    ? Object.entries(value).flatMap(([key, child]) => [
        [...prefix, key],
        ...addressable(child, [...prefix, key]),
      ])
    : [];

const pathUrl = (parts: ReadonlyArray<string>) =>
  `${CONFIG}/${parts.map((part) => encodeURIComponent(part)).join("/")}`;

/** Strings of `value` carrying a placeholder, by dotted path. */
const placeholders = (value: Json, prefix = "", out = new Map<string, string>()) => {
  if (typeof value === "string") {
    if (value.includes("[redacted#")) out.set(prefix, value);
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => placeholders(item, `${prefix}[${index}]`, out));
  } else if (isJsonObject(value)) {
    for (const [key, child] of Object.entries(value))
      placeholders(child, prefix === "" ? key : `${prefix}.${key}`, out);
  }

  return out;
};

const getText = async (path: string) => {
  const response = await call(path);

  return { status: response.status, text: new TextDecoder().decode(await response.arrayBuffer()) };
};

describe("GET /config* masking", () => {
  it("never shows a stored secret, at any addressable path (several random rounds)", async () => {
    for (let round = 0; round < 3; round++) {
      const secrets = makeSecrets();

      await seed(seededDocument(secrets));
      const document = await stored();
      const paths = [CONFIG, `${CONFIG}.yaml`, ...addressable(document).map(pathUrl)];

      expect(paths.length).toBeGreaterThan(50);

      for (const path of paths) {
        const { status, text } = await getText(path);

        expect(status, path).toBe(200);

        for (const [name, secret] of Object.entries(secrets))
          expect(text, `${path} shows ${name}`).not.toContain(secret);
      }
    }
  });

  it("numbers placeholders like GET /settings/config for the same version", async () => {
    const version = await seed(seededDocument(makeSecrets()));

    const raw = (await json("/v8/management/settings/config")).body as {
      version: number;
      yaml: string;
      secrets: number;
    };

    expect(raw.version).toBe(version);

    const full = await json(CONFIG);

    expect(full.headers.get("etag")).toBe(`"${version}"`);

    // The YAML export is the raw editor's text, byte for byte.
    const yaml = await getText(`${CONFIG}.yaml`);

    expect(yaml.text).toBe(raw.yaml);

    // Every placeholder of the JSON document is the one the raw editor shows at that path.
    const shown = placeholders(full.body as Json);
    const editor = placeholders(parse(raw.yaml) as Json);

    // One URL can hold several (user info, query, fragment).
    const count = [...shown.values()].reduce(
      (sum, text) => sum + (text.match(/\[redacted#\d+\]/g)?.length ?? 0),
      0,
    );

    expect(count).toBe(raw.secrets);
    // 11 + the payload parameter and the raw parameter's JSON text + the two OpenCode keys and the Zen header.
    expect(raw.secrets).toBe(16);
    expect(shown.get("api-keys.opencode-zen[0].keys[0].api-key")).toMatch(/^\[redacted#\d+\]…/);
    expect(shown.get("api-keys.opencode-go[0].keys[0].api-key")).toMatch(/^\[redacted#\d+\]…/);
    expect(shown.get("requests.payload.override-raw[0].params.extra_body")).toMatch(
      /^\[redacted#\d+\]…/,
    );
    expect(shown).toEqual(editor);

    // A subtree read keeps the whole document's numbering.
    const claude = await json(`${CONFIG}/api-keys/claude`);
    const fullApiKeys = (full.body as { "api-keys": { claude: Json } })["api-keys"];

    expect(claude.body).toEqual(fullApiKeys.claude);
    expect(JSON.stringify(claude.body)).toContain("[redacted#");
  });
});

/** Runs `write`, expects `422 masked_value` at `path`, and that nothing was stored. */
const refused = async (
  write: () => Promise<{ status: number; body: unknown }>,
  path: string,
  secret = true,
) => {
  const before = await controlPlane().getConfig();
  const response = await write();

  expect(response.status).toBe(422);
  expect(response.body).toMatchObject({
    error: secret ? "masked_value" : "masked_value_outside_secret_field",
    path,
  });
  expect((response.body as { message: string }).message).toContain(
    "PUT /v8/management/settings/config",
  );
  expect((response.body as { message: string }).message).toContain(
    secret ? "as a secret" : "placeholder text",
  );

  const after = await controlPlane().getConfig();

  expect(after.version).toBe(before.version);
  expect(after.document).toBe(before.document);
};

describe("/config* writes refuse masked placeholders", () => {
  it("PUT /config.yaml with the raw editor's masked text", async () => {
    await seed(seededDocument(makeSecrets()));
    const { yaml } = (await json("/v8/management/settings/config")).body as { yaml: string };

    await refused(
      () =>
        json(`${CONFIG}.yaml`, {
          method: "PUT",
          headers: { "content-type": "application/yaml" },
          body: yaml,
        }),
      "access.api-keys[0]",
    );
  });

  it("PUT /config with a masked GET body", async () => {
    await seed(seededDocument(makeSecrets()));
    const masked = (await json(CONFIG)).body as Json;

    await refused(() => json(CONFIG, jsonInit("PUT", masked)), "access.api-keys[0]");
  });

  it("PATCH /config/api-keys/claude with a [redacted]…abcd key", async () => {
    await seed(seededDocument(makeSecrets()));

    await refused(
      () =>
        json(
          `${CONFIG}/api-keys/claude`,
          jsonInit("PATCH", [{ keys: [{ "api-key": "[redacted]…abcd" }] }]),
        ),
      "api-keys.claude[0].keys[0].api-key",
    );
  });

  it("PUT /config/<path> with [new secret]… in any case, and URL credentials", async () => {
    await seed(seededDocument(makeSecrets()));

    await refused(
      () => json(`${CONFIG}/access/api-keys`, jsonInit("PUT", ["[NEW SECRET]…wxyz"])),
      "access.api-keys[0]",
    );
    await refused(
      () =>
        json(
          `${CONFIG}/requests/proxy-url`,
          jsonInit("PUT", "http://proxy-user:[Redacted#2]@proxy.test:8080"),
        ),
      "requests.proxy-url",
    );
  });

  it("PATCH /config with a placeholder in a non-secret field (refused too)", async () => {
    await seed(seededDocument(makeSecrets()));

    // A model alias is not a secret, but the raw editor refuses markers there, so storing one would block it.
    await refused(
      () =>
        json(
          `${CONFIG}/oauth/model-alias/claude`,
          jsonInit("PUT", [{ name: "[redacted#1]…abcd", alias: "opus" }]),
        ),
      "oauth.model-alias.claude[0].name",
      false,
    );
    // A masked secret header renamed to a shown header.
    await refused(
      () =>
        json(
          `${CONFIG}/api-keys/claude`,
          jsonInit("PUT", [
            {
              "base-url": "https://api.anthropic.com",
              headers: { "User-Agent": "[redacted#2]…abcd" },
              keys: [{ "api-key": "sk-ant-plain-new-key" }],
            },
          ]),
        ),
      "api-keys.claude[0].headers.User-Agent",
      false,
    );
  });

  it("still stores plain new secrets and masks them on the next read", async () => {
    await seed(seededDocument(makeSecrets()));
    const fresh = `sk-ant-${crypto.randomUUID()}`;

    const put = await json(
      `${CONFIG}/api-keys/claude`,
      jsonInit("PUT", [{ "base-url": "https://api.anthropic.com", keys: [{ "api-key": fresh }] }]),
    );

    expect(put).toMatchObject({ status: 200, body: { status: "ok" } });
    expect(await storedText()).toContain(fresh);
    expect((await getText(`${CONFIG}/api-keys/claude`)).text).not.toContain(fresh);

    // A Go config import (YAML, legacy layout included) keeps working.
    const imported = await json(`${CONFIG}.yaml`, {
      method: "PUT",
      headers: { "content-type": "application/yaml" },
      body: `claude-api-key:\n  - api-key: ${fresh}-legacy\n`,
    });

    expect(imported.status).toBe(200);
    expect(await storedText()).toContain(`${fresh}-legacy`);
  });

  it("lets a placeholder already stored at the same path through (written before the guard)", async () => {
    await seed({ ...seededDocument(makeSecrets()), oauth: { "model-alias": { claude: [] } } });
    const before = await stored();

    await seed({
      ...before,
      oauth: { "model-alias": { claude: [{ name: "[redacted#1]", alias: "legacy" }] } },
    });

    const patch = await json(`${CONFIG}/routing/strategy`, jsonInit("PUT", "round-robin"));

    expect(patch.status).toBe(200);

    // Moving it elsewhere is a new write of it: refused.
    const moved = await json(
      `${CONFIG}/oauth/model-alias/codex`,
      jsonInit("PUT", [{ name: "[redacted#1]", alias: "legacy" }]),
    );

    expect(moved).toMatchObject({
      status: 422,
      body: { error: "masked_value_outside_secret_field", path: "oauth.model-alias.codex[0].name" },
    });
  });

  it("answers a refused guess of a stored secret the same whether it is right or not", async () => {
    const secrets = makeSecrets();

    await seed(seededDocument(secrets));
    // Same length and alphabet as the stored secret, so only its value differs.
    const wrong = `client-${random()}`;

    expect(wrong.length).toBe(secrets.client.length);

    const yaml = (guess: string) =>
      json(`${CONFIG}.yaml`, {
        method: "PUT",
        headers: { "content-type": "application/yaml" },
        body: guess,
      });

    // `echoes`: the guess is a key the caller wrote, which the message names as written (for either guess).
    const bodies = async (
      attempt: (guess: string) => Promise<{ status: number; body: unknown }>,
      echoes = false,
    ) => {
      const right = await attempt(secrets.client);
      const other = await attempt(wrong);

      expect(right.status).toBe(422);

      if (!echoes) expect(JSON.stringify(right.body)).not.toContain(secrets.client);

      return [JSON.stringify(right.body), JSON.stringify(other.body)] as const;
    };

    // A schema error on a field whose decoding names the value.
    const [schemaRight, schemaWrong] = await bodies((guess) =>
      json(`${CONFIG}/multimedia/disable-image-generation`, jsonInit("PUT", guess)),
    );

    expect(schemaRight).toBe(schemaWrong);
    expect(JSON.parse(schemaRight)).toMatchObject({
      error: "invalid_config",
      path: "multimedia.disable-image-generation",
    });

    // A type error at a secret position.
    const [typeRight, typeWrong] = await bodies((guess) =>
      json(`${CONFIG}/access/api-keys`, jsonInit("PUT", { [guess]: 1 })),
    );

    expect(typeRight).toBe(typeWrong);

    // The guess as a key: an unknown provider family, an unknown group field, a key inside a typed map. The message
    // names the key as written and is not scrubbed of stored secrets (a scrubbed echo would differ).
    for (const attempt of [
      (guess: string) => json(`${CONFIG}/api-keys`, jsonInit("PUT", { [guess]: [] })),
      (guess: string) =>
        json(`${CONFIG}/api-keys/claude`, jsonInit("PUT", [{ [guess]: 1, keys: [] }])),
      (guess: string) =>
        json(
          `${CONFIG}/api-keys/claude`,
          jsonInit("PUT", [{ headers: { [guess]: [1] }, keys: [] }]),
        ),
      (guess: string) => yaml(`api-keys:\n  ${guess}: []\n`),
    ]) {
      const [right, other] = await bodies(attempt, true);

      expect(right.replaceAll(secrets.client, wrong)).toBe(other);
      expect(right).toContain(secrets.client);
    }

    // The guess as an alias name.
    const [aliasRight, aliasWrong] = await bodies((guess) => yaml(`a: *${guess}\n`));

    expect(aliasRight).toBe(aliasWrong);
    expect(JSON.parse(aliasRight)).toMatchObject({ error: "invalid_config" });

    // YAML syntax errors that quote the source around them (here a line holding the guess).
    for (const text of [
      (guess: string) => `access:\n  api-keys: [${guess}\n`,
      (guess: string) => `access:\n  api-keys: ["${guess}\\q"]\n`,
      (guess: string) => `access:\n  api-keys: [${guess}]\n  api-keys: []\n`,
    ]) {
      const [right, other] = await bodies((guess) => yaml(text(guess)));

      expect(right).toBe(other);
      expect(JSON.parse(right)).toMatchObject({
        error: "invalid_config",
        line: expect.any(Number),
        column: expect.any(Number),
      });
    }

    expect((await stored()).access).toMatchObject({ "api-keys": [secrets.client] });
  });
});

describe("/config* paths", () => {
  it("refuses __proto__, constructor and prototype segments, and never pollutes Object.prototype", async () => {
    await seed(seededDocument(makeSecrets()));
    const before = await storedText();

    for (const segment of ["__proto__", "constructor", "prototype", "%5F%5Fproto%5F%5F"])
      for (const method of ["PUT", "PATCH"] as const) {
        const response = await json(
          `${CONFIG}/routing/${segment}/polluted`,
          jsonInit(method, "yes"),
        );

        expect(response, `${method} ${segment}`).toMatchObject({
          status: 400,
          body: { error: "invalid_path" },
        });
      }

    expect((await json(`${CONFIG}/__proto__`)).status).toBe(400);
    expect((await call(`${CONFIG}/constructor`, { method: "DELETE" })).status).toBe(400);

    // A merge patch body with an own `__proto__` key (JSON.parse makes one) is not merged.
    const patch = await json(CONFIG, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: '{"__proto__": {"polluted": "yes"}, "routing": {"strategy": "round-robin"}}',
    });

    expect(patch.status).toBe(200);
    expect("polluted" in {}).toBe(false);
    expect(Object.hasOwn(await stored(), "__proto__")).toBe(false);
    expect((await stored()).routing).toMatchObject({ strategy: "round-robin" });
    expect(before).not.toBe(await storedText());
  });

  it("reads the path like the router matched the URL", async () => {
    await seed(seededDocument(makeSecrets()));

    // Duplicate slashes, an encoded prefix letter and another case all address routing.strategy.
    for (const [url, strategy] of [
      ["//v8/management/config/routing/strategy", "round-robin"],
      ["/v8//management/%63onfig/routing/strategy", "fill-first"],
      ["/V8/Management/CONFIG//routing/strategy/", "round-robin"],
    ] as const) {
      const response = await json(url, jsonInit("PUT", strategy));

      expect(response, url).toMatchObject({ status: 200 });
      expect((await stored()).routing, url).toMatchObject({ strategy });
      expect(Object.keys(await stored()).filter((key) => key.includes("routing"))).toEqual([
        "routing",
      ]);
    }

    // `%2F` stays inside one key.
    const alias = await json(
      `${CONFIG}/oauth/model-alias/vendor%2Fmodel`,
      jsonInit("PUT", [{ name: "a", alias: "b" }]),
    );

    expect(alias.status).toBe(200);
    expect(await json(`${CONFIG}/oauth/model-alias/vendor%2Fmodel`)).toMatchObject({
      status: 200,
      body: [{ name: "a", alias: "b" }],
    });
  });
});
