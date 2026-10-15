/**
 * The deployment mode (ADR 0026): a self-hosted Commissary keeps Cloudflare Access in front of the panel and the management
 * API; Commissary Cloud signs people in itself with Better Auth (`auth.ts`) and lets anyone sign up. New in the Workers
 * port, no Go counterpart.
 */

export type ProxyMode = "self-hosted" | "hosted";

/** `PROXY_MODE=hosted` (any case); anything else, unset included, is a self-hosted Commissary. */
export const proxyMode = (env: { readonly PROXY_MODE?: string | undefined }): ProxyMode =>
  (env.PROXY_MODE ?? "").trim().toLowerCase() === "hosted" ? "hosted" : "self-hosted";

export const isHosted = (env: { readonly PROXY_MODE?: string | undefined }): boolean =>
  proxyMode(env) === "hosted";
