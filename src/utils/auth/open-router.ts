import { fetch } from "@tauri-apps/plugin-http";
import pkceChallenge from "pkce-challenge";

export namespace OpenRouterAuth {
  export async function authorize(redirectUrl: string) {
    const pkce = await pkceChallenge();

    const url = new URL("https://openrouter.ai/auth");
    url.searchParams.set("callback_url", redirectUrl);
    url.searchParams.set("code_challenge", pkce.code_challenge);
    url.searchParams.set("code_challenge_method", "S256");
    return {
      url: url.toString(),
      verifier: pkce.code_verifier,
    };
  }

  export async function exchange(code: string, verifier: string) {
    const result = await fetch("https://openrouter.ai/api/v1/auth/keys", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        code,
        code_verifier: verifier,
        code_challenge_method: "S256",
      }),
    });
    if (!result.ok) throw new ExchangeFailed();

    const json = (await result.json()) as any;
    return {
      apiKey: json.key as string,
    };
  }

  export class ExchangeFailed extends Error {
    constructor() {
      super("Exchange failed");
    }
  }
}
