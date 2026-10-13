// Orgs through the management API (ADR 0021): platform admins list, create and rename orgs, address one with
// `/v8/management/orgs/<slug>/...`, and everyone else keeps to `global`. Through the router with the real ControlPlanes
// and a Platform registry of its own (`isolatedPlatform`).
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { ApiKeysList } from "../src/management/contract/api-keys.ts";
import type { RoutingModels } from "../src/management/contract/routing.ts";
import type { SettingsView } from "../src/management/contract/settings.ts";
import { GLOBAL_ORG, OrgId } from "../src/platform/org.ts";
import {
  claudeFile,
  controlPlane,
  isolatedPlatform,
  jsonInit,
  makeHarness,
  resetControlPlane,
  serviceToken,
  token,
} from "./support/management.ts";

const registry = isolatedPlatform();

const harness = makeHarness(undefined, registry.bindings);

afterAll(harness.dispose);

const CAROL = "carol@example.com";

/** An admin of `global` through her membership there (`seedCarol`), and of no other org. */
const asCarol = async () => ({ auth: await token(CAROL) });

beforeEach(async () => {
  await resetControlPlane();
});

interface OrgBody {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly created_at: string;
}

const orgs = async (): Promise<ReadonlyArray<OrgBody>> =>
  ((await harness.json("/v8/management/orgs")).body as { orgs: ReadonlyArray<OrgBody> }).orgs;

type Payload = Parameters<typeof jsonInit>[1];

const create = (body: Payload) => harness.json("/v8/management/orgs", jsonInit("POST", body));

const patch = (slug: string, body: Payload) =>
  harness.json(`/v8/management/orgs/${slug}`, jsonInit("PATCH", body));

const seedCarol = async () => {
  const added = await controlPlane().addMember(
    { email: CAROL, role: "admin" },
    { role: "owner", sensitive: true },
    "test",
  );

  expect(added.ok || added.error === "member_exists").toBe(true);
};

describe("the org list", () => {
  it("starts with the org global, slug default", async () => {
    const reply = await harness.json("/v8/management/orgs");

    expect(reply.status).toBe(200);
    expect(reply.body).toEqual({
      orgs: [
        {
          id: GLOBAL_ORG,
          slug: "default",
          name: "Default",
          created_at: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
        },
      ],
    });
  });

  it("lists a created org after global, in creation order", async () => {
    await create({ slug: "list-one", name: "One" });
    await create({ slug: "list-two", name: "Two" });

    expect((await orgs()).map((org) => org.slug)).toEqual(
      expect.arrayContaining(["default", "list-one", "list-two"]),
    );
    const slugs = (await orgs()).map((org) => org.slug);
    expect(slugs[0]).toBe("default");
    expect(slugs.indexOf("list-one")).toBeLessThan(slugs.indexOf("list-two"));
  });
});

describe("creating an org", () => {
  it("lets a platform admin create one and answers with its record", async () => {
    const reply = await create({ slug: "created", name: "  Created Inc  " });

    expect(reply.status).toBe(201);
    expect(reply.body).toEqual({
      id: expect.stringMatching(/^org-[0-9a-f]{16}$/),
      slug: "created",
      name: "Created Inc",
      created_at: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
    });

    expect((await orgs()).find((org) => org.slug === "created")?.id).toBe(
      (reply.body as OrgBody).id,
    );
    expect(reply.headers.get("cache-control")).toBe("no-store");
  });

  it("keeps slugs unique", async () => {
    expect((await create({ slug: "taken", name: "First" })).status).toBe(201);

    const again = await create({ slug: "taken", name: "Second" });
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ error: "slug_taken" });

    // The seeded org holds its slug too.
    expect((await create({ slug: "default", name: "Again" })).status).toBe(409);
    expect((await orgs()).filter((org) => org.slug === "taken")).toHaveLength(1);
  });

  it.each([
    [{ slug: "Not Valid", name: "A" }, "invalid_slug"],
    [{ slug: "-lead", name: "A" }, "invalid_slug"],
    [{ slug: "", name: "A" }, "invalid_slug"],
    [{ slug: "ok-slug", name: "   " }, "invalid_name"],
    [{ slug: "ok-slug", name: "x".repeat(101) }, "invalid_name"],
  ])("refuses %j with 422 %s", async (body, error) => {
    const reply = await create(body);

    expect(reply.status).toBe(422);
    expect(reply.body).toMatchObject({ error, message: expect.any(String) });
  });

  it.each([
    [{}],
    [{ slug: "only-slug" }],
    [{ name: "Only name" }],
    [{ slug: 1, name: "A" }],
    [{ slug: "a", name: "A", id: "org-x" }],
    [["a"]],
  ])("refuses the body %j with 400", async (body) => {
    const reply = await create(body);

    expect(reply.status).toBe(400);
    expect(reply.body).toEqual({ error: "invalid body" });
  });

  it("refuses an unreadable body", async () => {
    const reply = await harness.json("/v8/management/orgs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });

    expect(reply.status).toBe(400);
  });
});

