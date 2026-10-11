// /v8/management/settings through the router, Access gate and real ControlPlane: the Settings page's view and writes.
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Json } from "../src/json/index.ts";
import type { SettingsView } from "../src/management/contract/settings.ts";
import {
  ADMIN,
  controlPlane,
  jsonInit,
  makeHarness,
  resetControlPlane,
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
      { models: { catalog: "embed", "codex-catalog": "https://example.test/codex.json" } },
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

      // A deployment admin may remove anyone.
      const removed = await as(ADMIN, { access: { "admin-emails": null } }, version + 1);

      expect(removed).toMatchObject({ status: 200, body: { version: version + 2 } });
    } finally {
      await own.dispose();
    }
  });
});
