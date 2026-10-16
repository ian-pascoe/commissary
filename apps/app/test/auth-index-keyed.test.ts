// Keyed `auth_index` (src/models/management/auth-index.ts): HMAC under the deployment key, and no raw config credential id
// or unkeyed hash of key material in any management or client API response. End to end through `exports.default.fetch`
// (dev bypass on localhost, see vitest.config.ts); only the upstream provider is mocked, through the global `fetch`.
import { FULL_ACCESS } from "../src/models/credentials/ownership.ts";
import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { Layer, Logger, References } from "effect";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  AUTH_INDEX_LENGTH,
  AuthIndexKeyError,
  authIndexer,
  deploymentAuthIndexer,
} from "../src/models/management/auth-index.ts";
import { DEV_AUTH_INDEX_KEY } from "../src/models/management/auth-index-key.ts";
import { CLAUDE_PROFILE_URL, CLAUDE_USAGE_URL } from "../src/models/quota/claude.ts";
import { RESET_GRANT_STATUS_URL, resetGrantClaimUrl } from "../src/models/quota/reset-grants.ts";
import { TraceLayer } from "../src/models/observability/trace.ts";
import { ControlPlane } from "../src/index.ts";
import { authIndexOf, emptyKeyAuthIndexOf, unkeyedAuthIndexOf } from "./support/auth-index.ts";
import { claudeFile, makeHarness } from "./support/management.ts";
import { jsonResponse, loadConfig, makePipeline, postJson } from "./support/pipeline.ts";
import { resetUsageDb } from "./support/usage.ts";

