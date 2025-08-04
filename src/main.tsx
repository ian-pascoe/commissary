import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRouter, RouterProvider } from "@tanstack/react-router";
import ReactDOM from "react-dom/client";
import { DefaultError } from "./components/default-error";
import { DefaultLoading } from "./components/default-loading";
import { DefaultNotFound } from "./components/default-not-found";
import { Splashscreen } from "./components/splashscreen";
import { routeTree } from "./routeTree.gen";
import { initAutoHideScrollbars } from "./utils/auto-hide-scrollbars";

import "@fontsource-variable/geist-mono";
import "./styles/global.css";

const rootElement = document.getElementById("app");
let root: ReactDOM.Root;
if (!rootElement || rootElement.innerHTML) {
  throw new Error("Root element not found or already has content.");
} else {
  root = ReactDOM.createRoot(rootElement);
}
root.render(<Splashscreen />);

const { localDb } = await import("./lib/database");
const { stronghold } = await import("./lib/stronghold");
const { config } = await import("./lib/config");
const { authClient } = await import("./lib/auth");
const { apiClient } = await import("./lib/api");

const queryClient = new QueryClient();
const router = createRouter({
  routeTree,
  context: {
    queryClient,
    localDb,
    stronghold,
    config,
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

initAutoHideScrollbars();
