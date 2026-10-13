import { describe, expect, it } from "vitest";
import {
  addableRoles,
  callerOf,
  canChangeRoles,
  canManageMembers,
  canRemove,
  canSetAutoJoin,
  effectiveRole,
  holdsOnlyPrivate,
  homeFor,
  pageAllowed,
  pagesFor,
  roleOf,
  tokenRoleChanges,
  tokenRoles,
} from "../web/src/lib/role.ts";

const caller = (role: "owner" | "admin" | "member", platformAdmin = false) =>
  callerOf({ role, platform_admin: platformAdmin });

describe("the caller's role", () => {
  it("is the role in the org, an owner for a platform admin without one, a member otherwise", () => {
    expect(effectiveRole({ role: "admin", platform_admin: false })).toBe("admin");
    expect(effectiveRole({ role: null, platform_admin: true })).toBe("owner");
    expect(effectiveRole({ role: null, platform_admin: false })).toBe("member");
  });

  it("reads a picker's value as a role, or not at all", () => {
    expect(roleOf("admin")).toBe("admin");
    expect(roleOf("root")).toBeUndefined();
  });
});

describe("pages", () => {
  it("opens only Usage to a plain member and everything to an admin", () => {
    expect(pagesFor("member").map((page) => page.to)).toEqual(["/usage"]);
    expect(pagesFor("admin").map((page) => page.to)).toContain("/members");
    expect(homeFor("member")).toBe("/usage");
    expect(homeFor("admin")).toBe("/");
    expect(pageAllowed("member", "/usage")).toBe(true);
    expect(pageAllowed("member", "/usage/")).toBe(true);
    expect(pageAllowed("member", "/usage/prices")).toBe(false);
    expect(pageAllowed("member", "/members")).toBe(false);
    expect(pageAllowed("admin", "/usage/prices")).toBe(true);
  });
});

describe("private credentials in the panel (ADR 0023)", () => {
  it("opens a plain member their own accounts and API keys only where the org allows private credentials", () => {
    expect(pagesFor("member", true).map((page) => page.to)).toEqual([
      "/accounts",
      "/keys",
      "/usage",
    ]);
    expect(pagesFor("member", false).map((page) => page.to)).toEqual(["/usage"]);
    expect(pageAllowed("member", "/accounts", true)).toBe(true);
    expect(pageAllowed("member", "/accounts/connect", true)).toBe(true);
    expect(pageAllowed("member", "/keys/new", true)).toBe(true);
    expect(pageAllowed("member", "/accounts", false)).toBe(false);
    expect(pageAllowed("member", "/accountsabc", true)).toBe(false);
    expect(pageAllowed("member", "/models", true)).toBe(false);
    expect(pageAllowed("member", "/settings", true)).toBe(false);
    // A plain member still lands on Usage.
    expect(homeFor("member")).toBe("/usage");
  });

  it("reads the org's setting from /me, off when it is absent", () => {
    expect(callerOf({ role: "member", platform_admin: false }).privateCredentials).toBe(false);
    expect(
      callerOf({ role: "member", platform_admin: false, private_credentials: true })
        .privateCredentials,
    ).toBe(true);
    expect(holdsOnlyPrivate(caller("member"))).toBe(true);
    expect(holdsOnlyPrivate(caller("admin"))).toBe(false);
  });
});

describe("what each role may do with members", () => {
  it("lets admins add and remove plain members and owners do the rest", () => {
    expect(canManageMembers(caller("member"))).toBe(false);
    expect(addableRoles(caller("admin"))).toEqual(["member"]);
    expect(addableRoles(caller("owner"))).toEqual(["member", "admin", "owner"]);
    expect(canRemove(caller("admin"), "member")).toBe(true);
    expect(canRemove(caller("admin"), "admin")).toBe(false);
    expect(canRemove(caller("owner"), "owner")).toBe(true);
    expect(canChangeRoles(caller("admin"))).toBe(false);
    expect(canSetAutoJoin(caller("owner"))).toBe(true);
    expect(canSetAutoJoin(caller("admin"))).toBe(false);
  });

  it("keeps service tokens above member for platform admins", () => {
    expect(tokenRoles(caller("member"))).toEqual([]);
    expect(tokenRoles(caller("owner"))).toEqual(["member"]);
    expect(tokenRoles(caller("owner", true))).toEqual(["member", "admin", "owner"]);
    expect(tokenRoleChanges(caller("owner"), "admin")).toEqual(["member"]);
    expect(tokenRoleChanges(caller("admin"), "member")).toEqual([]);
  });
});
