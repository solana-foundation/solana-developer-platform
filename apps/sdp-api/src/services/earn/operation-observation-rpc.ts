import { createClusterRpc, getSignatureStatusesFromEveryEndpoint } from "@sdp/rpc/factory";
import { currentClusterScope } from "@sdp/rpc/scope";
import { type ChainHeight, getChainHeight, VERDICT_HISTORY_HORIZON_BLOCKS } from "@sdp/rpc/solana";
import { canonicalJson } from "@sdp/types/idempotency";
import { signature } from "@solana/kit";
import type { OperationScope } from "@/db/repositories/operations.repository";
import { internalError } from "@/lib/errors";
import { currentMoneyPrincipal } from "@/lib/money-principal";
import { logEvent } from "@/runtime/money-path-events";
import { readConfirmedBlockHeight } from "./vault-intent-execution.service";

interface PendingSignature {
  resolve: (observed: boolean) => void;
  reject: (error: unknown) => void;
}
interface ScopeReads {
  rpc?: ReturnType<typeof createClusterRpc>;
  height?: Promise<bigint>;
  finalized?: Promise<ChainHeight>;
  pending: Map<string, PendingSignature>;
  signatures: Map<string, Promise<boolean>>;
}

/** What retained history says about a signed transaction SDP did not send. */
export type UnsentTransactionVerdict =
  /** An endpoint holds a status for it: observe it like any landed transaction. */
  | "landed"
  /** It can still land, or no endpoint could prove otherwise yet. */
  | "pending"
  /** Its blockhash expired at finalized commitment and no endpoint's history has it. */
  | "expired";

/** Read-only observations shared only within one worker run and exact authority scope. */
export interface OperationObservationRpc {
  confirmedHeight(scope: OperationScope): Promise<bigint>;
  hasSignature(scope: OperationScope, value: string): Promise<boolean>;
  /**
   * Whether a signature a cheaper read missed can never land. Only once the `finalized` block
   * height is past `lastValidBlockHeight` does every pool endpoint, read at that finalized slot,
   * answer for it; `expired` needs every endpoint to miss it inside the history horizon. An
   * endpoint that cannot answer, or an expiry past the horizon, stays `pending`.
   *
   * @param scope - The operation's authority scope.
   * @param value - The transaction signature.
   * @param lastValidBlockHeight - The last block height its blockhash is valid for.
   * @returns The verdict.
   */
  unsentVerdict(
    scope: OperationScope,
    value: string,
    lastValidBlockHeight: bigint
  ): Promise<UnsentTransactionVerdict>;
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
  function finalizedHeight(reads: ScopeReads): Promise<ChainHeight> {
    if (reads.finalized === undefined) {
      reads.finalized = getChainHeight(rpc(reads), "finalized").catch((cause: unknown) => {
        reads.finalized = undefined;
        throw cause;
      });
    }
    return reads.finalized;
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
    async unsentVerdict(scope, value, lastValidBlockHeight) {
      const sent = signature(value);
      // The height comes first: once finalized is past the expiry, nothing lands after the
      // status read, and every read below is floored at that slot.
      const finalized = await finalizedHeight(state(scope));
      if (finalized.blockHeight <= lastValidBlockHeight) return "pending";
      const [read] = await getSignatureStatusesFromEveryEndpoint([sent], {
        minContextSlot: finalized.absoluteSlot,
        commitment: "finalized",
      });
      if (read === undefined) throw internalError("Operation signature history is incomplete");
      const evidence = {
        environment: scope.environment,
        signature: value,
        last_valid_block_height: lastValidBlockHeight.toString(),
        finalized_block_height: finalized.blockHeight.toString(),
        min_context_slot: finalized.absoluteSlot.toString(),
      };
      switch (read.kind) {
        case "found":
          return "landed";
        case "unresolved":
          logEvent("warn", {
            event: "sdp_api_earn_operation_unsent_unresolved",
            ...evidence,
            endpoint_failures: read.failures.map((failure) =>
              failure.reason === "node_behind_floor"
                ? { reason: failure.reason, context_slot: failure.contextSlot.toString() }
                : { reason: failure.reason, error_name: failure.errorName }
            ),
          });
          return "pending";
        case "absent":
          // Past the horizon a pruned history can miss a landed send: never call that expired.
          if (finalized.blockHeight - lastValidBlockHeight > VERDICT_HISTORY_HORIZON_BLOCKS) {
            logEvent("error", {
              event: "sdp_api_earn_operation_unsent_verdict_unprovable",
              ...evidence,
            });
            return "pending";
          }
          return "expired";
        default: {
          const unknownRead: never = read;
          throw internalError(`Unknown signature history read: ${unknownRead}`);
        }
      }
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
