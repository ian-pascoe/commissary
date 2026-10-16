// The errors test/getter-pipelining.test.ts provokes across Durable Object RPC on purpose. The tests and the Durable
// Objects share one isolate under vitest-pool-workers, so each such error is also reported as an unhandled rejection of
// the object's side; vitest.config.ts ignores these (and only these) through `isProvokedError`.

/** Carried by the message of every error the probe throws on purpose. */
export const PROVOKED_ERROR_MARKER = "[getter-probe]";

/** The probe part's method that vitest-pool-workers refuses as a pipelined call through the getter. */
export const REFUSED_THROUGH_GETTER = "pipelinedThroughGetter";

export const isProvokedError = (message: string): boolean =>
  message.includes(PROVOKED_ERROR_MARKER) ||
  message.includes(`the method "${REFUSED_THROUGH_GETTER}"`);
