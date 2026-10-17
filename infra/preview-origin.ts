/**
 * Where a Commissary Cloud preview (`pr-<number>`, `COMMISSARY_MODE=cloud`) serves its app, before the app Worker
 * exists (alchemy.run.ts). Deploy-time only; the Workers never read this file.
 *
 * The cycle: the app Worker binds the auth Worker (`AUTH`), so the auth Worker deploys first, yet the auth Worker must
 * know the app's origin (`APP_ORIGIN`: the one origin it trusts, and where a sign-in returns). On a deployed stage that
 * is `https://<app host>` (`COMMISSARY_APP_DOMAIN`), known from the settings; a preview serves workers.dev URLs only, so the app's URL is
 * an output of a Worker not deployed yet. On a preview the API Worker deploys before both, and every Worker of the
 * account shares its workers.dev subdomain: the app Worker gets an explicit name ({@link previewAppName}) and its origin
 * is that name under the API Worker's subdomain. Anything else fails the deploy rather than guessing.
 */

/** The explicit script name of a Cloud preview's app Worker (one DNS label, so at most 63 characters). */
export const previewAppName = (stage: string): string => `commissary-app-${stage}`;

/** A Cloud preview's app origin and the account's workers.dev domain, which its session cookie is scoped to. */
export interface PreviewOrigin {
  /** `https://<app name>.<account subdomain>.workers.dev`. */
  readonly appOrigin: string;
  /** `<account subdomain>.workers.dev`. */
  readonly accountDomain: string;
}

/** The workers.dev domain of a Worker's URL (`https://<worker>.<account subdomain>.workers.dev`). */
const WORKERS_DEV = /^[a-z0-9-]+\.([a-z0-9-]+\.workers\.dev)$/;

/**
 * The preview's app origin under the account subdomain of `apiUrl`, the preview API Worker's workers.dev URL. Throws
 * when there is none or it is no workers.dev URL.
 */
export const previewOrigin = (apiUrl: string | undefined, appName: string): PreviewOrigin => {
  if (apiUrl === undefined)
    throw new Error(
      "the preview API Worker has no workers.dev URL to derive the app's origin from",
    );

  const host = new URL(apiUrl).host;
  const accountDomain = WORKERS_DEV.exec(host)?.[1];

  if (accountDomain === undefined)
    throw new Error(
      `the preview API Worker's URL ${apiUrl} is no workers.dev URL: the app's origin cannot be derived from it`,
    );

  return { appOrigin: `https://${appName}.${accountDomain}`, accountDomain };
};
