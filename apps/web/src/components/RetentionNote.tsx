// One read-only line under the Usage heading: how long the org keeps usage records (ADR 0027). Nothing while it loads
// or when the caller may not read it.
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { orgAtom } from "../api/client.ts";
import { retentionSentence } from "../lib/retention.ts";

export const RetentionNote = ({ className }: { readonly className: string | undefined }) => {
  const org = useAtomValue(orgAtom);

  return AsyncResult.isSuccess(org) ? (
    <p className={className}>{retentionSentence(org.value.usage_retention_days)}</p>
  ) : null;
};
