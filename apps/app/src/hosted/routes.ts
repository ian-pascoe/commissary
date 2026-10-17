/**
 * The app host's part of Commissary Cloud's sign-in (ADR 0026, ADR 0030): the sign-in page (`/sign-in`), which is the
 * panel's. Better Auth's API (`/api/auth/*`) and the sign-in options are the auth Worker's, on the auth host
 * (apps/auth), which the page calls across origins. On a self-hosted Commissary the page does not exist: it answers like
 * any unknown path. New in the Workers port.
 */
import { HttpRouter } from "effect/http";
import { SIGN_IN_PAGE_PATH } from "@commissary/contract/sign-in";
import { panelIndex } from "../management/web-panel.ts";
import { hostedOnly } from "./only.ts";

/** `GET /sign-in`: the panel, which shows its sign-in page there. */
const signInPage = hostedOnly(panelIndex);

export const HostedRoutes = HttpRouter.addAll([
  HttpRouter.route("GET", SIGN_IN_PAGE_PATH, signInPage),
]);
