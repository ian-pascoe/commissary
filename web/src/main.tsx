import "@fontsource-variable/atkinson-hyperlegible-next";
import "./styles/tokens.css";
import "./styles/base.css";
import { RegistryProvider } from "@effect/atom-react";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { panelOrgSlug } from "./api/client.ts";
import { OrgsPage } from "./pages/Orgs.tsx";
import { router } from "./router.tsx";

const root = document.getElementById("root");

if (root === null) throw new Error("index.html has no #root element");

createRoot(root).render(
  <StrictMode>
    <RegistryProvider>
      {/* An address without an org (`/`, `/?choose`) is the chooser; an org's pages live under `/o/<slug>`. */}
      {panelOrgSlug === undefined ? <OrgsPage /> : <RouterProvider router={router} />}
    </RegistryProvider>
  </StrictMode>,
);
