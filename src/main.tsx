import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRouter, RouterProvider } from "@tanstack/react-router";
import ReactDOM from "react-dom/client";
import { routeTree } from "./routeTree.gen";
import "./styles/global.css";
import { createClient } from "@openauthjs/openauth/client";
import { DefaultError } from "./components/default-error";
import { DefaultLoading } from "./components/default-loading";
import { ThemeProvider } from "./contexts/theme";

const queryClient = new QueryClient();
const authClient = createClient({
  clientID: "commissary-app",
  issuer: `${import.meta.env.VITE_API_URL}/auth`,
});

// Create a new router instance
const router = createRouter({
  routeTree,
  context: {
    queryClient,
    authClient,
  },
  defaultPreload: "intent",
  scrollRestoration: true,
  defaultStructuralSharing: true,
  Wrap: function WrapComponent({ children }) {
    return (
      <ThemeProvider>
        <QueryClientProvider client={queryClient}>
          {children}
        </QueryClientProvider>
      </ThemeProvider>
    );
  },
  defaultPendingComponent: DefaultLoading,
  defaultErrorComponent: DefaultError,
});

// Register the router instance for type safety
declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

// Render the app
const rootElement = document.getElementById("app");
if (rootElement && !rootElement.innerHTML) {
  const root = ReactDOM.createRoot(rootElement);
  root.render(<RouterProvider router={router} />);
}
