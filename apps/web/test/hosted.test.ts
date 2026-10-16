import { describe, expect, it } from "vitest";
import {
  atOrgLimit,
  canCreateOrg,
  canSuspend,
  emailProblem,
  orgCountText,
  parseOrgLimit,
} from "../src/lib/hosted.ts";
import { issuableRoles, issuerText } from "../src/lib/management-keys.ts";
import { callerOf } from "../src/lib/role.ts";

describe("creating orgs", () => {
  it("is for platform admins, and for everyone on Commissary Cloud", () => {
    expect(canCreateOrg({ platform_admin: false })).toBe(false);
    expect(canCreateOrg({ platform_admin: true })).toBe(true);
    expect(canCreateOrg({ platform_admin: false, hosted: true })).toBe(true);
  });

  it("counts against the limit, except for platform admins", () => {
    const me = { platform_admin: false, hosted: true, org_limit: 3, owned_orgs: 3 };

    expect(atOrgLimit(me)).toBe(true);
    expect(atOrgLimit({ ...me, owned_orgs: 2 })).toBe(false);
    expect(atOrgLimit({ platform_admin: true, hosted: true })).toBe(false);
    expect(orgCountText(me)).toBe("3 of 3 orgs");
    expect(orgCountText({ platform_admin: true, hosted: true })).toBeUndefined();
  });

  it("suspends only for platform admins of Commissary Cloud", () => {
    expect(canSuspend({ platform_admin: true, hosted: true })).toBe(true);
    expect(canSuspend({ platform_admin: true })).toBe(false);
    expect(canSuspend({ platform_admin: false, hosted: true })).toBe(false);
  });
});

describe("people", () => {
  it("reads an org limit", () => {
    expect(parseOrgLimit("default")).toEqual({ kind: "default" });
    expect(parseOrgLimit("")).toEqual({ kind: "default" });
    expect(parseOrgLimit(" 5 ")).toEqual({ kind: "limit", value: 5 });
    expect(parseOrgLimit("0")).toEqual({ kind: "limit", value: 0 });
    expect(parseOrgLimit("1001")).toEqual({ kind: "invalid" });
    expect(parseOrgLimit("-1")).toEqual({ kind: "invalid" });
    expect(parseOrgLimit("2.5")).toEqual({ kind: "invalid" });
  });

  it("checks an email", () => {
    expect(emailProblem("a@b.co")).toBeUndefined();
    expect(emailProblem("nope")).toBeDefined();
  });
});

describe("management keys", () => {
  it("offers the roles up to the caller's", () => {
    expect(issuableRoles(callerOf({ role: "admin", platform_admin: false }))).toEqual([
      "member",
      "admin",
    ]);
    expect(issuableRoles(callerOf({ role: "owner", platform_admin: false }))).toEqual([
      "member",
      "admin",
      "owner",
    ]);
  });

  it("names a service token issuer", () => {
    expect(issuerText({ created_by: "service:abc" })).toBe("Service token abc");
    expect(issuerText({ created_by: "a@b.co" })).toBe("a@b.co");
  });
});