describe("renaming an org", () => {
  it("changes the name and the slug, keeping the id", async () => {
    const made = (await create({ slug: "before", name: "Before" })).body as OrgBody;
    const renamed = await patch("before", { slug: "after", name: "After" });

    expect(renamed.status).toBe(200);
    expect(renamed.body).toMatchObject({ id: made.id, slug: "after", name: "After" });

    // The old address is gone, the new one reaches the same org.
    expect((await harness.json("/v8/management/orgs/before/settings")).status).toBe(404);
    expect((await harness.json("/v8/management/orgs/after/settings")).status).toBe(200);
    expect((await patch("after", { name: "Only the name" })).body).toMatchObject({
      id: made.id,
      slug: "after",
      name: "Only the name",
    });
  });

  it("can rename the org global's slug, which only changes its address", async () => {
    expect((await patch("default", { slug: "home" })).status).toBe(200);
    expect((await harness.json("/v8/management/orgs/default/settings")).status).toBe(404);
    expect((await harness.json("/v8/management/orgs/home/settings")).status).toBe(200);
    expect((await patch("home", { slug: "default" })).status).toBe(200);
  });

  it("refuses a slug in use, an unknown org and a bad body", async () => {
    await create({ slug: "rename-a", name: "A" });
    await create({ slug: "rename-b", name: "B" });

    expect(await patch("rename-a", { slug: "rename-b" })).toMatchObject({
      status: 409,
      body: { error: "slug_taken" },
    });
    expect(await patch("rename-nobody", { name: "X" })).toMatchObject({
      status: 404,
      body: { error: "org_not_found" },
    });
    expect(await patch("rename-a", { slug: "Bad Slug" })).toMatchObject({
      status: 422,
      body: { error: "invalid_slug" },
    });
    expect(await patch("rename-a", { name: "" })).toMatchObject({
      status: 422,
      body: { error: "invalid_name" },
    });
    expect((await patch("rename-a", {})).status).toBe(400);
    expect((await patch("rename-a", { slug: 5 })).status).toBe(400);
    expect((await patch("rename-a", { id: "org-x" })).status).toBe(400);
  });
});

describe("who may manage the list of orgs", () => {
  it("is a platform admin only: an admin of global gets 403 platform_admin_required", async () => {
    await seedCarol();
    const carol = await asCarol();

    // She is an admin of global ...
    expect((await harness.json("/v8/management/settings", carol)).status).toBe(200);

    // ... but not of the platform.
    const forbidden = { status: 403, body: { error: "platform_admin_required" } };

    expect(await harness.json("/v8/management/orgs", carol)).toMatchObject(forbidden);

    expect(
      await harness.json("/v8/management/orgs", {
        ...jsonInit("POST", { slug: "carol-org", name: "Carol" }),
        ...carol,
      }),
    ).toMatchObject(forbidden);

    expect(
      await harness.json("/v8/management/orgs/default", {
        ...jsonInit("PATCH", { name: "Mine" }),
        ...carol,
      }),
    ).toMatchObject(forbidden);

    expect((await orgs()).some((org) => org.slug === "carol-org")).toBe(false);
    expect((await orgs()).find((org) => org.slug === "default")?.name).toBe("Default");
  });

  it("refuses a plain member, who still learns who they are", async () => {
    const dave = { auth: await token("dave@example.com") };

    expect((await harness.json("/v8/management/orgs", dave)).status).toBe(403);
    // `global` lets everyone Access admits join as a plain member (auto-join is on there).
    expect((await harness.json("/v8/management/me", dave)).body).toEqual({
      platform_admin: false,
      role: "member",
      orgs: [{ slug: "default", name: "Default" }],
      private_credentials: true,
    });
    expect((await harness.json("/v8/management/orgs", { auth: false })).status).toBe(401);
  });

  it("lets a service token named in PLATFORM_ADMIN_SERVICE_TOKENS create orgs", async () => {
    const service = makeHarness(undefined, {
      ...registry.bindings,
      PLATFORM_ADMIN_SERVICE_TOKENS: "ops.access",
    });

    try {
      const reply = await service.json("/v8/management/orgs", {
        ...jsonInit("POST", { slug: "from-service", name: "From a token" }),
        auth: await serviceToken("ops.access"),
      });

      expect(reply.status).toBe(201);
    } finally {
      await service.dispose();
    }
  });
});

