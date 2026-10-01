import { AsyncLocalStorage } from "node:async_hooks";
import type { EarnRuntimeContext } from "@sdp/earn/types";
import { isTransientRpcError, resolveClusterRpcUrls } from "@sdp/rpc";
import type { SolanaCluster } from "@sdp/types";
import type { Env } from "@/types/env";
import type { VaultDeadline } from "./vault-deadline";

function transientCause(error: unknown): boolean {
  const seen = new Set<unknown>();
  for (let cause = error; cause instanceof Error && !seen.has(cause); cause = cause.cause) {
    seen.add(cause);
    if (isTransientRpcError(cause)) return true;
  }
  return false;
}

/**
 * Provider operations build unsigned plans or read chain state. They never sign
 * or broadcast. Retry that whole read/build on a proven alternative, with one
 * workflow deadline and no process-wide sticky endpoint. Each concurrent call
 * owns its endpoint cursor; a later receipt read starts at the primary again.
 * A successful unknown/missing-history response is not an error or settlement.
 */
export function createVaultRpcFailover(
  env: Env,
  deadline: VaultDeadline,
  prove: (env: Env, cluster: SolanaCluster, url: string) => Promise<void>
) {
  const attempts = new AsyncLocalStorage<{ index: number; urls: string[] }>();
  return {
    async resolve(_ctx: EarnRuntimeContext, cluster: SolanaCluster): Promise<string> {
      const attempt = attempts.getStore();
      const urls = resolveClusterRpcUrls(env, cluster);
      if (attempt) attempt.urls = urls;
      const url = urls[attempt?.index ?? 0] ?? "";
      await prove(env, cluster, url);
      return url;
    },
    run<T>(label: string, operation: (assertActive: () => void) => Promise<T>): Promise<T> {
      const attempt: { index: number; urls: string[] } = { index: 0, urls: [] };
      return deadline.run(label, () =>
        attempts.run(attempt, async () => {
          for (;;) {
            deadline.assertActive(label);
            try {
              return await operation(() => deadline.assertActive(label));
            } catch (error) {
              if (!transientCause(error) || attempt.index + 1 >= attempt.urls.length) throw error;
              attempt.index += 1;
            }
          }
        })
      );
    },
  };
}
