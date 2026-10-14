/**
 * The reach of one caller: the union of the grants that name them (ADR 0023). Pure; selection and the model
 * registry both ask it the same question, "may this caller use this upstream model on this shared credential?".
 *
 * Patterns match the UPSTREAM model a credential would call (after prefix stripping and alias resolution), so an alias
 * can never reach a model its caller has no grant for. A request without a member (a service token without a member
 * behind it) is named by no member or team grant: only grants for everyone apply.
 */
import { isModelExcluded } from "../credentials/selection/model-name.ts";
import { ALL_MODELS, type GrantEntry, type GrantTable } from "./grant.ts";

/** The credential a grant is asked about: its id and its executor key (`executorKey`). */
export interface GrantTarget {
  readonly id: string;
  readonly executor: string;
}

export interface Reach {
  /** Every model of every shared credential is allowed (the default grant): nothing needs filtering. */
  readonly unrestricted: boolean;
  /** Whether `model` (an upstream model name, thinking suffix ignored) may be used on the shared credential `target`. */
  permits(target: GrantTarget, model: string): boolean;
  /** Whether every model of the shared credential `target` is allowed, so its models need no resolving one by one. */
  coversAll(target: GrantTarget): boolean;
}

/** Allows everything. For callers that are not a request of a member (tests, the system); selection needs one stated. */
export const ALLOW_ALL: Reach = {
  unrestricted: true,
  permits: () => true,
  coversAll: () => true,
};

/** Who asks: the member of the request, if any, and the teams they belong to. */
export interface GrantHolder {
  readonly member?: string | undefined;
  readonly teams: ReadonlyArray<string>;
}

const names = (grant: GrantEntry, holder: GrantHolder): boolean => {
  switch (grant.subject.kind) {
    case "everyone":
      return true;
    case "member":
      return holder.member !== undefined && grant.subject.id === holder.member;
    case "team":
      return holder.teams.includes(grant.subject.id);
  }
};

const covers = (grant: GrantEntry, target: GrantTarget): boolean => {
  switch (grant.scope.kind) {
    case "all":
      return true;
    case "provider":
      return grant.scope.provider === target.executor.toLowerCase();
    case "credential":
      return grant.scope.id === target.id;
  }
};

/** The reach of `holder` under `grants`. */
export const reachOf = (grants: ReadonlyArray<GrantEntry>, holder: GrantHolder): Reach => {
  const applicable = grants.filter((grant) => names(grant, holder));

  const unrestricted = applicable.some(
    (grant) => grant.scope.kind === "all" && grant.models.includes(ALL_MODELS),
  );

  if (unrestricted) return ALLOW_ALL;

  const reaching = (target: GrantTarget) => applicable.filter((grant) => covers(grant, target));

  return {
    unrestricted: false,
    permits: (target, model) =>
      reaching(target).some((grant) => isModelExcluded(grant.models, model)),
    coversAll: (target) => reaching(target).some((grant) => grant.models.includes(ALL_MODELS)),
  };
};

/** The reach of `member` (none: a request without a member) under a registry's grant table. */
export const reachFromTable = (table: GrantTable, member: string | undefined): Reach =>
  reachOf(table.grants, {
    member,
    teams:
      member === undefined
        ? []
        : table.teams.filter((team) => team.members.includes(member)).map((team) => team.id),
  });
