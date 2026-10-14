// A self-hosted proxy (PROXY_MODE unset) has none of a hosted proxy's sign-in routes (src/hosted/routes.ts): Better
// Auth's API, the sign-in options and the sign-in page answer exactly like an unknown path.
import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const fetchWorker = (path: string, init?: RequestInit) =>
  exports.default.fetch(new Request(`https://proxy.test${path}`, { redirect: "manual", ...init }));

const snapshot = async (response: Response) => ({
  status: response.status,
  headers: [...response.headers.entries()].filter(([name]) => name !== "x-cpa-trace-id"),
  body: await response.text(),
});

describe("self-hosted proxy", () => {
  it("reaches no Better Auth route, sign-in options or sign-in page", async () => {
    const unknown = await snapshot(await fetchWorker("/nope"));
    expect(unknown.status).toBe(404);

    for (const [method, path] of [
      ["GET", "/api/auth/get-session"],
      ["POST", "/api/auth/sign-in/social"],
      ["POST", "/api/auth/sign-out"],
      ["GET", "/api/auth/callback/github?code=x&state=y"],
      ["POST", "/api/auth/sign-up/email"],
      ["GET", "/api/sign-in-options"],
      ["GET", "/sign-in"],
    ] as const) {
      const response = await fetchWorker(path, {
        method,
        headers: { "content-type": "application/json", origin: "https://proxy.test" },
        ...(method === "POST" ? { body: JSON.stringify({ provider: "github" }) } : {}),
      });

      expect(await snapshot(response), `${method} ${path}`).toEqual(unknown);
    }
  });
});