describe("GET /me", () => {
  it("tells a platform admin it is one and lists every org", async () => {
    await create({ slug: "me-org", name: "Me Org" });
    const reply = await harness.json("/v8/management/me");

    expect(reply.status).toBe(200);

    const body = reply.body as {
      platform_admin: boolean;
      orgs: ReadonlyArray<{ slug: string; name: string }>;
    };

    expect(body.platform_admin).toBe(true);
    expect(body.orgs[0]).toEqual({ slug: "default", name: "Default" });
    expect(body.orgs).toContainEqual({ slug: "me-org", name: "Me Org" });
  });

  it("tells an admin of global its role and that its org is global, whatever its slug is now", async () => {
    await seedCarol();
    await create({ slug: "not-hers", name: "Not hers" });

    const carol = await harness.json("/v8/management/me", await asCarol());

    expect(carol.body).toEqual({
      platform_admin: false,
      role: "admin",
      orgs: [{ slug: "default", name: "Default" }],
      private_credentials: true,
    });

    await patch("default", { slug: "renamed-home" });

    try {
      expect((await harness.json("/v8/management/me", await asCarol())).body).toEqual({
        platform_admin: false,
        role: "admin",
        orgs: [{ slug: "renamed-home", name: "Default" }],
        private_credentials: true,
      });
    } finally {
      await patch("renamed-home", { slug: "default" });
    }
  });
});

