/**
 * Credential lookups and result types of the management RPCs of the ControlPlane Durable Object.
 *
 * Go source: internal/api/handlers/management/auth_files.go (`matchesAuthFileLookup`, `lookupAuthFile`),
 * api_tools.go (`tokenValueFromMetadata`, `tokenValueForAuth`). Everything here is plain data so it can cross the
 * Durable Object RPC boundary.
 */
import type { Schema } from "effect";
import type { Json } from "../json/index.ts";
import type { Credential } from "../credentials/model.ts";
import type { RefreshTarget } from "../credentials/pool.ts";
import type { AuthIndexer } from "./auth-index.ts";

/** A credential reference as the panel sends it: file name (or id) and/or `auth_index`. */
export interface CredentialRef {
  readonly name?: string;
  readonly authIndex?: string;
}

/**
 * `matchesAuthFileLookup`: both given criteria must match; a reference without criteria matches nothing. `authIndexOf`
 * is the deployment's indexer.
 *
 * Deviation from Go: `name` matches auth files only. A config provider key is addressed by its `auth_index`: its id is
 * derived from the key and never published, and matching it would let a caller confirm guessed keys.
 */
export const findCredential = (
  entries: ReadonlyArray<RefreshTarget>,
  ref: CredentialRef,
  authIndexOf: AuthIndexer,
): RefreshTarget | undefined => {
  const name = ref.name?.trim() ?? "";
  // Indexes are lower-case hex; match them case-insensitively like every other `auth_index` input.
  const authIndex = ref.authIndex?.trim().toLowerCase() ?? "";

  if (name === "" && authIndex === "") return undefined;

  return entries.find(
    (entry) =>
      (name === "" || (entry.credential.source === "file" && entry.credential.id === name)) &&
      (authIndex === "" || authIndexOf(entry.credential.id) === authIndex),
  );
};

export type RefreshOneResult =
  | {
      readonly ok: true;
      readonly refreshed: boolean;
      readonly entry: Record<string, Schema.MutableJson>;
    }
  | { readonly ok: false; readonly error: "not_found" }
  | { readonly ok: false; readonly error: "refresh_failed"; readonly message: string };

export interface RefreshAllItem {
  readonly id: string;
  readonly success: boolean;
  readonly error?: string;
}

export type CredentialMutation =
  | { readonly ok: true; readonly id: string }
  | {
      readonly ok: false;
      readonly error: "not_found" | "invalid";
      readonly message: string;
      /** The field a refused value belongs to (`invalid` only). */
      readonly path?: string;
    };

const text = (value: Json | undefined): string => (typeof value === "string" ? value.trim() : "");

/**
 * `tokenValueFromMetadata` + `tokenValueForAuth`: the value Go's `api-call` substitutes for `$TOKEN$` (not ported), the
 * token the quota probes send (`quota/target.ts`).
 */
export const apiCallToken = (credential: Pick<Credential, "metadata" | "attributes">): string => {
  const { metadata } = credential;
  const direct = text(metadata.accessToken) || text(metadata.access_token);

  if (direct !== "") return direct;
  const nested = metadata.token;

  if (typeof nested === "object" && nested !== null && !Array.isArray(nested)) {
    const value = text(nested.access_token) || text(nested.accessToken);

    if (value !== "") return value;
  }

  return (
    text(metadata.token) ||
    text(metadata.id_token) ||
    text(metadata.api_key) ||
    text(metadata.session_token) ||
    text(metadata.cookie) ||
    text(credential.attributes.api_key) ||
    text(credential.attributes.session_token)
  );
};
