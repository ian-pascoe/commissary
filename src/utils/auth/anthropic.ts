import { fetch } from "@tauri-apps/plugin-http";
import pkceChallenge from "pkce-challenge";

export namespace AnthropicAuth {
  const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

  export async function authorize(mode: "max" | "console") {
    const pkce = await pkceChallenge();

    const url = new URL(
      `https://${mode === "console" ? "console.anthropic.com" : "claude.ai"}/oauth/authorize`,
    );
    url.searchParams.set("code", "true");
    url.searchParams.set("client_id", CLIENT_ID);
    url.searchParams.set("response_type", "code");
    url.searchParams.set(
      "redirect_uri",
      "https://console.anthropic.com/oauth/code/callback",
    );
    url.searchParams.set(
      "scope",
      "org:create_api_key user:profile user:inference",
    );
    url.searchParams.set("code_challenge", pkce.code_challenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("state", pkce.code_verifier);
    return {
      url: url.toString(),
      verifier: pkce.code_verifier,
    };
  }

  export async function exchange(code: string, verifier: string) {
    const splits = code.split("#");
    const result = await fetch("https://console.anthropic.com/v1/oauth/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        code: splits[0],
        state: splits[1],
        grant_type: "authorization_code",
        client_id: CLIENT_ID,
        redirect_uri: "https://console.anthropic.com/oauth/code/callback",
        code_verifier: verifier,
      }),
    });
    if (!result.ok) throw new ExchangeFailed();

    const json = (await result.json()) as any;
    return {
      accessToken: json.access_token as string,
      refreshToken: json.refresh_token as string,
      expiresAt: Date.now() + json.expires_in * 1000,
    };
  }

  export async function refresh(refreshToken: string) {
    const response = await fetch(
      "https://console.anthropic.com/v1/oauth/token",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          client_id: CLIENT_ID,
        }),
      },
    );
    if (!response.ok) throw new RefreshFailed();

    const json = (await response.json()) as any;
    return {
      accessToken: json.access_token as string,
      refreshToken: json.refresh_token as string,
      expiresAt: Date.now() + json.expires_in * 1000,
    };
  }

  export async function createApiKey(accessToken: string) {
    const response = await fetch(
      "https://api.anthropic.com/api/oauth/claude_cli/create_api_key",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json, text/plain, */*",
        },
      },
    );
    if (!response.ok) {
      throw new Error("Failed to create API key");
    }
    const json = (await response.json()) as any;
    return json.raw_key as string;
  }

  export class ExchangeFailed extends Error {
    constructor() {
      super("Exchange failed");
    }
  }

  export class RefreshFailed extends Error {
    constructor() {
      super("Refresh failed");
    }
  }
}
