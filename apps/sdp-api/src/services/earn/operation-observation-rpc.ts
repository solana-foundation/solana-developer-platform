import { createClusterRpc } from "@sdp/rpc/factory";
import { currentClusterScope } from "@sdp/rpc/scope";
import { canonicalJson } from "@sdp/types/idempotency";
import { signature } from "@solana/kit";
import type { OperationScope } from "@/db/repositories/operations.repository";
import { internalError } from "@/lib/errors";
import { currentMoneyPrincipal } from "@/lib/money-principal";
import { readConfirmedBlockHeight } from "./vault-intent-execution.service";

interface PendingSignature {
  resolve: (observed: boolean) => void;
  reject: (error: unknown) => void;
}
interface ScopeReads {
  rpc?: ReturnType<typeof createClusterRpc>;
  height?: Promise<bigint>;
  pending: Map<string, PendingSignature>;
  signatures: Map<string, Promise<boolean>>;
}

/** Read-only observations shared only within one worker run and exact authority scope. */
export interface OperationObservationRpc {
  confirmedHeight(scope: OperationScope): Promise<bigint>;
  hasSignature(scope: OperationScope, value: string): Promise<boolean>;
}

/**
 * Lazy per-scope clients and height snapshots; concurrent status reads batch
 * after authorization. No result or failure survives this run's context.
 */
export function createOperationObservationRpc(): OperationObservationRpc {
  const clusterScope = currentClusterScope();
  const states = new Map<string, ScopeReads>();
  function state(scope: OperationScope): ScopeReads {
    const current = currentClusterScope();
    if (
      current.projectId !== clusterScope.projectId ||
      current.environment !== clusterScope.environment ||
      scope.environment !== clusterScope.environment ||
      (current.projectId !== null && current.projectId !== scope.projectId)
    ) {
      throw internalError("Operation observation scope changed");
    }
    const key = canonicalJson({ ...scope, principal: currentMoneyPrincipal() });
    const existing = states.get(key);
    if (existing !== undefined) return existing;
    const created: ScopeReads = { pending: new Map(), signatures: new Map() };
    states.set(key, created);
    return created;
  }
  function rpc(reads: ScopeReads) {
    reads.rpc ??= createClusterRpc({ timeoutMs: 2_000 });
    return reads.rpc;
  }
  async function flush(reads: ScopeReads): Promise<void> {
    const pending = [...reads.pending.entries()];
    reads.pending.clear();
    for (let offset = 0; offset < pending.length; offset += 256) {
      const batch = pending.slice(offset, offset + 256);
      try {
        const result = await rpc(reads)
          .getSignatureStatuses(
            batch.map(([value]) => signature(value)),
            {
              searchTransactionHistory: true,
            }
          )
          .send();
        // An incomplete reply is an RPC failure, never evidence of absence.
        if (result.value.length !== batch.length)
          throw internalError("Incomplete operation signature statuses");
        for (let i = 0; i < batch.length; i += 1) {
          batch[i]?.[1].resolve(result.value[i] !== null && result.value[i] !== undefined);
        }
      } catch (error) {
        for (const [, waiting] of batch) waiting.reject(error);
      } finally {
        for (const [value] of batch) reads.signatures.delete(value);
      }
    }
  }
  return {
    async confirmedHeight(scope) {
      const reads = state(scope);
      if (reads.height === undefined) {
        reads.height = readConfirmedBlockHeight(rpc(reads)).catch((error: unknown) => {
          reads.height = undefined;
          throw error;
        });
      }
      return reads.height;
    },
    async hasSignature(scope, value) {
      signature(value);
      const reads = state(scope);
      const existing = reads.signatures.get(value);
      if (existing !== undefined) return existing;
      const promise = new Promise<boolean>((resolve, reject) => {
        reads.pending.set(value, { resolve, reject });
        if (reads.pending.size === 1)
          setTimeout(() => {
            void flush(reads);
          }, 5);
      });
      reads.signatures.set(value, promise);
      return promise;
    },
  };
}
