import { useRouteContext } from "@tanstack/react-router";

export const useStronghold = () => {
  const stronghold = useRouteContext({
    from: "__root__",
    select: (s) => s.stronghold.stronghold,
  });
  return stronghold;
};

export const useStrongholdClient = () => {
  const strongholdClient = useRouteContext({
    from: "__root__",
    select: (s) => s.stronghold.client,
  });
  return strongholdClient;
};

export const useStrongholdStore = () => {
  const strongholdStore = useRouteContext({
    from: "__root__",
    select: (s) => s.stronghold.store,
  });
  return strongholdStore;
};
