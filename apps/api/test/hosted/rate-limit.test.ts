// The per-org rate limit of Commissary Cloud's client API (packages/auth/src/rate-limit.ts) on the API Worker: the test
// Worker's binding allows 5 requests per minute and org (vitest.config.ts). That the management API on the app Worker
// is not limited is tested there (apps/app/test/hosted/rate-limit.test.ts).
import { beforeAll, describe, expect, it } from "vitest";
import { RATE_LIMITED } from "@commissary/auth";
import { resetUsageDb } from "@commissary/models/testing";
import { keyedOrg, models } from "./support.ts";

beforeAll(async () => {
  await resetUsageDb();
});

const LIMIT = 5;

describe("the per-org rate limit", () => {
  it("answers 429 with Retry-After over an org's limit and leaves other orgs alone", async () => {
    const busy = (await keyedOrg("busy@example.com")).key;
    const quiet = (await keyedOrg("quiet@example.com")).key;

    for (let sent = 0; sent < LIMIT; sent += 1) expect((await models(busy)).status).toBe(200);

    const limited = await models(busy);

    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    expect(await limited.json()).toEqual({ error: RATE_LIMITED });

    expect((await models(quiet)).status).toBe(200);
  });
});
