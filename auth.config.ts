import { Database } from "bun:sqlite";
import { initAuth } from "~/server/lib/auth";

export const auth = initAuth(
  new Database() as any,
  null as any,
  {
    API_URL: "http://localhost:8080",
    APP_URL: "http://localhost:3000",
  } as any,
);
