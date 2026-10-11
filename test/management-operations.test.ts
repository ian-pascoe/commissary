// Latest-version, model definitions, log stubs, the removed api-call route and the legacy panel redirect.
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { jsonInit, makeHarness, resetControlPlane, token } from "./support/management.ts";

let release: () => { status?: number; body?: unknown; transportError?: boolean } = () => ({
  body: { tag_name: "v8.1.0" },
});

const harness = makeHarness((request) => {
  if (request.url.startsWith("https://api.github.com/")) return release();

  return { status: 201, body: { method: request.method, url: request.url } };
});

afterAll(harness.dispose);

beforeEach(async () => {
  release = () => ({ body: { tag_name: "v8.1.0" } });
  harness.requests.length = 0;
  await resetControlPlane();
});

const { call, json } = harness;

describe("api-call", () => {
  // Go's token-substituting upstream probe served only the upstream panel; quota and key checks run server-side.
  it("is not ported: 404 for administrators, still behind the admin gate", async () => {
    const body = {
      method: "GET",
      url: "https://api.example.com/q",
      header: { Authorization: "Bearer $TOKEN$" },
    };

    const admin = await call("/v8/management/requests/api-call", jsonInit("POST", body));

    expect(admin.status).toBe(404);
    expect(
      (await call("/v8/management/requests/api-call", { ...jsonInit("POST", body), auth: false }))
        .status,
    ).toBe(401);
    expect(
      (
        await call("/v8/management/requests/api-call", {
          ...jsonInit("POST", body),
          auth: await token("other@example.com"),
        })
      ).status,
    ).toBe(403);
    expect(harness.requests).toHaveLength(0);
  });
});

describe("server information", () => {
  it("reports the latest release tag and the failure modes", async () => {
    expect(await json("/v8/management/server/latest-version")).toMatchObject({
      status: 200,
      body: { "latest-version": "v8.1.0" },
    });
    expect(harness.requests[0]).toMatchObject({
      method: "GET",
      url: "https://api.github.com/repos/router-for-me/CLIProxyAPI/releases/latest",
    });
    expect(harness.requests[0]?.headers.accept).toBe("application/vnd.github+json");

    release = () => ({ status: 500, body: {} });
    expect(await json("/v8/management/server/latest-version")).toMatchObject({
      status: 502,
      body: { error: "unexpected_status" },
    });
    release = () => ({ body: { name: "fallback-name" } });
    expect(await json("/v8/management/server/latest-version")).toMatchObject({
      body: { "latest-version": "fallback-name" },
    });
    release = () => ({ body: {} });
    expect((await json("/v8/management/server/latest-version")).body).toMatchObject({
      error: "invalid_response",
    });
    release = () => ({ transportError: true });
    expect((await json("/v8/management/server/latest-version")).body).toMatchObject({
      error: "request_failed",
    });
  });

  it("serves static model definitions per channel", async () => {
    const claude = await json("/v8/management/routing/model-definitions/Claude");
    expect(claude.status).toBe(200);

    const body = claude.body as {
      channel: string;
      models: Array<{
        id: string;
        object: string;
        owned_by: string;
        type: string;
        created: number;
      }>;
    };

    expect(body.channel).toBe("claude");
    expect(body.models.length).toBeGreaterThan(0);
    expect(body.models[0]).toMatchObject({
      id: expect.any(String),
      object: "model",
      owned_by: "anthropic",
      type: "claude",
    });
    expect(body.models[0]).toHaveProperty("created");
    expect(body.models[0]).not.toHaveProperty("displayName");

    for (const channel of [
      "codex",
      "gemini",
      "xai",
      "grok",
      "kimi",
      "antigravity",
      "meta",
      "devin",
    ]) {
      const result = await json(`/v8/management/routing/model-definitions/${channel}`);
      expect(result.status, channel).toBe(200);
      expect((result.body as { models: unknown[] }).models.length, channel).toBeGreaterThan(0);
    }

    expect(await json("/v8/management/routing/model-definitions/nope")).toMatchObject({
      status: 400,
      body: { error: "unknown channel", channel: "nope" },
    });
    expect(await json("/v8/management/routing/model-definitions")).toMatchObject({
      status: 400,
      body: { error: "channel is required" },
    });
    expect((await json("/v8/management/routing/model-definitions?channel=claude")).status).toBe(
      200,
    );
  });

  it("answers the file-log routes like Go with file logging disabled", async () => {
    expect(await json("/v8/management/observability/logs")).toMatchObject({
      status: 400,
      body: { error: "logging to file disabled" },
    });
    expect((await json("/v8/management/observability/logs", { method: "DELETE" })).status).toBe(
      400,
    );
    expect(await json("/v8/management/observability/logs/errors")).toMatchObject({
      status: 200,
      body: { files: [] },
    });
    expect((await json("/v8/management/observability/logs/errors/error-1.log")).status).toBe(404);
    expect((await json("/v8/management/observability/logs/requests/abc")).status).toBe(404);
  });

  it("leaves plugin routes unported", async () => {
    for (const path of ["/v8/management/plugins"]) {
      expect((await call(path)).status, path).toBe(404);
    }

    // Unknown management paths still need the admin gate.
    expect((await call("/v8/management/plugins", { auth: false })).status).toBe(401);
  });
});

describe("legacy panel address", () => {
  // `/management.html` was the upstream panel; it now sends bookmarks to the control panel at `/`.
  const spellings = [
    "/management.html",
    "/Management.HTML",
    "/management%2Ehtml",
    "//management.html",
    "/%6Danagement.html",
  ];

  it("redirects administrators to / without caching, for every spelling, GET and HEAD", async () => {
    for (const path of spellings)
      for (const method of ["GET", "HEAD"]) {
        const response = await call(path, { method, redirect: "manual" });

        expect(response.status, `${method} ${path}`).toBe(302);
        expect(response.headers.get("location"), path).toBe("/");
        expect(response.headers.get("cache-control"), path).toBe("no-store");
        expect(response.headers.get("access-control-allow-origin"), path).toBeNull();
      }
  });

  it("stays behind the admin gate", async () => {
    for (const path of spellings) {
      expect((await call(path, { auth: false })).status, path).toBe(401);
      expect((await call(path, { auth: await token("other@example.com") })).status, path).toBe(403);
    }
  });
});
