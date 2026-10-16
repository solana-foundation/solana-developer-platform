import { AsyncLocalStorage } from "node:async_hooks";
import type { EarnRuntimeContext } from "@sdp/earn/types";
import { isTransientRpcError, resolveClusterRpcUrls } from "@sdp/rpc";
import type { SolanaCluster } from "@sdp/types";
import type { Env } from "@/types/env";
import type { VaultDeadline } from "./vault-deadline";

/**
 * Deepest nesting `transientCause` follows. Veda's fan-out read is already six
 * deep (SdpVedaError > AggregateError > per-vault wrapper > vaultUnreadable >
 * TypeError > socket error); the cap only stops a pathological chain.
 */
const MAX_CAUSE_DEPTH = 16;

/**
 * Whether another endpoint could succeed: some error on the `.cause` chain is a
 * transient RPC failure. A per-vault fan-out reports an `AggregateError` whose
 * failures sit in `.errors`, so those count too, but only when EVERY member is
 * transient: the read is all-or-nothing, and one deterministic failure would
 * fail the retry anyway.
 */
function transientCause(error: unknown): boolean {
  const verdicts = new Map<Error, boolean>();
  const visit = (node: unknown, depth: number): boolean => {
    if (!(node instanceof Error) || depth > MAX_CAUSE_DEPTH) return false;
    const known = verdicts.get(node);
    if (known !== undefined) return known;
    // Provisional verdict: a cycle back to this node proves nothing.
    verdicts.set(node, false);
    const verdict =
      isTransientRpcError(node) ||
      (node instanceof AggregateError &&
        node.errors.length > 0 &&
        node.errors.every((member: unknown) => visit(member, depth + 1))) ||
      visit(node.cause, depth + 1);
    verdicts.set(node, verdict);
    return verdict;
  };
  return visit(error, 0);
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
