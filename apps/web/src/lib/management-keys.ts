// The Management keys page's model: who a key was issued by, which roles the caller may give one and what a refused write
// says. Pure: no DOM, tested in test/management-keys.test.ts.
import type { ManagementKeyView } from "@commissary/contract/management-keys";
import { asSentence } from "./failure.ts";
import { formatAgo, formatDate } from "./format.ts";
import { type Caller, ROLES, atLeast, type OrgRole } from "./role.ts";

/** A key holds a role no higher than the issuer's. */
export const issuableRoles = (caller: Caller): ReadonlyArray<OrgRole> =>
  ROLES.filter((role) => atLeast(caller.role, role));

const SERVICE = "service:";

/** Who issued a key: an email, or "Service token <id>". */
export const issuerText = (key: Pick<ManagementKeyView, "created_by">): string =>
  key.created_by.startsWith(SERVICE)
    ? `Service token ${key.created_by.slice(SERVICE.length)}`
    : key.created_by;

const instant = (iso: string | undefined): number | undefined => {
  if (iso === undefined) return undefined;
  const ms = Date.parse(iso);

  return Number.isNaN(ms) ? undefined : ms;
};

export const keyCreatedText = (key: ManagementKeyView): string => {
  const created = instant(key.created_at);

  return created === undefined ? key.created_at : formatDate(created);
};

export const keyLastUsedText = (key: ManagementKeyView, now: number): string => {
  const used = instant(key.last_used_at);

  return used === undefined ? "Never" : formatAgo(Math.max(0, now - used));
};

/** Newest first. */
export const sortManagementKeys = (
  keys: ReadonlyArray<ManagementKeyView>,
): ReadonlyArray<ManagementKeyView> =>
  keys.toSorted(
    (a, b) =>
      (instant(b.created_at) ?? 0) - (instant(a.created_at) ?? 0) || a.id.localeCompare(b.id),
  );

/** What a refused management key write says, by the server's error code. */
export const managementKeyProblem = (
  error: string | undefined,
  message: string,
  detail?: string,
): string => {
  switch (error) {
    case "invalid_name":
      return "A name is 1 to 100 characters without control characters.";
    case "role_too_high":
      return "A key cannot hold a higher role than yours. Pick your role or a lower one.";
    case "management_key_forbidden":
      return "A management key cannot issue or revoke management keys. Do it from the panel.";
    case "too_many_keys":
      return "This org holds as many management keys as it may. Revoke keys you no longer use.";
    case "management_key_not_found":
      return "That key no longer exists. Reload to see the current list.";
    default:
      return detail === undefined ? message : asSentence(detail);
  }
};
