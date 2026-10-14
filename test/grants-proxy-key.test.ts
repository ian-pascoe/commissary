// Grants apply to a proxy key like to an Access sign-in (ADR 0022, ADR 0023): the key resolves to its member, and the
// member's reach decides what the request may pick. An ungranted model answers like an unknown one (same 400 body),
// and a request without a member (a service token) is served by the default grant only, so upgrading changes nothing.
import { env } from "cloudflare:workers";
import { Effect, Layer } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { afterAll, describe, expect, it } from "vitest";
import { AccessPrincipal } from "../src/access/principal.ts";
import { unknownModelBody } from "../src/credentials/selection/failures.ts";
import { controlPlaneOf, GLOBAL_ORG } from "../src/platform/org.ts";
import {
  ADMIN,
  claudeFile,
  isolatedPlatform,
  jsonInit,
  makeHarness,
  token,
} from "./support/management.ts";

/** Picks the model in `?model=` for the caller the way the proxy handlers do (the identity's org and member). */
const pickForCaller = Effect.gen(function* () {
  const identity = yield* AccessPrincipal;
  const request = yield* HttpServerRequest.HttpServerRequest;
  const model = new URL(request.url, "https://proxy.test").searchParams.get("model") ?? "";

  const answer = yield* Effect.promise(
    async () =>
      await controlPlaneOf(env, identity.org).pick({
        providers: ["claude"],
        model,
        ...(identity.memberId === undefined ? {} : { memberId: identity.memberId }),
      }),
  );

  const body = answer.ok
    ? { credential: answer.credential.id }
    : {
        refused: answer.failure.code,
        status: answer.failure.httpStatus,
        body: answer.failure.body,
      };

  return HttpServerResponse.text(JSON.stringify(body), { contentType: "application/json" });
});

const registry = isolatedPlatform();

const harness = makeHarness(
  undefined,
  registry.bindings,
  GLOBAL_ORG,
  Layer.mergeAll(HttpRouter.add("POST", "/v1/chat/completions", pickForCaller)),
);

afterAll(harness.dispose);

interface Auth {
  readonly auth: string;
}

const as = async (email: string): Promise<Auth> => ({ auth: await token(email) });

const send = async (
  slug: string,
  path: string,
  who: Auth,
  method = "GET",
  body?: Parameters<typeof jsonInit>[1],
) =>
  await harness.json(`/v8/management/orgs/${slug}${path}`, {
    ...(body === undefined ? { method } : jsonInit(method, body)),
    ...who,
  });

const SONNET = "claude-sonnet-4-5";

const OPUS = "claude-opus-4-1";

/** An org with a shared Claude subscription, an admin and two plain members each holding a proxy key. */
const org = async () => {
  const slug = `grants-key-${crypto.randomUUID().slice(0, 8)}`;
  const platform = await as(ADMIN);

  expect(
    (await harness.json("/v8/management/orgs", jsonInit("POST", { slug, name: slug }))).status,
  ).toBe(201);

  const add = async (name: string, role: string) => {
    const email = `${name}-${slug}@example.com`;
    const reply = await send(slug, "/members", platform, "POST", { email, role });

    expect(reply.status).toBe(201);
    const who = await as(email);
    const created = await send(slug, "/proxy-keys", who, "POST", { name: "laptop" });

    expect(created.status).toBe(201);

    return {
      id: (reply.body as { id: string }).id,
      who,
      key: (created.body as { key: string }).key,
    };
  };

  const admin = await add("admin", "admin");
  const alice = await add("alice", "member");
  const bob = await add("bob", "member");

  expect(
    (await send(slug, "/credentials?name=shared.json", admin.who, "POST", claudeFile())).status,
  ).toBe(200);

  return { slug, admin, alice, bob };
};

const pick = async (key: string, model: string) =>
  (
    await harness.json(`/v1/chat/completions?model=${model}`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}` },
      auth: false,
    })
  ).body;

describe("grants and proxy keys", () => {
  it("serves any model to every key under the default grant", async () => {
    const { alice, bob } = await org();

    for (const { key } of [alice, bob])
      for (const model of [SONNET, OPUS])
        expect(await pick(key, model)).toEqual({ credential: "shared.json" });
  });

  it("serves Sonnet and refuses Opus to the member the example grant names, like an unknown model", async () => {
    const { slug, admin, alice, bob } = await org();
    const listed = await send(slug, "/grants", admin.who);

    const [fallback] = (listed.body as { grants: ReadonlyArray<{ id: string; revision: number }> })
      .grants;

    expect(
      (
        await harness.json(`/v8/management/orgs/${slug}/grants/${fallback?.id}`, {
          method: "DELETE",
          headers: { "if-match": String(fallback?.revision) },
          auth: admin.who.auth,
        })
      ).status,
    ).toBe(200);

    const granted = await send(slug, "/grants", admin.who, "POST", {
      subject: { kind: "member", id: alice.id },
      scope: { kind: "credential", id: "shared.json" },
      models: ["claude-sonnet-*"],
    });

    expect(granted.status).toBe(200);

    expect(await pick(alice.key, SONNET)).toEqual({ credential: "shared.json" });

    expect(await pick(alice.key, OPUS)).toEqual({
      refused: "model_not_found",
      status: 400,
      body: unknownModelBody(OPUS),
    });

    expect(await pick(bob.key, SONNET)).toMatchObject({ refused: "model_not_found", status: 400 });
  });
});
