// Test helpers for grants: grant builders and the allowance of a holder.
import { type GrantHolder, allowanceOf } from "../../src/grants/allowance.ts";
import type { GrantEntry, GrantScope, GrantSubject } from "../../src/grants/grant.ts";

export const everyone: GrantSubject = { kind: "everyone" };

export const member = (id: string): GrantSubject => ({ kind: "member", id });

export const team = (id: string): GrantSubject => ({ kind: "team", id });

export const allCredentials: GrantScope = { kind: "all" };

export const credential = (id: string): GrantScope => ({ kind: "credential", id });

export const provider = (name: string): GrantScope => ({ kind: "provider", provider: name });

let counter = 0;

export const grant = (
  subject: GrantSubject,
  scope: GrantScope,
  models: ReadonlyArray<string>,
): GrantEntry => {
  counter += 1;

  return {
    id: `grant-${counter}`,
    subject,
    scope,
    models,
    revision: counter,
    updated_at: 0,
    updated_by: "test",
  };
};

/** The allowance of a member (with the teams they belong to) under `grants`. */
export const allowanceFor = (
  grants: ReadonlyArray<GrantEntry>,
  holder: GrantHolder = { teams: [] },
) => allowanceOf(grants, holder);
