// The org boundary (ADR 0021): two orgs in one deployment keep their config, credentials, cooldowns, usage and
// auth indexes apart, and the org `global` keeps everything it had before orgs existed.
import { env } from "cloudflare:workers";
import { Effect, Schema } from "effect";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { ConfigReader } from "../src/config/reader.ts";
import { makeControlPlanePicker } from "../src/executor/control-plane-picker.ts";
import { WorkerEnv } from "../src/platform/env.ts";
import {
  controlPlaneOf,
  CurrentOrg,
  GLOBAL_ORG,
  OrgId,
  orgOfScopedName,
  orgScopedName,
} from "../src/platform/org.ts";
import { resolveBackend } from "../src/session-state/client.ts";
import { loadVideoBinding, saveVideoBinding } from "../src/handlers/openai/video-binding.ts";
import { insertUsageRecord } from "../src/usage/d1.ts";
import { authIndexOf } from "./support/auth-index.ts";
import { claudeFile, makeHarness, resetControlPlane } from "./support/management.ts";
import { resetUsageDb, sampleRecord } from "./support/usage.ts";

/** A fresh org per test file run: its ControlPlane starts empty. */
const ACME = OrgId.make(`acme-${crypto.randomUUID().slice(0, 8)}`);

const global = makeHarness(undefined, {}, GLOBAL_ORG);

const acme = makeHarness(undefined, {}, ACME);

afterAll(async () => {
  await global.dispose();
  await acme.dispose();
});

beforeEach(async () => {
  await resetControlPlane(GLOBAL_ORG);
  await resetControlPlane(ACME);
});

const putYaml = (yaml: string) => ({
  method: "PUT",
  headers: { "content-type": "application/yaml" },
  body: yaml,
});

const upload = (content: ReturnType<typeof claudeFile>) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(content),
});

interface Entry {
  readonly name: string;
  readonly auth_index: string;
}

const credentials = async (harness: typeof global): Promise<ReadonlyArray<Entry>> => {
  const response = await harness.json("/v8/management/credentials");
  expect(response.status).toBe(200);

  return (response.body as { readonly files: ReadonlyArray<Entry> }).files;
};

describe("org-scoped names", () => {
  it("keep global's names and give every other org its own, which name the org back", () => {
    const acme = OrgId.make("acme");
    expect(orgScopedName(GLOBAL_ORG, "ag:sc:x")).toBe("ag:sc:x");
    expect(orgScopedName(acme, "ag:sc:x")).toBe("org.acme.ag:sc:x");
    expect(orgOfScopedName("ag:sc:x")).toBe(GLOBAL_ORG);
    expect(orgOfScopedName("org.acme.ag:sc:x")).toBe(acme);
    expect(orgOfScopedName("org.global.x")).toBeUndefined();
    expect(orgOfScopedName("org.Bad_Org.x")).toBeUndefined();
    expect(orgOfScopedName("org.acme")).toBeUndefined();
  });
});

describe("two orgs in one deployment", () => {
  it("keep separate config", async () => {
    const put = await acme.json(
      "/v8/management/config.yaml",
      putYaml("routing:\n  strategy: fill-first\n"),
    );

    expect(put.status).toBe(200);

    const acmeStrategy = await acme.json("/v8/management/config/routing/strategy");
    const globalStrategy = await global.json("/v8/management/config/routing/strategy");
    expect(acmeStrategy.body).toBe("fill-first");
    expect(globalStrategy.body).toBe("round-robin");
  });

  it("keep separate credentials, and the same credential gets another auth index in each", async () => {
    const name = "claude-shared.json";
    expect(
      (await acme.json(`/v8/management/credentials?name=${name}`, upload(claudeFile()))).status,
    ).toBe(200);
    expect(await credentials(global)).toEqual([]);

    expect(
      (await global.json(`/v8/management/credentials?name=${name}`, upload(claudeFile()))).status,
    ).toBe(200);
    const [inAcme] = await credentials(acme);
    const [inGlobal] = await credentials(global);
    expect(inAcme?.name).toBe(name);
    expect(inGlobal?.name).toBe(name);
    // `global` keeps the deployment key's index, so existing handles and panel links do not change.
    expect(inGlobal?.auth_index).toBe(authIndexOf(name));
    expect(inAcme?.auth_index).toMatch(/^[0-9a-f]{16}$/);
    expect(inAcme?.auth_index).not.toBe(inGlobal?.auth_index);
  });
});

