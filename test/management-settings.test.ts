// /v8/management/settings through the router, Access gate and real ControlPlane: the Settings page's view and writes.
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import type { Json } from "../src/json/index.ts";
import type { SettingsView } from "../src/management/contract/settings.ts";
import {
  ADMIN,
  controlPlane,
  jsonInit,
  makeHarness,
  resetControlPlane,
  serviceToken,
  token,
} from "./support/management.ts";

const harness = makeHarness();

afterAll(harness.dispose);

beforeEach(resetControlPlane);

const { call, json } = harness;

const PATH = "/v8/management/settings";

const SECRETS = {
  key: "sk-ant-SETTINGS-SECRET-4242",
  proxy: "http://user:proxy-pass-777@proxy.test:8080",
  groupProxy: "http://group-user:group-pass-555@proxy.test:9090",
  client: "client-key-SECRET-1313",
};

const seed = async (document: Record<string, unknown>): Promise<number> => {
  const result = await controlPlane().putConfig(JSON.stringify(document));

  if (!result.ok) throw new Error(result.message);

  return result.version;
};

const getView = async (): Promise<SettingsView> => {
  const response = await json(PATH);

  expect(response.status).toBe(200);

  // SAFETY: the shape is checked against the contract in management-contract.test.ts.
  return response.body as SettingsView;
};

const save = (version: number, patch: Json) => json(PATH, jsonInit("PATCH", { version, patch }));

const storedDocument = async (): Promise<Record<string, unknown>> => {
  const wire = await controlPlane().getConfig();

  // SAFETY: the stored config document is a serialized JSON object.
  return JSON.parse(wire.document ?? "{}") as Record<string, unknown>;
};

