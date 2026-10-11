/**
 * Pieces shared by the contract groups that edit the config document (`routing.ts` rule edits, `settings.ts`).
 * Shared with the browser: imports `effect` only.
 */
import { Schema } from "effect";

/** A config version as sent back on a write (the `version` / `config_version` of the view it was made from). */
export const ConfigVersion = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/** A saved config edit: `version` is the new config version. */
export const Saved = Schema.Struct({ status: Schema.Literal("ok"), version: Schema.Int });

export type Saved = typeof Saved.Type;