describe("cooldowns", () => {
  const CONFIG = `
api-keys:
  openai-compatibility:
    - name: oc
      base-url: https://oc.example/v1
      models: [{ name: up-1, alias: shared }]
      keys: [{ api-key: key-oc }]
`;

  const picker = makeControlPlanePicker(controlPlaneOf);
  const request = { providers: ["openai-compatible-oc"], model: "shared", callerScope: "s" };

  const inOrg =
    (org: OrgId) =>
    <A, E>(effect: Effect.Effect<A, E, WorkerEnv | CurrentOrg>) =>
      Effect.runPromise(
        effect.pipe(Effect.provideService(WorkerEnv, env), Effect.provideService(CurrentOrg, org)),
      );

  it("a cooldown in one org leaves the same credential of another org usable", async () => {
    await controlPlaneOf(env, ACME).putConfig(CONFIG);
    await controlPlaneOf(env, GLOBAL_ORG).putConfig(CONFIG);

    const picked = await inOrg(ACME)(picker.pick(request));
    await inOrg(ACME)(
      picker.report(picked.lease, {
        success: false,
        httpStatus: 429,
        error: { message: "q", retryable: true, httpStatus: 429 },
        retryAfterMs: 60_000,
        model: picked.route.stateModel,
      }),
    );

    const cooled = await inOrg(ACME)(Effect.flip(picker.pick(request)));
    expect(cooled).toMatchObject({ status: 429, code: "model_cooldown" });
    expect((await inOrg(GLOBAL_ORG)(picker.pick(request))).credential.provider).toBe(
      "openai-compatible-oc",
    );
  });
});

describe("usage", () => {
  const USAGE = "/v8/management/observability/usage";

  beforeEach(async () => {
    const db = await resetUsageDb();
    const at = Date.now() - 60_000;

    await insertUsageRecord(db, sampleRecord({ requestId: "g-1", requestedAt: at, model: "m-g" }));
    await insertUsageRecord(
      db,
      sampleRecord({ requestId: "a-1", requestedAt: at, model: "m-a", orgId: ACME }),
    );
    await insertUsageRecord(
      db,
      sampleRecord({ requestId: "a-2", requestedAt: at + 1, model: "m-a", orgId: ACME }),
    );
  });

  const Records = Schema.Struct({
    records: Schema.Array(Schema.Struct({ request_id: Schema.String })),
  });

  const ids = (reply: { readonly body: unknown }): ReadonlyArray<string> =>
    Schema.decodeUnknownSync(Records)(reply.body).records.map((record) => record.request_id);

  it("every query reads the request's org only", async () => {
    expect(ids(await acme.json(`${USAGE}/records`))).toEqual(["a-2", "a-1"]);
    expect(ids(await global.json(`${USAGE}/records`))).toEqual(["g-1"]);

    const summary = await acme.json(`${USAGE}/summary?group_by=model`);
    expect(summary.body).toMatchObject({ totals: { requests: 2 }, groups: [{ key: "m-a" }] });

    const since = Date.now() - 3_600_000;
    const series = await global.json(`${USAGE}/series?since=${since}&group_by=model`);
    expect(series.body).toMatchObject({ series: [{ key: "m-g" }] });
    expect((series.body as { readonly series: ReadonlyArray<unknown> }).series).toHaveLength(1);

    // The export queue of one org never hands out (or marks as exported) another org's records.
    const queue = await acme.json(`${USAGE}/queue?count=10`);
    expect(
      (queue.body as ReadonlyArray<{ readonly request_id: string }>).map((r) => r.request_id),
    ).toEqual(["a-1", "a-2"]);
    const rest = await global.json(`${USAGE}/queue?count=10`);
    expect(
      (rest.body as ReadonlyArray<{ readonly request_id: string }>).map((r) => r.request_id),
    ).toEqual(["g-1"]);
  });

  it("a credential filter of one org does not match the same credential id in another", async () => {
    const index = authIndexOf("codex-a.json");
    const records = await acme.json(`${USAGE}/records?auth_index=${index}`);
    expect(ids(records)).toEqual([]);
    expect(ids(await global.json(`${USAGE}/records?auth_index=${index}`))).toEqual(["g-1"]);
  });
});

