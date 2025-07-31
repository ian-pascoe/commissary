import { Database } from "bun:sqlite";
import { initAuth } from "~/server/lib/auth";

export const auth = initAuth(
  new Database() as any,
  null as any,
  {
    BETTER_AUTH_SECRET: "super-secret-key",
    API_URL: "http://localhost:8080",
    APP_URL: "http://localhost:3000",
  } as any,
);
