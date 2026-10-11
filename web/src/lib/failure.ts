// What a failed management call tells the operator: the server's own message when it sent one, otherwise the likely
// cause and the recovery.
import { Cause, Option } from "effect";
import type { AsyncResult } from "effect/reactivity";
import { ManagementError } from "#contract/errors.ts";

/** Server messages are lower-case fragments ("the control plane is unavailable"); print them as a sentence. */
export const asSentence = (message: string): string => {
  const trimmed = message.trim();

  if (trimmed === "") return "The server reported an error without a message.";

  const capitalised = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);

  return /[.!?]$/.test(capitalised) ? capitalised : `${capitalised}.`;
};

/** The server's own error text (`conflict`, `unknown_auth_index`, ...), when it sent one. */
export const serverError = (cause: Cause.Cause<unknown>): string | undefined => {
  const failure = Cause.findErrorOption(cause);

  return Option.isSome(failure) && failure.value instanceof ManagementError
    ? failure.value.error
    : undefined;
};

/**
 * The server's own explanation of a failure, the config path it is about and, for YAML that does not parse, the
 * 1-based line and column, when it sent them.
 */
export interface ServerDetail {
  readonly message?: string;
  readonly path?: string;
  readonly line?: number;
  readonly column?: number;
}

/** The server's `message`, `path`, `line` and `column` (a refused setting says which and why), when it sent them. */
export const serverDetail = (cause: Cause.Cause<unknown>): ServerDetail => {
  const failure = Cause.findErrorOption(cause);

  if (Option.isNone(failure) || !(failure.value instanceof ManagementError)) return {};
  const { message, path, line, column } = failure.value;

  return {
    ...(message === undefined ? {} : { message }),
    ...(path === undefined ? {} : { path }),
    ...(line === undefined ? {} : { line }),
    ...(column === undefined ? {} : { column }),
  };
};

/** What a failed call's cause tells the operator (a mutation's `Exit` carries one). */
export const causeMessage = (cause: Cause.Cause<unknown>): string => {
  const failure = Cause.findErrorOption(cause);

  if (Option.isSome(failure) && failure.value instanceof ManagementError) {
    return asSentence(failure.value.error);
  }

  return "The server did not answer. If your Access session expired, reload the page to sign in again.";
};

export const failureMessage = <A, E>(result: AsyncResult.Failure<A, E>): string =>
  causeMessage(result.cause);
