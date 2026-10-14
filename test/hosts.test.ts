// Which hostname serves what (src/http/hosts.ts, ADR 0028): with an API host the proxy routes are served there only and
// everything else on the app host; without one, one host serves everything. Unit tests of the decision, and end to end
// through the Worker's default export with the host settings bound (dev bypass on `localhost`, see vitest.config.ts).
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { apiOrigin, misdirected } from "../src/http/hosts.ts";
import worker from "../src/index.ts";

const SPLIT = { APP_DOMAIN: "app.example.com", API_DOMAIN: "api.example.com" };

const refusal = async (url: string, hosts: Partial<Env>) => {
  const response = misdirected(url, hosts);

  return response === undefined
    ? undefined
    : { status: response.status, body: await response.json<{ error: string }>() };
};

describe("host routing", () => {
  it("passes every request through without an API host", async () => {
    for (const url of [
      "https://proxy.example.com/v1/models",
      "https://proxy.example.com/v8/management/me",
      "https://proxy.example.com/",
    ]) {
      expect(misdirected(url, {})).toBeUndefined();
      expect(
        misdirected(url, { APP_DOMAIN: "proxy.example.com", API_DOMAIN: " " }),
      ).toBeUndefined();
    }

    expect(apiOrigin({})).toBeUndefined();
  });

  it("serves the proxy routes and /healthz on the API host, and nothing else", async () => {
    for (const path of [
      "/v1/models",
      "/v1beta/models",
      "/v1internal:generateContent",
      "/openai/v1/chat/completions",
      "/backend-api/codex/responses",
      "/chat/completions",
      "/completions",
      "/responses",
      "/healthz",
      "//V1/models",
    ])
      expect(misdirected(`https://API.example.com${path}`, SPLIT), path).toBeUndefined();

    for (const path of [
      "/",
      "/accounts",
      "/o/acme/accounts",
      "/assets/index.js",
      "/v8/management/me",
      "/v8/management/orgs/acme/config",
      "/sign-in",
      "/api/auth/get-session",
      "/management.html",
      "/nope",
    ])
      expect(await refusal(`https://api.example.com${path}`, SPLIT), path).toEqual({
        status: 404,
        body: {
          error:
            "Not found: api.example.com serves the proxy routes only; the control panel and the management API are at https://app.example.com",
        },
      });
  });

  it("serves everything but the proxy routes on the app host (and any other host)", async () => {
    for (const host of ["app.example.com", "other.example.com"]) {
      for (const path of ["/", "/accounts", "/v8/management/me", "/sign-in", "/healthz", "/nope"])
        expect(misdirected(`https://${host}${path}`, SPLIT), `${host}${path}`).toBeUndefined();

      for (const path of ["/v1/models", "/v1beta/models", "/responses", "/%76%31/models"])
        expect(await refusal(`https://${host}${path}`, SPLIT), `${host}${path}`).toEqual({
          status: 404,
          body: { error: "Not found: the proxy routes are served at https://api.example.com" },
        });
    }
  });

  it("names the API host as an https origin", () => {
    expect(apiOrigin({ API_DOMAIN: " API.example.com " })).toBe("https://api.example.com");
  });
});

/** A request to the Worker with the host settings `hosts` bound. */
const send = async (url: string, hosts: Partial<Env>, init?: RequestInit) => {
  const ctx = createExecutionContext();

  // SAFETY: the default export reads no `cf` property of the request; workerd's own requests carry them.
  const request = new Request(url, { redirect: "manual", ...init }) as Request<
    unknown,
    IncomingRequestCfProperties
  >;

  const response = await worker.fetch(request, { ...env, ...hosts }, ctx);
  await waitOnExecutionContext(ctx);

  return response;
};

describe("a Worker with an API host", () => {
  it("serves the panel and the management API on the app host and tells the panel the API host", async () => {
    const hosts = { APP_DOMAIN: "localhost", API_DOMAIN: "api.example.com" };
    const me = await send("http://localhost/v8/management/me", hosts);

    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ api_url: "https://api.example.com" });

    const proxy = await send("http://localhost/v1/models", hosts);

    expect(proxy.status).toBe(404);
    expect(await proxy.json()).toEqual({
      error: "Not found: the proxy routes are served at https://api.example.com",
    });

    // On the API host the proxy routes reach the Access gate, which fails closed off loopback without Access settings.
    const api = await send("https://api.example.com/v1/models", hosts);

    expect(api.status).toBe(500);
    expect(await api.text()).not.toContain("Not found");
  });

  it("serves the proxy routes on the API host only", async () => {
    const hosts = { APP_DOMAIN: "app.example.com", API_DOMAIN: "localhost" };
    const models = await send("http://localhost/v1/models", hosts);

    expect(models.status).toBe(200);
    expect((await send("http://localhost/healthz", hosts)).status).toBe(200);

    for (const path of ["/", "/v8/management/me"]) {
      const response = await send(`http://localhost${path}`, hosts);

      expect(response.status, path).toBe(404);
      expect(await response.json(), path).toEqual({
        error:
          "Not found: localhost serves the proxy routes only; the control panel and the management API are at https://app.example.com",
      });
    }
  });

  it("says nothing of an API host without one", async () => {
    const me = await send("http://localhost/v8/management/me", {});

    expect(me.status).toBe(200);
    expect(await me.json()).not.toHaveProperty("api_url");
  });
});
