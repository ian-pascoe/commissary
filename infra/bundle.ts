/**
 * Module aliases of the Worker's bundle (`alchemy.run.ts`) and of the tests (`vitest.config.ts`): smaller stand-ins
 * for dependencies of dependencies whose full code the Worker does not need. Every module of the bundle is compiled
 * when the Worker starts, also those only imported lazily, and startup has a CPU time limit.
 */
import { fileURLToPath } from "node:url";

export const BUNDLE_ALIASES = {
  // Better Auth's SSO plugin reads host names only (src/sso/tldts.ts).
  tldts: fileURLToPath(new URL("../src/sso/tldts.ts", import.meta.url)),
} as const;
