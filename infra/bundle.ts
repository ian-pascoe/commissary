/**
 * Module aliases of the app and auth Workers' bundles (`alchemy.run.ts`) and of their tests (`apps/app/vitest.config.ts`,
 * `apps/auth/vitest.config.ts`): smaller
 * stand-ins for dependencies of dependencies whose full code the Worker does not need. Every module of the bundle is
 * compiled when the Worker starts, also those only imported lazily, and startup has a CPU time limit.
 */
// Node's `URL`, not the global one: this module is also type-checked in the Worker project, where the global is workerd's.
import { URL, fileURLToPath } from "node:url";

export const BUNDLE_ALIASES = {
  // Better Auth's SSO plugin reads host names only (packages/auth/src/sso/tldts.ts).
  tldts: fileURLToPath(new URL("../packages/auth/src/sso/tldts.ts", import.meta.url)),
} as const;
