import { Spinner } from "./ui/kibo-ui/spinner";

export const DefaultLoading = () => {
  return (
    <div className="flex size-full items-center justify-center">
      <Spinner />
    </div>
  );
};
