import { Link } from "@tanstack/react-router";
import { Button } from "./ui/button";

export const DefaultNotFound = () => {
  return (
    <div className="flex h-full w-full items-center justify-center">
      <div className="text-center">
        <h1 className="font-bold text-2xl">404 - Not Found</h1>
        <p className="mt-4 text-gray-600">
          The page you are looking for does not exist.
        </p>
        <Button asChild>
          <Link to="/">Go to Home</Link>
        </Button>
      </div>
    </div>
  );
};