describe("management settings", () => {
  it("requires an Access admin", async () => {
    expect((await call(PATH, { auth: false })).status).toBe(401);
    expect((await call(PATH, { auth: await token("other@example.com") })).status).toBe(403);
  });

  it("serves the defaults on an empty config, with the env admins", async () => {
    const view = await getView();

    expect(view.values).toEqual(view.defaults);
    expect(view.values.routing.strategy).toBe("round-robin");
    expect(view.values.routing["session-affinity-ttl"]).toBe("1h");
    expect(view.values.oauth.providers.antigravity["signature-cache-enabled"]).toBeNull();
    expect(view.not_applied).toEqual([]);
    expect(view.env_admins).toEqual({ emails: [ADMIN], service_tokens: [] });
    expect(view.payload).toEqual({
      default: 0,
      "default-raw": 0,
      override: 0,
      "override-raw": 0,
      filter: 0,
    });
    expect(view.prefixed_credentials).toBe(0);
    expect(view.request_scoped_errors).toEqual({});
    expect(view.version).toBeGreaterThanOrEqual(0);
  });

  it("never serves a secret and lists the inert keys by name and reason", async () => {
    await seed({
      access: { "api-keys": [SECRETS.client] },
      requests: {
        "proxy-url": SECRETS.proxy,
        payload: { default: [{ models: [{ name: "gpt-*" }], params: { temperature: 0 } }] },
      },
      upstream: { codex: { "response-steering": true } },
      observability: { logs: { debug: true } },
      oauth: {
        "request-scoped-errors": {
          claude: [{ status: 400, match: ["overloaded"], action: "continue" }],
        },
      },
      "api-keys": {
        claude: [
          {
            name: "main",
            prefix: "team",
            "base-url": "https://api.anthropic.com",
            "proxy-url": SECRETS.groupProxy,
            keys: [{ "api-key": SECRETS.key }],
          },
        ],
      },
    });

    const response = await call(PATH);
    const text = await response.text();

    expect(response.status).toBe(200);

    for (const secret of [...Object.values(SECRETS), "proxy-pass", "group-pass"])
      expect(text).not.toContain(secret);

    // SAFETY: a 200 body of this route is a SettingsView (checked by the contract test).
    const view = JSON.parse(text) as SettingsView;

    expect(view.not_applied.map((entry) => entry.key)).toEqual([
      "access.api-keys",
      "requests.proxy-url",
      "observability.logs.debug",
    ]);
    expect(view.not_applied.every((entry) => entry.reason.length > 0)).toBe(true);
    // Response steering is effective on Workers: a value, not an inert key.
    expect(view.values.upstream.codex["response-steering"]).toBe(true);
    expect(view.payload.default).toBe(1);
    expect(view.prefixed_credentials).toBe(1);
    expect(view.request_scoped_errors).toEqual({
      claude: [{ status: 400, match: ["overloaded"], "match-regexr": [], action: "continue" }],
    });
    expect(view.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("writes one leaf and leaves everything else as stored", async () => {
    const version = await seed({
      "api-keys": {
        claude: [{ "base-url": "https://api.anthropic.com", keys: [{ "api-key": SECRETS.key }] }],
      },
      oauth: { "model-alias": { claude: [{ name: "claude-opus-4-6", alias: "opus" }] } },
    });

    const before = await storedDocument();
    const saved = await save(version, { routing: { "session-affinity-ttl": "30m" } });

    expect(saved).toMatchObject({ status: 200, body: { status: "ok", version: version + 1 } });

    const view = await getView();

    expect(view.version).toBe(version + 1);
    expect(view.values.routing["session-affinity-ttl"]).toBe("30m");
    expect({ ...view.values, routing: view.defaults.routing }).toEqual(view.defaults);

    const after = await storedDocument();

    expect(JSON.stringify(after["api-keys"])).toBe(JSON.stringify(before["api-keys"]));
    expect(after.oauth).toEqual(before.oauth);
  });

  it("resets a leaf to its default with null", async () => {
    const version = await seed({
      routing: { strategy: "fill-first" },
      oauth: { providers: { antigravity: { "signature-cache-enabled": false } } },
    });

    const saved = await save(version, {
      routing: { strategy: null },
      oauth: { providers: { antigravity: { "signature-cache-enabled": null } } },
    });

    expect(saved.status).toBe(200);
    const view = await getView();

    expect(view.values).toEqual(view.defaults);

    const yaml = new TextDecoder().decode(
      await (await call("/v8/management/config.yaml")).arrayBuffer(),
    );

    expect(yaml).not.toContain("strategy");
    expect(yaml).not.toContain("signature-cache-enabled");
  });

  it("removes a not-applied key with null and refuses any other value for it", async () => {
    const version = await seed({
      access: { "api-keys": [SECRETS.client] },
      observability: { usage: { "redis-usage-queue-retention-seconds": 120 } },
    });

    expect(await save(version, { access: { "api-keys": ["other"] } })).toMatchObject({
      status: 400,
      body: { error: "not_a_setting", path: "access.api-keys" },
    });

    const saved = await save(version, {
      access: { "api-keys": null },
      observability: { usage: { "redis-usage-queue-retention-seconds": null } },
    });

    expect(saved.status).toBe(200);
    expect((await getView()).not_applied).toEqual([]);
  });

  it("refuses a stale version without storing or retrying", async () => {
    const version = await seed({ routing: { strategy: "fill-first" } });

    expect((await save(version, { routing: { "session-affinity": true } })).status).toBe(200);

    const stale = await save(version, { routing: { strategy: "round-robin" } });

    expect(stale).toMatchObject({ status: 409, body: { error: "conflict" } });
    const view = await getView();

    expect(view.version).toBe(version + 1);
    expect(view.values.routing.strategy).toBe("fill-first");
  });

  it("answers 400 not_a_setting for paths that are not settings", async () => {
    const { version } = await getView();

    const cases: ReadonlyArray<readonly [Json, string]> = [
      [{ "api-keys": { claude: [] } }, "api-keys"],
      [{ routing: { bogus: 1 } }, "routing.bogus"],
      [{ oauth: { "model-alias": {} } }, "oauth.model-alias"],
      [{ requests: { payload: {} } }, "requests.payload"],
      [{ upstream: { codex: { "response-steering": true, nope: false } } }, "upstream.codex.nope"],
    ];

    for (const [patch, path] of cases) {
      expect(await save(version, patch)).toMatchObject({
        status: 400,
        body: { error: "not_a_setting", path },
      });
    }

    expect((await getView()).version).toBe(version);
  });

  it("answers 422 invalid_setting with the path and stores nothing", async () => {
    const { version } = await getView();

    const cases: ReadonlyArray<readonly [Json, string]> = [
      [{ routing: { "session-affinity-ttl": "soon" } }, "routing.session-affinity-ttl"],
      [{ routing: { "session-affinity-ttl": "0s" } }, "routing.session-affinity-ttl"],
      [{ routing: { strategy: "wrr2" } }, "routing.strategy"],
      [{ routing: { strategy: "wrr" } }, "routing.strategy"],
      [
        { routing: { retry: { "max-retry-credentials": -1 } } },
        "routing.retry.max-retry-credentials",
      ],
      [{ routing: { retry: { "request-retry": 1.5 } } }, "routing.retry.request-retry"],
      [{ routing: { "session-affinity": "yes" } }, "routing.session-affinity"],
      [{ routing: "fill-first" }, "routing"],
      [{ multimedia: { "gpt-image-2-base-model": "dall-e" } }, "multimedia.gpt-image-2-base-model"],
      [{ multimedia: { "disable-image-generation": "on" } }, "multimedia.disable-image-generation"],
      [
        { multimedia: { "video-result-auth-cache-ttl": "3" } },
        "multimedia.video-result-auth-cache-ttl",
      ],
      [{ models: { catalog: "ftp://catalog.test/models.json" } }, "models.catalog"],
      [
        { upstream: { codex: { "stream-bootstrap-timeout": "later" } } },
        "upstream.codex.stream-bootstrap-timeout",
      ],
      [
        { upstream: { claude: { "header-defaults": { timezone: "Mars/Olympus" } } } },
        "upstream.claude.header-defaults.timezone",
      ],
      // Valid but rewritten by the normaliser (trimmed / lower-cased): refused by the survival check.
      [
        { upstream: { claude: { "header-defaults": { "user-agent": " claude-cli " } } } },
        "upstream.claude.header-defaults.user-agent",
      ],
      [{ access: { "admin-emails": [ADMIN, "Mixed@Example.com"] } }, "access.admin-emails"],
      [{ access: { "admin-emails": ["not-an-email"] } }, "access.admin-emails"],
    ];

    for (const [patch, path] of cases) {
      const refused = await save(version, patch);

      expect(refused, JSON.stringify(patch)).toMatchObject({
        status: 422,
        body: { error: "invalid_setting", path, message: expect.any(String) },
      });
    }

    expect((await getView()).version).toBe(version);
  });

  it("accepts the documented special values", async () => {
    let { version } = await getView();

    for (const patch of [
      { upstream: { codex: { "stream-bootstrap-timeout": "unlimited" } } },
      { upstream: { codex: { "stream-bootstrap-timeout": "90" } } },
      { upstream: { claude: { "header-defaults": { timezone: "Local" } } } },
      { upstream: { claude: { "header-defaults": { timezone: "Europe/Berlin" } } } },
      { models: { catalog: "https://example.test/models.json" } },
      { models: { catalog: "embed" } },
      {
        multimedia: { "disable-image-generation": "chat", "gpt-image-2-base-model": "gpt-image-x" },
      },
      { routing: { cooldown: { "transient-error-cooldown-seconds": -1 } } },
    ] satisfies Json[]) {
      const saved = await save(version, patch);

      expect(saved.status, JSON.stringify(patch)).toBe(200);
      version = (saved.body as { version: number }).version;
    }

    const view = await getView();

    expect(view.values.models.catalog).toBe("embed");
    expect(view.values.multimedia["disable-image-generation"]).toBe("chat");
    expect(view.values.routing.cooldown["transient-error-cooldown-seconds"]).toBe(-1);
  });

  it("refuses bodies without a version or patch object", async () => {
    expect(await json(PATH, jsonInit("PATCH", { patch: {} }))).toMatchObject({
      status: 400,
      body: { error: "invalid body" },
    });
    expect(await json(PATH, jsonInit("PATCH", { version: 1, patch: [] }))).toMatchObject({
      status: 400,
    });
  });

  it("does not let a config-only admin remove their own access", async () => {
    // A fresh harness: the Access gate caches the config admin lists per isolate (5 s).
    const own = makeHarness();
    const CONFIG_ADMIN = "cfg@example.com";

    try {
      const version = await seed({
        access: { "admin-emails": [CONFIG_ADMIN, "other@example.com"] },
      });

      const as = async (email: string, patch: Json, at: number) => {
        const response = await own.call(PATH, {
          ...jsonInit("PATCH", { version: at, patch }),
          auth: await token(email),
        });

        const body: unknown = await response.json();

        return { status: response.status, body };
      };

      const lockout = await as(
        CONFIG_ADMIN,
        { access: { "admin-emails": ["other@example.com"] } },
        version,
      );

      expect(lockout).toMatchObject({
        status: 422,
        body: { error: "would_remove_your_admin_access", path: "access.admin-emails" },
      });

      const reset = await as(CONFIG_ADMIN, { access: { "admin-emails": null } }, version);

      expect(reset.status).toBe(422);

      const kept = await as(CONFIG_ADMIN, { access: { "admin-emails": [CONFIG_ADMIN] } }, version);

      expect(kept).toMatchObject({ status: 200, body: { version: version + 1 } });

      // A platform admin may remove anyone.
      const removed = await as(ADMIN, { access: { "admin-emails": null } }, version + 1);

      expect(removed).toMatchObject({ status: 200, body: { version: version + 2 } });
    } finally {
      await own.dispose();
    }
  });
});

describe("management raw configuration", () => {
  const RAW = "/v8/management/settings/config";

  const RAW_SECRETS = {
    key: "sk-ant-RAW-SECRET-KEY-4242",
    header: "Bearer raw-header-SECRET-7777",
    proxyPass: "raw-proxy-pass-SECRET-3131",
    client: "raw-client-key-SECRET-1313",
    pattern: "Bearer sk-raw-pattern-SECRET*",
  };

  const seeded = {
    access: { "api-keys": [RAW_SECRETS.client] },
    requests: {
      "proxy-url": `http://proxy-user:${RAW_SECRETS.proxyPass}@proxy.test:8080`,
      payload: {
        default: [
          {
            models: [{ name: "gpt-*", headers: { Authorization: RAW_SECRETS.pattern } }],
            params: { temperature: 0 },
          },
        ],
      },
    },
    routing: { strategy: "fill-first" },
    "api-keys": {
      claude: [
        {
          name: "main",
          "base-url": "https://api.anthropic.com",
          headers: { Authorization: RAW_SECRETS.header },
          keys: [{ "api-key": RAW_SECRETS.key }],
        },
      ],
    },
  };

  const expectNoSecret = (text: string): void => {
    for (const secret of Object.values(RAW_SECRETS)) expect(text).not.toContain(secret);
    expect(text).not.toContain("SECRET");
  };

  const rawText = async (init?: RequestInit) => {
    const response = await call(RAW, init);
    const text = await response.text();

    return { status: response.status, text, body: JSON.parse(text) as Record<string, unknown> };
  };

  const getRaw = async () => {
    const { status, text, body } = await rawText();

    expect(status).toBe(200);
    expectNoSecret(text);

    // SAFETY: a 200 body of this route is a RawConfig (checked by the contract test).
    return body as { version: number; yaml: string; secrets: number };
  };

  const send = async (method: "PUT" | "POST", body: Json) => {
    const response = await call(method === "PUT" ? RAW : `${RAW}/check`, jsonInit(method, body));
    const text = await response.text();

    return { status: response.status, text, body: JSON.parse(text) as Record<string, unknown> };
  };

  it("requires an Access admin", async () => {
    expect((await call(RAW, { auth: false })).status).toBe(401);
    expect((await call(RAW, { auth: await token("other@example.com") })).status).toBe(403);
  });

  it("serves the stored document as sparse YAML with every secret masked", async () => {
    const version = await seed(seeded);
    const raw = await getRaw();

    expect(raw.version).toBe(version);
    expect(raw.secrets).toBe(5);
    expect(raw.yaml.match(/\[redacted#\d+\]/g)).toHaveLength(5);
    expect(raw.yaml).toContain('"[redacted#1]…1313"');
    expect(raw.yaml).toContain('"http://[redacted#2]@proxy.test:8080"');
    expect(raw.yaml).toContain("strategy: fill-first");
    // Sparse: defaults are omitted.
    expect(raw.yaml).not.toContain("session-affinity");
    expect(raw.yaml).not.toContain("auth_index");
    expect(parseYaml(raw.yaml)).toMatchObject({ "config-version": 8 });
  });

  it("saves unchanged YAML without writing, keeping the version", async () => {
    const version = await seed(seeded);
    const before = await storedDocument();
    const { yaml } = await getRaw();
    const saved = await send("PUT", { version, yaml });

    expectNoSecret(saved.text);
    expect(saved).toMatchObject({
      status: 200,
      body: {
        status: "ok",
        version,
        dropped: [],
        not_applied: ["access.api-keys", "requests.proxy-url"],
      },
    });
    expect((await controlPlane().getConfig()).version).toBe(version);
    expect(await storedDocument()).toEqual(before);
  });

  it("stores an edit and keeps every secret behind its placeholder", async () => {
    const version = await seed(seeded);
    const before = await storedDocument();
    const { yaml } = await getRaw();
    const saved = await send("PUT", { version, yaml: yaml.replace("fill-first", "round-robin") });

    expectNoSecret(saved.text);
    expect(saved).toMatchObject({ status: 200, body: { status: "ok", version: version + 1 } });

    const after = await storedDocument();

    expect(after["api-keys"]).toEqual(before["api-keys"]);
    expect(after.access).toEqual(before.access);
    expect(after.requests).toEqual(before.requests);
    expect((after.routing as { strategy: string }).strategy).toBe("round-robin");
  });

  it("checks without storing and never echoes a submitted secret", async () => {
    const version = await seed(seeded);
    const { yaml } = await getRaw();
    const typed = "sk-ant-NEW-TYPED-SECRET-5150";
    const edited = yaml.replace('"[redacted#5]…4242"', JSON.stringify(typed));

    expect(edited).toContain(typed);
    const checked = await send("POST", { version, yaml: edited });

    expect(checked.status).toBe(200);
    expectNoSecret(checked.text);
    expect(checked.text).not.toContain(typed);
    expect(checked.body).toMatchObject({ kept_secrets: 4, new_secrets: 1, dropped: [] });
    expect(checked.body.yaml).toContain('"[new secret]…5150"');
    expect(checked.body.yaml).toContain('"[redacted#1]…1313"');
    expect((await controlPlane().getConfig()).version).toBe(version);
  });

  it("reports what a pasted Go config loses and what does nothing on Workers", async () => {
    const { version } = await getRaw();

    const legacy = [
      "host: 0.0.0.0",
      "port: 8317",
      "remote-management:",
      "  allow-remote: true",
      "debug: true",
      "request-retry: 3",
      "claude-api-key:",
      `  - api-key: ${RAW_SECRETS.key}`,
      "    auth_index: deadbeefdeadbeef",
      "",
    ].join("\n");

    const checked = await send("POST", { version, yaml: legacy });

    expect(checked.status).toBe(200);
    expectNoSecret(checked.text);
    expect(checked.body.dropped).toEqual(["host", "port", "remote-management"]);
    expect(checked.body.not_applied).toEqual(["observability.logs.debug"]);
    expect(checked.body.new_secrets).toBe(1);

    const saved = await send("PUT", { version, yaml: legacy });

    expectNoSecret(saved.text);
    expect(saved.status).toBe(200);

    const stored = await storedDocument();

    const claude = (
      stored["api-keys"] as { claude: Array<{ keys: Array<Record<string, unknown>> }> }
    ).claude;

    expect(claude[0]?.keys[0]).toEqual({ "api-key": RAW_SECRETS.key });
    expect(JSON.stringify(stored)).not.toContain("auth_index");
    expect(JSON.stringify(stored)).not.toContain("allow-remote");
  });

  it("reports entries the normaliser drops (a duplicated placeholder)", async () => {
    const version = await seed({
      "api-keys": { gemini: [{ keys: [{ "api-key": "AIzaSy-gemini-SECRET-0001" }] }] },
    });

    const yaml = [
      "api-keys:",
      "  gemini:",
      "    - keys:",
      '        - api-key: "[redacted#1]…0001"',
      '        - api-key: "[redacted#1]"',
      "",
    ].join("\n");

    const checked = await send("POST", { version, yaml });

    expect(checked.status).toBe(200);
    expect(checked.text).not.toContain("SECRET");
    expect(checked.body.dropped).toEqual(["api-keys.gemini[0].keys[1]"]);
    expect(checked.body.kept_secrets).toBe(1);
  });

  it("answers 422 invalid_yaml with line and column, without quoting the source", async () => {
    const { version } = await getRaw();

    for (const [yaml, line] of [
      ["routing:\n  strategy: fill-first\n  strategy: round-robin\n", 3],
      ["access:\n  api-keys:\n    - |SECRET-in-a-block-header\n", 3],
      ["routing: !custom\n  strategy: fill-first\n", 1],
      ["models:\n  catalog: !secret SECRET-tagged\n", 2],
    ] as const) {
      const refused = await send("POST", { version, yaml });

      expect(refused, yaml).toMatchObject({
        status: 422,
        body: {
          error: "invalid_yaml",
          message: expect.any(String),
          line,
          column: expect.any(Number),
        },
      });
      expect(refused.text).not.toContain("SECRET");
    }
  });

  it("expands anchors", async () => {
    const { version } = await getRaw();

    const yaml = [
      "upstream:",
      "  codex:",
      "    model-level-cooling: &on true",
      "  claude:",
      "    model-level-cooling: *on",
      "",
    ].join("\n");

    const checked = await send("POST", { version, yaml });

    expect(checked.status).toBe(200);
    expect(checked.body.yaml).toContain("model-level-cooling: true");
    expect(checked.body.yaml).not.toContain("*on");
  });

  it("answers 422 invalid_config with the path, scrubbed of secrets", async () => {
    const { version } = await getRaw();

    const cases: ReadonlyArray<readonly [string, string]> = [
      ["routing:\n  retry:\n    request-retry: lots\n", "routing.retry.request-retry"],
      [
        `api-keys:\n  claude:\n    - keys:\n        - api-key: sk-ant-ECHO-SECRET-0001\n          weight: { heavy: sk-ant-ECHO-SECRET-0001 }\n`,
        "api-keys.claude[0].keys[0].weight",
      ],
    ];

    for (const [yaml, path] of cases) {
      const refused = await send("PUT", { version, yaml });

      expect(refused, yaml).toMatchObject({
        status: 422,
        body: { error: "invalid_config", path, message: expect.any(String) },
      });
      expect(refused.text).not.toContain("ECHO-SECRET");
    }

    const notMapping = await send("PUT", { version, yaml: "- a\n- b\n" });

    expect(notMapping).toMatchObject({ status: 422, body: { error: "invalid_config" } });
    expect((await getRaw()).version).toBe(version);
  });

  it("refuses placeholders that cannot be restored, with their path", async () => {
    const version = await seed(seeded);
    const { yaml } = await getRaw();

    const cases: ReadonlyArray<readonly [string, string, string]> = [
      [
        yaml.replace("name: main", 'name: "[redacted#5]…4242"'),
        "masked_value_outside_secret_field",
        "api-keys.claude[0].name",
      ],
      [
        yaml.replace('Authorization: "[redacted#4]', '" user-agent": "[redacted#4]'),
        "masked_value_outside_secret_field",
        "api-keys.claude[0].headers. user-agent",
      ],
      [
        yaml.replace('"[redacted#5]…4242"', '"[redacted#9]"'),
        "unknown_secret_reference",
        "api-keys.claude[0].keys[0].api-key",
      ],
      [
        yaml.replace('"[redacted#5]…4242"', '"[redacted]…4242"'),
        "invalid_secret_placeholder",
        "api-keys.claude[0].keys[0].api-key",
      ],
    ];

    for (const [edited, error, path] of cases) {
      expect(edited).not.toBe(yaml);
      const refused = await send("PUT", { version, yaml: edited });

      expect(refused, error).toMatchObject({ status: 422, body: { error, path } });
      expectNoSecret(refused.text);
    }

    expect((await controlPlane().getConfig()).version).toBe(version);
  });

  it("refuses a stale version with 409 and stores nothing, also after an unconditional write", async () => {
    const version = await seed(seeded);
    const { yaml } = await getRaw();

    // curl writes without a version: the raw editor's view is now stale.
    const upstream = await call("/v8/management/config.yaml", {
      method: "PUT",
      headers: { "content-type": "application/yaml" },
      body: "routing:\n  strategy: round-robin\n",
    });

    expect(upstream.status).toBe(200);

    for (const method of ["POST", "PUT"] as const) {
      const stale = await send(method, { version, yaml });

      expect(stale).toMatchObject({ status: 409, body: { error: "conflict" } });
    }

    expect((await controlPlane().getConfig()).version).toBe(version + 1);
  });

  it("refuses bodies without a version, non-JSON bodies and bodies above 512 KiB", async () => {
    expect(await send("PUT", { yaml: "" })).toMatchObject({
      status: 400,
      body: { error: "invalid body" },
    });
    expect(await send("POST", { version: -1, yaml: "" })).toMatchObject({ status: 400 });
    expect(await send("PUT", { version: 0 })).toMatchObject({ status: 400 });

    const big = await send("PUT", { version: 0, yaml: `# ${"x".repeat(512 * 1024)}\n` });

    expect(big).toMatchObject({ status: 413, body: { error: "body_too_large" } });
  });

  it("does not let a config-only service token remove its own access", async () => {
    const own = makeHarness();
    const SERVICE = "svc-client.access";

    try {
      const version = await seed({ access: { "admin-service-tokens": [SERVICE, "other.access"] } });
      const auth = await serviceToken(SERVICE);
      const yaml = "access:\n  admin-service-tokens:\n    - other.access\n";

      for (const [method, path] of [
        ["POST", `${RAW}/check`],
        ["PUT", RAW],
      ] as const) {
        const response = await own.call(path, { ...jsonInit(method, { version, yaml }), auth });

        expect(response.status).toBe(422);
        expect(await response.json()).toMatchObject({
          error: "would_remove_your_admin_access",
          path: "access.admin-service-tokens",
        });
      }

      expect((await controlPlane().getConfig()).version).toBe(version);
    } finally {
      await own.dispose();
    }
  });

  it("keeps a secret masked behind a padded exempt header name (` token_type`)", async () => {
    const version = await seed(seeded);
    const { yaml } = await getRaw();

    const edited = yaml.replace(
      'Authorization: "[redacted#4]…7777"',
      '" token_type": "[redacted#5]…4242"',
    );

    expect(edited).not.toBe(yaml);
    const checked = await send("POST", { version, yaml: edited });

    expect(checked.status).toBe(200);
    expectNoSecret(checked.text);
    expect(checked.body.yaml).toContain('token_type: "[redacted#5]…4242"');

    const saved = await send("PUT", { version, yaml: edited });

    expect(saved.status).toBe(200);
    expectNoSecret(saved.text);

    const after = await getRaw();

    expect(after.yaml).toContain('token_type: "[redacted#');
  });

  it("refuses a $-secret moved into a header", async () => {
    const version = await seed({
      access: { "api-keys": ["$ecret-client-SECRET-0001"] },
      "api-keys": {
        claude: [
          { headers: { "X-Org": "org-SECRET-0002" }, keys: [{ "api-key": "k-SECRET-0003" }] },
        ],
      },
    });

    const { yaml } = await getRaw();
    const edited = yaml.replace('"[redacted#2]…0002"', '"[redacted#1]…0001"');

    expect(edited).not.toBe(yaml);
    const refused = await send("PUT", { version, yaml: edited });

    expect(refused).toMatchObject({
      status: 422,
      body: {
        error: "masked_value_outside_secret_field",
        path: "api-keys.claude[0].headers.X-Org",
      },
    });
    expect(refused.text).not.toContain("SECRET");
  });

  it("refuses placeholders copied by an alias, and does not merge with << (even under %YAML 1.1)", async () => {
    const version = await seed(seeded);

    const alias = [
      "api-keys:",
      "  claude:",
      "    - name: *k",
      "      keys:",
      '        - api-key: &k "[redacted#5]…4242"',
      "",
    ].join("\n");

    // An alias before its anchor is a YAML error; anchor first:
    const anchored = [
      "api-keys:",
      "  claude:",
      "    - keys:",
      '        - api-key: &k "[redacted#5]…4242"',
      "      name: *k",
      "",
    ].join("\n");

    const aliasRefused = await send("PUT", { version, yaml: alias });

    expect(aliasRefused.status).toBe(422);
    expectNoSecret(aliasRefused.text);
    expect(await send("PUT", { version, yaml: anchored })).toMatchObject({
      status: 422,
      body: { error: "masked_value_outside_secret_field", path: "api-keys.claude[0].name" },
    });

    const merge = [
      "%YAML 1.1",
      "---",
      "api-keys:",
      "  claude:",
      "    - headers: &h",
      '        Authorization: "[redacted#4]…7777"',
      "      keys:",
      '        - api-key: "[redacted#5]…4242"',
      "    - base-url: https://evil.test",
      "      headers:",
      "        <<: *h",
      "      keys:",
      "        - api-key: typed-new-key",
      "",
    ].join("\n");

    const merged = await send("POST", { version, yaml: merge });

    expect(merged).toMatchObject({
      status: 422,
      body: { error: "invalid_yaml", line: 1, column: 1, message: "only YAML 1.2 is supported" },
    });

    // Without the directive, a plain `<<` key is refused where it is.
    const plain = await send("POST", { version, yaml: merge.split("\n").slice(2).join("\n") });

    expect(plain).toMatchObject({
      status: 422,
      body: { error: "invalid_yaml", line: 9, column: 9 },
    });
    expectNoSecret(merged.text);
    expect((await controlPlane().getConfig()).version).toBe(version);
  });

  it("answers the same review for a right and a wrong guess of a stored secret", async () => {
    const version = await seed(seeded);
    const { yaml } = await getRaw();

    const guess = async (value: string) => {
      const edited = yaml.replace(
        '        - api-key: "[redacted#5]…4242"',
        `        - api-key: "[redacted#5]…4242"\n        - api-key: ${JSON.stringify(value)}`,
      );

      expect(edited).not.toBe(yaml);
      const checked = await send("POST", { version, yaml: edited });

      expect(checked.status).toBe(200);

      return checked.body;
    };

    const right = await guess(RAW_SECRETS.key);
    const wrong = await guess(`X${RAW_SECRETS.key.slice(1)}`);

    expect(right).toEqual(wrong);
    expect(right).toMatchObject({ kept_secrets: 5, new_secrets: 1 });
  });

  it("refuses tags that would resolve to merges or non-JSON values", async () => {
    const version = await seed(seeded);

    for (const yaml of [
      'routing: &a\n  strategy: fill-first\nupstream:\n  !!merge "<<": *a\n',
      "models:\n  catalog: !!binary aGVsbG8=\n",
      "models:\n  catalog: !!timestamp 2001-12-14\n",
      "access:\n  admin-emails: !!set {a@example.com}\n",
      "access:\n  admin-emails: !!omap [{a: 1}]\n",
      "access:\n  admin-emails: !!pairs [{a: 1}]\n",
    ]) {
      expect(await send("POST", { version, yaml }), yaml).toMatchObject({
        status: 422,
        body: { error: "invalid_yaml", message: "custom tags are not supported" },
      });
    }
  });

  it("answers the same whether a typed string contains a stored secret or not (no fail-safe oracle)", async () => {
    const version = await seed(seeded);
    const { yaml } = await getRaw();

    const probe = async (text: string) => {
      const edited = yaml.replace("name: main", `name: ${JSON.stringify(text)}`);

      expect(edited).not.toBe(yaml);
      const checked = await send("POST", { version, yaml: edited });

      const body = { ...checked.body };

      if (typeof body.yaml === "string")
        body.yaml = body.yaml
          .replace(`name: ${JSON.stringify(text)}\n`, "name: TYPED\n")
          .replace(`name: ${text}\n`, "name: TYPED\n");

      return { status: checked.status, body };
    };

    for (const [right, wrong] of [
      [RAW_SECRETS.key, `X${RAW_SECRETS.key.slice(1)}`],
      [`words ${RAW_SECRETS.key.slice(3, 9)} words`, "words zzzzzz words"],
      [RAW_SECRETS.key.slice(-4), "9999"],
    ] as const) {
      const a = await probe(right);
      const b = await probe(wrong);

      expect(a.status).toBe(200);
      expect(a).toEqual(b);
    }
  });

  it("accepts a new value that contains a short stored secret (no false refusal)", async () => {
    const version = await seed({
      "api-keys": { claude: [{ name: "main", keys: [{ "api-key": "test" }] }] },
    });

    const { yaml } = await getRaw();

    expect(
      await send("PUT", { version, yaml: yaml.replace("name: main", "name: test-x") }),
    ).toMatchObject({
      status: 200,
      body: { version: version + 1 },
    });
  });

  it("reviews raw payload rules and dca: Meta keys like the stored decode", async () => {
    const version = await seed({
      access: { "api-keys": ["dca:client-SECRET-0002"] },
      requests: {
        payload: {
          "override-raw": [{ params: { "metadata.api_key": '"raw-SECRET-0001"' } }],
        },
      },
    });

    const { yaml, secrets } = await getRaw();

    expect(secrets).toBe(2);
    const unchanged = await send("POST", { version, yaml });

    expect(unchanged.status).toBe(200);
    expectNoSecret(unchanged.text);
    expect(unchanged.body).toMatchObject({ dropped: [], kept_secrets: 2, new_secrets: 0 });

    const meta = `${yaml}api-keys:\n  meta:\n    - keys:\n        - api-key: "[redacted#1]"\n`;
    const checked = await send("POST", { version, yaml: meta });

    expect(checked.status).toBe(200);
    expectNoSecret(checked.text);
    expect(checked.body).toMatchObject({ kept_secrets: 2, moved_secrets: [] });
    expect(checked.body.dropped).toEqual([expect.stringMatching(/^api-keys\.meta/)]);
  });

  it("masks a raw payload parameter whose JSON names a secret key, and restores it", async () => {
    const extra = JSON.stringify({ metadata: { api_key: "sk-raw-json-SECRET-5150" } });

    const version = await seed({
      requests: {
        payload: {
          "override-raw": [
            {
              models: [{ name: "gpt-*" }],
              params: { extra_body: extra, plain: '{"temperature":0}' },
            },
          ],
        },
      },
    });

    const { yaml, secrets } = await getRaw();

    // The secret-looking JSON is one secret; JSON without such a key is shown.
    expect(secrets).toBe(1);
    expect(yaml).toContain('extra_body: "[redacted#1]…');
    expect(yaml).toContain("temperature");

    const unchanged = await send("POST", { version, yaml });

    expect(unchanged.status).toBe(200);
    expectNoSecret(unchanged.text);
    expect(unchanged.body).toMatchObject({ dropped: [], kept_secrets: 1, new_secrets: 0 });

    // Saved through its placeholder, the stored text is unchanged.
    const saved = await send("PUT", {
      version,
      yaml: `${yaml}routing:\n  strategy: round-robin\n`,
    });

    expect(saved.status).toBe(200);
    expectNoSecret(saved.text);

    const document = JSON.parse((await controlPlane().getConfig()).document ?? "{}") as {
      requests: { payload: { "override-raw": Array<{ params: Record<string, string> }> } };
    };

    expect(document.requests.payload["override-raw"][0]!.params["extra_body"]).toBe(extra);

    // Its placeholder cannot move to a field that shows its value.
    const { yaml: next, version: current } = await getRaw();
    const placeholder = "[redacted#1]";

    const moved = await send("POST", {
      version: current,
      yaml: `${next}oauth:\n  model-alias:\n    claude:\n      - name: "${placeholder}"\n        alias: x\n`,
    });

    expect(moved).toMatchObject({
      status: 422,
      body: {
        error: "masked_value_outside_secret_field",
        path: "oauth.model-alias.claude[0].name",
      },
    });
    expectNoSecret(moved.text);
  });

  it("answers a guess of a stored secret the same whether it is right or not (check and save)", async () => {
    const version = await seed(seeded);
    // Same length and alphabet as the stored client key.
    const wrong = RAW_SECRETS.client.replace("SECRET", "GUESSX");

    expect(wrong.length).toBe(RAW_SECRETS.client.length);

    for (const yaml of [
      (guess: string) => `multimedia:\n  disable-image-generation: ${guess}\n`,
      (guess: string) => `access:\n  api-keys: [${guess}\n`,
      (guess: string) => `access:\n  api-keys: ["${guess}\\q"]\n`,
    ])
      for (const method of ["POST", "PUT"] as const) {
        const right = await send(method, { version, yaml: yaml(RAW_SECRETS.client) });
        const other = await send(method, { version, yaml: yaml(wrong) });

        expect(right.status).toBe(422);
        expectNoSecret(right.text);
        expect(right.text).toBe(other.text);
      }

    // The guess as a key (named as written, never scrubbed: a scrubbed echo would differ) and as an alias name.
    for (const yaml of [
      (guess: string) => `api-keys:\n  ${guess}: []\n`,
      (guess: string) => `api-keys:\n  claude:\n    - ${guess}: 1\n      keys: []\n`,
      (guess: string) =>
        `api-keys:\n  claude:\n    - keys: []\n      headers:\n        ${guess}: [1]\n`,
      (guess: string) => `a: *${guess}\n`,
    ])
      for (const method of ["POST", "PUT"] as const) {
        const right = await send(method, { version, yaml: yaml(RAW_SECRETS.client) });
        const other = await send(method, { version, yaml: yaml(wrong) });

        expect(right.status).toBe(422);
        expect(right.text.replaceAll(RAW_SECRETS.client, wrong)).toBe(other.text);
      }
  });

  it("flags a kept secret moved to another path on the same host", async () => {
    const version = await seed(seeded);
    const { yaml } = await getRaw();

    const shared = yaml.replace(
      "base-url: https://api.anthropic.com",
      "base-url: https://api.anthropic.com/v1/other-account",
    );

    expect(shared).not.toBe(yaml);
    const moved = await send("POST", { version, yaml: shared });
    const place = { family: "claude", host: "api.anthropic.com" };

    expectNoSecret(moved.text);
    expect(moved.body.moved_secrets).toEqual([
      {
        path: "api-keys.claude[0].headers.Authorization",
        placeholder: expect.stringMatching(/^\[redacted#\d+\]/),
        from: place,
        to: place,
      },
      {
        path: "api-keys.claude[0].keys[0].api-key",
        placeholder: expect.stringMatching(/^\[redacted#\d+\]/),
        from: place,
        to: place,
      },
    ]);

    const slash = yaml.replace(
      "base-url: https://api.anthropic.com",
      "base-url: https://API.anthropic.com/",
    );

    expect((await send("POST", { version, yaml: slash })).body.moved_secrets).toEqual([]);
  });

  it("reports kept keys the normaliser deduplicates once an edit makes their identities equal", async () => {
    const key = "AIzaSy-shared-SECRET-0001";

    const version = await seed({
      "api-keys": {
        gemini: [
          { prefix: "a", keys: [{ "api-key": key }] },
          { prefix: "b", keys: [{ "api-key": key }] },
        ],
      },
    });

    const { yaml } = await getRaw();

    expect(await send("POST", { version, yaml })).toMatchObject({
      status: 200,
      body: { dropped: [] },
    });

    const same = yaml.replace("prefix: b", "prefix: a");

    expect(same).not.toBe(yaml);
    const checked = await send("POST", { version, yaml: same });

    expect(checked).toMatchObject({ status: 200, body: { dropped: ["api-keys.gemini[1]"] } });
    expect(checked.text).not.toContain("SECRET");
  });

  it("reports kept secrets moved to another family or upstream host", async () => {
    const version = await seed(seeded);
    const { yaml } = await getRaw();

    const edited = `${yaml}  codex:\n    - base-url: https://user:pass-SECRET@evil.test/v1/tenant-42?key=q-SECRET\n      keys:\n        - api-key: "[redacted#5]"\n`;

    const placeholder = /- api-key: "?(\[redacted#5\][^"\n]*)/.exec(yaml)?.[1];

    const moved = {
      path: "api-keys.codex[0].keys[0].api-key",
      placeholder,
      from: { family: "claude", host: "api.anthropic.com" },
      // The host only: user info, path and query of the URL never leave the server here.
      to: { family: "codex", host: "evil.test" },
    };

    expect(placeholder).toMatch(/^\[redacted#5\]/);
    const checked = await send("POST", { version, yaml: edited });

    expect(checked).toMatchObject({ status: 200, body: { moved_secrets: [moved] } });
    expectNoSecret(checked.text);
    // The masked YAML shows the edited URL's path; the moved list carries the host only.
    expect(JSON.stringify(checked.body.moved_secrets)).not.toMatch(/tenant-42|user|key=/);

    const saved = await send("PUT", { version, yaml: edited });

    expect(saved).toMatchObject({
      status: 200,
      body: { version: version + 1, moved_secrets: [moved] },
    });
    expectNoSecret(saved.text);
    expect(
      (await send("POST", { version: version + 1, yaml: (await getRaw()).yaml })).body
        .moved_secrets,
    ).toEqual([]);
  });

  it("refuses a chunked body above 512 KiB while reading it", async () => {
    const chunk = new TextEncoder().encode("x".repeat(64 * 1024));
    let pulled = 0;

    const body = new ReadableStream<Uint8Array>({
      pull: (controller) => {
        pulled++;

        if (pulled > 64) controller.close();
        else controller.enqueue(chunk);
      },
    });

    const response = await call(RAW, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body,
      // SAFETY: a streaming request body needs `duplex` (not in the RequestInit typings used here).
      ...({ duplex: "half" } as RequestInit),
    });

    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: "body_too_large" });
    expect(pulled).toBeLessThan(20);
  });

  it("never shows a stored secret, whatever placeholder moves where", async () => {
    const SECRET_DOC = {
      models: {
        catalog: "https://cdn.test/models.json?v=1&token=cat-SECRET-01#sig=frag-SECRET-02",
      },
      access: { "api-keys": ["client-SECRET-03", "$dollar-SECRET-04"] },
      requests: {
        "proxy-url": "http://user:proxy-SECRET-05@proxy.test:8080",
        payload: {
          default: [
            {
              models: [
                { name: "gpt-*", headers: { "X-Match": "pattern-SECRET-06*", Accept: "json" } },
              ],
              params: { "metadata.api_key": "param-SECRET-07", temperature: 0 },
            },
          ],
        },
      },
      "api-keys": {
        claude: [
          {
            name: "main",
            prefix: "team",
            "base-url":
              "https://base-user:base-SECRET-08@api.anthropic.test/v1?key=query-SECRET-09",
            "proxy-url": "socks5://gp:group-proxy-SECRET-10@proxy.test:1080",
            headers: {
              "X-Custom": "custom-SECRET-11",
              "User-Agent": "agent",
              "X-Copy": "$Authorization",
            },
            keys: [{ "api-key": "key-SECRET-12", headers: { token_type: "tt-SECRET-13" } }],
          },
        ],
        "openai-compatibility": [
          {
            name: "compat",
            "base-url": "https://compat.test/v1",
            keys: [{ "api-key": "compat-SECRET-14" }],
          },
        ],
      },
    };

    const leakFree = (text: string, what: string) => {
      expect(text, what).not.toContain("SECRET");
      expect(text, what).not.toMatch(/t[0-9a-f]{32}k\d+k/);
    };

    let version = await seed(SECRET_DOC);
    const masked = parseYaml((await getRaw()).yaml) as Record<string, Json>;
    const placeholders: string[] = [];
    const leaves: Array<Array<string | number>> = [];

    const walk = (value: Json, path: Array<string | number>) => {
      if (typeof value === "string") {
        leaves.push(path);

        for (const match of value.matchAll(/\[redacted#\d+\]/g)) placeholders.push(match[0]);
      } else if (Array.isArray(value)) value.forEach((item, index) => walk(item, [...path, index]));
      else if (value !== null && typeof value === "object")
        for (const [key, child] of Object.entries(value)) walk(child, [...path, key]);
    };

    walk(masked, []);
    expect(placeholders.length).toBe(14);

    const setAt = (document: Json, path: ReadonlyArray<string | number>, text: string) => {
      const parent = path.slice(0, -1).reduce<Json>(
        // SAFETY: the paths come from walking this very document.
        (node, segment) => (node as Record<string | number, Json>)[segment] as Json,
        document,
      );

      // SAFETY: as above.
      (parent as Record<string | number, Json>)[path.at(-1) as string | number] = text;
    };

    const edits: string[] = [];

    for (const placeholder of placeholders)
      for (const leaf of leaves) {
        const document = structuredClone(masked);

        setAt(document, leaf, placeholder);
        edits.push(JSON.stringify(document));
      }

    // Header renames: padded, exempt and plain names over every header map.
    for (const name of [" token_type", "User-Agent", " accept ", "X-New", "authorization "]) {
      const document = structuredClone(masked) as Record<string, Json>;

      const claude = (document["api-keys"] as Record<string, Json[]>).claude?.[0] as Record<
        string,
        Json
      >;

      const headers = claude.headers as Record<string, string>;

      headers[name] = headers["X-Custom"] ?? "";
      delete headers["X-Custom"];
      edits.push(JSON.stringify(document));
    }

    let accepted = 0;

    for (const yaml of edits) {
      const checked = await send("POST", { version, yaml });

      leakFree(checked.text, `check ${yaml}`);

      if (checked.status !== 200) continue;
      accepted++;
      const saved = await send("PUT", { version, yaml });

      leakFree(saved.text, `save ${yaml}`);
      expect(saved.status).toBe(200);

      const raw = await call(RAW);

      leakFree(await raw.text(), `get after ${yaml}`);

      // Back to the seeded document for the next edit.
      const reset = await controlPlane().putConfig(JSON.stringify(SECRET_DOC));

      if (!reset.ok) throw new Error(reset.message);
      version = reset.version;
    }

    // Many edits are accepted (a placeholder over another secret, unchanged positions), many refused.
    expect(accepted).toBeGreaterThan(50);
    expect(accepted).toBeLessThan(edits.length);
  });

  it("does not let a config-only admin remove their own access", async () => {
    const own = makeHarness();
    const CONFIG_ADMIN = "cfg@example.com";

    try {
      const version = await seed({
        access: { "admin-emails": [CONFIG_ADMIN, "other@example.com"] },
      });

      const as = async (email: string, method: string, path: string, body: Json) => {
        const response = await own.call(path, {
          ...jsonInit(method, body),
          auth: await token(email),
        });

        return { status: response.status, body: (await response.json()) as unknown };
      };

      const yaml = "access:\n  admin-emails:\n    - other@example.com\n";

      for (const [method, path] of [
        ["POST", `${RAW}/check`],
        ["PUT", RAW],
      ] as const) {
        expect(await as(CONFIG_ADMIN, method, path, { version, yaml })).toMatchObject({
          status: 422,
          body: { error: "would_remove_your_admin_access", path: "access.admin-emails" },
        });
      }

      expect(await as(ADMIN, "PUT", RAW, { version, yaml })).toMatchObject({
        status: 200,
        body: { version: version + 1 },
      });
    } finally {
      await own.dispose();
    }
  });
});