/** `hex(HMAC-SHA256(key, "auth-index:" + id))[:16]` through WebCrypto: no state shared with the module's caches. */
const referenceIndex = async (key: string, id: string): Promise<string> => {
  const encoder = new TextEncoder();

  const imported = await crypto.subtle.importKey(
    "raw",
    encoder.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const mac = new Uint8Array(
    await crypto.subtle.sign("HMAC", imported, encoder.encode(`auth-index:${id}`)),
  );

  return Array.from(mac, (byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, AUTH_INDEX_LENGTH);
};

describe("authIndexer", () => {
  const ids = ["claude-a.json", "claude:apikey:0123456789ab", "openai-compatibility:mock:abc"];

  it("is HMAC-SHA256 under the key, truncated to 16 hex characters", async () => {
    for (const id of ids) {
      const index = authIndexOf(id);
      expect(index).toMatch(/^[0-9a-f]{16}$/);
      expect(index).toBe(await referenceIndex(env.AUTH_INDEX_KEY, id));
      expect(index).not.toBe(unkeyedAuthIndexOf(id));
    }
  });

  it("is stable across calls and isolates for the same key", async () => {
    // One indexer per key and isolate; a fresh computation elsewhere (WebCrypto, no shared cache) agrees.
    expect(authIndexer(env.AUTH_INDEX_KEY)).toBe(authIndexOf);

    for (const id of ids) {
      expect(authIndexOf(id)).toBe(authIndexOf(id));
      expect(authIndexer(env.AUTH_INDEX_KEY)(id)).toBe(authIndexOf(id));
      expect(await referenceIndex(env.AUTH_INDEX_KEY, id)).toBe(authIndexOf(id));
    }
  });

  it("differs under a different key", async () => {
    const other = authIndexer("another-deployment-key");

    for (const id of ids) {
      expect(other(id)).not.toBe(authIndexOf(id));
      expect(other(id)).toBe(await referenceIndex("another-deployment-key", id));
    }

    expect(new Set(ids.map(authIndexOf)).size).toBe(ids.length);
  });

  it("fails closed without a key, with an empty or a short one", () => {
    // node:crypto accepts a 0-byte HMAC key: a missing binding must throw, not hash under it.
    for (const secret of [undefined, "", "short-key", "x".repeat(15)])
      expect(() => authIndexer(secret), String(secret)).toThrow(AuthIndexKeyError);

    expect(authIndexer("x".repeat(16))("claude-a.json")).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("deploymentAuthIndexer", () => {
  const minted = "a1".repeat(32);

  it("refuses the dev key and keys shorter than 64 characters once Access is configured", () => {
    for (const deployed of [
      { ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com", ACCESS_AUD: "" },
      { ACCESS_TEAM_DOMAIN: "", ACCESS_AUD: "aud-tag" },
    ]) {
      for (const key of [
        DEV_AUTH_INDEX_KEY,
        "short-but-valid-locally",
        "b".repeat(63),
        "",
        undefined,
      ])
        expect(
          () => deploymentAuthIndexer({ ...deployed, AUTH_INDEX_KEY: key }),
          String(key),
        ).toThrow(/refused because ACCESS_TEAM_DOMAIN\/ACCESS_AUD are set/);

      expect(deploymentAuthIndexer({ ...deployed, AUTH_INDEX_KEY: minted })("x")).toBe(
        authIndexer(minted)("x"),
      );
    }
  });

  it("accepts the dev and test keys while Access is not configured (alchemy dev, tests)", () => {
    const local = { ACCESS_TEAM_DOMAIN: " ", ACCESS_AUD: "" };

    expect(deploymentAuthIndexer({ ...local, AUTH_INDEX_KEY: DEV_AUTH_INDEX_KEY })("x")).toBe(
      authIndexer(DEV_AUTH_INDEX_KEY)("x"),
    );
    expect(deploymentAuthIndexer({ ...local, AUTH_INDEX_KEY: env.AUTH_INDEX_KEY })).toBe(
      authIndexOf,
    );
    expect(() => deploymentAuthIndexer({ ...local, AUTH_INDEX_KEY: "" })).toThrow(
      AuthIndexKeyError,
    );
  });
});

describe("a refused key on a deployed stage", () => {
  // Access configured (both harnesses) and a key that is long enough locally but not for a deployed stage.
  const bindings = { AUTH_INDEX_KEY: "short-but-valid-locally" };

  it("keeps serving (the log line omits authIndex) while management calls needing an index fail", async () => {
    const annotations: Array<Record<string, unknown>> = [];

    const capture = Logger.layer([
      Logger.make((options) => {
        annotations.push({ ...options.fiber.getRef(References.CurrentLogAnnotations) });
      }),
    ]);

    const config = await loadConfig(`
api-keys:
  openai-compatibility:
    - name: Mock
      base-url: https://upstream.test/v1/
      models:
        - name: upstream-model
      keys:
        - api-key: sk-test-1
`);

    const pipeline = makePipeline({
      config,
      respond: () =>
        jsonResponse({
          id: "chatcmpl-1",
          object: "chat.completion",
          created: 1700000000,
          model: "upstream-model",
          choices: [
            { index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
        }),
      extraLayers: Layer.mergeAll(TraceLayer, capture),
      bindings,
    });

    const management = makeHarness(undefined, bindings);

    try {
      const response = await pipeline.call(
        "/v1/chat/completions",
        postJson({ model: "upstream-model", messages: [{ role: "user", content: "hi" }] }),
      );

      expect(response.status).toBe(200);
      expect(await response.text()).toContain("hello");
      expect(pipeline.records).toHaveLength(1);

      // The request log line was written, without an index.
      const requestLine = annotations.find((entry) => entry["requestId"] !== undefined);

      expect(requestLine).toMatchObject({ status: 200, attempts: 1 });
      expect(requestLine).not.toHaveProperty("authIndex");

      // Management reads that index in the Worker fail, and `GET /provider-keys`, which indexes inside the ControlPlane:
      // the test's object keeps the valid key, so an instance over the same storage gets the refused bindings.
      await runInDurableObject(env.CONTROL_PLANE.getByName("global"), async (_instance, state) => {
        const refused = new ControlPlane(state, {
          ...env,
          ACCESS_TEAM_DOMAIN: "team",
          ...bindings,
        });

        await refused.started;
        expect(() => refused.models().providerKeysView(FULL_ACCESS)).toThrow(AuthIndexKeyError);
      });

      for (const path of [
        "/v9/management/routing/models",
        "/v9/management/observability/usage/summary?group_by=auth",
        "/v9/management/observability/usage/records",
      ])
        expect((await management.call(path)).status, path).toBe(500);
    } finally {
      await pipeline.dispose();
      await management.dispose();
    }
  });
});

// --- end to end ------------------------------------------------------------------------------------------------

/** Known keys, one deliberately low-entropy (the brute-forceable case of a self-hosted endpoint). */
const KEYS = { claude: "sk-ant-leakcheck-0001", codex: "sk-codex-leakcheck-0002", compat: "1234" };

const YAML = `
api-keys:
  claude:
    - keys:
        - api-key: ${KEYS.claude}
  codex:
    - base-url: https://codex.upstream.test/v1
      keys:
        - api-key: ${KEYS.codex}
  openai-compatibility:
    - name: Mock
      base-url: https://upstream.test/v1
      models:
        - name: upstream-model
          alias: leak-model
      keys:
        - api-key: "${KEYS.compat}"
`;

/** OpenAI chat completion chunks, for `stream: true`. */
const STREAM = [
  {
    id: "chatcmpl-1",
    object: "chat.completion.chunk",
    created: 1700000000,
    model: "upstream-model",
    choices: [{ index: 0, delta: { role: "assistant", content: "hello" }, finish_reason: null }],
  },
  {
    id: "chatcmpl-1",
    object: "chat.completion.chunk",
    created: 1700000000,
    model: "upstream-model",
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
  },
]
  .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
  .concat("data: [DONE]\n\n")
  .join("");

const ORGANIZATION = "abcdef01-2345-6789-abcd-ef0123456789";

/** Anthropic's account endpoints (quota, reset grants), for the auth file `claude-leak.json`. */
const ANTHROPIC = {
  [RESET_GRANT_STATUS_URL]: {
    five_hour: { utilization: 100 },
    cedar_ember: {
      eligible: true,
      at_limit: true,
      weekly_resets_at: "2026-10-14T00:00:00Z",
      grants: [
        {
          id: "g1",
          label: "Launch week",
          resets_total: 3,
          resets_left: 2,
          starts_at: "2026-01-01T00:00:00Z",
          ends_at: "2999-01-01T00:00:00Z",
          clears: ["five_hour", "seven_day"],
          paused: false,
          usable_now: true,
          use_requires_limit: false,
        },
      ],
    },
  },
  [CLAUDE_PROFILE_URL]: {
    account: { has_claude_max: true },
    organization: { uuid: ORGANIZATION },
  },
  [resetGrantClaimUrl(ORGANIZATION)]: { result: "reset" },
  [CLAUDE_USAGE_URL]: { five_hour: { utilization: 0 } },
} satisfies Record<string, Record<string, unknown>>;

const COMPLETION = {
  id: "chatcmpl-1",
  object: "chat.completion",
  created: 1700000000,
  model: "upstream-model",
  choices: [{ index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
};

const realFetch = globalThis.fetch;

let upstreamStatus = 200;

const controlPlane = () => env.CONTROL_PLANE.getByName("global");

const call = async (path: string, init?: RequestInit) =>
  await exports.default.fetch(new Request(`http://localhost${path}`, init));

const chat = (model: string, stream = false) =>
  call("/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, stream, messages: [{ role: "user", content: "hi" }] }),
  });

const post = (
  path: string,
  body: Readonly<Record<string, string | boolean | ReadonlyArray<string> | undefined>>,
  method = "POST",
) =>
  call(path, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

/** Every console line written while `run` runs (the Worker shares the test isolate), as JSON. */
const captureConsole = async (run: () => Promise<void>): Promise<ReadonlyArray<string>> => {
  const lines: Array<string> = [];

  const spies = (["log", "info", "warn", "error", "debug"] as const).map((method) =>
    // The arguments as one JSON array: structured log objects stay JSON, strings are quoted (escaped quotes inside).
    vi.spyOn(console, method).mockImplementation((...args) => {
      try {
        lines.push(JSON.stringify(args));
      } catch {
        lines.push("[unserialisable console arguments]");
      }
    }),
  );

  try {
    await run();
  } finally {
    for (const spy of spies) spy.mockRestore();
  }

  return lines;
};

/** Everything a client can see of a response: status line, headers and body. */
const visible = async (response: Response): Promise<string> =>
  `${response.status}\n${[...response.headers].map(([name, value]) => `${name}: ${value}`).join("\n")}\n${await response.text()}`;

const json = async <A>(path: string): Promise<A> => {
  const response = await call(path);
  expect(response.status).toBe(200);

  // SAFETY: the shapes are those of the management contract; mismatches fail the assertions below.
  return (await response.json()) as A;
};

interface KeysList {
  readonly families: Record<
    string,
    ReadonlyArray<{
      readonly group: {
        readonly keys: ReadonlyArray<{
          readonly auth_index?: string;
          readonly runtime: Record<string, unknown> | null;
        }>;
      };
    }>
  >;
}

const BASE = "/v9/management";

let configIds: ReadonlyArray<string> = [];

beforeAll(async () => {
  // Effect's FetchHttpClient resolves `globalThis.fetch` once: one stable fetch for every upstream call.
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    if (upstreamStatus !== 200)
      return Response.json({ error: { message: "upstream exploded" } }, { status: upstreamStatus });

    const request = new Request(input, init);
    const account = ANTHROPIC[request.url];

    if (account !== undefined) return Response.json(account);
    const body = await request.text();

    return body.includes('"stream":true')
      ? new Response(STREAM, { headers: { "content-type": "text/event-stream" } })
      : Response.json(COMPLETION);
  };

  await resetUsageDb();
  const stored = await controlPlane().models().importConfig(YAML, "test");
  expect(stored.ok).toBe(true);
  configIds = (await controlPlane().models().listCredentials(FULL_ACCESS))
    .filter((entry) => entry.source === "config")
    .map((entry) => entry.id);
  expect(configIds).toHaveLength(3);

  const upload = await call(`${BASE}/credentials?name=claude-leak.json`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(claudeFile()),
  });

  expect(upload.status).toBe(200);
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  await controlPlane().models().removeCredentials(["claude-leak.json"], FULL_ACCESS);
  await controlPlane().models().importConfig("", "test");
});

describe("no raw config id or unkeyed hash in any response", () => {
  /**
   * The strings that must never reach a client: ids, their hash part, the unkeyed index, the index under an empty key
   * (a missing binding) and the keys themselves.
   */
  const forbidden = (): ReadonlyArray<string> =>
    [...configIds, "claude-leak.json"]
      .flatMap((id) => [unkeyedAuthIndexOf(id), emptyKeyAuthIndexOf(id)])
      .concat(configIds.flatMap((id) => [id, id.slice(id.lastIndexOf(":") + 1)]))
      .concat([KEYS.claude, KEYS.codex]);

  it("client API responses (success, streaming, upstream failure, unknown model), every management read and the logs", async () => {
    const seen: Array<{ readonly what: string; readonly text: string }> = [];

    const record = async (what: string, response: Promise<Response>) =>
      seen.push({ what, text: await visible(await response) });

    const logs = await captureConsole(async () => {
      upstreamStatus = 200;
      await record("chat ok", chat("leak-model"));
      await record("chat stream", chat("leak-model", true));
      upstreamStatus = 500;
      await record("chat upstream 500", chat("leak-model"));
      upstreamStatus = 200;
      await record("chat unknown model", chat("no-such-model"));
      await record("models", call("/v1/models"));
      // Commissary really served (streamed, and failed) through the config credential.
      expect(seen.map(({ text }) => text.slice(0, 3))).toEqual(["200", "200", "500", "400", "200"]);
      expect(seen[1]?.text).toContain("data: [DONE]");

      await vi.waitFor(
        async () => {
          const rows = await env.USAGE.prepare("SELECT COUNT(*) AS n FROM usage_records").first<{
            n: number;
          }>();

          expect(rows?.n).toBeGreaterThanOrEqual(2);
        },
        { timeout: 5_000 },
      );

      const since = Date.now() - 86_400_000;

      for (const path of [
        `${BASE}/provider-keys`,
        `${BASE}/credentials`,
        `${BASE}/credentials/models?name=${encodeURIComponent(configIds[0] ?? "")}`,
        `${BASE}/routing/models`,
        `${BASE}/settings`,
        `${BASE}/observability/usage/summary?group_by=auth`,
        `${BASE}/observability/usage/summary?group_by=model`,
        `${BASE}/observability/usage/series?since=${since}&group_by=auth`,
        `${BASE}/observability/usage/records`,
        `${BASE}/observability/usage/queue?count=100`,
        `${BASE}/credentials?auth_index=${authIndexOf("claude-leak.json")}`,
        ...configIds.map((id) => `${BASE}/credentials?auth_index=${authIndexOf(id)}`),
      ])
        await record(path, call(path));

      // A quota check of the auth file (the mocked usage endpoint answers nonsense: a report with an error), and of a
      // config id, which is no auth file.
      await record("quota", post(`${BASE}/credentials/quota`, { name: "claude-leak.json" }));
      await record("quota by id", post(`${BASE}/credentials/quota`, { name: configIds[0] }));

      await record("quota all", post(`${BASE}/credentials/quota/all`, {}));

      // Reset grants of the auth file (read and claim), and of the config keys (no Claude account: refused).
      const fileIndex = authIndexOf("claude-leak.json");

      await record(
        "reset grants",
        call(`${BASE}/credentials/reset-grants?auth_index=${fileIndex}`),
      );
      await record(
        "reset grant claim",
        post(`${BASE}/credentials/reset-grants/claim`, { auth_index: fileIndex }),
      );

      // Both really reached the (mocked) account: a grant list, then a claimed reset.
      expect(seen.at(-2)?.text).toMatch(/^200[\s\S]*"grants"/);
      expect(seen.at(-1)?.text).toMatch(/^200[\s\S]*"outcome":"reset"/);

      for (const id of configIds)
        await record(
          `reset grants of ${id}`,
          call(`${BASE}/credentials/reset-grants?auth_index=${authIndexOf(id)}`),
        );

      // Batches echo the names sent, so a config id sent comes back; what must not differ is the reply to a right
      // and a wrong guess: every action answers the real ids exactly as ids of the same shape that do not exist.
      const guesses = configIds.map((id) => `${id.slice(0, id.lastIndexOf(":") + 1)}000000000000`);

      for (const action of ["disable", "enable", "refresh", "delete"]) {
        const batchText = async (names: ReadonlyArray<string>) =>
          await (
            await post(`${BASE}/credentials/batch`, {
              action,
              // The auth file too for enable/disable; a refresh (the token endpoint is not mocked) or a delete would
              // spoil it for the later tests.
              names:
                action === "refresh" || action === "delete"
                  ? names
                  : ["claude-leak.json", ...names],
            })
          ).text();

        const real = await batchText(configIds);
        const guessed = await batchText(guesses);

        expect(
          configIds.reduce((text, id, at) => text.replaceAll(id, guesses[at] ?? ""), real),
          `batch ${action}`,
        ).toBe(guessed);
        seen.push({ what: `batch ${action}`, text: guessed });
      }

      expect(
        (await controlPlane().models().listCredentials(FULL_ACCESS)).filter(
          (e) => e.source === "config",
        ),
      ).toHaveLength(configIds.length);

      // The panel's address of an account and its usage filter.
      await record("account page", call(`/accounts/${fileIndex}`));
    });

    expect(seen.length).toBeGreaterThan(20);

    for (const { what, text } of seen)
      for (const secret of forbidden())
        expect(text, `${what} leaks ${secret}`).not.toContain(secret);

    // Logs carry keyed indexes only (and saw the proxied requests: the capture works).
    const keyed = new Set([...configIds, "claude-leak.json"].map(authIndexOf));

    const logged = logs.flatMap((line) =>
      [...line.matchAll(/\\?"authIndex\\?":\\?"([^"\\]*)/g)].map((m) => m[1]),
    );

    expect(logged).toContain(
      authIndexOf(configIds.find((id) => id.startsWith("openai-compat")) ?? ""),
    );

    for (const index of logged) expect(keyed.has(index ?? ""), `log authIndex ${index}`).toBe(true);

    expect(logs).not.toContain("[unserialisable console arguments]");

    for (const line of logs)
      for (const secret of forbidden()) expect(line, `log leaks ${secret}`).not.toContain(secret);
  });

  it("refuses the credential id as a lookup or filter", async () => {
    const id = configIds[0] ?? "";

    const status = await call(`${BASE}/credentials/status`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: id, disabled: true }),
    });

    expect(status.status).toBe(404);
    expect(
      (await call(`${BASE}/observability/usage/records?auth_id=${encodeURIComponent(id)}`)).status,
    ).toBe(400);
  });
});

describe("views join on the keyed auth_index", () => {
  it("provider-keys, routing/models, credentials, usage summary, series and records agree", async () => {
    const keys = await json<KeysList>(`${BASE}/provider-keys`);

    const keyIndexes = Object.values(keys.families).flatMap((groups) =>
      groups.flatMap((group) =>
        group.group.keys.map((key) => {
          // The runtime carries the same index and no id.
          expect(key.runtime?.["auth_index"]).toBe(key.auth_index);
          expect(key.runtime).not.toHaveProperty("id");

          return key.auth_index;
        }),
      ),
    );

    expect(keyIndexes).toHaveLength(configIds.length);
    expect(new Set(keyIndexes)).toEqual(new Set(configIds.map(authIndexOf)));

    const routing = await json<{
      readonly models: ReadonlyArray<{
        readonly id: string;
        readonly routes: ReadonlyArray<{ readonly auth_index: string; readonly name?: string }>;
      }>;
    }>(`${BASE}/routing/models`);

    const routed = new Set(
      routing.models.flatMap((model) => model.routes.map((r) => r.auth_index)),
    );

    const compatIndex = authIndexOf(configIds.find((id) => id.startsWith("openai-compat")) ?? "");
    expect(keyIndexes).toContain(compatIndex);
    expect(routed.has(compatIndex)).toBe(true);
    expect(routed.has(authIndexOf("claude-leak.json"))).toBe(true);

    const credentials = await json<{
      readonly files: ReadonlyArray<{ readonly name: string; readonly auth_index: string }>;
    }>(`${BASE}/credentials`);

    expect(credentials.files.find((file) => file.name === "claude-leak.json")?.auth_index).toBe(
      authIndexOf("claude-leak.json"),
    );

    await vi.waitFor(
      async () => {
        const summary = await json<{
          readonly groups: ReadonlyArray<{ readonly key: string; readonly requests: number }>;
        }>(`${BASE}/observability/usage/summary?group_by=auth`);

        expect(summary.groups.map((group) => group.key)).toEqual([compatIndex]);
      },
      { timeout: 5_000 },
    );

    const since = Date.now() - 86_400_000;

    const series = await json<{ readonly series: ReadonlyArray<{ readonly key: string }> }>(
      `${BASE}/observability/usage/series?since=${since}&group_by=auth&auth_index=${compatIndex}`,
    );

    expect(series.series.map((entry) => entry.key)).toEqual([compatIndex]);

    const records = await json<{
      readonly records: ReadonlyArray<{ readonly auth_index: string }>;
    }>(`${BASE}/observability/usage/records?auth_index=${compatIndex}`);

    expect(records.records.length).toBeGreaterThan(0);
    expect(records.records.every((entry) => entry.auth_index === compatIndex)).toBe(true);
  });

  it("matches auth_index case-insensitively in every lookup and filter", async () => {
    const fileIndex = authIndexOf("claude-leak.json");
    const compatIndex = authIndexOf(configIds.find((id) => id.startsWith("openai-compat")) ?? "");
    const upper = (index: string) => index.toUpperCase();

    // Both indexes have letters, so the upper-case forms differ.
    expect(upper(fileIndex)).not.toBe(fileIndex);
    expect(upper(compatIndex)).not.toBe(compatIndex);

    const listed = await json<{ readonly files: ReadonlyArray<{ readonly name: string }> }>(
      `${BASE}/credentials?auth_index=${upper(fileIndex)}`,
    );

    expect(listed.files.map((file) => file.name)).toEqual(["claude-leak.json"]);
    expect(
      (await call(`${BASE}/credentials/reset-grants?auth_index=${upper(fileIndex)}`)).status,
    ).toBe(200);

    for (const disabled of [true, false]) {
      const status = await post(
        `${BASE}/credentials/status`,
        { auth_index: upper(fileIndex), disabled },
        "PATCH",
      );

      expect(status.status).toBe(200);
    }

    const records = await json<{
      readonly records: ReadonlyArray<{ readonly auth_index: string }>;
    }>(`${BASE}/observability/usage/records?auth_index=${upper(compatIndex)}`);

    expect(records.records.length).toBeGreaterThan(0);
    expect(records.records.every((entry) => entry.auth_index === compatIndex)).toBe(true);
  });
});
