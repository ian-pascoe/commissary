// Which org the panel shows, and how its API calls are addressed (web/src/lib/org.ts).
import { describe, expect, it } from "vitest";
import { orgPanelPath, orgSlugOfPath, panelBasepath, scopedApiUrl } from "../web/src/lib/org.ts";

describe("orgSlugOfPath", () => {
  it.each([
    ["/o/acme", "acme"],
    ["/o/acme/", "acme"],
    ["/o/acme/accounts/claude-a.json", "acme"],
    ["/o/ACME/accounts", "acme"],
    ["/O/acme", "acme"],
  ])("reads the slug of %s", (path, slug) => {
    expect(orgSlugOfPath(path)).toBe(slug);
  });

  it.each(["/", "/accounts", "/o", "/o/", "/other/acme", "/x/o/acme"])(
    "finds none in %s",
    (path) => {
      expect(orgSlugOfPath(path)).toBeUndefined();
    },
  );
});

describe("panelBasepath and orgPanelPath", () => {
  it("is the org's prefix, or the root for an address without an org", () => {
    expect(panelBasepath("/o/acme/accounts")).toBe("/o/acme");
    expect(panelBasepath("/o/Acme")).toBe("/o/acme");
    expect(panelBasepath("/accounts")).toBe("/");
    expect(panelBasepath("/")).toBe("/");
  });

  it("builds the address of a page of an org", () => {
    expect(orgPanelPath("acme")).toBe("/o/acme/");
    expect(orgPanelPath("acme", "/")).toBe("/o/acme/");
    expect(orgPanelPath("acme", "/accounts")).toBe("/o/acme/accounts");
  });
});

describe("scopedApiUrl", () => {
  it("inserts the org after the management prefix, in paths and absolute URLs", () => {
    expect(scopedApiUrl("/v8/management/credentials", "acme")).toBe(
      "/v8/management/orgs/acme/credentials",
    );
    expect(scopedApiUrl("https://proxy.test/v8/management/config/routing?x=1", "acme")).toBe(
      "https://proxy.test/v8/management/orgs/acme/config/routing?x=1",
    );
    expect(scopedApiUrl("/v8/management/oauth/import?provider=vertex", "acme")).toBe(
      "/v8/management/orgs/acme/oauth/import?provider=vertex",
    );
  });

  it("leaves the platform-level routes alone", () => {
    for (const url of [
      "/v8/management/me",
      "/v8/management/orgs",
      "/v8/management/orgs/acme",
      "https://proxy.test/v8/management/orgs?x=1",
      "/v8/management/me?x=1",
    ])
      expect(scopedApiUrl(url, "acme")).toBe(url);
  });

  it("scopes routes whose name merely starts like a platform-level one", () => {
    expect(scopedApiUrl("/v8/management/orgsx", "acme")).toBe("/v8/management/orgs/acme/orgsx");
    expect(scopedApiUrl("/v8/management/media", "acme")).toBe("/v8/management/orgs/acme/media");
  });

  it("changes nothing without an org or for another API", () => {
    expect(scopedApiUrl("/v8/management/credentials", undefined)).toBe(
      "/v8/management/credentials",
    );
    expect(scopedApiUrl("/v1/models", "acme")).toBe("/v1/models");
  });

  it("encodes a slug", () => {
    expect(scopedApiUrl("/v8/management/config", "a b")).toBe("/v8/management/orgs/a%20b/config");
  });
});
