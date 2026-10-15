/**
 * Pieces shared by the contract groups that edit config entries (`routing.ts` rule edits, `settings.ts`,
 * `provider-keys.ts`). Every config entry has a revision (ADR 0025): a write names the revision of each entry it changes
 * and is refused with `409 conflict` when one changed since; an entry that is not stored is at revision 0.
 * Shared with the browser: imports `effect` only.
 */
import { Schema } from "effect";

/** A config version: the org's change counter, which moves with every write. */
export const ConfigVersion = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/** The revision of one config entry (0: not stored). */
export const Revision = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/** Revisions by entry id; an id that is not listed is at revision 0. */
export const Revisions = Schema.Record(Schema.String, Revision);

export type Revisions = typeof Revisions.Type;

/** A saved config edit: `version` is the new change counter. */
export const Saved = Schema.Struct({ status: Schema.Literal("ok"), version: Schema.Int });

export type Saved = typeof Saved.Type;

/** A saved edit of one entry: its new `revision` (0 when it was removed). */
export const EntrySaved = Schema.Struct({
  status: Schema.Literal("ok"),
  version: Schema.Int,
  revision: Revision,
});

export type EntrySaved = typeof EntrySaved.Type;
