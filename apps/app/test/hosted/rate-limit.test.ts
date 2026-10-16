// The per-org rate limit of Commissary Cloud's client API (packages/auth/src/rate-limit.ts): the test Worker's binding allows
// 5 requests per minute and org (vitest.config.ts).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RATE_LIMITED } from "@commissary/auth";
import { call, clearPeople, installFakes, panelHeaders, restoreFetch, signIn } from "./support.ts";

beforeAll(async () => {
  await installFakes();
  await clearPeople();
});

afterAll(restoreFetch);

const LIMIT = 5;

/** An API key in the Personal org of a new person. */
const keyOf = async (email: string): Promise<string> => {
  const cookie = await signIn({ email });
  const me = await call("/v9/management/me", { headers: panelHeaders(cookie) });
  const { orgs } = await me.json<{ orgs: ReadonlyArray<{ slug: string }> }>();

  const created = await call(`/v9/management/orgs/${orgs[0]?.slug}/api-keys`, {
    method: "POST",
    headers: panelHeaders(cookie, { "content-type": "application/json" }),
    body: JSON.stringify({ name: "load" }),
  });

  expect(created.status).toBe(201);

  return (await created.json<{ key: string }>()).key;
};

const models = (key: string) => call("/v1/models", { headers: { authorization: `Bearer ${key}` } });

describe("the per-org rate limit", () => {
  it("answers 429 with Retry-After over an org's limit and leaves other orgs alone", async () => {
    const busy = await keyOf("busy@example.com");
    const quiet = await keyOf("quiet@example.com");

    for (let sent = 0; sent < LIMIT; sent += 1) expect((await models(busy)).status).toBe(200);

    const limited = await models(busy);

    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    expect(await limited.json()).toEqual({ error: RATE_LIMITED });

    expect((await models(quiet)).status).toBe(200);
  });

  it("does not limit the management API", async () => {
    const cookie = await signIn({ email: "admin-heavy@example.com" });

    for (let sent = 0; sent < LIMIT + 2; sent += 1)
      expect((await call("/v9/management/me", { headers: panelHeaders(cookie) })).status).toBe(200);
  });
});
