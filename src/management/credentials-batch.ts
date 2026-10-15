/**
 * `POST /v9/management/credentials/batch {action, names}` (`batch` in contract/credentials.ts): enable, disable,
 * refresh the tokens of or delete several accounts (auth files, named by file name) at once, for the control panel's
 * selection on the Accounts page. Answers `200 {action, results, succeeded, failed, skipped}` with one result per
 * distinct name, in the order sent: `{name, ok}`, `{name, ok: false, error, message, status?}` (`not_found`,
 * `refresh_failed`, `unauthorized`: fixed reasons, never the upstream body) or `{name, ok: false, skipped: true}` (a
 * refresh of an account without a refresh token), so a partial failure says which accounts failed and why. Names are
 * taken as sent (file names are exact). A delete of a name that is no longer stored is `ok`: it is already gone.
 *
 * Workers addition, no Go counterpart (Go's panel deletes several files with `DELETE /auth-files` names and toggles
 * the rest one request each). One endpoint rather than the panel calling the single-account routes with bounded
 * concurrency, because:
 * - The ControlPlane is the single writer: one RPC runs the whole batch inside the object. Enable, disable and delete
 *   are applied in one synchronous pass (nothing interleaves; the refresh alarm is re-armed once), which is as atomic
 *   as the object gets without a transaction across credentials; per-account requests would each re-arm and could
 *   interleave with other writes.
 * - Subrequests: per-account requests cost one Access check and one RPC each; here a batch is one RPC from the Worker.
 *   Token refreshes are upstream calls the object makes itself, at most four at a time.
 * - The outcome is decided where the state is, so the answer per account is exactly what was stored.
 * A batch names at most `MAX_BATCH_NAMES` accounts, `MAX_BATCH_REFRESH_NAMES` for a refresh (`400` beyond; the body
 * is read up to {@link MAX_BODY_BYTES}, `413` beyond); the panel sends larger selections in several requests. Unknown
 * names and config provider keys (not auth files) are `not_found` results, not a failed request, except for a delete, which
 * answers every name that is no stored auth file `ok`: a config id must read like any unknown name, or the reply would
 * confirm a guessed id and with it a guessed provider key (`auth-index.ts`). A config provider key named by its `auth_index`
 * (the name the credential list gives OpenCode Go keys) answers `config_credential` for every action: it lives in the
 * config, and an index is public, so the clear answer confirms nothing.
 */
import { Effect, Option, Schema } from "effect";
import { BatchAction, batchLimit } from "./contract/credentials.ts";
import { boundedBodyText, controlPlane, handled, jsonReply, replyError } from "./http.ts";
import { currentViewer } from "./viewer.ts";

/** A hundred file names fit many times over. */
const MAX_BODY_BYTES = 64 * 1024;

const BatchRequest = Schema.Struct({ action: BatchAction, names: Schema.Array(Schema.String) });

const decodeRequest = Schema.decodeUnknownOption(Schema.fromJsonString(BatchRequest));

const batchCredentials = Effect.gen(function* () {
  const request = decodeRequest(yield* boundedBodyText(MAX_BODY_BYTES));

  if (Option.isNone(request)) {
    return yield* replyError(400, "invalid body", {
      message: "send {action: enable | disable | refresh | delete, names: [file name, …]}",
    });
  }

  const { action } = request.value;

  const names = [...new Set(request.value.names)].filter((name) => name !== "");
  const limit = batchLimit(action);

  if (names.length === 0) return yield* replyError(400, "names is required");

  if (names.length > limit) {
    return yield* replyError(400, "too many names", {
      message: `a ${action} batch names at most ${limit} accounts`,
    });
  }

  const viewer = yield* currentViewer;

  const results = yield* controlPlane("batchCredentials", (stub) =>
    stub.batchCredentials(action, names, viewer),
  );

  const succeeded = results.filter((result) => result.ok).length;
  const skipped = results.filter((result) => result.skipped === true).length;

  return jsonReply(200, {
    action,
    results,
    succeeded,
    failed: results.length - succeeded - skipped,
    skipped,
  });
});

export const credentialsBatchHandler = handled(batchCredentials);