describe("OAuth logins", () => {
  interface Started {
    readonly state: string;
  }

  const startIn = async (harness: typeof global): Promise<Started> => {
    const reply = await harness.json("/v8/management/oauth/auth-url?provider=claude");
    expect(reply.status).toBe(200);

    return reply.body as Started;
  };

  const statusIn = async (harness: typeof global, state: string) =>
    (await harness.json(`/v8/management/oauth/status?state=${state}`)).body;

  it("the public callback reaches the ControlPlane of the org that started the login", async () => {
    const inGlobal = await startIn(global);
    expect(inGlobal.state).toMatch(/^[0-9a-f]{32}$/);
    const inAcme = await startIn(acme);
    expect(inAcme.state).toMatch(new RegExp(`^org\\.${ACME}\\.[0-9a-f]{32}$`));

    // The browser callback has no Access identity; the state alone names the org.
    const callback = await global.call(
      `/anthropic/callback?error=access_denied&state=${inAcme.state}`,
      {
        auth: false,
      },
    );

    expect(callback.status).toBe(200);
    expect(await callback.text()).toContain("Authentication failed");
    expect(await statusIn(acme, inAcme.state)).toMatchObject({ status: "error" });
    expect(await statusIn(global, inGlobal.state)).toEqual({ status: "wait" });

    // A state is only known to its own org's ControlPlane.
    const bare = inAcme.state.slice(`org.${ACME}.`.length);
    const elsewhere = await statusIn(global, inAcme.state);
    expect(elsewhere).not.toEqual({ status: "wait" });

    for (const state of [bare, `org.Not_An_Org.${bare}`, `org.global.${inGlobal.state}`]) {
      const rejected = await global.call(`/anthropic/callback?code=c&state=${state}`, {
        auth: false,
      });

      expect(rejected.status, state).toBe(400);
    }

    expect(await statusIn(global, inGlobal.state)).toEqual({ status: "wait" });
  });
});

describe("the shared model catalog", () => {
  const CATALOG = "/v8/management/models/catalog";

  it("only global's config sets its source; another org refuses the setting", async () => {
    const refused = await acme.json(
      "/v8/management/config.yaml",
      putYaml("models:\n  catalog: embed\n"),
    );

    expect(refused.status).toBe(422);
    expect(JSON.stringify(refused.body)).toContain("models.catalog");
    expect(JSON.stringify(refused.body)).toContain("deployment setting");

    const accepted = await global.json(
      "/v8/management/config.yaml",
      putYaml("models:\n  catalog: embed\n"),
    );

    expect(accepted.status).toBe(200);
  });

  it("every org reads, shows and refreshes the catalog under global's setting", async () => {
    await controlPlaneOf(env, GLOBAL_ORG).putConfig("models:\n  catalog: embed\n");
    await controlPlaneOf(env, ACME).putConfig("routing:\n  strategy: fill-first\n");

    const status = await acme.json(CATALOG);
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({ mode: "embed" });

    // Refused as global's `embed` would be: acme cannot point the shared catalog anywhere.
    const refresh = await acme.json(`${CATALOG}/refresh`, { method: "POST" });
    expect(refresh.status).toBe(409);
    expect(refresh.body).toMatchObject({ error: "catalog_not_fetched" });

    const snapshot = await Effect.runPromise(
      Effect.gen(function* () {
        const reader = yield* ConfigReader;

        return yield* reader.get;
      }).pipe(
        Effect.provide(ConfigReader.layerControlPlane()),
        Effect.provideService(WorkerEnv, env),
        Effect.provideService(CurrentOrg, ACME),
      ),
    );

    expect(snapshot.config.models.catalog).toBe("embed");
    expect(snapshot.config.routing.strategy).toBe("fill-first");
  });
});

describe("session state and video bindings", () => {
  const inOrg =
    (org: OrgId) =>
    <A, E>(effect: Effect.Effect<A, E, WorkerEnv | CurrentOrg>) =>
      Effect.runPromise(
        effect.pipe(Effect.provideService(WorkerEnv, env), Effect.provideService(CurrentOrg, org)),
      );

  it("one org's session entries and video pins are invisible to another", async () => {
    const address = { store: "codex-replay", scope: "", session: crypto.randomUUID() };
    const put = { op: "put", key: "k", value: "acme-value", ttlMs: 60_000 } as const;

    await inOrg(ACME)(Effect.flatMap(resolveBackend(), (backend) => backend.run(address, [put])));

    const read = (org: OrgId) =>
      inOrg(org)(
        Effect.flatMap(resolveBackend(), (backend) =>
          backend.run(address, [{ op: "get", key: "k" }]),
        ),
      );

    expect(await read(ACME)).toEqual([expect.objectContaining({ value: "acme-value" })]);
    expect(await read(GLOBAL_ORG)).toEqual([{ status: "ok", generation: 0 }]);

    const videoId = `video-${crypto.randomUUID()}`;
    await inOrg(ACME)(saveVideoBinding(videoId, { authId: "xai-a.json", model: "grok" }, 60_000));
    expect(await inOrg(ACME)(loadVideoBinding(videoId))).toEqual({
      authId: "xai-a.json",
      model: "grok",
    });
    expect(await inOrg(GLOBAL_ORG)(loadVideoBinding(videoId))).toBeUndefined();
  });
});
