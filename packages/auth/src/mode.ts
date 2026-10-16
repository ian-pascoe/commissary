/**
 * The deployment mode (ADR 0026): a self-hosted Commissary keeps Cloudflare Access in front of the panel and the
 * management API; Commissary Cloud signs people in itself with Better Auth (the Worker's `hosted/auth.ts`) and lets
 * anyone sign up. New in the Workers port, no Go counterpart.
 */

export type CommissaryMode = "self-hosted" | "cloud";

/** `COMMISSARY_MODE=cloud` (any case); anything else, unset included, is a self-hosted Commissary. */
export const commissaryMode = (env: {
  readonly COMMISSARY_MODE?: string | undefined;
}): CommissaryMode =>
  (env.COMMISSARY_MODE ?? "").trim().toLowerCase() === "cloud" ? "cloud" : "self-hosted";

export const isHosted = (env: { readonly COMMISSARY_MODE?: string | undefined }): boolean =>
  commissaryMode(env) === "cloud";
