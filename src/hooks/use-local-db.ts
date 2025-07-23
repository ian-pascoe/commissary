import { useRouteContext } from "@tanstack/react-router";

export const useLocalDb = () => {
  const { db } = useRouteContext({ from: "__root__" });
  return db;
};
