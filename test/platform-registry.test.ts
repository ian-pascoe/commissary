// The Platform registry (ADR 0021): the deployment's orgs and the index of who belongs to which, in the `Platform`
// Durable Object. Each test uses an object of its own (`getByName`), so none sees another's orgs.
import { evictDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { DEFAULT_ORG_SLUG, GLOBAL_ORG, newOrgId } from "../src/platform/org.ts";
import { PLATFORM_NAME, platformOf } from "../src/platform/registry.ts";

const fresh = () => env.PLATFORM.getByName(`registry-${crypto.randomUUID()}`);

const NOW = 1_700_000_000_000;

describe("seed", () => {
  it("lists the org global with the slug default on first start", async () => {
    const platform = fresh();

    expect(await platform.listOrgs()).toEqual([
      { id: GLOBAL_ORG, slug: DEFAULT_ORG_SLUG, name: "Default", createdAt: expect.any(Number) },
    ]);
    expect((await platform.getOrgBySlug("default"))?.id).toBe(GLOBAL_ORG);
    expect((await platform.getOrgById("global"))?.slug).toBe("default");
  });

  it("keeps a renamed global when the object restarts", async () => {
    const platform = fresh();
    expect((await platform.updateOrg("default", { slug: "home", name: "Home" })).ok).toBe(true);

    // A restart runs the constructor again over the stored tables.
    await evictDurableObject(platform);
    const listed = await platform.listOrgs();

    expect(listed.map((org) => [org.id, org.slug, org.name])).toEqual([
      [GLOBAL_ORG, "home", "Home"],
    ]);
  });

  it("has a singleton the Worker reaches by name", async () => {
    expect(PLATFORM_NAME).toBe("platform");
    expect((await platformOf(env).listOrgs()).some((org) => org.id === GLOBAL_ORG)).toBe(true);
  });
});

describe("orgs", () => {
  it("creates an org under the id the caller prepared", async () => {
    const platform = fresh();
    const id = newOrgId();
    const created = await platform.createOrg({ slug: "prepared", name: "Prepared", id }, NOW);

    if (!created.ok) throw new Error(created.message);
    expect(created.org.id).toBe(id);
    expect((await platform.getOrgById(id))?.slug).toBe("prepared");
  });

  it("creates an org under a fresh id and refuses a slug in use", async () => {
    const platform = fresh();
    const created = await platform.createOrg({ slug: "acme", name: "  Acme Inc  " }, NOW);

    if (!created.ok) throw new Error(created.message);
    expect(created.org).toMatchObject({ slug: "acme", name: "Acme Inc", createdAt: NOW });
    expect(created.org.id).toMatch(/^org-[0-9a-f]{16}$/);
    expect(created.org.id).not.toBe(GLOBAL_ORG);

    const again = await platform.createOrg({ slug: "acme", name: "Other" }, NOW);
    expect(again).toMatchObject({ ok: false, error: "slug_taken" });
    // The slug of the seeded org is taken too.
    expect(await platform.createOrg({ slug: "default", name: "X" }, NOW)).toMatchObject({
      ok: false,
      error: "slug_taken",
    });

    expect((await platform.listOrgs()).map((org) => org.slug)).toEqual(["default", "acme"]);
    expect((await platform.getOrgBySlug("acme"))?.id).toBe(created.org.id);
  });

  it.each(["", "Acme", "-acme", "acme-", "a_b", "a b", "a/b", "a.b", "x".repeat(64)])(
    "refuses the slug %j",
    async (slug) => {
      expect(await fresh().createOrg({ slug, name: "Acme" }, NOW)).toMatchObject({
        ok: false,
        error: "invalid_slug",
      });
    },
  );

  it.each(["", "   ", "bad\nname", "x".repeat(101)])("refuses the name %j", async (name) => {
    expect(await fresh().createOrg({ slug: "acme", name }, NOW)).toMatchObject({
      ok: false,
      error: "invalid_name",
    });
  });

  it("renames the name and the slug, keeping the id, and keeps slugs unique", async () => {
    const platform = fresh();
    const acme = await platform.createOrg({ slug: "acme", name: "Acme" }, NOW);
    const beta = await platform.createOrg({ slug: "beta", name: "Beta" }, NOW + 1);

    if (!acme.ok || !beta.ok) throw new Error("setup");

    const renamed = await platform.updateOrg("acme", { slug: "acme-inc", name: "Acme Inc" });
    expect(renamed).toMatchObject({ ok: true, org: { id: acme.org.id, slug: "acme-inc" } });
    expect(await platform.getOrgBySlug("acme")).toBeUndefined();
    expect((await platform.getOrgBySlug("acme-inc"))?.name).toBe("Acme Inc");

    expect(await platform.updateOrg("beta", { slug: "acme-inc" })).toMatchObject({
      ok: false,
      error: "slug_taken",
    });
    // Keeping its own slug is not a clash; only the name changes.
    expect(await platform.updateOrg("beta", { slug: "beta", name: "Beta Ltd" })).toMatchObject({
      ok: true,
      org: { name: "Beta Ltd" },
    });
    expect(await platform.updateOrg("nobody", { name: "X" })).toMatchObject({
      ok: false,
      error: "not_found",
    });
    expect(await platform.updateOrg("beta", { slug: "Bad Slug" })).toMatchObject({
      ok: false,
      error: "invalid_slug",
    });
    expect(await platform.updateOrg("beta", { name: " " })).toMatchObject({
      ok: false,
      error: "invalid_name",
    });

    // The freed slug can be taken again, by an org with an id of its own.
    const reused = await platform.createOrg({ slug: "acme", name: "New Acme" }, NOW + 2);

    if (!reused.ok) throw new Error(reused.message);
    expect(reused.org.id).not.toBe(acme.org.id);
  });
});

describe("membership index", () => {
  const setup = async () => {
    const platform = fresh();
    const acme = await platform.createOrg({ slug: "acme", name: "Acme" }, NOW);
    const beta = await platform.createOrg({ slug: "beta", name: "Beta" }, NOW + 1);

    if (!acme.ok || !beta.ok) throw new Error("setup");

    return { platform, acme: acme.org, beta: beta.org };
  };

  it("finds the orgs of a person and the org of a service token", async () => {
    const { platform, acme, beta } = await setup();

    expect(
      await platform.replaceOrgIndex(acme.id, {
        emails: [" Alice@Example.com ", "bob@example.com", "alice@example.com"],
        serviceTokens: ["ci.access"],
      }),
    ).toEqual({ ok: true, members: 2, serviceTokens: 1, conflicts: [] });

    await platform.replaceOrgIndex(beta.id, { emails: ["ALICE@example.com"], serviceTokens: [] });

    expect((await platform.orgsOfEmail("alice@EXAMPLE.com")).map((org) => org.slug)).toEqual([
      "acme",
      "beta",
    ]);
    expect((await platform.orgsOfEmail("bob@example.com")).map((org) => org.slug)).toEqual([
      "acme",
    ]);
    expect(await platform.orgsOfEmail("nobody@example.com")).toEqual([]);
    expect((await platform.orgOfServiceToken("ci.access"))?.id).toBe(acme.id);
    expect(await platform.orgOfServiceToken("other.access")).toBeUndefined();
  });

  it("repairs an org's rows from its own lists, leaving other orgs alone", async () => {
    const { platform, acme, beta } = await setup();

    await platform.replaceOrgIndex(acme.id, {
      emails: ["alice@example.com", "stale@example.com"],
      serviceTokens: ["old.access"],
    });
    await platform.replaceOrgIndex(beta.id, { emails: ["alice@example.com"], serviceTokens: [] });

    // The ControlPlane of acme says stale left and the token changed.
    await platform.replaceOrgIndex(acme.id, {
      emails: ["alice@example.com"],
      serviceTokens: ["new.access"],
    });

    expect(await platform.orgsOfEmail("stale@example.com")).toEqual([]);
    expect(await platform.orgOfServiceToken("old.access")).toBeUndefined();
    expect((await platform.orgOfServiceToken("new.access"))?.id).toBe(acme.id);
    expect((await platform.orgsOfEmail("alice@example.com")).map((org) => org.slug)).toEqual([
      "acme",
      "beta",
    ]);
  });

  it("keeps a service token with the org that holds it and reports the clash", async () => {
    const { platform, acme, beta } = await setup();

    await platform.replaceOrgIndex(acme.id, { emails: [], serviceTokens: ["shared.access"] });

    expect(
      await platform.replaceOrgIndex(beta.id, { emails: [], serviceTokens: ["shared.access"] }),
    ).toEqual({ ok: true, members: 0, serviceTokens: 0, conflicts: ["shared.access"] });
    expect((await platform.orgOfServiceToken("shared.access"))?.id).toBe(acme.id);
    // Repairing the same org again is no clash with itself.
    expect(
      await platform.replaceOrgIndex(acme.id, { emails: [], serviceTokens: ["shared.access"] }),
    ).toMatchObject({ ok: true, serviceTokens: 1, conflicts: [] });
  });

  it("refuses to index an org the registry does not list", async () => {
    expect(
      await fresh().replaceOrgIndex("ghost", { emails: ["a@b.c"], serviceTokens: [] }),
    ).toEqual({ ok: false, error: "not_found" });
  });
});

describe("catalog refresh lease", () => {
  it("is held by one refresh at a time and given back with its token", async () => {
    const platform = fresh();
    const first = await platform.takeCatalogRefreshLease("cron");

    if (!first.ok) throw new Error("the first refresh takes the lease");

    const second = await platform.takeCatalogRefreshLease("panel");
    expect(second).toMatchObject({ ok: false, held: { source: "cron" } });

    await platform.releaseCatalogRefreshLease("not-the-token");
    expect((await platform.takeCatalogRefreshLease("panel")).ok).toBe(false);

    await platform.releaseCatalogRefreshLease(first.lease.token);
    expect((await platform.takeCatalogRefreshLease("panel")).ok).toBe(true);
  });
});
