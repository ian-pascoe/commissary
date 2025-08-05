import { useStore } from "@tanstack/react-form";
import { useMutation } from "@tanstack/react-query";
import { useLocation, useSearch } from "@tanstack/react-router";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "~/components/ui/button";
import { withForm } from "~/hooks/use-form";
import { OpenRouterAuth } from "~/utils/auth/open-router";
import type { Provider } from "../form";

export const OpenRouterAuthForm = withForm({
  defaultValues: {} as Provider,
  render: function Form({ form }) {
    const [verifier, setVerifier] = useState<string | null>(null);

    const pathname = useLocation({ select: (loc) => loc.pathname });
    const authorizeMutation = useMutation({
      mutationFn: async () => {
        const { url, verifier } = await OpenRouterAuth.authorize(
          `com.spiritledsoftware.commissary://${pathname}`,
        );
        setVerifier(verifier);
        await openUrl(url);
      },
      onError: (error) => {
        toast.error(
          `Authorization failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      },
    });

    const search = useSearch({ strict: false });
    const exchangeMutation = useMutation({
      mutationFn: async (code: string) => {
        if (!verifier) return;
        const { apiKey } = await OpenRouterAuth.exchange(code, verifier);
        form.setFieldValue("auth.type", "api-key");
        form.setFieldValue("auth.apiKey", apiKey);
        form.validate("change");
      },
      onError: (error) => {
        toast.error(
          `Authorization failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      },
    });
    useEffect(() => {
      if ((search as any).code) {
        exchangeMutation.mutate((search as any).code);
      }
    }, [search, exchangeMutation]);

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
        ) : (
          <div className="flex w-full gap-2">
            <Button onClick={() => authorizeMutation.mutate()}>
              Authorize
            </Button>
          </div>
        )}
      </div>
    );
  },
});
