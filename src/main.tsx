import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRouter, RouterProvider } from "@tanstack/react-router";
import ReactDOM from "react-dom/client";
import { DefaultError } from "./components/default-error";
import { DefaultLoading } from "./components/default-loading";
import { DefaultNotFound } from "./components/default-not-found";
import { Splashscreen } from "./components/splashscreen";
import { initApiClient } from "./lib/api";
import { initAuthClient } from "./lib/auth";
import { initConfig } from "./lib/config";
import { initLocalDb } from "./lib/database";
import { initGeneralStore } from "./lib/general-store";
import { initStronghold } from "./lib/stronghold";
import { routeTree } from "./routeTree.gen";
import { initAutoHideScrollbars } from "./utils/auto-hide-scrollbars";

import "@fontsource-variable/plus-jakarta-sans";
import "@fontsource-variable/source-serif-4";
import "@fontsource-variable/jetbrains-mono";
import "./styles/global.css";

const rootElement = document.getElementById("app");
let root: ReactDOM.Root;
if (!rootElement || rootElement.innerHTML) {
  throw new Error("Root element not found or already has content.");
} else {
  root = ReactDOM.createRoot(rootElement);
}

root.render(<Splashscreen />);

const queryClient = new QueryClient();

const [db, config, generalStore, stronghold] = await Promise.all([
  initLocalDb(),
  initConfig(),
  initGeneralStore(),
  initStronghold(),
]);

const authClient = initAuthClient(stronghold.store);
const apiClient = initApiClient(stronghold.store);

// Create a new router instance
const router = createRouter({
  routeTree,
  context: {
    queryClient,
    db,
    config,
    generalStore,
    stronghold,
    authClient,
    apiClient,
  },
  defaultPreload: "intent",
  scrollRestoration: true,
  defaultStructuralSharing: true,
  Wrap: function WrapComponent({ children }) {
    return (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
  },
  defaultNotFoundComponent: DefaultNotFound,
  defaultPendingComponent: DefaultLoading,
  defaultErrorComponent: DefaultError,
});

// Register the router instance for type safety
declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

root.render(<RouterProvider router={router} />);

// Initialize auto-hide scrollbars
initAutoHideScrollbars();
