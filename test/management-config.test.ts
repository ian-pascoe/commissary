// /v8/management/config, /config.yaml and /config/*path through the router, Access gate and real ControlPlane.
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Json } from "../src/json/index.ts";
import { authIndexOf } from "../src/management/auth-index.ts";
import {
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

describe("management config", () => {
  it("requires an Access admin", async () => {
    expect((await call("/v8/management/config", { auth: false })).status).toBe(401);
    expect(
      (await call("/v8/management/config", { auth: await token("other@example.com") })).status,
    ).toBe(403);
    expect((await call("/v8/management/config.yaml", { auth: false })).status).toBe(401);
    expect((await call("/v8/management/config/routing/strategy", { auth: false })).status).toBe(
      401,
    );
  });

  it("serves the whole document with the management headers and no-store", async () => {
    const response = await json("/v8/management/config");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-cpa-version")).toBeTruthy();
    expect(response.headers.get("x-cpa-support-plugin")).toBe("false");
    expect(response.body).toMatchObject({
      "config-version": 8,
      routing: { strategy: "round-robin" },
    });
  });

  it("replaces the config from YAML and exports sparse YAML", async () => {
    const put = await json("/v8/management/config.yaml", {
      method: "PUT",
      headers: { "content-type": "application/yaml" },
      body: "routing:\n  strategy: fill-first\n",
    });

    expect(put).toMatchObject({ status: 200, body: { status: "ok", "config-version": 8 } });
    expect((await json("/v8/management/config/routing/strategy")).body).toBe("fill-first");

    const yaml = await call("/v8/management/config.yaml");
    expect(yaml.headers.get("content-type")).toBe("application/yaml; charset=utf-8");
    const text = new TextDecoder().decode(await yaml.arrayBuffer());
    expect(text).toContain("strategy: fill-first");
    expect(text).not.toContain("passthrough-headers");
  });

  it("replaces the config from a JSON object and rejects other bodies", async () => {
    const put = await json(
      "/v8/management/config",
      jsonInit("PUT", { routing: { strategy: "fill-first" } }),
    );

    expect(put.status).toBe(200);
    expect((await json("/v8/management/config/routing/strategy")).body).toBe("fill-first");

    expect((await json("/v8/management/config", jsonInit("PUT", ["x"]))).body).toEqual({
      error: "config_must_be_object",
    });

    const invalidJson = await json("/v8/management/config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: "{nope",
    });

    expect(invalidJson).toMatchObject({ status: 400, body: { error: "invalid_json" } });
    const bad = await json("/v8/management/config", jsonInit("PUT", { routing: "not-an-object" }));
    expect(bad.status).toBe(422);
    expect(bad.body).toMatchObject({ error: "invalid_config" });

    const badYaml = await json("/v8/management/config.yaml", {
      method: "PUT",
      headers: { "content-type": "application/yaml" },
      body: "routing: [",
    });

    expect(badYaml.status).toBe(422);
    // A rejected write leaves the stored config untouched.
    expect((await json("/v8/management/config/routing/strategy")).body).toBe("fill-first");
  });

  it("deep-merges PATCH /config and replaces lists", async () => {
    await json(
      "/v8/management/config",
      jsonInit("PUT", { routing: { strategy: "fill-first" }, access: { "api-keys": ["a"] } }),
    );

    const patch = await json(
      "/v8/management/config",
      jsonInit("PATCH", {
        routing: { "session-affinity": true },
        access: { "api-keys": ["b", "c"] },
      }),
    );

    expect(patch.status).toBe(200);

    const config = (await json("/v8/management/config")).body as {
      routing: { strategy: string; "session-affinity": boolean };
      access: { "api-keys": string[] };
    };

    expect(config.routing.strategy).toBe("fill-first");
    expect(config.routing["session-affinity"]).toBe(true);
    expect(config.access["api-keys"]).toEqual(["b", "c"]);
  });

  it("reads, writes, patches and deletes nested paths", async () => {
    expect((await json("/v8/management/config/routing/retry/request-retry")).status).toBe(200);
    expect(
      (await json("/v8/management/config/routing/retry/request-retry", jsonInit("PUT", 5))).status,
    ).toBe(200);
    expect((await json("/v8/management/config/routing/retry/request-retry")).body).toBe(5);
    expect(
      (
        await json(
          "/v8/management/config/routing/retry",
          jsonInit("PATCH", { "max-retry-interval": 20 }),
        )
      ).status,
    ).toBe(200);

    const retry = (await json("/v8/management/config/routing/retry")).body as Record<
      string,
      unknown
    >;

    expect(retry).toMatchObject({ "request-retry": 5, "max-retry-interval": 20 });

    // DELETE removes the key; the default shows again.
    expect(
      (await json("/v8/management/config/routing/retry/request-retry", { method: "DELETE" }))
        .status,
    ).toBe(200);
    expect((await json("/v8/management/config/routing/retry/request-retry")).body).not.toBe(5);

    expect(await json("/v8/management/config/nope/missing")).toMatchObject({
      status: 404,
      body: { error: "not_found" },
    });
    expect(await json("/v8/management/config/nope/missing", { method: "DELETE" })).toMatchObject({
      status: 404,
      body: { error: "not_found" },
    });
    expect(await json("/v8/management/config", { method: "DELETE" })).toMatchObject({
      status: 400,
      body: { error: "cannot_delete_config" },
    });
    // Writing below a scalar is an invalid path; invalid values are rejected by validation.
    expect(
      await json("/v8/management/config/routing/strategy/x", jsonInit("PUT", 1)),
    ).toMatchObject({
      status: 400,
      body: { error: "invalid_path" },
    });
    expect((await json("/v8/management/config/routing", jsonInit("PUT", "x"))).status).toBe(422);
    expect((await json("/v8/management/config/a//b")).body).toEqual({ error: "invalid_path" });
  });

  it("answers percent-encoded path segments", async () => {
    await json(
      "/v8/management/config/oauth/model-alias",
      jsonInit("PUT", { claude: [{ name: "claude-opus-4", alias: "opus" }] }),
    );
    const value = await json("/v8/management/config/oauth/model-alias/cl%61ude");
    expect(value.body).toEqual([{ name: "claude-opus-4", alias: "opus" }]);
  });

  it("adds auth_index to api-key entries and never stores it", async () => {
    const put = await json(
      "/v8/management/config",
      jsonInit("PUT", {
        "api-keys": {
          claude: [
            {
              "base-url": "https://api.anthropic.com",
              keys: [{ "api-key": "sk-ant-one" }, { "api-key": "sk-ant-two" }],
            },
          ],
          "openai-compatibility": [
            {
              name: "Router",
              "base-url": "https://router.example/v1",
              keys: [{ "api-key": "k1" }, { "api-key": "k2" }],
            },
            { name: "Keyless", "base-url": "https://free.example/v1", keys: [] },
          ],
        },
      }),
    );

    expect(put.status).toBe(200);

    const config = (await json("/v8/management/config")).body as {
      "api-keys": {
        claude: Array<{ keys: Array<{ auth_index?: string }> }>;
        "openai-compatibility": Array<{
          auth_index?: string;
          keys: Array<{ auth_index?: string }>;
        }>;
      };
    };

    const indexes = [
      ...config["api-keys"].claude[0]!.keys.map((entry) => entry.auth_index),
      ...config["api-keys"]["openai-compatibility"][0]!.keys.map((entry) => entry.auth_index),
      config["api-keys"]["openai-compatibility"][1]!.auth_index,
    ];

    for (const index of indexes) expect(index).toMatch(/^[0-9a-f]{16}$/);
    expect(new Set(indexes).size).toBe(5);

    // The same handles address the credentials: cooldown reset knows them.
    const reset = await json(
      "/v8/management/routing/cooldown/reset",
      jsonInit("POST", { auth_index: indexes[0] ?? "" }),
    );

    expect(reset.body).toMatchObject({ status: "ok", auth_index: indexes[0] ?? "" });

    // Writing the document back (with auth_index) does not persist the derived field.
    expect((await json("/v8/management/config", jsonInit("PUT", config))).status).toBe(200);

    const stored = JSON.parse((await controlPlane().getConfig()).document ?? "{}") as {
      "api-keys": unknown;
    };

    expect(JSON.stringify(stored["api-keys"])).not.toContain("auth_index");

    const exported = new TextDecoder().decode(
      await (await call("/v8/management/config.yaml")).arrayBuffer(),
    );

    expect(exported).not.toContain("auth_index");
  });

  describe("ETag and If-Match", () => {
    const ALIASES = "/v8/management/config/oauth/model-alias/claude";
    const alias = [{ name: "claude-opus-4", alias: "opus" }];

    const version = async (): Promise<number> => (await controlPlane().getConfig()).version;

    const ifMatch = (value: string, method: string, body?: Json): RequestInit => ({
      method,
      headers: { "content-type": "application/json", "if-match": value },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    it("answers the config version as a strong ETag on every GET", async () => {
      await json(ALIASES, jsonInit("PUT", alias));
      const current = await version();

      expect(current).toBeGreaterThan(0);
      expect((await call("/v8/management/config")).headers.get("etag")).toBe(`"${current}"`);
      expect((await call(ALIASES)).headers.get("etag")).toBe(`"${current}"`);
      expect((await call("/v8/management/config.yaml")).headers.get("etag")).toBe(`"${current}"`);
    });

    it("every ok reply carries the stored version, with or without If-Match", async () => {
      const plain = await json(ALIASES, jsonInit("PUT", alias));

      expect(plain).toMatchObject({
        status: 200,
        body: { status: "ok", "config-version": 8, version: await version() },
      });

      const matched = await json(ALIASES, ifMatch(`"${await version()}"`, "PUT", []));

      expect(matched).toMatchObject({
        status: 200,
        body: { status: "ok", version: await version() },
      });
    });

    it("PUT with the current version stores the edit, in quoted, weak and bare forms", async () => {
      for (const format of [(n: number) => `"${n}"`, (n: number) => `W/"${n}"`, String]) {
        const before = await version();
        const response = await json(ALIASES, ifMatch(format(before), "PUT", alias));

        expect(response).toMatchObject({ status: 200, body: { version: before + 1 } });
      }

      expect((await json(ALIASES)).body).toEqual(alias);
    });

    it("a stale PUT answers 409 conflict and leaves the document unchanged", async () => {
      await json(ALIASES, jsonInit("PUT", alias));
      const stale = await version();
      await json(ALIASES, jsonInit("PUT", [{ name: "claude-opus-4", alias: "o4" }]));
      const current = await version();

      const response = await json(
        ALIASES,
        ifMatch(`"${stale}"`, "PUT", [{ name: "claude-opus-4", alias: "lost" }]),
      );

      expect(response).toMatchObject({ status: 409, body: { error: "conflict" } });
      // One attempt only: nothing was retried against the newer version.
      expect(await version()).toBe(current);
      expect((await json(ALIASES)).body).toEqual([{ name: "claude-opus-4", alias: "o4" }]);
    });

    it("PATCH and DELETE honour If-Match; a stale DELETE is 409, not 404", async () => {
      await json(ALIASES, jsonInit("PUT", alias));
      const stale = await version();
      await json("/v8/management/config/routing/strategy", jsonInit("PUT", "fill-first"));

      expect((await json(ALIASES, ifMatch(`"${stale}"`, "DELETE"))).body).toMatchObject({
        error: "conflict",
      });
      expect(
        (await json("/v8/management/config/routing", ifMatch(`"${stale}"`, "PATCH", {}))).status,
      ).toBe(409);
      expect((await json(ALIASES)).body).toEqual(alias);

      const deleted = await json(ALIASES, ifMatch(`"${await version()}"`, "DELETE"));

      expect(deleted).toMatchObject({
        status: 200,
        body: { status: "ok", version: await version() },
      });
      // A current version with a missing key keeps the ordinary 404.
      expect(await json(ALIASES, ifMatch(`"${await version()}"`, "DELETE"))).toMatchObject({
        status: 404,
        body: { error: "not_found" },
      });
    });

    it("whole-document writes honour If-Match too", async () => {
      await json("/v8/management/config", jsonInit("PUT", { routing: { strategy: "fill-first" } }));
      const stale = await version();
      await json(ALIASES, jsonInit("PUT", alias));

      const jsonPut = await json(
        "/v8/management/config",
        ifMatch(`"${stale}"`, "PUT", { routing: { strategy: "round-robin" } }),
      );

      expect(jsonPut).toMatchObject({ status: 409, body: { error: "conflict" } });

      const yamlPut = await json("/v8/management/config.yaml", {
        method: "PUT",
        headers: { "content-type": "application/yaml", "if-match": `"${stale}"` },
        body: "routing:\n  strategy: round-robin\n",
      });

      expect(yamlPut).toMatchObject({ status: 409, body: { error: "conflict" } });
      expect((await json("/v8/management/config/routing/strategy")).body).toBe("fill-first");
    });

    it("a malformed If-Match is 400 and stores nothing; * is unconditional", async () => {
      const before = await version();

      for (const value of ["abc", '"1', "-1", "1.5", '"1", "2"']) {
        expect(await json(ALIASES, ifMatch(value, "PUT", alias)), value).toMatchObject({
          status: 400,
          body: { error: "invalid_if_match" },
        });
      }

      expect(await version()).toBe(before);
      expect((await json(ALIASES, ifMatch("*", "PUT", alias))).status).toBe(200);
    });

    it("without If-Match writes keep the unconditional behaviour", async () => {
      await json(ALIASES, jsonInit("PUT", alias));
      await json("/v8/management/config/routing/strategy", jsonInit("PUT", "fill-first"));
      expect((await json(ALIASES, jsonInit("PUT", []))).status).toBe(200);
    });
  });

  it("derives auth_index from the credential id", () => {
    expect(authIndexOf("claude-a.json")).toMatch(/^[0-9a-f]{16}$/);
    expect(authIndexOf("claude-a.json")).not.toBe(authIndexOf("claude-b.json"));
  });
});
