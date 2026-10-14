import "@fontsource-variable/atkinson-hyperlegible-next";
import "./styles/tokens.css";
import "./styles/base.css";
import { RegistryProvider } from "@effect/atom-react";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { panelOrgSlug } from "./api/client.ts";
import { SIGN_IN_PAGE_PATH } from "#contract/sign-in.ts";
import { OrgsPage } from "./pages/Orgs.tsx";
import { PeoplePage } from "./pages/People.tsx";
import { SignInPage } from "./pages/SignIn.tsx";
import { router } from "./router.tsx";

const root = document.getElementById("root");

/** The pages that are not an org's: sign-in (before anyone is signed in), people and the chooser. */
const outsideOrg = () => {
  const path = window.location.pathname.replace(/\/+$/, "");

  if (path === SIGN_IN_PAGE_PATH) return <SignInPage />;

  return path === "/people" ? <PeoplePage /> : <OrgsPage />;
};

if (root === null) throw new Error("index.html has no #root element");

createRoot(root).render(
  <StrictMode>
    <RegistryProvider>
      {/* An address without an org (`/`, `/?choose`) is the chooser; an org's pages live under `/o/<slug>`. */}
      {panelOrgSlug === undefined ? outsideOrg() : <RouterProvider router={router} />}
    </RegistryProvider>
  </StrictMode>,
);
