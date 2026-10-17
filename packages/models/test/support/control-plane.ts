// The ControlPlane of an org in tests that reach the Models part directly: its stub, a reset to a pristine part (no
// credentials, default config, no price overrides), an auth file and a JSON request body.
import { env } from "cloudflare:workers";
import { GLOBAL_ORG, type OrgId } from "@commissary/core";
import type { Json } from "@commissary/json";
import { controlPlaneOf } from "@commissary/state";
import { FULL_ACCESS } from "../../src/credentials/ownership.ts";

/** The ControlPlane of `org` (`global` by default). */
export const controlPlane = (org: OrgId = GLOBAL_ORG) => controlPlaneOf(env, org);

/** Restores a pristine ControlPlane of `org` (no credentials, default config). */
export const resetOrgControlPlane = async (org: OrgId): Promise<void> => {
  const stub = controlPlane(org);
  const entries = await stub.models().listCredentials(FULL_ACCESS);
  await stub.models().removeCredentials(
    entries.map((entry) => entry.id),
    FULL_ACCESS,
  );
  await stub.models().importConfig("", "test");

  // An import leaves the price overrides alone.
  for (const override of (await stub.models().priceOverrideEntries()).overrides)
    await stub
      .models()
      .writePriceOverride({ id: override.id, revision: override.revision, value: null }, "test");
};

/** Restores a pristine ControlPlane of `global` (no credentials, default config); usable as a `beforeEach` hook. */
export const resetControlPlane = async (): Promise<void> => {
  await resetOrgControlPlane(GLOBAL_ORG);
};

export const jsonInit = (method: string, body: Json): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

export const claudeFile = (extra: Record<string, unknown> = {}) => ({
  type: "claude",
  email: "me@x.com",
  access_token: "sk-ant-oat-secret-access",
  refresh_token: "secret-refresh",
  expired: "2999-01-01T00:00:00Z",
  ...extra,
});
