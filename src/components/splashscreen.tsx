import { useMediaQuery } from "usehooks-ts";
import { cn } from "~/lib/utils";
import { Spinner } from "./ui/kibo-ui/spinner";

export const Splashscreen = () => {
  const prefersDark = useMediaQuery("(prefers-color-scheme: dark)");
  return (
    <div
      className={cn(
        "flex size-full items-center justify-center",
        prefersDark && "dark",
      )}
    >
      <div className="flex flex-col items-center gap-4">
        <h1>Welcome to Commissary</h1>
        <Spinner />
      </div>
    </div>
  );
};
