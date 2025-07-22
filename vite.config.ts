import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import tsConfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [
    cloudflare({
      persistState: process.env.ALCHEMY_CLOUDFLARE_PERSIST_PATH
        ? {
            path: process.env.ALCHEMY_CLOUDFLARE_PERSIST_PATH,
          }
        : undefined,
    }),
    tsConfigPaths(),
    tailwindcss(),
    tanstackRouter({ target: "react", autoCodeSplitting: true }),
    react(),
  ],
});
