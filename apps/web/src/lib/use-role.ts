// The caller's role in the org the panel shows, read from the org-scoped `GET /me`.
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { meAtom } from "../api/client.ts";
import { type Caller, callerOf } from "./role.ts";

export type RoleState =
  | { readonly kind: "loading" }
  | { readonly kind: "failed"; readonly retry: () => void }
  | { readonly kind: "ready"; readonly caller: Caller };

export const useRole = (): RoleState => {
  const me = useAtomValue(meAtom);
  const retry = useAtomRefresh(meAtom);

  if (AsyncResult.isSuccess(me)) return { kind: "ready", caller: callerOf(me.value) };

  return AsyncResult.isFailure(me) ? { kind: "failed", retry } : { kind: "loading" };
};