describe("org-scoped management routes", () => {
  const upload = (name: string) =>
    harness.json(`/v8/management/credentials?name=${name}`, jsonInit("POST", claudeFile()));

  const credentialNames = async (prefix: string): Promise<ReadonlyArray<string>> => {
    const reply = await harness.json(`${prefix}/credentials`);
    expect(reply.status).toBe(200);

    return (reply.body as { files: ReadonlyArray<{ name: string }> }).files.map(
      (file) => file.name,
    );
  };

  it("reach the ControlPlane of the org in the URL, and the unscoped ones global's", async () => {
    const acme = (await create({ slug: "scoped-acme", name: "Acme" })).body as OrgBody;

    // Written through the org's address ...
    expect(
      (
        await harness.json(
          "/v8/management/orgs/scoped-acme/credentials?name=claude-acme.json",
          jsonInit("POST", claudeFile() as never),
        )
      ).status,
    ).toBe(200);

    // ... it is in that org's ControlPlane, and only there.
    expect(
      (await controlPlane(OrgId.make(acme.id)).listCredentials()).map((entry) => entry.id),
    ).not.toEqual([]);
    expect(await credentialNames("/v8/management/orgs/scoped-acme")).toEqual(["claude-acme.json"]);
    expect(await credentialNames("/v8/management")).toEqual([]);
    expect(await credentialNames("/v8/management/orgs/default")).toEqual([]);

    // Global's own are reached by its slug and without one.
    expect((await upload("claude-global.json")).status).toBe(200);
    expect(await credentialNames("/v8/management")).toEqual(["claude-global.json"]);
    expect(await credentialNames("/v8/management/orgs/default")).toEqual(["claude-global.json"]);
    expect(await credentialNames("/v8/management/orgs/scoped-acme")).toEqual(["claude-acme.json"]);
  });

  it("keep each org's config entries apart on every config route", async () => {
    await create({ slug: "scoped-cfg", name: "Cfg" });
    const ORG = "/v8/management/orgs/scoped-cfg";

    const strategy = async (base: string) =>
      ((await harness.json(`${base}/settings`)).body as SettingsView).values.routing.strategy;

    // Settings, at the org's own revisions.
    const saved = await harness.json(
      `${ORG}/settings`,
      jsonInit("PATCH", { revisions: {}, patch: { routing: { strategy: "fill-first" } } }),
    );

    expect(saved.status).toBe(200);
    expect(await strategy(ORG)).toBe("fill-first");
    expect(await strategy("/v8/management")).toBe("round-robin");
    // Duplicate slashes and case in the fixed prefix reach the same org and the same path.
    expect(await strategy("//V8/Management//Orgs/scoped-cfg/")).toBe("fill-first");

    // A key group, by id and revision.
    const written = await harness.json(
      `${ORG}/api-keys/groups`,
      jsonInit("PUT", {
        family: "claude",
        revision: 0,
        group: { keys: [{ "api-key": "sk-org" }] },
      }),
    );

    expect(written.status).toBe(200);

    const groups = async (base: string) =>
      ((await harness.json(`${base}/api-keys`)).body as ApiKeysList).families.claude;

    expect(await groups("/v8/management")).toEqual([]);
    const [group] = await groups(ORG);

    expect(group?.id).toBe((written.body as { id: string }).id);
    expect(
      (
        await harness.json(
          `${ORG}/api-keys/groups`,
          jsonInit("DELETE", {
            family: "claude",
            id: group?.id ?? "",
            revision: group?.revision ?? 0,
          }),
        )
      ).status,
    ).toBe(200);

    // A channel's model rules, at the revision in If-Match.
    const rule = await harness.json(`${ORG}/model-rules/exclusions/claude`, {
      method: "PUT",
      headers: { "content-type": "application/json", "if-match": "0" },
      body: JSON.stringify(["claude-opus-*"]),
    });

    expect(rule.status).toBe(200);

    const excluded = async (base: string) =>
      ((await harness.json(`${base}/routing/models`)).body as RoutingModels).excluded;

    expect(await excluded(ORG)).toEqual({ claude: ["claude-opus-*"] });
    expect(await excluded("/v8/management")).toEqual({});

    // The import replaces the org's entries only.
    const imported = await harness.json(`${ORG}/settings/import`, {
      method: "POST",
      headers: { "content-type": "application/yaml" },
      body: "routing:\n  strategy: weighted-round-robin\n",
    });

    expect(imported.status).toBe(200);
    expect(await strategy(ORG)).toBe("weighted-round-robin");
    expect(await excluded(ORG)).toEqual({});
    expect(await strategy("/v8/management")).toBe("round-robin");
  });

  it("keep the query of the request", async () => {
    await create({ slug: "scoped-query", name: "Query" });

    const reply = await harness.json(
      "/v8/management/orgs/scoped-query/credentials?page=1&page_size=1",
    );

    expect(reply.status).toBe(200);
  });

  it("answer 404 for an org the registry does not list, to a platform admin", async () => {
    expect((await harness.json("/v8/management/orgs/ghost/credentials")).status).toBe(404);
    expect((await harness.json("/o/ghost/accounts")).status).toBe(404);
  });

  it("answer 403 to an admin of global for any org they are no member of", async () => {
    await seedCarol();
    await create({ slug: "scoped-closed", name: "Closed" });
    const carol = await asCarol();

    expect((await harness.json("/v8/management/orgs/default/settings", carol)).status).toBe(200);
    expect((await harness.json("/v8/management/orgs/scoped-closed/settings", carol)).status).toBe(
      403,
    );
    // An org that does not exist answers like one she may not manage.
    expect((await harness.json("/v8/management/orgs/ghost/settings", carol)).status).toBe(403);
  });

  it("keep the guards of the cross-site rules", async () => {
    await create({ slug: "scoped-csrf", name: "Csrf" });

    const forged = await harness.json("/v8/management/orgs/scoped-csrf/settings/import", {
      method: "POST",
      headers: { origin: "https://evil.test", "content-type": "application/yaml" },
      body: "routing:\n  strategy: fill-first\n",
    });

    expect(forged.status).toBe(403);
    expect(
      ((await harness.json("/v8/management/orgs/scoped-csrf/settings")).body as SettingsView).values
        .routing.strategy,
    ).toBe("round-robin");

    const wrongType = await harness.json("/v8/management/orgs/scoped-csrf/settings/import", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "routing:\n  strategy: fill-first\n",
    });

    expect(wrongType.status).toBe(415);
  });
});
