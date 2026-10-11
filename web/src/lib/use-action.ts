// One button's call to a mutation atom: whether it is running, and its outcome as a value or the operator-facing
// failure message. Mutation atoms are shared per endpoint, so the busy flag is kept per caller instead.
import { useAtomSet } from "@effect/atom-react";
import { Exit } from "effect";
import type { Atom } from "effect/reactivity";
import { useCallback, useState } from "react";
import { causeMessage, serverDetail, serverError } from "./failure.ts";

export type Outcome<A> =
  | { readonly ok: true; readonly value: A }
  | {
      readonly ok: false;
      readonly message: string;
      /** The server's raw error text (`conflict`, ...), to tell failures apart. */
      readonly error: string | undefined;
      /** The server's own explanation (`422` reasons), when it sent one. */
      readonly detail?: string;
      /** The dotted config path the failure is about, when the server named one. */
      readonly path?: string;
    };

export const useAction = <Arg, A, E>(atom: Atom.AtomResultFn<Arg, A, E>) => {
  const call = useAtomSet(atom, { mode: "promiseExit" });
  const [busy, setBusy] = useState(false);

  const run = useCallback(
    async (input: Arg): Promise<Outcome<A>> => {
      setBusy(true);

      try {
        const exit = await call(input);

        if (Exit.isSuccess(exit)) return { ok: true, value: exit.value };
        const { message: detail, path } = serverDetail(exit.cause);

        return {
          ok: false,
          message: causeMessage(exit.cause),
          error: serverError(exit.cause),
          ...(detail === undefined ? {} : { detail }),
          ...(path === undefined ? {} : { path }),
        };
      } finally {
        setBusy(false);
      }
    },
    [call],
  );

  return { run, busy } as const;
};
