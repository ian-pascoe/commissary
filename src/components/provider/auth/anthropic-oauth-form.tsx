import { useStore } from "@tanstack/react-form";
import { useMutation } from "@tanstack/react-query";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { withForm } from "~/hooks/use-form";
import { AnthropicAuth } from "~/utils/auth/anthropic";
import type { Provider } from "../form";

export const AnthropicOauthForm = withForm({
  defaultValues: {} as Provider,
  render: function Form({ form }) {
    const [mode, setMode] = useState<"max" | "console">("max");
    const [verifier, setVerifier] = useState<string | null>(null);
    const [authorizationCode, setAuthorizationCode] = useState("");

    const authorizeMutation = useMutation({
      mutationFn: async (mode: "max" | "console") => {
        setMode(mode);
        const { url, verifier } = await AnthropicAuth.authorize(mode);
        setVerifier(verifier);
        await openUrl(url);
      },
    });

    const exchangeMutation = useMutation({
      mutationFn: async () => {
        if (!authorizationCode || !verifier) return;

        const { accessToken, refreshToken, expiresAt } =
          await AnthropicAuth.exchange(authorizationCode, verifier);

        if (mode === "console") {
          const apiKey = await AnthropicAuth.createApiKey(accessToken);
          form.setFieldValue("auth.type", "api-key");
          form.setFieldValue("auth.apiKey", apiKey);
        } else {
          form.setFieldValue("auth.type", "oauth");
          form.setFieldValue("auth.accessToken", accessToken);
          form.setFieldValue("auth.refreshToken", refreshToken);
          form.setFieldValue("auth.expiresAt", expiresAt);
        }
        form.validate("change");
      },
      onError: (error) => {
        toast.error(
          `Authorization failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      },
    });

    const isAuthorized = useStore(form.store, (state) => {
      const auth = state.values.auth;
      if (!auth) return false;
      if (auth.type === "api-key" && auth.apiKey) return true;
      if (
        auth.type === "oauth" &&
        auth.accessToken &&
        auth.refreshToken &&
        auth.expiresAt
      ) {
        return true;
      }
      return false;
    });

    return (
      <div>
        {isAuthorized ? (
          <div className="font-medium text-green-600">Authorized!</div>
        ) : verifier ? (
          <div className="flex flex-col gap-2">
            <Input
              placeholder="Paste Authorization Code Here"
              value={authorizationCode}
              onChange={(e) => setAuthorizationCode(e.target.value)}
            />
            <Button
              onClick={() => exchangeMutation.mutate()}
              disabled={!authorizationCode || exchangeMutation.isPending}
            >
              Authorize
            </Button>
          </div>
        ) : (
          <div className="flex w-full gap-2">
            <Button onClick={() => authorizeMutation.mutate("max")}>
              Authorize with Max
            </Button>
            <Button onClick={() => authorizeMutation.mutate("console")}>
              Authorize With Console
            </Button>
          </div>
        )}
      </div>
    );
  },
});
