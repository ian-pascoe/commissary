import {
  type UseQueryResult,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { type UnwatchFn, watch } from "@tauri-apps/plugin-fs";
import React, { type PropsWithChildren, useEffect, useRef } from "react";
import { useConfigInterface } from "~/hooks/use-config";
import { queryKeys } from "~/lib/query-keys";
import type { Config } from "~/schemas/config";

export type ConfigContextType = UseQueryResult<Config, Error>;

export const ConfigContext = React.createContext<ConfigContextType | null>(
  null,
);

export const ConfigProvider = (props: PropsWithChildren) => {
  const queryClient = useQueryClient();
  const config = useConfigInterface();

  const query = useQuery({
    queryKey: queryKeys.config.all(),
    queryFn: () => config.get(),
  });

  const unwatchFnRef = useRef<UnwatchFn | null>(null);
  useEffect(() => {
    console.log("Setting up config watcher...");
    watch(
      config.path,
      () => {
        console.log("Config file changed, refetching...");
        queryClient.invalidateQueries({
          queryKey: queryKeys.config.all(),
        });
      },
      {
        delayMs: 200,
      },
    ).then((unwatchFn) => {
      console.log("Config watcher initialized.");
      unwatchFnRef.current = unwatchFn;
    });

    return () => {
      const unwatchFn = unwatchFnRef.current;
      if (unwatchFn) {
        console.log("Cleaning up config watcher...");
        unwatchFn();
      }
    };
  }, [config.path, queryClient.invalidateQueries]);

  return (
    <ConfigContext.Provider value={query}>
      {props.children}
    </ConfigContext.Provider>
  );
};

export const useConfig = () => {
  const ctx = React.useContext(ConfigContext);
  if (ctx === null) {
    throw new Error("useConfig must be used within a ConfigProvider");
  }
  return ctx;
};
