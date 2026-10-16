/**
 * Persistent (best-effort) side of the signature cache: the store interface and the prefetch/flush steps executors run
 * around a synchronous translation. The Worker's `CACHE` KV store implements {@link SignatureStore}.
 *
 * Go source: internal/cache/signature_cache.go home-KV branch.
 * Every operation swallows failures: the signature cache is an optimisation, never a reason to fail a request.
 */
import { type MemorySignatureCache, type SignatureWrite, signatureStoreKey } from "./cache.ts";

export interface SignatureStore {
  get(modelName: string, text: string): Promise<string | undefined>;
  put(write: SignatureWrite): Promise<void>;
  delete(modelName: string, text: string): Promise<void>;
}

/** Store for tests and for deployments without the `CACHE` binding. */
export const makeMemorySignatureStore = (): SignatureStore & {
  readonly entries: Map<string, string>;
} => {
  const entries = new Map<string, string>();

  return {
    entries,
    get: async (modelName, text) => entries.get(signatureStoreKey(modelName, text)),
    put: async ({ modelName, text, signature }) => {
      entries.set(signatureStoreKey(modelName, text), signature);
    },
    delete: async (modelName, text) => {
      entries.delete(signatureStoreKey(modelName, text));
    },
  };
};

/**
 * Loads the signatures the next synchronous translation may read (`texts` are thinking blocks that arrived without a
 * usable signature) into the in-memory cache; texts already cached are skipped. Store failures only mean a miss.
 */
export const prefetchSignatures = async (
  cache: MemorySignatureCache,
  store: SignatureStore | undefined,
  modelName: string,
  texts: ReadonlyArray<string>,
): Promise<void> => {
  if (store === undefined) return;
  const wanted = [...new Set(texts.filter((text) => text !== "" && !cache.has(modelName, text)))];
  await Promise.allSettled(
    wanted.map(async (text) => {
      const signature = await store.get(modelName, text);

      if (signature !== undefined) cache.hydrate(modelName, text, signature);
    }),
  );
};

/** Persists the writes recorded by the response translator. */
export const flushSignatureWrites = async (
  cache: MemorySignatureCache,
  store: SignatureStore | undefined,
): Promise<void> => {
  const writes = cache.drainPendingWrites();

  if (store === undefined || writes.length === 0) return;
  await Promise.allSettled(writes.map((write) => store.put(write)));
};
