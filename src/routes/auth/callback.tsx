import { createFileRoute, redirect } from "@tanstack/react-router";
import z from "zod";
import { Spinner } from "~/components/ui/kibo-ui/spinner";

export const Route = createFileRoute("/auth/callback")({
  validateSearch: z.object({
    code: z.string(),
    state: z.string(),
  }),
  loaderDeps: ({ search }) => search,
  loader: async ({
    location,
    context: {
      authClient,
      stronghold: { store },
    },
    deps: { code, state },
  }) => {
    const challengeString = await store.get("challenge");
    if (!challengeString) {
      throw redirect({ to: "/" });
    }

    const challenge = JSON.parse(challengeString);
    if (state === challenge.state && challenge.verifier) {
      const redirectUrl = import.meta.env.DEV
        ? "http://localhost:3000/auth/callback"
        : "com.spiritledsoftware.commissary://auth/callback";

      const exchanged = await authClient.exchange(
        code,
        redirectUrl,
        challenge.verifier,
      );
      if (exchanged.err) {
        console.error("Failed to exchange tokens:", exchanged.err);
        throw redirect({ to: "/" });
      }

      store.set("access-token", exchanged.tokens.access);
      store.set("refresh-token", exchanged.tokens.refresh);

      return redirect({ to: "/" });
    }
  },
  component: RouteComponent,
});

function RouteComponent() {
  return (
    <div className="flex size-full items-center justify-center">
      <Spinner />
    </div>
  );
}
