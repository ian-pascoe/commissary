/**
 * Grants (ADR 0023, GLOSSARY "Grant"): which upstream models of which shared credentials a member may use.
 *
 * A grant names a subject (everyone, one member or one team), a scope (all shared credentials, every credential of one
 * provider, or one credential) and model patterns written like model exclusions (`claude-sonnet-*`, case-insensitive,
 * thinking suffix ignored). A member's reach is the union of the grants that name them; there is no deny.
 */

export type GrantSubject =
  | { readonly kind: "everyone" }
  | { readonly kind: "member"; readonly id: string }
  | { readonly kind: "team"; readonly id: string };

export type GrantScope =
  | { readonly kind: "all" }
  /** The executor key of the credentials (`executorKey`): `claude`, `codex`, `openai-compatible-<name>`, ... */
  | { readonly kind: "provider"; readonly provider: string }
  | { readonly kind: "credential"; readonly id: string };

/** What a grant says: who, which credentials, which upstream models. */
export interface GrantValue {
  readonly subject: GrantSubject;
  readonly scope: GrantScope;
  /** Model patterns (`*` wildcards); lower-case, trimmed and non-empty once stored. */
  readonly models: ReadonlyArray<string>;
}

/** A stored grant. */
export interface GrantEntry extends GrantValue {
  readonly id: string;
  readonly revision: number;
  readonly updated_at: number;
  readonly updated_by: string;
}

/** What the management routes read (`grantEntries` over RPC): the grants and the counter they were read at. */
export interface GrantsWire {
  readonly version: number;
  readonly grants: ReadonlyArray<GrantEntry>;
}

/** A grant write: `value` `null` deletes it; no `id` creates one (`revision` 0). */
export interface GrantChange {
  readonly id?: string;
  readonly revision: number;
  readonly value: GrantValue | null;
}

/** A team of the org as the registry needs it to resolve a member's grants. */
interface GrantTeam {
  readonly id: string;
  readonly members: ReadonlyArray<string>;
}

/**
 * Everything the Worker needs to compute any member's reach (`grantTable` over RPC). `version` moves with every
 * grant write and every change of who belongs to a team, so a registry view built from it is cached against it.
 */
export interface GrantTable {
  readonly version: number;
  readonly grants: ReadonlyArray<GrantEntry>;
  readonly teams: ReadonlyArray<GrantTeam>;
}

/** The pattern of the default grant: every model. */
export const ALL_MODELS = "*";

/** The default grant of a new org (ADR 0023). */
export const DEFAULT_GRANT: GrantValue = {
  subject: { kind: "everyone" },
  scope: { kind: "all" },
  models: [ALL_MODELS],
};

/** Lower-cased, trimmed, de-duplicated patterns in the order first written; blank entries dropped. */
export const normalizeModelPatterns = (models: ReadonlyArray<string>): string[] => {
  const seen = new Set<string>();

  for (const model of models) {
    const pattern = model.trim().toLowerCase();

    if (pattern !== "") seen.add(pattern);
  }

  return [...seen];
};
