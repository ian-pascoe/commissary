/**
 * Models' section of the export of an org (`GET /v9/management/export`, ADR 0027; the app Worker's `org-routes.ts`
 * builds the rest, #134 "The area package convention"), new in the Workers port: what an org owner may keep before the
 * org is deleted. Models' part is the org's shared config (with every secret as a preview, like every other view of
 * it), its price overrides, the credentials it holds (summaries, never tokens) and its grants. Usage records are not
 * part of it: the usage routes already page and export them.
 */
import { Effect } from "effect";
import { currentViewer } from "@commissary/auth";
import { isJsonObject, type Json, type JsonObject } from "@commissary/json";
import { maskHeaders, isSecretName, maskSecret } from "../credentials/summary.ts";
import { modelsControlPlane } from "../env.ts";
import type { GrantSubject } from "../grants/grant.ts";
import { storedConfig } from "./settings-routes.ts";

/** A proxy URL's credentials are secret; the rest of the address is not. */
const maskProxyUrl = (value: string): string => {
  if (!URL.canParse(value)) return value.includes("@") ? maskSecret(value) : value;
  const url = new URL(value);

  if (url.username === "" && url.password === "") return value;
  url.username = "[redacted]";
  url.password = "";

  return url.toString();
};

const isStringRecord = (value: Json): value is Record<string, string> =>
  isJsonObject(value) && Object.values(value).every((item) => typeof item === "string");

/**
 * `value` with every secret replaced by a preview: the values of keys named like a secret (`api-key`, `token`,
 * `secret`, `password`, ...) including lists of them, the secret-looking values of `headers`, and the credentials in a
 * `proxy-url`. Everything else is kept, so the export reads like the config it was made from.
 */
export const maskConfigSecrets = (value: Json): Json => {
  if (Array.isArray(value)) return value.map(maskConfigSecrets);

  if (!isJsonObject(value)) return value;

  const masked: JsonObject = {};

  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue;

    if (isSecretName(key) && typeof item === "string") masked[key] = maskSecret(item);
    else if (
      isSecretName(key) &&
      Array.isArray(item) &&
      item.every((entry) => typeof entry === "string")
    )
      masked[key] = item.map((entry) => maskSecret(String(entry)));
    else if (key === "headers" && isStringRecord(item)) masked[key] = maskHeaders(item);
    else if (key === "proxy-url" && typeof item === "string") masked[key] = maskProxyUrl(item);
    else masked[key] = maskConfigSecrets(item);
  }

  return masked;
};

/** Who the org's ids name, from the org-wide state: member ids to emails, team ids to names. */
export interface ExportNames {
  readonly members: ReadonlyMap<string, string>;
  readonly teams: ReadonlyMap<string, string>;
}

/** A grant's subject by what a person reads: the member's email or the team's name instead of an id. */
const exportedSubject = (subject: GrantSubject, names: ExportNames): JsonObject => {
  if (subject.kind === "member")
    return { kind: "member", email: names.members.get(subject.id) ?? "" };

  if (subject.kind === "team") return { kind: "team", name: names.teams.get(subject.id) ?? "" };

  return { kind: "everyone" };
};

/** Models' section of the current org's export, as the caller may see it; `names` turns grant subjects into people. */
export const exportSection = (names: ExportNames) =>
  Effect.gen(function* () {
    const viewer = yield* currentViewer;
    const config = yield* storedConfig;

    const prices = yield* modelsControlPlane("priceOverrideEntries", (stub) =>
      stub.models().priceOverrideEntries(),
    );

    const credentials = yield* modelsControlPlane("listCredentialEntries", (stub) =>
      stub.models().listCredentialEntries(viewer),
    );

    const grants = yield* modelsControlPlane("grantEntries", (stub) =>
      stub.models().grantEntries(),
    );

    const iso = (at: number) => new Date(at).toISOString();

    return {
      config: maskConfigSecrets(config.document),
      prices: prices.overrides.map(({ id: _id, revision: _revision, ...price }) => ({
        ...price,
        updated_at: iso(price.updated_at),
      })),
      credentials,
      grants: grants.grants.map((grant) => ({
        subject: exportedSubject(grant.subject, names),
        scope: grant.scope,
        models: grant.models,
        updated_at: iso(grant.updated_at),
      })),
    };
  });
