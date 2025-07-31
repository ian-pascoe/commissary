import { AuthCard } from "@daveyplate/better-auth-ui";
import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { ChevronLeft } from "lucide-react";
import { useEffect } from "react";
import * as z from "zod";
import { Button } from "~/components/ui/button";
import { useStrongholdStore } from "~/hooks/use-stronghold";

const anonymousPaths = [
  "sign-in",
  "sign-up",
  "forgot-password",
  "reset-password",
] as const;
const signedInPaths = ["sign-out"] as const;

export const Route = createFileRoute("/auth/$pathname")({
  params: z.object({
    pathname: z.enum([...anonymousPaths, ...signedInPaths]),
  }),
  beforeLoad: async ({ context: { user }, params: { pathname } }) => {
    console.log("[Route] /auth/$pathname beforeLoad", { user, pathname });
    if (anonymousPaths.includes(pathname as (typeof anonymousPaths)[number])) {
      if (user && !user.isAnonymous) {
        throw redirect({ to: "/chat" });
      }
    }

    if (signedInPaths.includes(pathname as (typeof signedInPaths)[number])) {
      if (!user || user.isAnonymous) {
        throw redirect({ to: "/chat" });
      }
    }
  },
  component: RouteComponent,
});

function RouteComponent() {
  const router = useRouter();
  const strongholdStore = useStrongholdStore();
  const { pathname } = Route.useParams();
  useEffect(() => {
    if (pathname === "sign-out") {
      strongholdStore.remove("auth-token");
    }
  }, [pathname, strongholdStore]);

  return (
    <div className="relative flex size-full flex-col items-center justify-center p-4">
      <Button
        variant="outline"
        className="absolute top-4 left-4"
        onClick={() => {
          router.history.back();
        }}
      >
        <ChevronLeft />
        <span>Back</span>
      </Button>
      <AuthCard pathname={pathname} />
    </div>
  );
}
